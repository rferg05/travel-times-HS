// What to look up right now, and how to read the answers: which saved
// routes are showing, which events need a trip, when to leave, and which
// way gets there first.

import type { Config } from './config';
import type { TransitLine, TransitOption, TripRequest, TripTimes } from './providers';
import { eventPeople, findPerson, isActive, isComplete, upcomingTrips } from './schedule';
import type { CalendarEvent, Person } from './schedule';

/** One tile each. Uber and Lyft are estimates from the drive lookup. */
export type ModeName = 'transit' | 'uber' | 'lyft' | 'drive';

export interface Trip {
  key: string;
  kind: 'route' | 'event';
  title: string;
  /** Who it's for: the route's person, or whoever's calendar the event is on. */
  people: Person[];
  /** A route's person as typed, when it matches nobody in the household. */
  personName: string | null;
  destination: string;
  /** Event start (epoch ms). */
  startsAt: number | null;
  /** Arrive by (epoch ms): the event start less the buffer. */
  arriveBy: number | null;
  request: TripRequest;
}

export function tripKey(req: TripRequest): string {
  // The rideshare wait is left out: changing it changes no lookup.
  return JSON.stringify([req.origin, req.destination, req.arriveBy, req.transit, req.drive, req.rideshare]);
}

/** The trips to show now: active saved routes first, then upcoming events.
 *  `home` is where routes without a start, and trips to events, begin: the
 *  home address, or the household location as "lat,lon" when that's blank. */
export function buildTrips(
  config: Config,
  now: Date,
  opts: { timezone?: string; events?: CalendarEvent[]; people?: Person[]; home?: string } = {},
): Trip[] {
  const people = opts.people ?? [];
  const home = opts.home ?? config.homeAddress;
  const modes = {
    transit: config.showTransit,
    drive: config.showDrive,
    rideshare: config.uberEstimates || config.lyftEstimates,
  };
  const trips: Trip[] = [];

  for (const route of config.routes) {
    if (!isComplete(route, home) || !isActive(route, now, opts.timezone)) continue;
    const request: TripRequest = {
      ...modes,
      // A work route leaves the Drive tile off unless asked for.
      drive: config.showDrive && (!route.work || config.driveOnWork),
      origin: route.origin || home,
      destination: route.destination,
      arriveBy: null,
    };
    const person = findPerson(route.person, people);
    trips.push({
      key: tripKey(request),
      kind: 'route',
      title: route.label || route.destination,
      people: person ? [person] : [],
      personName: person ? null : route.person || null,
      destination: route.destination,
      startsAt: null,
      arriveBy: null,
      request,
    });
  }

  if (config.showCalendar && home) {
    for (const event of upcomingTrips(opts.events, config, now)) {
      const startsAt = Date.parse(event.start);
      // Rounded to the minute so the request (and its cache entry) stays the
      // same across refreshes.
      const arriveBy = Math.floor((startsAt - config.bufferMinutes * 60_000) / 60_000) * 60_000;
      const request: TripRequest = {
        ...modes,
        origin: home,
        destination: event.location!.trim(),
        arriveBy: arriveBy > now.getTime() ? arriveBy : null,
      };
      trips.push({
        key: tripKey(request),
        kind: 'event',
        title: event.title || 'Event',
        people: eventPeople(event, people),
        personName: null,
        destination: event.location!.trim(),
        startsAt,
        arriveBy,
        request,
      });
    }
  }
  return trips;
}

/** A departure this long past its leave time is dropped, and the next one shown. */
export const EXPIRE_MS = 90_000;

/** One way by transit: the same line or lines, with its next departures. */
export interface TransitRoute {
  /** The lines in order, e.g. "Blue" or "9>Green". */
  key: string;
  lines: TransitLine[];
  /** The departure to show: the next one, or for an event the latest that's in time. */
  main: TransitOption;
  /** Departures after `main` on the same lines, soonest first. */
  next: TransitOption[];
}

const stillCatchable = (o: TransitOption, now: number) => o.leaveAt === null || o.leaveAt >= now - EXPIRE_MS;

/**
 * Google's transit answers grouped into distinct routes (the Blue Line, the
 * 9 bus to the Green Line...), each with its departures. Departures more than
 * 90 seconds past their leave time are dropped, so a missed one gives way to
 * the next. Routes are ordered by when their shown departure arrives, and at
 * most `maxRoutes` are kept, each with up to `perRoute` departures.
 */
export function transitRoutes(
  options: TransitOption[],
  now: number,
  arriveBy: number | null,
  maxRoutes: number,
  perRoute: number,
): TransitRoute[] {
  const groups = new Map<string, TransitOption[]>();
  for (const o of options) {
    if (!stillCatchable(o, now)) continue;
    const key = o.lines.map((l) => l.name).join('>') || 'walk';
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  const routes: TransitRoute[] = [];
  for (const [key, list] of groups) {
    const byLeave = [...list].sort((a, b) => (a.leaveAt ?? 0) - (b.leaveAt ?? 0));
    let main = byLeave[0];
    if (arriveBy !== null) {
      // For an event: the latest departure that still arrives in time.
      const inTime = byLeave.filter((o) => o.arriveAt !== null && o.arriveAt <= arriveBy);
      if (inTime.length) main = inTime[inTime.length - 1];
    }
    const next = byLeave.filter((o) => o !== main && (o.leaveAt ?? 0) > (main.leaveAt ?? 0)).slice(0, perRoute - 1);
    routes.push({ key, lines: main.lines, main, next });
  }
  return routes
    .sort((a, b) => (a.main.arriveAt ?? Infinity) - (b.main.arriveAt ?? Infinity))
    .slice(0, maxRoutes);
}

/** Every transit departure on hand has passed: time to ask again. */
export function transitExhausted(times: TripTimes, now: number): boolean {
  const t = times.transit;
  return !!t?.ok && t.value.length > 0 && !t.value.some((o) => stillCatchable(o, now));
}

/** Door to door by Uber or Lyft: the wait for a car, then the drive. */
export function rideMinutes(times: TripTimes | undefined, wait: number): number | null {
  return times?.drive?.ok ? wait + times.drive.value.minutes : null;
}

/** The tiles that get there first: every one within a minute of the
 *  earliest, when at least two tiles have a time to compare. */
export function fastestOf(arrivals: Record<string, number | undefined>): Set<string> {
  const known = Object.entries(arrivals).filter((e): e is [string, number] => typeof e[1] === 'number');
  if (known.length < 2) return new Set();
  const first = Math.min(...known.map(([, t]) => t));
  return new Set(known.filter(([, t]) => t - first < 60_000).map(([id]) => id));
}

// ── When to look a trip up ──────────────────────────────────────────────────

/** Events closer than this to home wait until shortly before they start. */
export const NEARBY_MILES = 50;
/** A nearby event gets one look this long before it starts... */
export const FIRST_LOOK_MS = 3 * 3_600_000;
/** ...and the normal refresh cadence from this long before. */
export const CLOSE_IN_MS = 90 * 60_000;
/** The refresh loop wakes once a minute, so a trip counts as due up to half a
 *  wake-up early. Without this, a 10-minute refresh lands every 11 minutes. */
const DUE_TOLERANCE_MS = 30_000;

/** A mode the service didn't answer this time, worth asking again soon. */
export function hasFailure(t: TripTimes): boolean {
  return [t.transit, t.drive].some((m) => m && !m.ok && m.reason === 'unavailable');
}

/**
 * Whether a trip should be looked up now.
 *
 * Routes, and events 50 miles or more from home, refresh every `refreshMs`.
 * A nearby event (or one whose distance isn't known) isn't looked up until
 * 3 hours before it starts, gets one look then, and refreshes every
 * `refreshMs` from 90 minutes before. A failed look is retried after
 * `retryMs` at any stage.
 */
export function isDue(
  trip: Trip,
  have: TripTimes | undefined,
  now: number,
  opts: { refreshMs: number; retryMs: number; milesFromHome?: number | null },
): boolean {
  // A failed lookup, or one whose departures have all gone, is asked again soon.
  const failed = !!have && (hasFailure(have) || transitExhausted(have, now));
  const olderThan = (ms: number) => !have || now - have.fetchedAt >= ms - DUE_TOLERANCE_MS;
  const cadence = () => olderThan(failed ? Math.min(opts.retryMs, opts.refreshMs) : opts.refreshMs);

  if (trip.kind === 'route' || trip.startsAt === null) return cadence();
  if (typeof opts.milesFromHome === 'number' && opts.milesFromHome >= NEARBY_MILES) return cadence();

  const untilStart = trip.startsAt - now;
  if (untilStart > FIRST_LOOK_MS) return false;
  if (untilStart > CLOSE_IN_MS) {
    // One look on entering the 3-hour window; more only to retry a failure.
    if (!have || have.fetchedAt < trip.startsAt - FIRST_LOOK_MS) return true;
    return failed && olderThan(opts.retryMs);
  }
  return cadence();
}

/** Google requests one lookup of this trip costs. */
export function googleCost(req: TripRequest): number {
  return (req.transit ? 1 : 0) + (req.drive || req.rideshare ? 1 : 0);
}
