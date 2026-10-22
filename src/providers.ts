// Travel-time lookups: Google Routes for transit and driving. Everything goes
// through the host proxy, which holds the Google key; nothing secret reaches
// this bundle.
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
  | 'notConnected' // the Google key isn't entered
  | 'badKey' // the service turned the key down
  | 'notFound' // no route between these places, or an address it can't place
  | 'capped' // this month's Google request limit is used up
  | 'unavailable'; // the service didn't answer properly; try again next time

export type Mode<T> = { ok: true; value: T } | { ok: false; reason: Reason };

const fail = <T>(reason: Reason): Mode<T> => ({ ok: false, reason });

/** The proxy's words for a secret nobody entered. */
function isMissingSecret(a: ProxyAnswer): boolean {
  const b = a.body as { error?: string; detail?: string } | null;
  return /not configured/i.test(`${b?.detail ?? ''} ${b?.error ?? ''}`);
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
  /** The operating agency as Google names it ("Chicago Transit Authority"). */
  agency?: string;
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
  /** Road distance, for fare estimates. */
  miles?: number;
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
        const agency = (line?.agencies as { name?: string }[] | undefined)?.[0]?.name;
        lines.push({
          agency: typeof agency === 'string' && agency ? agency : undefined,
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
  const meters = Number(r.distanceMeters);
  return {
    minutes: Math.round(traffic / 60),
    delayMinutes: Math.max(0, Math.round(traffic / 60) - Math.round(clear / 60)),
    ...(Number.isFinite(meters) && meters > 0 ? { miles: meters / 1609.344 } : {}),
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
  }, 'routes.duration,routes.staticDuration,routes.distanceMeters,routes.legs.startLocation,routes.legs.endLocation'));
  if (a.status !== 200) return fail(googleFailure(a));
  const drive = parseDrive(a.body);
  return drive ? { ok: true, value: drive } : fail('notFound');
}

// ── A whole trip ────────────────────────────────────────────────────────────

export interface TripRequest {
  origin: string;
  destination: string;
  /** Plan transit to arrive by this time (epoch ms) instead of leaving now. */
  arriveBy: number | null;
  transit: boolean;
  /** Show the Drive tile. */
  drive: boolean;
  /** Show the Uber and Lyft estimate tiles, which need the drive lookup. */
  rideshare: boolean;
  /** Minutes allowed for a car to arrive. Not part of any lookup. */
  rideshareWait: number;
}

export interface TripTimes {
  transit?: Mode<TransitOption[]>;
  drive?: Mode<DriveTime>;
  fetchedAt: number;
}

/** Every requested lookup for one trip. One that fails leaves the other. */
export async function loadTrip(fetch: Fetcher, req: TripRequest, now = Date.now()): Promise<TripTimes> {
  const out: TripTimes = { fetchedAt: now };
  const guard = async <T>(f: () => Promise<Mode<T>>): Promise<Mode<T>> => {
    try { return await f(); } catch { return fail('unavailable'); }
  };
  if (req.transit) {
    out.transit = await guard(() => loadTransit(fetch, req.origin, req.destination, req.arriveBy, now));
  }
  // The drive lookup also gives the distance and time the Uber and Lyft
  // estimates are priced from, so it runs when either tile needs it.
  if (req.drive || req.rideshare) {
    out.drive = await guard(() => loadDrive(fetch, req.origin, req.destination));
  }
  return out;
}
