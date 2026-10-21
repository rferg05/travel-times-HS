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
}

export interface Config {
  routes: SavedRoute[];
  showTransit: boolean;
  showUber: boolean;
  showLyft: boolean;
  showDrive: boolean;
  /** An estimated ride-hail tile from the drive time, for when Uber and
   *  Lyft won't give quotes. */
  showRideshare: boolean;
  /** Minutes the Rideshare tile allows for a car to arrive. */
  rideshareWait: number;
  transitOptions: number;
  uberProduct: string;
  lyftRideType: string;
  showCalendar: boolean;
  homeAddress: string;
  calendarHours: number;
  maxEvents: number;
  rideshareHours: number;
  bufferMinutes: number;
  eventFilter: string[];
  showTitle: boolean;
  timeFormat: 'auto' | '12h' | '24h';
  refreshMinutes: number;
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
  };
}

export function readConfig(raw: Record<string, unknown>): Config {
  return {
    routes: Array.isArray(raw.routes) ? raw.routes.map(readRoute) : [],
    showTransit: on(raw.showTransit),
    // Off unless turned on: Uber only answers apps it has approved.
    showUber: raw.showUber === true || raw.showUber === 'true',
    showLyft: on(raw.showLyft),
    showDrive: on(raw.showDrive),
    showRideshare: on(raw.showRideshare),
    rideshareWait: Math.round(num(raw.rideshareWait, 5, 0, 30)),
    transitOptions: Math.round(num(raw.transitOptions, 2, 1, 3)),
    uberProduct: str(raw.uberProduct, 'UberX') || 'UberX',
    lyftRideType: str(raw.lyftRideType, 'lyft') || 'lyft',
    showCalendar: on(raw.showCalendar),
    homeAddress: str(raw.homeAddress),
    calendarHours: num(raw.calendarHours, 12, 1, 48),
    maxEvents: Math.round(num(raw.maxEvents, 3, 1, 6)),
    rideshareHours: num(raw.rideshareHours, 3, 0, 12),
    bufferMinutes: Math.round(num(raw.bufferMinutes, 5, 0, 30)),
    eventFilter: str(raw.eventFilter).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    showTitle: on(raw.showTitle),
    timeFormat: pick(raw.timeFormat, ['auto', '12h', '24h'] as const, 'auto'),
    refreshMinutes: num(raw.refreshMinutes, 10, 2, 30),
    quietFrom: raw.quietFrom === undefined ? '23:00' : clockTime(raw.quietFrom),
    quietTo: raw.quietTo === undefined ? '05:30' : clockTime(raw.quietTo),
  };
}
