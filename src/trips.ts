// What to look up right now, and how to read the answers: which saved
// routes are showing, which events need a trip, when to leave, and which
// way gets there first.

import type { Config } from './config';
import type { DriveTime, Mode, RideQuote, TransitOption, TripRequest, TripTimes } from './providers';
import { eventPeople, findPerson, isActive, isComplete, upcomingTrips } from './schedule';
import type { CalendarEvent, Person } from './schedule';

export type ModeName = 'transit' | 'rideshare' | 'uber' | 'lyft' | 'drive';

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
  return JSON.stringify([req.origin, req.destination, req.arriveBy, req.transit, req.drive, req.rideshare,
    req.uber, req.lyft, req.uberProduct, req.lyftRideType]);
}

/** The trips to show now: active saved routes first, then upcoming events. */
export function buildTrips(
  config: Config,
  now: Date,
  opts: { timezone?: string; events?: CalendarEvent[]; people?: Person[] } = {},
): Trip[] {
  const people = opts.people ?? [];
  const modes = {
    transit: config.showTransit,
    drive: config.showDrive,
    rideshare: config.showRideshare,
    rideshareWait: config.rideshareWait,
    uberProduct: config.uberProduct,
    lyftRideType: config.lyftRideType,
  };
  const trips: Trip[] = [];

  for (const route of config.routes) {
    if (!isComplete(route, config.homeAddress) || !isActive(route, now, opts.timezone)) continue;
    const request: TripRequest = {
      ...modes,
      origin: route.origin || config.homeAddress,
      destination: route.destination,
      arriveBy: null,
      uber: config.showUber,
      lyft: config.showLyft,
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

  if (config.showCalendar && config.homeAddress) {
    for (const event of upcomingTrips(opts.events, config, now)) {
      const startsAt = Date.parse(event.start);
      // Rounded to the minute so the request (and its cache entry) stays the
      // same across refreshes.
      const arriveBy = Math.floor((startsAt - config.bufferMinutes * 60_000) / 60_000) * 60_000;
      const soon = startsAt - now.getTime() <= config.rideshareHours * 3_600_000;
      const request: TripRequest = {
        ...modes,
        origin: config.homeAddress,
        destination: event.location!.trim(),
        arriveBy: arriveBy > now.getTime() ? arriveBy : null,
        uber: config.showUber && soon,
        lyft: config.showLyft && soon,
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

/** Door to door by ride-hail: wait for the car, then the ride. The ride
 *  falls back to the drive time when the service didn't say. */
export function rideMinutes(quote: RideQuote, drive?: Mode<DriveTime>): { minutes: number | null; estimated: boolean } {
  const ride = quote.rideMinutes ?? (drive?.ok ? drive.value.minutes : null);
  if (ride === null) return { minutes: null, estimated: false };
  return { minutes: (quote.pickupMinutes ?? 0) + ride, estimated: quote.rideMinutes === null || quote.pickupMinutes === null };
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

/** The estimated Rideshare tile: wait for the car, then drive. */
export function rideshareMinutes(times: TripTimes | undefined, wait: number): number | null {
  return times?.drive?.ok ? wait + times.drive.value.minutes : null;
}

/** When each shown mode gets there (epoch ms), leaving now, for the modes that answered. */
export function arrivals(times: TripTimes | undefined, now: number, req: TripRequest): Partial<Record<ModeName, number>> {
  const out: Partial<Record<ModeName, number>> = {};
  if (!times) return out;
  const t = req.transit && times.transit?.ok ? times.transit.value[0] : null;
  if (t?.arriveAt) out.transit = t.arriveAt;
  if (req.drive && times.drive?.ok) out.drive = now + times.drive.value.minutes * 60_000;
  const share = req.rideshare ? rideshareMinutes(times, req.rideshareWait) : null;
  if (share !== null) out.rideshare = now + share * 60_000;
  for (const m of ['uber', 'lyft'] as const) {
    const q = times[m];
    if (req[m] && q?.ok) {
      const { minutes } = rideMinutes(q.value, times.drive);
      if (minutes !== null) out[m] = now + minutes * 60_000;
    }
  }
  return out;
}

/** The mode that arrives first leaving now, if at least two answered. */
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
  const share = rideshareMinutes(times, trip.request.rideshareWait);
  if (share !== null) out.rideshare = trip.arriveBy - share * 60_000;
  for (const m of ['uber', 'lyft'] as const) {
    const q = times[m];
    if (q?.ok) {
      const { minutes } = rideMinutes(q.value, times.drive);
      if (minutes !== null) out[m] = trip.arriveBy - minutes * 60_000;
    }
  }
  return out;
}
