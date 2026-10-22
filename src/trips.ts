// What to look up right now, and how to read the answers: which saved
// routes are showing, which events need a trip, when to leave, and which
// way gets there first.

import type { Config } from './config';
import type { TransitOption, TripRequest, TripTimes } from './providers';
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
    rideshare: config.showRideshare,
    rideshareWait: config.rideshareWait,
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

/** The transit option to show first: for an event, the one that leaves
 *  latest while still arriving in time; otherwise the soonest arrival. */
export function bestTransit(options: TransitOption[], arriveBy: number | null): TransitOption | null {
  if (!options.length) return null;
  if (arriveBy === null) return options[0];
  const inTime = options.filter((o) => o.arriveAt !== null && o.arriveAt <= arriveBy && o.leaveAt !== null);
  if (!inTime.length) return options[0];
  return inTime.reduce((a, b) => ((b.leaveAt ?? 0) > (a.leaveAt ?? 0) ? b : a));
}

/** The estimate's door-to-door time: wait for a car, then drive. */
export function rideshareMinutes(times: TripTimes | undefined, wait: number): number | null {
  return times?.drive?.ok ? wait + times.drive.value.minutes : null;
}

/** An Uber or Lyft tile's door-to-door minutes: the wait plus the drive.
 *  Null when estimates are off or the drive lookup has no answer. */
export function rideFor(req: TripRequest, times: TripTimes | undefined): number | null {
  return req.rideshare ? rideshareMinutes(times, req.rideshareWait) : null;
}

/** When each shown mode gets there (epoch ms), leaving now, for the modes that answered. */
export function arrivals(times: TripTimes | undefined, now: number, req: TripRequest): Partial<Record<ModeName, number>> {
  const out: Partial<Record<ModeName, number>> = {};
  if (!times) return out;
  const t = req.transit && times.transit?.ok ? times.transit.value[0] : null;
  if (t?.arriveAt) out.transit = t.arriveAt;
  if (req.drive && times.drive?.ok) out.drive = now + times.drive.value.minutes * 60_000;
  const ride = rideFor(req, times);
  // Uber and Lyft estimates take the same time; one of them stands for both.
  if (ride !== null) out.uber = now + ride * 60_000;
  return out;
}

/** The mode that arrives first leaving now, if at least two answered. A
 *  ride-hail win is reported as 'uber' and highlights both ride tiles. */
export function fastest(times: TripTimes | undefined, now: number, req: TripRequest): ModeName | null {
  const a = Object.entries(arrivals(times, now, req)) as [ModeName, number][];
  if (a.length < 2) return null;
  return a.reduce((x, y) => (y[1] < x[1] ? y : x))[0];
}

/** When to leave for an event by each mode (epoch ms). */
export function leaveTimes(trip: Trip, times: TripTimes | undefined): Partial<Record<ModeName, number>> {
  const out: Partial<Record<ModeName, number>> = {};
  if (!times || trip.arriveBy === null) return out;
  const t = times.transit?.ok ? bestTransit(times.transit.value, trip.arriveBy) : null;
  if (t?.leaveAt) out.transit = t.leaveAt;
  if (times.drive?.ok) out.drive = trip.arriveBy - times.drive.value.minutes * 60_000;
  const ride = rideFor(trip.request, times);
  if (ride !== null) out.uber = out.lyft = trip.arriveBy - ride * 60_000;
  return out;
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
  const failed = !!have && hasFailure(have);
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
