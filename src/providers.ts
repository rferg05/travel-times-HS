// Travel-time lookups: Google Routes for transit and driving, Uber and Lyft
// for ride-hail. Everything goes through the host proxy, which holds the keys
// and the Uber sign-in; nothing secret reaches this bundle except Lyft's
// short-lived read-only token (see `lyftToken`).
//
// The parsers are exported and pure so they can be tested against recorded
// response shapes.

export const PLUGIN_ID = 'travel-times';

// ── Fetch plumbing ──────────────────────────────────────────────────────────

export interface ProxyRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  payload?: string;
  secretInjections?: { header?: Record<string, string>; query?: Record<string, string> };
  cacheTtlMs?: number;
}

export interface ProxyAnswer {
  status: number;
  body: unknown;
}

export type Fetcher = (req: ProxyRequest) => Promise<ProxyAnswer>;

/** Why a mode has no time. Each maps to one plain line on the card. */
export type Reason =
  | 'notConnected' // Uber not signed in / Lyft or Google credentials not entered
  | 'reconnect' // Uber sign-in expired
  | 'notApproved' // Uber hasn't granted this app the estimates endpoints
  | 'badKey' // the service turned the key down
  | 'notFound' // no route between these places, or an address it can't place
  | 'noService' // no rides of this type here right now
  | 'capped' // this month's Google request limit is used up
  | 'unavailable'; // the service didn't answer properly; try again next time

export type Mode<T> = { ok: true; value: T } | { ok: false; reason: Reason };

const fail = <T>(reason: Reason): Mode<T> => ({ ok: false, reason });

/** The proxy's words for a secret nobody entered. */
function isMissingSecret(a: ProxyAnswer): boolean {
  const b = a.body as { error?: string; detail?: string } | null;
  return /not configured/i.test(`${b?.detail ?? ''} ${b?.error ?? ''}`);
}

function isAuthExpired(a: ProxyAnswer): boolean {
  return a.status === 401 && (a.body as { error?: string } | null)?.error === 'auth_expired';
}

/** The host proxy allows 60 requests a minute per plugin. Requests go out one
 *  at a time, spaced so even a long list of trips stays under 50 a minute. */
const MIN_SPACING_MS = 1200;
let queue: Promise<unknown> = Promise.resolve();
let lastSent = 0;

export function hostFetcher(): Fetcher {
  return (req) => {
    const run = async (): Promise<ProxyAnswer> => {
      const wait = lastSent + MIN_SPACING_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastSent = Date.now();
      const sdk = window.__HS_SDK__;
      if (!sdk?.pluginFetch) throw new Error('Host SDK unavailable');
      const res = await sdk.pluginFetch(PLUGIN_ID, req);
      const text = await res.text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* keep the text */ }
      return { status: res.status, body };
    };
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };
}

// ── Places ──────────────────────────────────────────────────────────────────

export interface LatLon { lat: number; lon: number }

/** "41.9,-87.6" as coordinates; anything else is an address. */
export function parseLatLon(text: string): LatLon | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

function waypoint(place: string) {
  const ll = parseLatLon(place);
  return ll ? { location: { latLng: { latitude: ll.lat, longitude: ll.lon } } } : { address: place };
}

const seconds = (d: unknown): number => {
  const n = parseFloat(String(d ?? '').replace(/s$/, ''));
  return Number.isFinite(n) ? n : 0;
};

// ── Google Routes ───────────────────────────────────────────────────────────

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

export interface TransitLine {
  /** Short name where the agency has one ("Blue", "56"), else the long one. */
  name: string;
  color?: string;
  textColor?: string;
  /** Google's vehicle type: SUBWAY, BUS, HEAVY_RAIL, TRAM, ... */
  vehicle: string;
}

export interface TransitOption {
  /** Leave home at (epoch ms): the first departure less the walk to it. */
  leaveAt: number | null;
  /** Arrive at the destination (epoch ms). */
  arriveAt: number | null;
  /** Door to door, leaving at `leaveAt`. */
  minutes: number;
  lines: TransitLine[];
  /** Where the first ride starts ("Division"). */
  firstStop: string | null;
  walkMinutes: number;
}

export interface DriveTime {
  minutes: number;
  /** Extra minutes from current traffic over a clear road. */
  delayMinutes: number;
  start: LatLon | null;
  end: LatLon | null;
}

function legEnd(leg: Record<string, unknown> | undefined, key: 'startLocation' | 'endLocation'): LatLon | null {
  const ll = (leg?.[key] as { latLng?: { latitude?: number; longitude?: number } } | undefined)?.latLng;
  return ll && typeof ll.latitude === 'number' && typeof ll.longitude === 'number'
    ? { lat: ll.latitude, lon: ll.longitude }
    : null;
}

/** Google's answer to a refused or unroutable request, sorted by who can fix it. */
function googleFailure(a: ProxyAnswer): Reason {
  if (isMissingSecret(a)) return 'notConnected';
  if (a.status === 429 && (a.body as { error?: string } | null)?.error === 'monthly_cap') return 'capped';
  const text = JSON.stringify(a.body ?? '');
  if (a.status === 401 || a.status === 403 || /API_KEY_INVALID|PERMISSION_DENIED/.test(text)) return 'badKey';
  if (a.status === 400 || a.status === 404) return 'notFound';
  return 'unavailable';
}

export function parseTransit(body: unknown, now: number): TransitOption[] {
  const routes = (body as { routes?: unknown[] } | null)?.routes;
  if (!Array.isArray(routes)) return [];
  const options: TransitOption[] = [];
  for (const r of routes as Record<string, unknown>[]) {
    const steps = ((r.legs as Record<string, unknown>[] | undefined) ?? [])
      .flatMap((leg) => (leg.steps as Record<string, unknown>[] | undefined) ?? []);
    const lines: TransitLine[] = [];
    let walkBefore = 0;
    let walkAfter = 0;
    let walkTotal = 0;
    let firstDepart: number | null = null;
    let lastArrive: number | null = null;
    let firstStop: string | null = null;
    for (const s of steps) {
      const td = s.transitDetails as Record<string, unknown> | undefined;
      if (s.travelMode === 'TRANSIT' && td) {
        const stops = td.stopDetails as Record<string, unknown> | undefined;
        const dep = Date.parse(String(stops?.departureTime ?? ''));
        const arr = Date.parse(String(stops?.arrivalTime ?? ''));
        if (firstDepart === null && Number.isFinite(dep)) {
          firstDepart = dep;
          firstStop = String((stops?.departureStop as { name?: string } | undefined)?.name ?? '') || null;
        }
        if (Number.isFinite(arr)) lastArrive = arr;
        walkAfter = 0;
        const line = td.transitLine as Record<string, unknown> | undefined;
        const vehicle = String((line?.vehicle as { type?: string } | undefined)?.type ?? 'BUS');
        const name = String(line?.nameShort ?? line?.name ?? '').trim();
        lines.push({
          name: name || vehicle.toLowerCase(),
          color: typeof line?.color === 'string' ? line.color : undefined,
          textColor: typeof line?.textColor === 'string' ? line.textColor : undefined,
          vehicle,
        });
      } else {
        const sec = seconds(s.staticDuration);
        walkTotal += sec;
        if (firstDepart === null) walkBefore += sec;
        else walkAfter += sec;
      }
    }
    const duration = seconds(r.duration);
    const leaveAt = firstDepart !== null ? firstDepart - walkBefore * 1000 : null;
    const arriveAt = lastArrive !== null ? lastArrive + walkAfter * 1000 : (duration ? now + duration * 1000 : null);
    const minutes = leaveAt !== null && arriveAt !== null
      ? Math.round((arriveAt - leaveAt) / 60_000)
      : Math.round(duration / 60);
    if (!minutes && !lines.length) continue;
    options.push({ leaveAt, arriveAt, minutes, lines, firstStop, walkMinutes: Math.round(walkTotal / 60) });
  }
  // Soonest arrival first; Google's own order is by its notion of "best".
  return options.sort((a, b) => (a.arriveAt ?? Infinity) - (b.arriveAt ?? Infinity));
}

export function parseDrive(body: unknown): DriveTime | null {
  const r = (body as { routes?: Record<string, unknown>[] } | null)?.routes?.[0];
  if (!r) return null;
  const traffic = seconds(r.duration);
  const clear = seconds(r.staticDuration) || traffic;
  const leg = (r.legs as Record<string, unknown>[] | undefined)?.[0];
  return {
    minutes: Math.round(traffic / 60),
    delayMinutes: Math.max(0, Math.round(traffic / 60) - Math.round(clear / 60)),
    start: legEnd(leg, 'startLocation'),
    end: legEnd(leg, 'endLocation'),
  };
}

function googleRequest(body: object, fieldMask: string): ProxyRequest {
  return {
    url: ROUTES_URL,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-FieldMask': fieldMask },
    payload: JSON.stringify(body),
    secretInjections: { header: { 'X-Goog-Api-Key': '{{google_maps_key}}' } },
  };
}

export async function loadTransit(
  fetch: Fetcher, origin: string, destination: string, arriveBy: number | null, now: number,
): Promise<Mode<TransitOption[]>> {
  const body: Record<string, unknown> = {
    origin: waypoint(origin),
    destination: waypoint(destination),
    travelMode: 'TRANSIT',
    computeAlternativeRoutes: true,
  };
  if (arriveBy !== null) body.arrivalTime = new Date(arriveBy).toISOString();
  const a = await fetch(googleRequest(body,
    'routes.duration,routes.legs.steps.travelMode,routes.legs.steps.staticDuration,routes.legs.steps.transitDetails'));
  if (a.status !== 200) return fail(googleFailure(a));
  const options = parseTransit(a.body, now);
  return options.length ? { ok: true, value: options } : fail('notFound');
}

export async function loadDrive(fetch: Fetcher, origin: string, destination: string): Promise<Mode<DriveTime>> {
  const a = await fetch(googleRequest({
    origin: waypoint(origin),
    destination: waypoint(destination),
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE',
  }, 'routes.duration,routes.staticDuration,routes.legs.startLocation,routes.legs.endLocation'));
  if (a.status !== 200) return fail(googleFailure(a));
  const drive = parseDrive(a.body);
  return drive ? { ok: true, value: drive } : fail('notFound');
}

// ── Ride-hail ───────────────────────────────────────────────────────────────

export interface RideQuote {
  /** The ride type as the service names it ("UberX"). */
  name: string;
  /** Minutes until a car arrives, when the service says. */
  pickupMinutes: number | null;
  /** Minutes in the car, when the service says. */
  rideMinutes: number | null;
  /** "$18-23", already formatted for the region. */
  price: string | null;
}

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** The entry whose name is the wanted one, else one that contains it, else the first. */
function pickByName<T>(list: T[], wanted: string, ...names: ((x: T) => unknown)[]): T | undefined {
  const w = norm(wanted);
  return list.find((x) => names.some((n) => norm(n(x)) === w))
    ?? list.find((x) => names.some((n) => norm(n(x)).includes(w)))
    ?? list[0];
}

// Uber ──

const UBER = 'https://api.uber.com/v1.2';

/** Which Uber endpoints this app may use. Uber only opens the estimate
 *  endpoints to approved apps; an unapproved one can still quote its own
 *  developer through the request-estimate endpoint (the `request` scope works
 *  for the app's developers before review). Learned on first use, then kept. */
let uberPath: 'estimates' | 'requestEstimate' = 'estimates';

export function resetUberPath(): void { uberPath = 'estimates'; }

function uberFailure(a: ProxyAnswer): Reason {
  if (isAuthExpired(a)) return 'reconnect';
  if (a.status === 401) return 'notConnected';
  if (a.status === 403) return 'notApproved';
  if (a.status === 422 || a.status === 404) return 'noService';
  return 'unavailable';
}

export function parseUberEstimates(prices: unknown, times: unknown, product: string): RideQuote | null {
  const list = (prices as { prices?: Record<string, unknown>[] } | null)?.prices ?? [];
  const p = pickByName(list, product, (x) => x.display_name, (x) => x.localized_display_name);
  if (!p) return null;
  const etas = (times as { times?: Record<string, unknown>[] } | null)?.times ?? [];
  const t = etas.find((x) => x.product_id === p.product_id);
  const eta = typeof t?.estimate === 'number' ? Math.round(t.estimate / 60) : null;
  const duration = typeof p.duration === 'number' ? Math.round(p.duration / 60) : null;
  return {
    name: String(p.localized_display_name ?? p.display_name ?? product),
    pickupMinutes: eta,
    rideMinutes: duration,
    price: typeof p.estimate === 'string' && p.estimate ? p.estimate : null,
  };
}

export function parseUberRequestEstimate(body: unknown, name: string): RideQuote | null {
  const b = body as Record<string, unknown> | null;
  if (!b) return null;
  const fare = b.fare as { display?: string } | undefined;
  const trip = b.trip as { duration_estimate?: number } | undefined;
  const estimate = b.estimate as { display?: string } | undefined;
  return {
    name,
    pickupMinutes: typeof b.pickup_estimate === 'number' ? Math.round(b.pickup_estimate) : null,
    rideMinutes: typeof trip?.duration_estimate === 'number' ? Math.round(trip.duration_estimate / 60) : null,
    price: fare?.display ?? estimate?.display ?? null,
  };
}

const ll = (prefix: string, p: LatLon) =>
  `${prefix}_latitude=${p.lat.toFixed(6)}&${prefix}_longitude=${p.lon.toFixed(6)}`;

export async function loadUber(fetch: Fetcher, from: LatLon, to: LatLon, product: string): Promise<Mode<RideQuote>> {
  if (uberPath === 'estimates') {
    const prices = await fetch({ url: `${UBER}/estimates/price?${ll('start', from)}&${ll('end', to)}`, cacheTtlMs: 60_000 });
    if (prices.status === 200) {
      const times = await fetch({ url: `${UBER}/estimates/time?${ll('start', from)}`, cacheTtlMs: 60_000 });
      const quote = parseUberEstimates(prices.body, times.status === 200 ? times.body : null, product);
      return quote ? { ok: true, value: quote } : fail('noService');
    }
    if (isAuthExpired(prices) || (prices.status !== 401 && prices.status !== 403)) return fail(uberFailure(prices));
    // Signed in, but these endpoints aren't open to this app: try the other way.
    uberPath = 'requestEstimate';
  }

  const products = await fetch({
    url: `${UBER}/products?latitude=${from.lat.toFixed(6)}&longitude=${from.lon.toFixed(6)}`,
    cacheTtlMs: 3_600_000,
  });
  if (products.status !== 200) return fail(uberFailure(products));
  const list = (products.body as { products?: Record<string, unknown>[] } | null)?.products ?? [];
  const p = pickByName(list, product, (x) => x.display_name);
  if (!p) return fail('noService');
  const est = await fetch({
    url: `${UBER}/requests/estimate`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    payload: JSON.stringify({
      product_id: p.product_id,
      start_latitude: from.lat, start_longitude: from.lon,
      end_latitude: to.lat, end_longitude: to.lon,
    }),
  });
  if (est.status !== 200) return fail(uberFailure(est));
  const quote = parseUberRequestEstimate(est.body, String(p.display_name ?? product));
  return quote ? { ok: true, value: quote } : fail('noService');
}

// Lyft ──

const LYFT = 'https://api.lyft.com';

/** Lyft's client-credentials token: read-only ("public" scope), good for a
 *  day. The host's auth adapter slot is Uber's, so this one is fetched here,
 *  with the client credentials injected by the proxy. */
let lyftToken: { value: string; expiresAt: number } | null = null;

export function resetLyftToken(): void { lyftToken = null; }

async function getLyftToken(fetch: Fetcher): Promise<string | Reason> {
  if (lyftToken && lyftToken.expiresAt > Date.now() + 60_000) return lyftToken.value;
  const a = await fetch({
    url: `${LYFT}/oauth/token`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    payload: JSON.stringify({ grant_type: 'client_credentials', scope: 'public' }),
    secretInjections: { header: { Authorization: 'Basic {{lyft_basic_auth}}' } },
  });
  if (isMissingSecret(a)) return 'notConnected';
  const b = a.body as { access_token?: string; expires_in?: number } | null;
  if (a.status !== 200 || !b?.access_token) return a.status === 400 || a.status === 401 ? 'badKey' : 'unavailable';
  lyftToken = { value: b.access_token, expiresAt: Date.now() + (b.expires_in ?? 3600) * 1000 };
  return lyftToken.value;
}

function cents(min: unknown, max: unknown, currency: unknown): string | null {
  if (typeof min !== 'number' || typeof max !== 'number') return null;
  const fmt = (c: number) => {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency', currency: typeof currency === 'string' ? currency : 'USD', maximumFractionDigits: 0,
      }).format(c / 100);
    } catch {
      return `$${Math.round(c / 100)}`;
    }
  };
  return Math.round(min / 100) === Math.round(max / 100) ? fmt(min) : `${fmt(min)}-${fmt(max).replace(/^[^\d]+/, '')}`;
}

export function parseLyft(cost: unknown, eta: unknown, rideType: string): RideQuote | null {
  const costs = (cost as { cost_estimates?: Record<string, unknown>[] } | null)?.cost_estimates ?? [];
  const etas = (eta as { eta_estimates?: Record<string, unknown>[] } | null)?.eta_estimates ?? [];
  const c = pickByName(costs, rideType, (x) => x.ride_type, (x) => x.display_name);
  const e = etas.find((x) => x.ride_type === (c?.ride_type ?? rideType))
    ?? pickByName(etas, rideType, (x) => x.ride_type, (x) => x.display_name);
  if (!c && !e) return null;
  return {
    name: String(c?.display_name ?? e?.display_name ?? 'Lyft'),
    pickupMinutes: typeof e?.eta_seconds === 'number' ? Math.round(e.eta_seconds / 60) : null,
    rideMinutes: typeof c?.estimated_duration_seconds === 'number' ? Math.round(c.estimated_duration_seconds / 60) : null,
    price: c && c.is_valid_estimate !== false
      ? cents(c.estimated_cost_cents_min, c.estimated_cost_cents_max, c.currency)
      : null,
  };
}

export async function loadLyft(fetch: Fetcher, from: LatLon, to: LatLon, rideType: string): Promise<Mode<RideQuote>> {
  const token = await getLyftToken(fetch);
  if (token === 'notConnected' || token === 'badKey' || token === 'unavailable') return fail(token as Reason);
  const headers = { Authorization: `Bearer ${token}` };
  const q = `start_lat=${from.lat.toFixed(6)}&start_lng=${from.lon.toFixed(6)}`;
  const cost = await fetch({
    url: `${LYFT}/v1/cost?${q}&end_lat=${to.lat.toFixed(6)}&end_lng=${to.lon.toFixed(6)}&ride_type=${encodeURIComponent(rideType)}`,
    headers, cacheTtlMs: 60_000,
  });
  if (cost.status === 401) { lyftToken = null; return fail('unavailable'); }
  if (cost.status !== 200) return fail(cost.status === 400 || cost.status === 404 ? 'noService' : 'unavailable');
  const eta = await fetch({
    url: `${LYFT}/v1/eta?lat=${from.lat.toFixed(6)}&lng=${from.lon.toFixed(6)}&ride_type=${encodeURIComponent(rideType)}`,
    headers, cacheTtlMs: 60_000,
  });
  const quote = parseLyft(cost.body, eta.status === 200 ? eta.body : null, rideType);
  return quote ? { ok: true, value: quote } : fail('noService');
}

// ── A whole trip ────────────────────────────────────────────────────────────

export interface TripRequest {
  origin: string;
  destination: string;
  /** Plan transit to arrive by this time (epoch ms) instead of leaving now. */
  arriveBy: number | null;
  transit: boolean;
  drive: boolean;
  uber: boolean;
  lyft: boolean;
  /** The estimated Rideshare tile: needs only the drive time. */
  rideshare: boolean;
  /** Minutes allowed for a rideshare car to arrive. Not part of any lookup. */
  rideshareWait: number;
  uberProduct: string;
  lyftRideType: string;
}

export interface TripTimes {
  transit?: Mode<TransitOption[]>;
  drive?: Mode<DriveTime>;
  uber?: Mode<RideQuote>;
  lyft?: Mode<RideQuote>;
  fetchedAt: number;
}

/** Whether the Uber connection exists, checked at most every few minutes. */
let uberStatus: { connected: boolean; checkedAt: number } | null = null;

async function uberConnected(): Promise<boolean> {
  if (uberStatus && Date.now() - uberStatus.checkedAt < 5 * 60_000) return uberStatus.connected;
  const get = window.__HS_SDK__?.getAuthStatus;
  // A host without auth status: assume connected and let the call itself say.
  const connected = get ? (await get(PLUGIN_ID).catch(() => ({ connected: false }))).connected : true;
  uberStatus = { connected, checkedAt: Date.now() };
  return connected;
}

/** Every requested mode for one trip. A mode that fails leaves the rest. */
export async function loadTrip(fetch: Fetcher, req: TripRequest, now = Date.now()): Promise<TripTimes> {
  const out: TripTimes = { fetchedAt: now };
  const guard = async <T>(f: () => Promise<Mode<T>>): Promise<Mode<T>> => {
    try { return await f(); } catch { return fail('unavailable'); }
  };

  if (req.transit) {
    out.transit = await guard(() => loadTransit(fetch, req.origin, req.destination, req.arriveBy, now));
  }
  // The drive lookup also places both ends for Uber and Lyft, which need
  // coordinates rather than addresses.
  const wantsCar = req.drive || req.rideshare || req.uber || req.lyft;
  const drive = wantsCar ? await guard(() => loadDrive(fetch, req.origin, req.destination)) : undefined;
  // Kept even when the Drive tile is off: it stands in for a ride's length
  // when Uber or Lyft doesn't give one.
  out.drive = drive;
  const from = drive?.ok ? drive.value.start : null;
  const to = drive?.ok ? drive.value.end : null;
  const noPlace = (): Mode<RideQuote> => fail(drive && !drive.ok ? drive.reason : 'notFound');

  if (req.uber) {
    out.uber = !(await uberConnected())
      ? fail('notConnected')
      : from && to ? await guard(() => loadUber(fetch, from, to, req.uberProduct)) : noPlace();
    if (!out.uber.ok && out.uber.reason === 'reconnect') uberStatus = null;
  }
  if (req.lyft) {
    out.lyft = from && to ? await guard(() => loadLyft(fetch, from, to, req.lyftRideType)) : noPlace();
  }
  return out;
}
