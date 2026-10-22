import { describe, expect, it } from 'vitest';
import { readConfig } from './config';
import { loadTrip, parseDrive, parseLatLon, parseTransit } from './providers';
import type { Fetcher, ProxyRequest } from './providers';
import { findPerson, householdPeople, inWindow, isActive, upcomingTrips } from './schedule';
import type { Person } from './schedule';
import { buildTrips, EXPIRE_MS, fastestOf, rideMinutes, transitExhausted, transitRoutes } from './trips';

const T0 = Date.parse('2026-10-21T13:00:00Z'); // Wed 08:00 in Chicago
const TZ = 'America/Chicago';
const iso = (offsetMin: number) => new Date(T0 + offsetMin * 60_000).toISOString();

const transitBody = {
  routes: [
    {
      duration: '1800s',
      legs: [{
        steps: [
          { travelMode: 'WALK', staticDuration: '300s' },
          {
            travelMode: 'TRANSIT', staticDuration: '1200s',
            transitDetails: {
              stopDetails: { departureStop: { name: 'Division' }, departureTime: iso(9), arrivalTime: iso(29) },
              transitLine: { nameShort: 'Blue', color: '#00a1de', textColor: '#ffffff', vehicle: { type: 'SUBWAY' } },
            },
          },
          { travelMode: 'WALK', staticDuration: '240s' },
        ],
      }],
    },
    {
      duration: '2400s',
      legs: [{
        steps: [
          { travelMode: 'WALK', staticDuration: '120s' },
          {
            travelMode: 'TRANSIT', staticDuration: '1500s',
            transitDetails: {
              stopDetails: { departureStop: { name: 'Milwaukee & Division' }, departureTime: iso(5), arrivalTime: iso(32) },
              transitLine: { name: 'Milwaukee', nameShort: '56', vehicle: { type: 'BUS' } },
            },
          },
        ],
      }],
    },
  ],
};

describe('parseTransit', () => {
  it('reads leave and arrive times including the walks', () => {
    const [first, second] = parseTransit(transitBody, T0);
    // Sorted by arrival: the bus arrives at 08:32, the train at 08:33.
    expect(second.lines[0]).toEqual({ name: 'Blue', color: '#00a1de', textColor: '#ffffff', vehicle: 'SUBWAY' });
    expect(second.leaveAt).toBe(T0 + 4 * 60_000);
    expect(second.arriveAt).toBe(T0 + 33 * 60_000);
    expect(second.minutes).toBe(29);
    expect(second.firstStop).toBe('Division');
    expect(second.walkMinutes).toBe(9);
    expect(first.lines[0].name).toBe('56');
    expect(first.leaveAt).toBe(T0 + 3 * 60_000);
  });

  it('copes with an empty answer', () => {
    expect(parseTransit({}, T0)).toEqual([]);
    expect(parseTransit(null, T0)).toEqual([]);
  });
});

describe('parseDrive', () => {
  it('reads traffic delay and the two ends', () => {
    const d = parseDrive({
      routes: [{
        duration: '1500s', staticDuration: '1140s',
        legs: [{ startLocation: { latLng: { latitude: 41.9, longitude: -87.67 } }, endLocation: { latLng: { latitude: 41.88, longitude: -87.63 } } }],
      }],
    });
    expect(d).toEqual({ minutes: 25, delayMinutes: 6, start: { lat: 41.9, lon: -87.67 }, end: { lat: 41.88, lon: -87.63 } });
  });
});

describe('schedule', () => {
  it('handles windows that wrap midnight', () => {
    expect(inWindow(23 * 60, '22:00', '02:00')).toBe(true);
    expect(inWindow(60, '22:00', '02:00')).toBe(true);
    expect(inWindow(12 * 60, '22:00', '02:00')).toBe(false);
    expect(inWindow(12 * 60, '', '')).toBe(true);
  });

  const base = { label: 'Work', person: '', origin: 'a', destination: 'b', days: [], activeFrom: '', activeTo: '', work: false };

  it('shows a route on its days and hours only', () => {
    const now = new Date(T0); // Wednesday 08:00 in Chicago
    expect(isActive({ ...base, days: ['mon', 'wed'] }, now, TZ)).toBe(true);
    expect(isActive({ ...base, days: ['sat'] }, now, TZ)).toBe(false);
    expect(isActive({ ...base, activeFrom: '06:00', activeTo: '10:00' }, now, TZ)).toBe(true);
    expect(isActive({ ...base, activeFrom: '16:00', activeTo: '19:00' }, now, TZ)).toBe(false);
  });

  it('keeps an overnight window on the day it started', () => {
    const satAt1am = new Date(Date.parse('2026-10-24T06:00:00Z')); // Sat 01:00 Chicago
    expect(isActive({ ...base, days: ['fri'], activeFrom: '22:00', activeTo: '02:00' }, satAt1am, TZ)).toBe(true);
    expect(isActive({ ...base, days: ['sat'], activeFrom: '22:00', activeTo: '02:00' }, satAt1am, TZ)).toBe(false);
  });

  const people: Person[] = [
    { id: '1', name: 'Ryan Smith', color: '#3b82f6', sourceIds: ['cal-r'] },
    { id: '2', name: 'Audra', color: '#ec4899', sourceIds: ['cal-a', 'shared'] },
  ];

  it('matches people by full or first name', () => {
    expect(findPerson('ryan', people)?.id).toBe('1');
    expect(findPerson('Audra', people)?.id).toBe('2');
    expect(findPerson('Sam', people)).toBeNull();
  });

  it('picks timed, in-person, upcoming events', () => {
    const events = [
      { id: 'a', title: 'Dentist', start: iso(120), end: iso(180), location: '100 W Randolph St, Chicago', allDay: false, sourceId: 'cal-a' },
      { id: 'b', title: 'Standup', start: iso(60), end: iso(75), location: 'https://zoom.us/j/1', allDay: false },
      { id: 'c', title: 'Holiday', start: iso(30), end: iso(90), location: 'Home', allDay: true },
      { id: 'd', title: 'Past', start: iso(-30), end: iso(30), location: 'Office', allDay: false },
      { id: 'e', title: 'WFH block', start: iso(90), end: iso(120), location: 'Office', allDay: false },
      { id: 'f', title: 'Far off', start: iso(60 * 30), end: iso(60 * 31), location: 'Office', allDay: false },
    ];
    const trips = upcomingTrips(events, { calendarHours: 12, maxEvents: 3, eventFilter: ['wfh'] }, new Date(T0));
    expect(trips.map((e) => e.id)).toEqual(['a']);
  });

  it('builds route and event trips, tagged by person', () => {
    const config = readConfig({
      homeAddress: 'Home St',
      routes: [{ ...base, person: 'Audra', origin: '' }, { ...base, label: 'Gym', days: ['sat'] }],
    });
    const events = [{ id: 'a', title: 'Dentist', start: iso(120), end: iso(180), location: 'Clinic', allDay: false, sourceId: 'shared' }];
    const trips = buildTrips(config, new Date(T0), { timezone: TZ, events, people });
    expect(trips.map((t) => [t.kind, t.title, t.people.map((p) => p.name)])).toEqual([
      ['route', 'Work', ['Audra']],
      ['event', 'Dentist', ['Audra']],
    ]);
    expect(trips[0].request.origin).toBe('Home St');
    // Arrive five minutes early by default.
    expect(trips[1].arriveBy).toBe(T0 + 115 * 60_000);
    expect(trips[1].request.rideshare).toBe(true);
  });

  it('starts from the household location when there is no home address', () => {
    const config = readConfig({ homeAddress: '', routes: [{ ...base, origin: '' }] });
    const trips = buildTrips(config, new Date(T0), { timezone: TZ, home: '41.9087,-87.6776' });
    expect(trips[0].request.origin).toBe('41.9087,-87.6776');
    expect(buildTrips(config, new Date(T0), { timezone: TZ })).toEqual([]);
  });

  it('leaves the Drive tile off work routes unless asked', () => {
    const routes = [{ ...base, work: true }, { ...base, label: 'Gym' }];
    const off = buildTrips(readConfig({ routes }), new Date(T0), { timezone: TZ });
    expect(off.map((t) => t.request.drive)).toEqual([false, true]);
    const on = buildTrips(readConfig({ routes, driveOnWork: true }), new Date(T0), { timezone: TZ });
    expect(on.map((t) => t.request.drive)).toEqual([true, true]);
    // The estimates still get their drive lookup.
    expect(off[0].request.rideshare).toBe(true);
  });

  it('takes everyone from Settings > Family, with calendars where linked', () => {
    const family = [
      { id: '1', name: 'Ryan Smith', color: '#3b82f6', emoji: '🚲' },
      { id: '2', name: 'Audra', color: '#ec4899' },
    ];
    // Only Ryan has a calendar, so the host's calendar list has only him.
    const merged = householdPeople(family, [{ id: '1', name: 'Ryan Smith', color: '#000', sourceIds: ['cal-r'] }]);
    expect(merged).toEqual([
      { id: '1', name: 'Ryan Smith', color: '#3b82f6', emoji: '🚲', sourceIds: ['cal-r'] },
      { id: '2', name: 'Audra', color: '#ec4899', emoji: undefined, sourceIds: [] },
    ]);
    expect(findPerson('audra', merged)?.color).toBe('#ec4899');
    expect(householdPeople(null, people)).toBe(people);
  });

  it('defaults to estimated Uber and Lyft tiles', () => {
    const c = readConfig({});
    expect([c.uberEstimates, c.lyftEstimates, c.uberTypes, c.lyftTypes, c.driveOnWork]).toEqual([true, true, ['uberx'], ['lyft'], false]);
    expect([c.transitRoutes, c.transitOptions, c.cardColumns]).toEqual([2, 2, 0]);
    expect([c.rushSurge, c.rushMultiplier, c.rateRegion, c.scaleWithSize]).toEqual([true, 1.25, '', true]);
  });

  it('keeps choices saved by older versions', () => {
    const c = readConfig({ showRideshare: false, uberProduct: 'Black', lyftRideType: 'lyft_plus' });
    expect([c.uberEstimates, c.lyftEstimates]).toEqual([false, false]);
    expect([c.uberTypes, c.lyftTypes]).toEqual([['uber_black'], ['lyft_xl']]);
    const d = readConfig({ uberEstimates: true, lyftEstimates: false, uberTypes: ['uber_black', 'uberx', 'bogus'] });
    expect([d.uberEstimates, d.lyftEstimates, d.uberTypes]).toEqual([true, false, ['uberx', 'uber_black']]);
  });

  it('looks up the drive for the rideshare tile even with Drive off', async () => {
    const log: ProxyRequest[] = [];
    const fetch: Fetcher = async (req) => {
      log.push(req);
      return { status: 200, body: { routes: [{ duration: '900s', staticDuration: '900s', legs: [{}] }] } };
    };
    const times = await loadTrip(fetch, {
      origin: 'a', destination: 'b', arriveBy: null, transit: false, drive: false, rideshare: true,
    }, T0);
    expect(log).toHaveLength(1);
    expect(rideMinutes(times, 4)).toBe(19);
  });
});

describe('a whole trip', () => {
  function mockFetcher(log: ProxyRequest[]): Fetcher {
    return async (req) => {
      log.push(req);
      const body = req.payload ? JSON.parse(req.payload) : null;
      if (req.url.includes('computeRoutes')) {
        return body.travelMode === 'TRANSIT'
          ? { status: 200, body: transitBody }
          : { status: 200, body: { routes: [{ duration: '1320s', staticDuration: '1200s', distanceMeters: 8047, legs: [{ startLocation: { latLng: { latitude: 41.9, longitude: -87.67 } }, endLocation: { latLng: { latitude: 41.88, longitude: -87.63 } } }] }] } };
      }
      return { status: 404, body: {} };
    };
  }

  it('looks up transit and drive, and picks the fastest shown', async () => {
    const log: ProxyRequest[] = [];
    const times = await loadTrip(mockFetcher(log), {
      origin: 'a', destination: 'b', arriveBy: null, transit: true, drive: true, rideshare: true,
    }, T0);
    expect(log).toHaveLength(2);
    expect(times.transit?.ok).toBe(true);
    expect(times.drive).toEqual({ ok: true, value: expect.objectContaining({ minutes: 22, delayMinutes: 2 }) });
    if (times.drive?.ok) expect(times.drive.value.miles).toBeCloseTo(5, 1);
    expect(log.find((r) => r.url.includes('computeRoutes'))?.secretInjections?.header?.['X-Goog-Api-Key']).toBe('{{google_maps_key}}');
    // Leaving now: bus arrives 08:32, drive 08:22, a ride (5 + 22) 08:27.
    const min = 60_000;
    expect(fastestOf({ transit: T0 + 32 * min, drive: T0 + 22 * min, uber: T0 + 27 * min })).toEqual(new Set(['drive']));
    // Uber and Lyft arriving together are both fastest.
    expect(fastestOf({ transit: T0 + 32 * min, uber: T0 + 27 * min, lyft: T0 + 27 * min })).toEqual(new Set(['uber', 'lyft']));
    expect(fastestOf({ uber: T0 })).toEqual(new Set());
  });
});

describe('transit routes', () => {
  const options = parseTransit(transitBody, T0);

  it('lists each line as its own route, soonest arrival first', () => {
    const routes = transitRoutes(options, T0, null, 3, 2);
    expect(routes.map((r) => r.key)).toEqual(['56', 'Blue']);
    expect(transitRoutes(options, T0, null, 1, 2).map((r) => r.key)).toEqual(['56']);
  });

  it('groups departures on the same line, next ones after the shown one', () => {
    const later = parseTransit({ routes: [transitBody.routes[0], transitBody.routes[0]].map((r, i) => ({
      ...r, legs: [{ steps: r.legs[0].steps.map((st) => (st.transitDetails ? { ...st, transitDetails: { ...st.transitDetails,
        stopDetails: { ...st.transitDetails.stopDetails,
          departureTime: new Date(T0 + (9 + i * 8) * 60_000).toISOString(),
          arrivalTime: new Date(T0 + (29 + i * 8) * 60_000).toISOString() } } } : st)) }],
    })) }, T0);
    const [blue] = transitRoutes(later, T0, null, 2, 3);
    expect(blue.key).toBe('Blue');
    expect(blue.main.leaveAt).toBe(T0 + 4 * 60_000);
    expect(blue.next.map((o) => o.leaveAt)).toEqual([T0 + 12 * 60_000]);
  });

  it('drops a departure 90 seconds after its leave time', () => {
    // The 56 says leave at 08:03.
    const leave56 = T0 + 3 * 60_000;
    expect(transitRoutes(options, leave56 + EXPIRE_MS - 1000, null, 3, 2).map((r) => r.key)).toEqual(['56', 'Blue']);
    expect(transitRoutes(options, leave56 + EXPIRE_MS + 1000, null, 3, 2).map((r) => r.key)).toEqual(['Blue']);
  });

  it('asks again once every departure has gone', () => {
    const times = { fetchedAt: T0, transit: { ok: true as const, value: options } };
    expect(transitExhausted(times, T0)).toBe(false);
    expect(transitExhausted(times, T0 + 10 * 60_000)).toBe(true);
  });

  it('picks, for an event, the latest departure that still arrives in time', () => {
    // Arrive by 08:32: the 56 makes it, the Blue Line (08:33) doesn't, but is still listed.
    const routes = transitRoutes(options, T0, T0 + 32 * 60_000, 3, 2);
    expect(routes[0].key).toBe('56');
  });
});

describe('parseLatLon', () => {
  it('reads coordinates and leaves addresses alone', () => {
    expect(parseLatLon('41.9, -87.67')).toEqual({ lat: 41.9, lon: -87.67 });
    expect(parseLatLon('1500 N Milwaukee')).toBeNull();
  });
});
