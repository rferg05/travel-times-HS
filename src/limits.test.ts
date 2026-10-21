import { describe, expect, it } from 'vitest';
import { milesBetween, parseNominatim } from './geo';
import type { Fetcher, ProxyRequest, TripRequest, TripTimes } from './providers';
import { loadDrive } from './providers';
import { googleCost, isDue } from './trips';
import type { Trip } from './trips';
import { cappedFetcher, currentUsage, monthKey } from './usage';
import type { Usage, UsageStore } from './usage';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-10-21T13:00:00Z');
const TZ = 'America/Chicago';

function memoryStore(start: Usage | null = null): UsageStore & { value: Usage | null } {
  const s = { value: start, load: () => s.value, save: (u: Usage) => { s.value = u; } };
  return s;
}

const okFetcher = (log: ProxyRequest[]): Fetcher => async (req) => {
  log.push(req);
  return { status: 200, body: { routes: [{ duration: '600s', staticDuration: '600s', legs: [{}] }] } };
};

describe('monthly Google cap', () => {
  const settings = () => ({ monthlyCap: 3, alertPercent: 80 });

  it('counts Google requests and refuses past the cap', async () => {
    const store = memoryStore();
    const sent: ProxyRequest[] = [];
    const f = cappedFetcher(okFetcher(sent), settings, { store, now: () => new Date(T0), timezone: () => TZ });
    for (let i = 0; i < 3; i++) expect((await loadDrive(f, 'a', 'b')).ok).toBe(true);
    const refused = await loadDrive(f, 'a', 'b');
    expect(refused).toEqual({ ok: false, reason: 'capped' });
    expect(sent).toHaveLength(3);
    expect(store.value).toMatchObject({ month: '2026-10', count: 3, alerted: true, capped: true });
  });

  it("doesn't count other services", async () => {
    const store = memoryStore();
    const f = cappedFetcher(okFetcher([]), settings, { store, now: () => new Date(T0) });
    await f({ url: 'https://nominatim.openstreetmap.org/search?q=x' });
    await f({ url: 'https://api.lyft.com/v1/eta' });
    expect(store.value).toBeNull();
  });

  it('starts over each calendar month, in the household time zone', () => {
    const store = memoryStore({ month: '2026-10', count: 9_999, alerted: true, capped: false });
    // 11:30 pm Oct 31 in Chicago is already November in UTC.
    const lateOct = new Date('2026-11-01T04:30:00Z');
    expect(monthKey(lateOct, TZ)).toBe('2026-10');
    expect(currentUsage(store, lateOct, TZ).count).toBe(9_999);
    expect(currentUsage(store, new Date('2026-11-01T06:00:00Z'), TZ)).toEqual(
      { month: '2026-11', count: 0, alerted: false, capped: false },
    );
  });
});

describe('when trips are looked up', () => {
  const req = { transit: true, drive: true, rideshare: true, uber: false, lyft: false } as TripRequest;
  const route = { kind: 'route', startsAt: null, destination: 'Office', request: req } as Trip;
  const event = (startsInMs: number) =>
    ({ kind: 'event', startsAt: T0 + startsInMs, destination: 'Clinic', request: req }) as Trip;
  const at = (agoMs: number, failed = false): TripTimes => ({
    fetchedAt: T0 - agoMs,
    drive: failed ? { ok: false, reason: 'unavailable' } : { ok: true, value: { minutes: 10, delayMinutes: 0, start: null, end: null } },
  });
  const opts = (milesFromHome?: number | null) => ({ refreshMs: 11 * MIN, retryMs: 2 * MIN, milesFromHome });

  it('refreshes routes on the set interval, not one wake-up late', () => {
    expect(isDue(route, undefined, T0, opts())).toBe(true);
    expect(isDue(route, at(10 * MIN), T0, opts())).toBe(false);
    // The once-a-minute loop sees it a few seconds short of 11 minutes.
    expect(isDue(route, at(11 * MIN - 3_000), T0, opts())).toBe(true);
    expect(isDue(route, at(3 * MIN, true), T0, opts())).toBe(true);
  });

  it('leaves a nearby event alone until 3 hours before', () => {
    expect(isDue(event(3 * HOUR + MIN), undefined, T0, opts(12))).toBe(false);
    expect(isDue(event(3 * HOUR - MIN), undefined, T0, opts(12))).toBe(true);
  });

  it('looks once in the 3-hour window, then waits for 90 minutes', () => {
    // Looked at 2h59m before; now 2h before: no more until 90 minutes out.
    const e = event(2 * HOUR);
    expect(isDue(e, at(59 * MIN), T0, opts(12))).toBe(false);
    // A failed look is retried.
    expect(isDue(e, at(3 * MIN, true), T0, opts(12))).toBe(true);
    // An answer from before the window (e.g. a far-away guess) doesn't count.
    expect(isDue(e, at(70 * MIN), T0, opts(12))).toBe(true);
  });

  it('refreshes on the normal cadence inside 90 minutes', () => {
    const e = event(89 * MIN);
    expect(isDue(e, at(91 * MIN), T0, opts(12))).toBe(true);
    expect(isDue(e, at(5 * MIN), T0, opts(12))).toBe(false);
    expect(isDue(e, at(11 * MIN), T0, opts(12))).toBe(true);
  });

  it('treats unknown distance as nearby, and far events like routes', () => {
    expect(isDue(event(6 * HOUR), undefined, T0, opts(null))).toBe(false);
    expect(isDue(event(6 * HOUR), undefined, T0, opts(undefined))).toBe(false);
    expect(isDue(event(6 * HOUR), undefined, T0, opts(50))).toBe(true);
    expect(isDue(event(6 * HOUR), at(5 * MIN), T0, opts(120))).toBe(false);
  });

  it('knows what a lookup costs', () => {
    expect(googleCost(req)).toBe(2);
    expect(googleCost({ ...req, transit: false })).toBe(1);
    expect(googleCost({ ...req, drive: false, rideshare: false })).toBe(1);
  });
});

describe('geocoding', () => {
  it('reads Nominatim answers', () => {
    expect(parseNominatim([{ lat: '41.88', lon: '-87.63' }])).toEqual({ lat: 41.88, lon: -87.63 });
    expect(parseNominatim([])).toBeNull();
  });

  it('measures straight-line miles', () => {
    // Chicago Loop to Milwaukee downtown: about 82 miles.
    const d = milesBetween({ lat: 41.8786, lon: -87.6359 }, { lat: 43.0389, lon: -87.9065 });
    expect(d).toBeGreaterThan(78);
    expect(d).toBeLessThan(85);
  });
});
