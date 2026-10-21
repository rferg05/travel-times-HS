import { describe, expect, it } from 'vitest';
import { readConfig } from './config';
import {
  loadTrip, parseDrive, parseLatLon, parseLyft, parseTransit, parseUberEstimates, parseUberRequestEstimate,
  resetLyftToken, resetUberPath,
} from './providers';
import type { Fetcher, ProxyRequest } from './providers';
import { findPerson, inWindow, isActive, upcomingTrips } from './schedule';
import type { Person } from './schedule';
import { bestTransit, buildTrips, fastest, leaveTimes } from './trips';

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

describe('ride-hail parsers', () => {
  it('picks the configured Uber product', () => {
    const q = parseUberEstimates(
      { prices: [
        { product_id: 'a', display_name: 'UberXL', estimate: '$30-38', duration: 1320 },
        { product_id: 'b', display_name: 'UberX', estimate: '$18-23', duration: 1260 },
      ] },
      { times: [{ product_id: 'b', estimate: 240 }, { product_id: 'a', estimate: 420 }] },
      'uberx',
    );
    expect(q).toEqual({ name: 'UberX', pickupMinutes: 4, rideMinutes: 21, price: '$18-23' });
  });

  it('reads a request estimate', () => {
    expect(parseUberRequestEstimate(
      { fare: { display: '$21.40' }, trip: { duration_estimate: 1200 }, pickup_estimate: 3 }, 'UberX',
    )).toEqual({ name: 'UberX', pickupMinutes: 3, rideMinutes: 20, price: '$21.40' });
  });

  it('reads Lyft cost and eta', () => {
    const q = parseLyft(
      { cost_estimates: [{ ride_type: 'lyft', display_name: 'Lyft', estimated_cost_cents_min: 1700, estimated_cost_cents_max: 2200, estimated_duration_seconds: 1250, currency: 'USD', is_valid_estimate: true }] },
      { eta_estimates: [{ ride_type: 'lyft', display_name: 'Lyft', eta_seconds: 360 }] },
      'lyft',
    );
    expect(q).toMatchObject({ name: 'Lyft', pickupMinutes: 6, rideMinutes: 21 });
    expect(q?.price).toMatch(/^\$17-22$/);
  });
});

describe('schedule', () => {
  it('handles windows that wrap midnight', () => {
    expect(inWindow(23 * 60, '22:00', '02:00')).toBe(true);
    expect(inWindow(60, '22:00', '02:00')).toBe(true);
    expect(inWindow(12 * 60, '22:00', '02:00')).toBe(false);
    expect(inWindow(12 * 60, '', '')).toBe(true);
  });

  const base = { label: 'Work', person: '', origin: 'a', destination: 'b', days: [], activeFrom: '', activeTo: '' };

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
    // Arrive five minutes early by default; rideshare only within 3 hours.
    expect(trips[1].arriveBy).toBe(T0 + 115 * 60_000);
    expect(trips[1].request.uber).toBe(true);
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
          : { status: 200, body: { routes: [{ duration: '1320s', staticDuration: '1200s', legs: [{ startLocation: { latLng: { latitude: 41.9, longitude: -87.67 } }, endLocation: { latLng: { latitude: 41.88, longitude: -87.63 } } }] }] } };
      }
      if (req.url.includes('/estimates/price')) return { status: 401, body: { message: 'unauthorized' } };
      if (req.url.includes('/products')) return { status: 200, body: { products: [{ product_id: 'x', display_name: 'UberX' }] } };
      if (req.url.includes('/requests/estimate')) return { status: 200, body: { fare: { display: '$20' }, trip: { duration_estimate: 1260 }, pickup_estimate: 4 } };
      if (req.url.includes('/oauth/token')) return { status: 500, body: { error: 'Request failed', detail: 'Secret "lyft_basic_auth" is not configured for plugin "travel-times"' } };
      return { status: 404, body: {} };
    };
  }

  it('falls back to request estimates for Uber and reports Lyft as not set up', async () => {
    resetUberPath();
    resetLyftToken();
    (globalThis as { window?: unknown }).window = { __HS_SDK__: { getAuthStatus: async () => ({ connected: true }) } };
    const log: ProxyRequest[] = [];
    const times = await loadTrip(mockFetcher(log), {
      origin: 'a', destination: 'b', arriveBy: null, transit: true, drive: true, uber: true, lyft: true,
      uberProduct: 'UberX', lyftRideType: 'lyft',
    }, T0);
    expect(times.transit?.ok).toBe(true);
    expect(times.drive).toEqual({ ok: true, value: expect.objectContaining({ minutes: 22, delayMinutes: 2 }) });
    expect(times.uber).toEqual({ ok: true, value: { name: 'UberX', pickupMinutes: 4, rideMinutes: 21, price: '$20' } });
    expect(times.lyft).toEqual({ ok: false, reason: 'notConnected' });
    expect(log.find((r) => r.url.includes('computeRoutes'))?.secretInjections?.header?.['X-Goog-Api-Key']).toBe('{{google_maps_key}}');
    // Leaving now: bus arrives 08:32, drive 08:22, Uber 08:25.
    expect(fastest(times, T0)).toBe('drive');
  });
});

describe('leave times for events', () => {
  it('leaves as late as still arrives in time', () => {
    const options = parseTransit(transitBody, T0);
    // Arrive by 08:32: only the bus makes it.
    expect(bestTransit(options, T0 + 32 * 60_000)?.lines[0].name).toBe('56');
    // Arrive by 08:40: both do; the train leaves later.
    expect(bestTransit(options, T0 + 40 * 60_000)?.lines[0].name).toBe('Blue');
  });

  it('counts back from the arrive-by time', () => {
    const trip = { arriveBy: T0 + 60 * 60_000 } as Parameters<typeof leaveTimes>[0];
    const leave = leaveTimes(trip, {
      fetchedAt: T0,
      drive: { ok: true, value: { minutes: 20, delayMinutes: 0, start: null, end: null } },
      uber: { ok: true, value: { name: 'UberX', pickupMinutes: 5, rideMinutes: null, price: null } },
    });
    expect(leave.drive).toBe(T0 + 40 * 60_000);
    // No ride length from Uber: the drive time stands in.
    expect(leave.uber).toBe(T0 + 35 * 60_000);
  });
});

describe('parseLatLon', () => {
  it('reads coordinates and leaves addresses alone', () => {
    expect(parseLatLon('41.9, -87.67')).toEqual({ lat: 41.9, lon: -87.67 });
    expect(parseLatLon('1500 N Milwaukee')).toBeNull();
  });
});
