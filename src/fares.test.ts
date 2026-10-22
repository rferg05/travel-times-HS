import { describe, expect, it } from 'vitest';
import { estimateFare, findCard, formatFare, medianWait, parseRateCsv, pickRegion, pickupWait, rushMultiplier, SERVICE_LABEL, serviceFor } from './fares';

// The header and Chicago/default UberX rows as Ridewise publishes them.
const CSV = `region,provider,service_type,base_fare_usd,per_mile_usd,per_minute_usd,booking_fee_usd,minimum_fare_usd
Chicago Metro,uber,uberx,1.7,1.35,0.28,2.3,6.75
Chicago Metro,lyft,lyft,1.6,1.3,0.26,2.35,6.5
NYC Metro,uber,uberx,2.55,1.75,0.35,2.75,8.0
US Default,uber,uberx,1.5,1.2,0.22,2.2,6.0
US Default,uber,uber_xl,2.85,2.3,0.4,2.2,9.5
US Default,lyft,lyft,1.4,1.15,0.2,2.25,5.75`;

const cards = parseRateCsv(CSV);
const TZ = 'America/Chicago';
const at = (iso: string) => new Date(iso);

describe('rate cards', () => {
  it('parses the CSV', () => {
    expect(cards).toHaveLength(6);
    expect(cards[0]).toEqual({ region: 'Chicago Metro', provider: 'uber', service: 'uberx', base: 1.7, perMile: 1.35, perMinute: 0.28, booking: 2.3, minimum: 6.75 });
    expect(parseRateCsv('nonsense\n1,2,3')).toEqual([]);
  });

  it('picks the region nearest home, else US Default', () => {
    expect(pickRegion(cards, { lat: 41.90, lon: -87.67 }, '')).toBe('Chicago Metro');
    expect(pickRegion(cards, { lat: 44.5, lon: -89.5 }, '')).toBe('US Default'); // central Wisconsin
    expect(pickRegion(cards, null, '')).toBe('US Default');
    expect(pickRegion(cards, { lat: 41.9, lon: -87.67 }, 'nyc metro')).toBe('NYC Metro');
  });

  it('maps ride types to Ridewise services, falling back to US Default', () => {
    expect(serviceFor('uber', 'UberX')).toBe('uberx');
    expect(serviceFor('uber', 'UberXL')).toBe('uber_xl');
    expect(serviceFor('lyft', 'lyft_plus')).toBe('lyft_xl');
    expect(findCard(cards, 'Chicago Metro', 'uber', 'uber_xl')?.region).toBe('US Default');
  });
});

describe('fare estimate', () => {
  it('follows base + per mile + per minute + booking, as a range', () => {
    const card = findCard(cards, 'Chicago Metro', 'uber', 'uberx')!;
    // 1.70 + 1.35 x 5.5 + 0.28 x 28 + 2.30 = 19.265
    const e = estimateFare(card, 5.5, 28, 1);
    expect(e.low).toBeCloseTo(19.265 * 0.88);
    expect(e.high).toBeCloseTo(19.265 * 1.12);
    expect(formatFare(e)).toBe('$17-$22');
  });

  it('never goes under the minimum fare', () => {
    const card = findCard(cards, 'Chicago Metro', 'uber', 'uberx')!;
    expect(estimateFare(card, 0.2, 2, 1).high).toBeCloseTo(6.75 * 1.12);
  });

  it('applies the surge multiplier', () => {
    const card = findCard(cards, 'Chicago Metro', 'uber', 'uberx')!;
    expect(estimateFare(card, 5.5, 28, 1.25).high).toBeCloseTo(19.265 * 1.25 * 1.12);
  });
});

describe('rush hour guess', () => {
  const s = { rushSurge: true, rushMultiplier: 1.3 };
  it('peaks on weekday rush hours, half on the shoulders', () => {
    expect(rushMultiplier(at('2026-10-21T13:00:00Z'), TZ, s)).toBe(1.3); // Wed 8:00
    expect(rushMultiplier(at('2026-10-21T14:45:00Z'), TZ, s)).toBeCloseTo(1.15); // Wed 9:45
    expect(rushMultiplier(at('2026-10-21T17:00:00Z'), TZ, s)).toBe(1); // Wed noon
    expect(rushMultiplier(at('2026-10-21T22:30:00Z'), TZ, s)).toBe(1.3); // Wed 17:30
  });
  it('covers Friday and Saturday late nights, not weekend days', () => {
    expect(rushMultiplier(at('2026-10-24T04:00:00Z'), TZ, s)).toBe(1.3); // Fri 23:00
    expect(rushMultiplier(at('2026-10-24T06:30:00Z'), TZ, s)).toBe(1.3); // Sat 01:30
    expect(rushMultiplier(at('2026-10-24T13:00:00Z'), TZ, s)).toBe(1); // Sat 8:00
  });
  it('can be turned off', () => {
    expect(rushMultiplier(at('2026-10-21T13:00:00Z'), TZ, { ...s, rushSurge: false })).toBe(1);
  });
});

describe('a tile of several ride types', () => {
  it('takes the median wait', () => {
    expect(medianWait([5])).toBe(5);
    expect(medianWait([5, 9])).toBe(7);
    expect(medianWait([9, 5, 7])).toBe(7);
    expect(medianWait([5, 6, 7, 9])).toBe(7); // (6 + 7) / 2 rounded
  });
});

describe('pickup wait', () => {
  const wed = (hhmm: string) => new Date(`2026-10-21T${hhmm}:00-05:00`);
  it('depends on ride type and region', () => {
    expect(pickupWait('uberx', 'Chicago Metro', wed('12:00'), TZ)).toBe(5);
    expect(pickupWait('uber_black', 'Chicago Metro', wed('12:00'), TZ)).toBe(9);
    expect(pickupWait('uberx', 'US Default', wed('12:00'), TZ)).toBe(8);
  });
  it('is longer at rush hour, late at night and in the small hours', () => {
    expect(pickupWait('uberx', 'Chicago Metro', wed('08:00'), TZ)).toBe(7);
    expect(pickupWait('lyft', 'Chicago Metro', wed('03:00'), TZ)).toBe(9);
    expect(pickupWait('uberx', 'Chicago Metro', new Date('2026-10-24T23:30:00-05:00'), TZ)).toBe(8); // Sat night
  });
  it('labels every service', () => {
    for (const t of ['uberx', 'uber_comfort', 'uber_xl', 'uber_black', 'lyft', 'lyft_xl', 'lyft_lux']) expect(SERVICE_LABEL[t]).toBeTruthy();
  });
});
