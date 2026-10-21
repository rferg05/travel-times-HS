// How far an event is from home, without spending Google requests.
//
// Event locations are placed with OpenStreetMap's Nominatim geocoder, which
// is free but asks for light use (at most one request a second, and caching).
// Answers are kept in localStorage for a month, so a recurring event's address
// is looked up once. Distances are straight-line, which is all a 50-mile
// threshold needs.

import type { Fetcher, LatLon } from './providers';
import { parseLatLon } from './providers';

const STORAGE_KEY = 'travel-times:geocode';
const FOUND_TTL_MS = 30 * 24 * 3_600_000;
/** A place Nominatim couldn't find is asked about again the next day. */
const MISSING_TTL_MS = 24 * 3_600_000;
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

type Entry = { at: number; ll: LatLon | null };

let memory: Record<string, Entry> = {};

function loadAll(): Record<string, Entry> {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Record<string, Entry>;
  } catch { /* blocked or corrupt */ }
  return memory;
}

function saveAll(all: Record<string, Entry>): void {
  memory = all;
  try { window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(all)); } catch { /* memory only */ }
}

const norm = (place: string) => place.trim().toLowerCase().replace(/\s+/g, ' ');

/** A cached answer: coordinates, null for "not found", undefined for "never asked or expired". */
export function cachedPlace(place: string, now = Date.now()): LatLon | null | undefined {
  const direct = parseLatLon(place);
  if (direct) return direct;
  const e = loadAll()[norm(place)];
  if (!e) return undefined;
  const ttl = e.ll ? FOUND_TTL_MS : MISSING_TTL_MS;
  return now - e.at < ttl ? e.ll : undefined;
}

export function parseNominatim(body: unknown): LatLon | null {
  const first = Array.isArray(body) ? (body[0] as { lat?: string; lon?: string } | undefined) : undefined;
  const lat = Number(first?.lat);
  const lon = Number(first?.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

/** Look a place up, from the cache when possible. Null when it can't be placed. */
export async function geocode(fetch: Fetcher, place: string): Promise<LatLon | null> {
  const hit = cachedPlace(place);
  if (hit !== undefined) return hit;
  const a = await fetch({
    url: `${NOMINATIM}?format=jsonv2&limit=1&q=${encodeURIComponent(place.trim())}`,
    headers: { 'User-Agent': 'travel-times-home-screens/1.2 (https://github.com/rferg05/travel-times-HS)' },
    cacheTtlMs: 3_600_000,
  });
  // A failed request isn't remembered as "not found": it's asked again next time.
  if (a.status !== 200) return null;
  const ll = parseNominatim(a.body);
  const all = loadAll();
  all[norm(place)] = { at: Date.now(), ll };
  saveAll(all);
  return ll;
}

/** Straight-line distance in miles. */
export function milesBetween(a: LatLon, b: LatLon): number {
  const R = 3958.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
