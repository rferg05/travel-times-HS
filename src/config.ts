// Module config, read defensively: the editor stores whatever its widgets
// produce, so numbers can arrive as strings and a half-typed route can be
// missing fields.

export type Day = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
export const DAYS: Day[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export interface SavedRoute {
  label: string;
  /** A household member's name; blank means the route is for everyone. */
  person: string;
  origin: string;
  destination: string;
  /** Empty means every day. */
  days: Day[];
  /** "HH:MM", or '' for no limit. */
  activeFrom: string;
  activeTo: string;
  /** An office/work route: its Drive tile follows `driveOnWork`. */
  work: boolean;
}

export interface Config {
  routes: SavedRoute[];
  showTransit: boolean;
  showDrive: boolean;
  /** Show the Drive tile on routes marked as work/office routes. */
  driveOnWork: boolean;
  /** Estimated Uber and Lyft tiles, each on its own. */
  uberEstimates: boolean;
  lyftEstimates: boolean;
  /** Ride types priced on each tile, Ridewise service ids ("uberx", "uber_black"). */
  uberTypes: string[];
  lyftTypes: string[];
  /** Ridewise region to price in; '' picks the nearest to home. */
  rateRegion: string;
  /** Raise estimated prices at rush hour and on weekend late nights. */
  rushSurge: boolean;
  rushMultiplier: number;
  /** Grow everything with the module's area, as the CTA module does. */
  scaleWithSize: boolean;
  /** Distinct transit routes shown per trip (Blue Line, 9 bus...). */
  transitRoutes: number;
  /** Departures listed for each transit route. */
  transitOptions: number;
  /** Trip cards side by side; 0 picks from the module's shape. */
  cardColumns: number;
  showCalendar: boolean;
  homeAddress: string;
  calendarHours: number;
  maxEvents: number;
  bufferMinutes: number;
  eventFilter: string[];
  timeFormat: 'auto' | '12h' | '24h';
  refreshMinutes: number;
  /** Google requests allowed per calendar month on this display. */
  monthlyCap: number;
  /** Warn on screen at this percent of the cap. */
  alertPercent: number;
  quietFrom: string;
  quietTo: string;
}

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v.trim() : d);

function num(v: unknown, d: number, lo: number, hi: number): number {
  const x = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
}

// Toggles default on; off is `false` or the string "false".
const on = (v: unknown) => v !== false && v !== 'false';

function pick<T extends string>(v: unknown, opts: readonly T[], d: T): T {
  return opts.includes(v as T) ? (v as T) : d;
}

/** "HH:MM" (24-hour, as the time widget stores it), or '' when unset or unreadable. */
export function clockTime(v: unknown): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(str(v));
  if (!m) return '';
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? `${String(h).padStart(2, '0')}:${m[2]}` : '';
}

function readRoute(raw: unknown): SavedRoute {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const days = Array.isArray(r.days) ? r.days.filter((d): d is Day => DAYS.includes(d as Day)) : [];
  return {
    label: str(r.label),
    person: str(r.person),
    origin: str(r.origin),
    destination: str(r.destination),
    days,
    activeFrom: clockTime(r.activeFrom),
    activeTo: clockTime(r.activeTo),
    work: r.work === true || r.work === 'true',
  };
}

export const UBER_TYPES = ['uberx', 'uber_comfort', 'uber_xl', 'uber_black'];
export const LYFT_TYPES = ['lyft', 'lyft_xl', 'lyft_lux'];

/** The ride types picked, in the tile's order, or the fallback when none are. */
function rideTypes(v: unknown, known: string[], fallback: string): string[] {
  const picked = Array.isArray(v) ? known.filter((t) => v.includes(t)) : [];
  return picked.length ? picked : [fallback];
}

/** Ride types as the single-choice settings before 1.5 stored them. */
function legacyUber(v: unknown): string {
  const t = String(v ?? '').toLowerCase();
  return t.includes('comfort') ? 'uber_comfort' : t.includes('black') ? 'uber_black' : t.includes('xl') ? 'uber_xl' : 'uberx';
}
function legacyLyft(v: unknown): string {
  const t = String(v ?? '').toLowerCase();
  return t.includes('lux') ? 'lyft_lux' : t.includes('xl') || t.includes('plus') ? 'lyft_xl' : 'lyft';
}

export function readConfig(raw: Record<string, unknown>): Config {
  return {
    routes: Array.isArray(raw.routes) ? raw.routes.map(readRoute) : [],
    showTransit: on(raw.showTransit),
    showDrive: on(raw.showDrive),
    driveOnWork: raw.driveOnWork === true || raw.driveOnWork === 'true',
    // One toggle each now; a module saved with the older shared toggle keeps its choice.
    uberEstimates: raw.uberEstimates === undefined ? on(raw.showRideshare) : on(raw.uberEstimates),
    lyftEstimates: raw.lyftEstimates === undefined ? on(raw.showRideshare) : on(raw.lyftEstimates),
    uberTypes: rideTypes(raw.uberTypes, UBER_TYPES, legacyUber(raw.uberProduct)),
    lyftTypes: rideTypes(raw.lyftTypes, LYFT_TYPES, legacyLyft(raw.lyftRideType)),
    rateRegion: /^auto$/i.test(str(raw.rateRegion)) ? '' : str(raw.rateRegion),
    rushSurge: on(raw.rushSurge),
    rushMultiplier: num(raw.rushMultiplier, 1.25, 1, 2),
    scaleWithSize: on(raw.scaleWithSize),
    transitRoutes: Math.round(num(raw.transitRoutes, 2, 1, 4)),
    transitOptions: Math.round(num(raw.transitOptions, 2, 1, 4)),
    cardColumns: /^auto$/i.test(String(raw.cardColumns ?? 'auto')) ? 0 : Math.round(num(raw.cardColumns, 0, 0, 4)),
    showCalendar: on(raw.showCalendar),
    homeAddress: str(raw.homeAddress),
    calendarHours: num(raw.calendarHours, 12, 1, 48),
    maxEvents: Math.round(num(raw.maxEvents, 3, 1, 6)),
    bufferMinutes: Math.round(num(raw.bufferMinutes, 5, 0, 30)),
    eventFilter: str(raw.eventFilter).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    timeFormat: pick(raw.timeFormat, ['auto', '12h', '24h'] as const, 'auto'),
    refreshMinutes: num(raw.refreshMinutes, 11, 2, 30),
    monthlyCap: Math.round(num(raw.monthlyCap, 10_000, 100, 100_000)),
    alertPercent: Math.round(num(raw.alertPercent, 80, 50, 95)),
    quietFrom: raw.quietFrom === undefined ? '23:00' : clockTime(raw.quietFrom),
    quietTo: raw.quietTo === undefined ? '05:30' : clockTime(raw.quietTo),
  };
}
