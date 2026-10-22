// Estimated Uber and Lyft prices, following Ridewise's published method
// (https://getridewise.com/methodology):
//
//   fare = base + per-mile × distance + per-minute × time + booking fee,
//   at least the minimum fare, shown as a range rather than one number.
//
// The rate cards are Ridewise's, downloaded at runtime from their public CSV
// (free to cite with attribution) and kept for a day, so their monthly
// updates arrive on their own and the data isn't copied into this plugin.
//
// Ridewise models surge from historical demand but doesn't publish it. The
// rush-hour adjustment below is this plugin's own rough guess, labeled as
// such wherever it shows.

import type { Fetcher, LatLon } from './providers';
import { milesBetween } from './geo';
import { wallClock } from './schedule';

export const RATES_URL = 'https://getridewise.com/data/ridewise-rate-cards.csv';
const STORAGE_KEY = 'travel-times:rate-cards';
/** Re-download after a day; Ridewise reviews its cards monthly. */
const RATES_TTL_MS = 24 * 3_600_000;
/** Ridewise quotes "typically within 10-15%"; the range spans that. */
const RANGE_LOW = 0.88;
const RANGE_HIGH = 1.12;
export const DEFAULT_REGION = 'US Default';

export interface RateCard {
  region: string;
  provider: 'uber' | 'lyft' | 'taxi' | string;
  service: string;
  base: number;
  perMile: number;
  perMinute: number;
  booking: number;
  minimum: number;
}

export function parseRateCsv(text: string): RateCard[] {
  const lines = text.trim().split(/\r?\n/);
  const header = lines.shift()?.split(',').map((h) => h.trim()) ?? [];
  const col = (name: string) => header.indexOf(name);
  const idx = {
    region: col('region'), provider: col('provider'), service: col('service_type'), base: col('base_fare_usd'),
    perMile: col('per_mile_usd'), perMinute: col('per_minute_usd'), booking: col('booking_fee_usd'),
    minimum: col('minimum_fare_usd'),
  };
  if (Object.values(idx).some((i) => i < 0)) return [];
  const cards: RateCard[] = [];
  for (const line of lines) {
    const f = line.split(',').map((x) => x.trim());
    const n = (i: number) => Number(f[i]);
    const card = {
      region: f[idx.region], provider: f[idx.provider], service: f[idx.service],
      base: n(idx.base), perMile: n(idx.perMile), perMinute: n(idx.perMinute), booking: n(idx.booking), minimum: n(idx.minimum),
    };
    if (card.region && card.service && [card.base, card.perMile, card.perMinute, card.booking, card.minimum].every(Number.isFinite)) {
      cards.push(card);
    }
  }
  return cards;
}

/** Rough centers of Ridewise's regions, for picking the one nearest home. */
export const REGION_CENTERS: Record<string, LatLon> = {
  'Atlanta Metro': { lat: 33.749, lon: -84.388 }, 'Austin Metro': { lat: 30.267, lon: -97.743 },
  'Boston Metro': { lat: 42.360, lon: -71.059 }, 'Charlotte Metro': { lat: 35.227, lon: -80.843 },
  'Chicago Metro': { lat: 41.878, lon: -87.630 }, 'Columbus Metro': { lat: 39.961, lon: -82.999 },
  'DC Metro': { lat: 38.907, lon: -77.037 }, 'Dallas-Fort Worth': { lat: 32.897, lon: -97.040 },
  'Denver Metro': { lat: 39.739, lon: -104.990 }, 'Houston Metro': { lat: 29.760, lon: -95.370 },
  'Indianapolis Metro': { lat: 39.768, lon: -86.158 }, 'LA Metro': { lat: 34.052, lon: -118.244 },
  'Las Vegas Metro': { lat: 36.170, lon: -115.140 }, 'Miami Metro': { lat: 25.762, lon: -80.192 },
  'Minneapolis Metro': { lat: 44.978, lon: -93.265 }, 'NYC Metro': { lat: 40.713, lon: -74.006 },
  'Nashville Metro': { lat: 36.163, lon: -86.781 }, 'New Orleans Metro': { lat: 29.951, lon: -90.072 },
  'Orlando Metro': { lat: 28.538, lon: -81.379 }, 'Philadelphia Metro': { lat: 39.953, lon: -75.165 },
  'Phoenix Metro': { lat: 33.448, lon: -112.074 }, 'Portland Metro': { lat: 45.515, lon: -122.679 },
  'SF Bay Area': { lat: 37.775, lon: -122.419 }, 'San Antonio Metro': { lat: 29.424, lon: -98.494 },
  'San Diego Metro': { lat: 32.716, lon: -117.161 }, 'Seattle Metro': { lat: 47.606, lon: -122.332 },
};

/** A metro this far from home doesn't count as home's; US Default is used. */
const REGION_RADIUS_MILES = 60;

/** The region to price in: the one named in settings, else the nearest
 *  metro within 60 miles of home, else Ridewise's US Default. */
export function pickRegion(cards: RateCard[], home: LatLon | null, setting: string): string {
  const regions = new Set(cards.map((c) => c.region));
  const named = [...regions].find((r) => r.toLowerCase() === setting.trim().toLowerCase());
  if (named) return named;
  if (home) {
    let best: [string, number] | null = null;
    for (const [region, center] of Object.entries(REGION_CENTERS)) {
      if (!regions.has(region)) continue;
      const d = milesBetween(home, center);
      if (d <= REGION_RADIUS_MILES && (!best || d < best[1])) best = [region, d];
    }
    if (best) return best[0];
  }
  return DEFAULT_REGION;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

/** The Ridewise service row for the ride type picked in settings. */
export function serviceFor(provider: 'uber' | 'lyft', rideType: string): string {
  const t = norm(rideType);
  if (provider === 'uber') {
    if (t.includes('comfort')) return 'uber_comfort';
    if (t.includes('black') || t.includes('suv')) return 'uber_black';
    if (t.includes('xl')) return 'uber_xl';
    return 'uberx';
  }
  if (t.includes('lux')) return 'lyft_lux';
  if (t.includes('xl') || t.includes('plus')) return 'lyft_xl';
  return 'lyft';
}

export function findCard(cards: RateCard[], region: string, provider: 'uber' | 'lyft', service: string): RateCard | null {
  return cards.find((c) => c.region === region && c.provider === provider && c.service === service)
    ?? cards.find((c) => c.region === DEFAULT_REGION && c.provider === provider && c.service === service)
    ?? null;
}

// ── Rush hour ───────────────────────────────────────────────────────────────

export interface SurgeSettings {
  rushSurge: boolean;
  /** Price multiplier at the peak of rush hour. */
  rushMultiplier: number;
}

/** Peak windows, in minutes past midnight on the household clock, with a
 *  half-hour shoulder either side at half the extra. */
const WEEKDAY_PEAKS: [number, number][] = [[7 * 60, 9 * 60 + 30], [16 * 60, 19 * 60]];
const SHOULDER = 30;

/**
 * This plugin's own guess at surge, not Ridewise's: weekday rush hours
 * (7:00-9:30 and 16:00-19:00) and Friday/Saturday late nights (22:00-03:00)
 * get the full multiplier, the half hour either side of a weekday rush gets
 * half of it, and everything else none.
 */
export function rushMultiplier(at: Date, timezone: string | undefined, s: SurgeSettings): number {
  if (!s.rushSurge || s.rushMultiplier <= 1) return 1;
  const { day, minutes } = wallClock(at, timezone);
  const extra = s.rushMultiplier - 1;
  // Friday and Saturday nights, including the small hours of the next day.
  const lateNight = ((day === 'fri' || day === 'sat') && minutes >= 22 * 60)
    || ((day === 'sat' || day === 'sun') && minutes < 3 * 60);
  if (lateNight) return s.rushMultiplier;
  if (day === 'sat' || day === 'sun') return 1;
  for (const [from, to] of WEEKDAY_PEAKS) {
    if (minutes >= from && minutes < to) return s.rushMultiplier;
    if (minutes >= from - SHOULDER && minutes < to + SHOULDER) return 1 + extra / 2;
  }
  return 1;
}

// ── The estimate ────────────────────────────────────────────────────────────

export interface FareEstimate {
  low: number;
  high: number;
  /** The multiplier applied for rush hour (1 when none). */
  surge: number;
  region: string;
}

export function estimateFare(card: RateCard, miles: number, minutes: number, surge: number): FareEstimate {
  const metered = card.base + card.perMile * miles + card.perMinute * minutes + card.booking;
  const fare = Math.max(card.minimum, metered) * surge;
  return { low: fare * RANGE_LOW, high: fare * RANGE_HIGH, surge, region: card.region };
}

/** "$16-22", or "$7" when the range rounds to one number. */
export function formatFare(e: FareEstimate): string {
  const lo = Math.round(e.low);
  const hi = Math.round(e.high);
  return lo === hi ? `$${lo}` : `$${lo}–${hi}`;
}

// ── Loading the cards ───────────────────────────────────────────────────────

interface Stored { at: number; text: string }

function readStored(): Stored | null {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}

/**
 * Ridewise's rate cards: from storage when less than a day old, else
 * downloaded. If the download fails, older cards are used rather than none.
 * Null only when there have never been any.
 */
export async function loadRates(fetch: Fetcher, now = Date.now()): Promise<RateCard[] | null> {
  const stored = readStored();
  if (stored && now - stored.at < RATES_TTL_MS) {
    const cards = parseRateCsv(stored.text);
    if (cards.length) return cards;
  }
  try {
    const a = await fetch({ url: RATES_URL, cacheTtlMs: 3_600_000 });
    const text = typeof a.body === 'string' ? a.body : '';
    const cards = a.status === 200 ? parseRateCsv(text) : [];
    if (cards.length) {
      try { window.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ at: now, text })); } catch { /* memory only */ }
      return cards;
    }
  } catch { /* fall through to whatever is stored */ }
  const old = stored ? parseRateCsv(stored.text) : [];
  return old.length ? old : null;
}

// ── Pickup wait ─────────────────────────────────────────────────────────────
//
// Ridewise publishes fares, not how long a car takes to arrive, so the wait
// is this plugin's own estimate, built the same way as its surge guess: a
// typical wait per ride type, more outside the big metros (Ridewise's US
// Default region), more at rush hour and on weekend late nights, and most in
// the small hours when few drivers are out. Shown with "~" like the rest.

/** Typical minutes for a car to arrive in a big metro, off-peak. */
const BASE_WAIT: Record<string, number> = {
  uberx: 5, uber_comfort: 6, uber_xl: 7, uber_black: 9,
  lyft: 5, lyft_xl: 7, lyft_lux: 9,
};

export function pickupWait(service: string, region: string, at: Date, timezone?: string): number {
  let wait = BASE_WAIT[service] ?? 6;
  if (region === DEFAULT_REGION) wait += 3;
  const { day, minutes } = wallClock(at, timezone);
  const weekend = day === 'sat' || day === 'sun';
  const lateNight = ((day === 'fri' || day === 'sat') && minutes >= 22 * 60)
    || ((day === 'sat' || day === 'sun') && minutes < 3 * 60);
  if (lateNight) return wait + 3;
  // 1:00-5:00 on other nights: few drivers about.
  if (minutes >= 60 && minutes < 5 * 60) return wait + 4;
  if (!weekend && WEEKDAY_PEAKS.some(([from, to]) => minutes >= from && minutes < to)) return wait + 2;
  return wait;
}

/** How each Ridewise service is named on a tile. */
export const SERVICE_LABEL: Record<string, string> = {
  uberx: 'UberX', uber_comfort: 'Comfort', uber_xl: 'UberXL', uber_black: 'Black',
  lyft: 'Lyft', lyft_xl: 'Lyft XL', lyft_lux: 'Lux',
};
