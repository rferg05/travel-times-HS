import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { PluginComponentProps } from './hs-plugin';
import { hostFrameStyle } from './host-style';
import { useFitFontSize } from './fit';
import { readConfig } from './config';
import type { Config } from './config';
import { hostFetcher, loadTrip } from './providers';
import { geocode, milesBetween } from './geo';
import { alertLevel, browserStore, cappedFetcher, currentUsage, remaining } from './usage';
import type { Fetcher, LatLon, Mode, Reason, TransitLine, TransitOption, TripTimes } from './providers';
import { estimateFare, findCard, formatFare, loadRates, pickRegion, rushMultiplier, serviceFor } from './fares';
import type { RateCard } from './fares';
import { isQuiet } from './schedule';
import type { CalendarEvent, Person } from './schedule';
import {
  bestTransit, buildTrips, fastest, FIRST_LOOK_MS, googleCost, isDue, leaveTimes, NEARBY_MILES, rideFor,
} from './trips';
import type { ModeName, Trip } from './trips';

/** Countdowns and which routes are showing are re-read this often. */
const CLOCK_TICK_MS = 30_000;
/** A failed lookup is tried again sooner than a good one is refreshed. */
const RETRY_MS = 2 * 60_000;
/** Leaving within this long turns a "leave by" time amber. */
const SOON_MS = 10 * 60_000;

const ACCENT = '#38bdf8';
const AMBER = '#f59e0b';
const RED = '#f87171';
const GREEN = '#4ade80';

const REASON_TEXT: Record<Reason, string> = {
  notConnected: 'not set up',
  reconnect: 'reconnect Uber',
  notApproved: 'Uber access pending',
  badKey: 'key refused',
  notFound: 'no route found',
  noService: 'none available',
  capped: 'monthly limit',
  unavailable: 'no answer',
};

// ── Data ────────────────────────────────────────────────────────────────────

const cacheKey = (key: string) => `travel-times:${key}`;
/** Kept long enough to cover a nearby event's wait between its 3-hour look
 *  and the 90-minute mark, so a screen rotating back in doesn't look again. */
const CACHE_TTL_MS = 4 * 3_600_000;
/** Addresses typed in the editor are looked up once they stop changing for this long. */
const TYPING_SETTLE_MS = 2000;

function readCache(key: string): TripTimes | undefined {
  try {
    const hit = window.__HS_SDK__?.displayCache?.get<TripTimes>(cacheKey(key));
    return hit?.data ?? undefined;
  } catch {
    return undefined;
  }
}

function writeCache(key: string, value: TripTimes): void {
  try { window.__HS_SDK__?.displayCache?.set(cacheKey(key), value, CACHE_TTL_MS); } catch { /* preview without host */ }
}

/** `value`, once it has stopped changing for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

/**
 * Home's coordinates: the household location from Settings when the host
 * provides it, else the module's home address, placed with the geocoder.
 */
function useHome(fetcher: Fetcher, address: string, lat?: number, lon?: number): LatLon | null {
  const settledAddress = useSettled(address, TYPING_SETTLE_MS);
  const [placed, setPlaced] = useState<LatLon | null>(null);
  const fromHost = typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon);
  useEffect(() => {
    if (fromHost || !settledAddress) return;
    let cancelled = false;
    geocode(fetcher, settledAddress).then((ll) => { if (!cancelled) setPlaced(ll); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [fromHost, settledAddress, fetcher]);
  return useMemo(() => (fromHost ? { lat: lat!, lon: lon! } : placed), [fromHost, lat, lon, placed]);
}

/**
 * Straight-line miles from home to each event's location, keyed by location:
 * a number, null when the event's place can't be found, absent while unknown.
 */
function useEventDistances(trips: Trip[], fetcher: Fetcher, home: LatLon | null) {
  const [miles, setMiles] = useState<Record<string, number | null>>({});
  const places = [...new Set(trips.filter((t) => t.kind === 'event').map((t) => t.destination))].sort().join('\n');
  const homeKey = home ? `${home.lat},${home.lon}` : '';

  useEffect(() => {
    if (!places || !homeKey) return;
    let cancelled = false;
    (async () => {
      const [lat, lon] = homeKey.split(',').map(Number);
      for (const place of places.split('\n')) {
        if (cancelled) return;
        const to = await geocode(fetcher, place).catch(() => null);
        if (cancelled) return;
        setMiles((m) => ({ ...m, [place]: to ? milesBetween({ lat, lon }, to) : null }));
      }
    })();
    return () => { cancelled = true; };
  }, [places, homeKey, fetcher]);

  return miles;
}

/**
 * Times for every trip, each looked up when `isDue` says (see trips.ts),
 * paused during quiet hours and once the month's Google cap is used up.
 * Answers are kept in the host's display cache, so a screen rotating back in
 * shows them at once instead of asking Google again.
 */
function useTripTimes(
  trips: Trip[],
  config: Config,
  timezone: string | undefined,
  fetcher: Fetcher,
  miles: Record<string, number | null>,
) {
  const [times, setTimes] = useState<Record<string, TripTimes>>(() => {
    const out: Record<string, TripTimes> = {};
    for (const t of trips) {
      const hit = readCache(t.key);
      if (hit) out[t.key] = hit;
    }
    return out;
  });
  const [usage, setUsage] = useState(() => currentUsage(browserStore, new Date(), timezone));
  const [poll, setPoll] = useState(0);
  // Updated as lookups land, ahead of React state.
  const timesRef = useRef(times);
  const tripsRef = useRef(trips);
  tripsRef.current = trips;
  const milesRef = useRef(miles);
  milesRef.current = miles;
  const keys = trips.map((t) => t.key).join('\n');
  // While an address is being typed in the editor, every keystroke is a new
  // trip; only the one it settles on is looked up.
  const settledKeys = useSettled(keys, TYPING_SETTLE_MS);
  const refreshMs = config.refreshMinutes * 60_000;
  const distancesKnown = Object.keys(miles).length;

  useEffect(() => {
    const id = setInterval(() => setPoll((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // One pass over the trips at a time. A change while a pass is running (a
  // distance arriving, the minute ticking over) asks for another pass rather
  // than cancelling this one, so a lookup that already went out is never
  // thrown away and asked for again.
  const running = useRef(false);
  const again = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    if (settledKeys !== keys) return;
    if (running.current) { again.current = true; return; }
    running.current = true;
    (async () => {
      do {
        again.current = false;
        const quiet = isQuiet(config, new Date(), timezone);
        setUsage(currentUsage(browserStore, new Date(), timezone));
        for (const trip of tripsRef.current) {
          if (!mounted.current) return;
          const have = timesRef.current[trip.key] ?? readCache(trip.key);
          if (have && !timesRef.current[trip.key]) {
            timesRef.current = { ...timesRef.current, [trip.key]: have };
            setTimes((s) => ({ ...s, [trip.key]: have }));
          }
          const due = isDue(trip, have, Date.now(), {
            refreshMs, retryMs: RETRY_MS, milesFromHome: milesRef.current[trip.destination],
          });
          if (!due) continue;
          // Overnight, keep showing what we have; only a trip with nothing yet is looked up.
          if (quiet && have) continue;
          // Whole trips only: half a lookup would replace good times with a gap.
          if (remaining(browserStore, config, new Date(), timezone) < googleCost(trip.request)) continue;
          const fresh = await loadTrip(fetcher, trip.request);
          writeCache(trip.key, fresh);
          // Straight into the ref too, so a second pass sees it before React re-renders.
          timesRef.current = { ...timesRef.current, [trip.key]: fresh };
          if (!mounted.current) return;
          setTimes((s) => ({ ...s, [trip.key]: fresh }));
          setUsage(currentUsage(browserStore, new Date(), timezone));
        }
      } while (again.current && mounted.current);
    })().finally(() => { running.current = false; });
    // Trips and distances are read through refs; `settledKeys` and
    // `distancesKnown` say when they changed in a way that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledKeys, keys, poll, distancesKnown, refreshMs, config.quietFrom, config.quietTo,
    config.monthlyCap, timezone, fetcher]);

  return { times, usage };
}

// ── Formatting ──────────────────────────────────────────────────────────────

function clockFormatter(config: Config, hostFormat: '12h' | '24h' | undefined, timezone?: string) {
  const fmt = config.timeFormat === 'auto' ? hostFormat : config.timeFormat;
  let f: Intl.DateTimeFormat;
  try {
    f = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric', minute: '2-digit', timeZone: timezone || undefined,
      ...(fmt ? { hour12: fmt === '12h' } : {}),
    });
  } catch {
    f = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  // "8:04 AM" reads fine as "8:04a" on a tile and saves room.
  return (ms: number) => f.format(new Date(ms)).replace(/\s?([AaPp])\.?\s?[Mm]\.?$/, (_m, ap: string) => ap.toLowerCase());
}

function minutesText(n: number): string {
  if (n < 60) return `${n}`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

function shortPlace(place: string): string {
  return place.split(',')[0].trim();
}

// ── Logos ───────────────────────────────────────────────────────────────────
//
// Drawn here rather than shipped as image files: the CTA's roundel (blue disc,
// red ring, white "cta"), and the Uber and Lyft wordmarks as their brand-color
// badges. Sized in em, so they follow the module's text size.

function CtaLogo() {
  return (
    <svg viewBox="0 0 100 100" height="1.35em" width="1.35em" aria-label="CTA" role="img" style={{ flexShrink: 0 }}>
      <circle cx="50" cy="50" r="50" fill="#ffffff" />
      <circle cx="50" cy="50" r="47.5" fill="#d31145" />
      <circle cx="50" cy="50" r="44.5" fill="#ffffff" />
      <circle cx="50" cy="50" r="42.5" fill="#0078c1" />
      <text x="50" y="62" textAnchor="middle" fill="#ffffff" fontFamily="Helvetica, Arial, sans-serif" fontWeight="700"
        fontSize="36" letterSpacing="-1">cta</text>
    </svg>
  );
}

function Wordmark({ text, bg, fg, label, weight }: { text: string; bg: string; fg: string; label: string; weight: number }) {
  return (
    <span role="img" aria-label={label} style={{
      display: 'inline-flex', alignItems: 'center', height: '1.35em', padding: '0 0.4em', borderRadius: '0.3em',
      background: bg, color: fg, fontWeight: weight, fontSize: '1em', letterSpacing: '-0.02em', lineHeight: 1,
      flexShrink: 0, fontFamily: 'Helvetica, Arial, sans-serif',
    }}>
      {text}
    </span>
  );
}

const UberLogo = () => <Wordmark text="Uber" bg="#000000" fg="#ffffff" label="Uber" weight={500} />;
const LyftLogo = () => <Wordmark text="lyft" bg="#ff00bf" fg="#ffffff" label="Lyft" weight={800} />;

function GlyphIcon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="1.35em" height="1.35em" fill="currentColor" aria-hidden style={{ flexShrink: 0 }}>
      <path d={d} />
    </svg>
  );
}

const TRAIN_PATH = 'M7 3h10a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3l1.5 2.5h-2.3L14.7 18H9.3l-1.5 2.5H5.5L7 18a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Zm-1 4v4h12V7H6Zm2 7.5a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Zm8 0a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z';
const CAR_PATH = 'M6.5 5h11l2.5 6.2V19h-2.5v-2h-11v2H4v-7.8L6.5 5Zm1.3 2-1.6 4h11.6l-1.6-4H7.8ZM7.5 13a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm9 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z';

const isCta = (agency?: string) => !!agency && /chicago transit|^cta\b/i.test(agency);

/** A tile's header: the operator's logo, or an icon and a word where there is no brand. */
function ModeMark({ mode, agency }: { mode: ModeName; agency?: string }) {
  const word: CSSProperties = { fontWeight: 650 };
  if (mode === 'uber') return <UberLogo />;
  if (mode === 'lyft') return <LyftLogo />;
  if (mode === 'drive') return <><GlyphIcon d={CAR_PATH} /><span style={word}>Drive</span></>;
  if (isCta(agency)) return <CtaLogo />;
  return <><GlyphIcon d={TRAIN_PATH} /><span style={word}>{agency ? agency.split(/\s+/)[0] : 'Transit'}</span></>;
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function LineChip({ line }: { line: TransitLine }) {
  const bg = line.color ?? 'rgba(255,255,255,0.18)';
  return (
    <span style={{
      display: 'inline-block', padding: '0.05em 0.4em', borderRadius: '0.35em', fontWeight: 700,
      background: bg, color: line.textColor ?? '#fff', lineHeight: 1.3, whiteSpace: 'nowrap',
    }}>
      {line.name}
    </span>
  );
}

const firstName = (name: string) => name.trim().split(/\s+/)[0];

/** The rider's color as a solid disc with their initial: readable as "whose"
 *  from across the room before any name is. */
function Avatar({ person }: { person: { name: string; color: string } }) {
  return (
    <span aria-label={person.name} style={{
      width: '1.7em', height: '1.7em', borderRadius: '50%', background: person.color, flexShrink: 0,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      color: '#fff', fontWeight: 800, textShadow: '0 1px 2px rgba(0,0,0,0.45)',
      boxShadow: '0 0 0 0.12em rgba(255,255,255,0.85)',
    }}>
      {firstName(person.name).charAt(0).toUpperCase()}
    </span>
  );
}

function PersonTag({ people }: { people: { name: string; color: string }[] }) {
  if (!people.length) return null;
  return (
    <span style={{ display: 'inline-flex', gap: '0.3em', flexShrink: 0 }}>
      {people.map((p) => (
        <span key={p.name} style={{
          padding: '0.15em 0.6em', borderRadius: '1em', fontSize: '0.85em', fontWeight: 700,
          background: p.color, color: '#fff', textShadow: '0 1px 2px rgba(0,0,0,0.4)',
        }}>
          {firstName(p.name)}
        </span>
      ))}
    </span>
  );
}

interface TileProps {
  mode: ModeName;
  agency?: string;
  big: string | null;
  estimated?: boolean;
  sub: ReactNode;
  highlight?: boolean;
  tone?: string;
}

function Tile({ mode, agency, big, estimated, sub, highlight, tone }: TileProps) {
  const style: CSSProperties = {
    flex: '1 1 0', minWidth: '6.6em', display: 'flex', flexDirection: 'column', gap: '0.15em',
    padding: '0.4em 0.55em', borderRadius: '0.55em', position: 'relative',
    background: highlight ? 'rgba(56, 189, 248, 0.18)' : 'rgba(0,0,0,0.28)',
    border: `0.1em solid ${highlight ? ACCENT : 'rgba(255,255,255,0.10)'}`,
  };
  // Logo and time share a row, so the time can be large without the tile
  // growing tall; the details sit underneath.
  return (
    <div style={style}>
      {highlight && (
        <span style={{
          position: 'absolute', top: '-0.55em', right: '0.5em', fontSize: '0.62em', fontWeight: 800, letterSpacing: '0.04em',
          padding: '0.05em 0.45em', borderRadius: '0.4em', background: ACCENT, color: '#04263a', textTransform: 'uppercase',
        }}>
          fastest
        </span>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4em', minWidth: 0 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3em', fontSize: '0.85em', flexShrink: 0 }}>
          <ModeMark mode={mode} agency={agency} />
        </span>
        {big === null ? (
          <span style={{ fontSize: '1.6em', fontWeight: 700, opacity: 0.35, lineHeight: 1 }}>—</span>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: '0.15em', whiteSpace: 'nowrap' }}>
            <span style={{ fontSize: '1.6em', fontWeight: 750, lineHeight: 1, fontVariantNumeric: 'tabular-nums', color: tone }}>
              {estimated ? '~' : ''}{big}
            </span>
            <span style={{ fontSize: '0.75em', opacity: 0.7 }}>min</span>
          </span>
        )}
      </div>
      <div style={{
        fontSize: '0.86em', opacity: 0.9, lineHeight: 1.3, minHeight: '1.3em',
        display: 'flex', flexWrap: 'wrap', columnGap: '0.35em', alignItems: 'center',
      }}>
        {sub}
      </div>
    </div>
  );
}

function failText(m: Mode<unknown> | undefined): string {
  return !m ? 'loading…' : m.ok ? '' : REASON_TEXT[m.reason];
}

function leaveNote(at: number | undefined, now: number, clock: (ms: number) => string): { text: string; tone?: string } | null {
  if (at === undefined) return null;
  if (at < now - 60_000) return { text: 'too late', tone: RED };
  if (at <= now + 60_000) return { text: 'leave now', tone: AMBER };
  return { text: `leave ${clock(at)}`, tone: at - now <= SOON_MS ? AMBER : undefined };
}

interface Pricing {
  cards: RateCard[] | null;
  region: string;
  timezone?: string;
}

interface TileCommon {
  trip: Trip;
  times: TripTimes | undefined;
  config: Config;
  now: number;
  clock: (ms: number) => string;
  pricing: Pricing;
  highlight?: boolean;
}

function TransitTile({ trip, times, config, now, clock, highlight, leave }: TileCommon & { leave?: number }) {
  const m = times?.transit;
  if (!m || !m.ok) return <Tile mode="transit" big={null} sub={failText(m)} />;
  const best = bestTransit(m.value, trip.arriveBy) as TransitOption;
  const others = m.value.filter((o) => o !== best && o.leaveAt !== null && o.leaveAt > now)
    .slice(0, config.transitOptions - 1);
  const note = trip.kind === 'event'
    ? leaveNote(leave, now, clock)
    : best.leaveAt !== null ? leaveNote(best.leaveAt, now, clock) : null;
  const lines = best.lines.slice(0, 3);
  return (
    <Tile
      mode="transit"
      agency={best.lines.find((l) => l.agency)?.agency}
      big={minutesText(best.minutes)}
      highlight={highlight}
      tone={note?.tone}
      sub={(
        <>
          {lines.map((l, i) => <LineChip key={i} line={l} />)}
          {!lines.length && <span>walk</span>}
          {note && <span style={{ color: note.tone }}>{note.text}</span>}
          {others.length > 0 && <span style={{ opacity: 0.75 }}>· then {others.map((o) => clock(o.leaveAt!)).join(', ')}</span>}
        </>
      )}
    />
  );
}

/** Uber or Lyft: the live quote when there is one, else the estimate. */
function RideTile({ mode, trip, times, config, now, clock, pricing, highlight, leave }: TileCommon & {
  mode: 'uber' | 'lyft';
  leave?: number;
}) {
  const ride = rideFor(mode, trip.request, times);
  if (!ride || ride.minutes === null) {
    // Nothing to show: say why, preferring the live service's reason when it's the only source.
    const live = trip.request[mode] ? times?.[mode] : undefined;
    const reason = live && !live.ok && !trip.request.rideshare ? live : times?.drive;
    return <Tile mode={mode} big={null} sub={failText(reason)} />;
  }
  const note = trip.kind === 'event' ? leaveNote(leave, now, clock) : null;
  let detail: ReactNode;
  if (ride.live) {
    const q = ride.live;
    detail = <span>{[q.price, q.pickupMinutes !== null ? `car ${q.pickupMinutes}m` : null].filter(Boolean).join(' · ') || q.name}</span>;
  } else {
    // Priced for when the car would be called: now, or the leave time for an event.
    const drive = times?.drive?.ok ? times.drive.value : null;
    const at = trip.kind === 'event' && leave !== undefined ? Math.max(now, leave) : now;
    const surge = rushMultiplier(new Date(at), pricing.timezone, config);
    const service = serviceFor(mode, mode === 'uber' ? config.uberProduct : config.lyftRideType);
    const card = pricing.cards ? findCard(pricing.cards, pricing.region, mode, service) : null;
    const fare = card && drive?.miles ? estimateFare(card, drive.miles, drive.minutes, surge) : null;
    detail = (
      <>
        <span style={{ fontWeight: 650 }}>{fare ? formatFare(fare) : 'price n/a'}</span>
        {surge > 1 && <span style={{ color: AMBER, fontWeight: 650 }}>rush ×{Number(surge.toFixed(2))}</span>}
      </>
    );
  }
  return (
    <Tile
      mode={mode}
      big={minutesText(ride.minutes)}
      estimated={ride.estimated}
      highlight={highlight}
      tone={note?.tone}
      sub={(
        <>
          {detail}
          {note && <span style={{ color: note.tone }}>{note.text}</span>}
        </>
      )}
    />
  );
}

function DriveTile({ trip, times, now, clock, highlight, leave }: TileCommon & { leave?: number }) {
  const m = times?.drive;
  if (!m || !m.ok) return <Tile mode="drive" big={null} sub={failText(m)} />;
  const d = m.value;
  const note = trip.kind === 'event' ? leaveNote(leave, now, clock) : null;
  return (
    <Tile
      mode="drive"
      big={minutesText(d.minutes)}
      highlight={highlight}
      tone={note?.tone}
      sub={(
        <>
          <span style={{ color: d.delayMinutes >= 10 ? RED : d.delayMinutes >= 4 ? AMBER : GREEN }}>
            {d.delayMinutes > 0 ? `+${d.delayMinutes} traffic` : 'clear'}
          </span>
          {note && <span style={{ color: note.tone }}>{note.text}</span>}
        </>
      )}
    />
  );
}

/** The card's own colors: its rider's, a stripe per rider when an event is
 *  several people's, neutral when it's nobody's in particular. */
export function cardColors(people: { color: string }[]): { bar: string; tint: string; border: string } {
  if (!people.length) {
    return { bar: 'rgba(255,255,255,0.35)', tint: 'rgba(255,255,255,0.05)', border: 'rgba(255,255,255,0.12)' };
  }
  const c = people[0].color;
  const n = people.length;
  const bar = n === 1
    ? c
    : `linear-gradient(to bottom, ${people.map((p, i) => `${p.color} ${(i / n) * 100}% ${((i + 1) / n) * 100}%`).join(', ')})`;
  return {
    bar,
    tint: `color-mix(in srgb, ${c} 24%, rgba(0,0,0,0.25))`,
    border: `color-mix(in srgb, ${c} 70%, transparent)`,
  };
}

function TripCard({ trip, times, config, now, clock, pricing, waitUntil, capped }: Omit<TileCommon, 'highlight'> & {
  waitUntil?: number;
  capped?: boolean;
}) {
  const best = trip.kind === 'route' ? fastest(times, now, trip.request) : null;
  const leave = trip.kind === 'event' ? leaveTimes(trip, times) : {};
  const common = { trip, times, config, now, clock, pricing };
  const riders = trip.people.length
    ? trip.people
    : trip.personName ? [{ name: trip.personName, color: 'rgba(255,255,255,0.45)' }] : [];
  const colors = cardColors(trip.people);
  const r = trip.request;
  return (
    <div style={{
      display: 'flex', borderRadius: '0.75em', overflow: 'hidden', flexShrink: 0,
      background: colors.tint, border: `0.12em solid ${colors.border}`,
    }}>
      <div style={{ width: '0.55em', flexShrink: 0, background: colors.bar }} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.45em', padding: '0.55em 0.7em' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.55em', minWidth: 0 }}>
          {trip.people.length > 0 && (
            <span style={{ display: 'inline-flex' }}>
              {trip.people.map((p, i) => (
                <span key={p.id} style={{ marginLeft: i ? '-0.45em' : 0 }}><Avatar person={p} /></span>
              ))}
            </span>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
            <span style={{ fontWeight: 700, fontSize: '1.05em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {trip.title}
            </span>
            <span style={{ fontSize: '0.8em', opacity: 0.75, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {trip.startsAt !== null ? `${clock(trip.startsAt)} · ` : 'to '}{shortPlace(trip.destination)}
            </span>
          </div>
          <PersonTag people={riders} />
        </div>
        {!times && (capped || waitUntil !== undefined) ? (
          <div style={{ fontSize: '0.8em', opacity: 0.7 }}>
            {capped ? 'Paused for the rest of the month' : `Travel times from ${clock(waitUntil!)}`}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '0.45em', flexWrap: 'wrap' }}>
            {r.transit && <TransitTile {...common} highlight={best === 'transit'} leave={leave.transit} />}
            {(r.uber || r.rideshare) && <RideTile {...common} mode="uber" highlight={best === 'uber'} leave={leave.uber} />}
            {(r.lyft || r.rideshare) && <RideTile {...common} mode="lyft" highlight={best === 'lyft'} leave={leave.lyft} />}
            {r.drive && <DriveTile {...common} highlight={best === 'drive'} leave={leave.drive} />}
          </div>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: '0.75em', fontWeight: 750, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.6 }}>
      {children}
    </div>
  );
}

// ── Sizing ──────────────────────────────────────────────────────────────────

/** The module size the layout is authored at: its default size. */
const REFERENCE_AREA = 640 * 520;
/** With room to spare, type grows up to this much past its scaled size. */
const MAX_GROW = 1.8;

/** An element's size in px, kept current. */
function useBoxSize(ref: React.RefObject<HTMLDivElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    const ro = new ResizeObserver(read);
    ro.observe(el);
    read();
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

// ── Rate cards ──────────────────────────────────────────────────────────────

/** Ridewise's rate cards while estimates are on, re-checked every few hours
 *  (the download itself happens at most once a day). */
function useRates(fetcher: Fetcher, enabled: boolean): RateCard[] | null {
  const [cards, setCards] = useState<RateCard[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () => { loadRates(fetcher).then((c) => { if (!cancelled && c) setCards(c); }).catch(() => undefined); };
    load();
    const id = setInterval(load, 6 * 3_600_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [fetcher, enabled]);
  return cards;
}

// ── Module ──────────────────────────────────────────────────────────────────

export interface TravelTimesProps extends PluginComponentProps {
  /** Preview and tests only: stands in for the host proxy. */
  fetcher?: Fetcher;
  /** Preview and tests only: a fixed clock. */
  nowMs?: number;
}

export default function TravelTimes(props: TravelTimesProps) {
  const { style, timezone } = props;
  const config = useMemo(() => readConfig(props.config ?? {}), [props.config]);
  const fetcher = useMemo(() => props.fetcher ?? hostFetcher(), [props.fetcher]);
  // Google requests go through the monthly cap; the geocoder and rate cards aren't Google.
  const capRef = useRef(config);
  capRef.current = config;
  const timezoneRef = useRef(timezone);
  timezoneRef.current = timezone;
  const googleFetcher = useMemo(
    () => cappedFetcher(fetcher, () => capRef.current, { timezone: () => timezoneRef.current }),
    [fetcher],
  );

  const [tick, setTick] = useState(() => props.nowMs ?? Date.now());
  useEffect(() => {
    if (props.nowMs !== undefined) return;
    const id = setInterval(() => setTick(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, [props.nowMs]);
  const now = props.nowMs ?? tick;
  const minute = Math.floor(now / 60_000);

  const events = props.events as CalendarEvent[] | undefined;
  const people = props.people as Person[] | undefined;
  const trips = useMemo(
    () => buildTrips(config, new Date(minute * 60_000), { timezone, events, people }),
    [config, minute, timezone, events, people],
  );
  const home = useHome(fetcher, config.homeAddress, props.latitude, props.longitude);
  const miles = useEventDistances(trips, fetcher, home);
  const { times, usage } = useTripTimes(trips, config, timezone, googleFetcher, miles);
  const cards = useRates(fetcher, config.showRideshare);
  const pricing: Pricing = useMemo(() => ({
    cards, region: cards ? pickRegion(cards, home, config.rateRegion) : '', timezone,
  }), [cards, home, config.rateRegion, timezone]);
  const clock = useMemo(() => clockFormatter(config, props.timeFormat, timezone), [config, props.timeFormat, timezone]);

  /** A nearby event shows when its times will appear instead of empty tiles. */
  const waitUntil = (t: Trip): number | undefined => {
    if (t.kind !== 'event' || t.startsAt === null) return undefined;
    const d = miles[t.destination];
    if (typeof d === 'number' && d >= NEARBY_MILES) return undefined;
    const from = t.startsAt - FIRST_LOOK_MS;
    return from > now ? from : undefined;
  };
  // Reached once no whole trip fits in what's left, not only at the exact number.
  const cheapest = Math.max(1, Math.min(...trips.map((t) => googleCost(t.request)).filter((c) => c > 0), 2));
  const capped = config.monthlyCap - usage.count < cheapest;
  const nearCap = !capped && usage.count >= alertLevel(config);

  const routes = trips.filter((t) => t.kind === 'route');
  const upcoming = trips.filter((t) => t.kind === 'event');
  const updated = Math.max(0, ...Object.values(times).map((t) => t.fetchedAt));

  // Sized as in the CTA module: scale with the module's area against its
  // default size, then grow up to 1.8x more while everything still fits.
  const textSize = style.fontSize || 16;
  const measureRef = useRef<HTMLDivElement>(null);
  const box = useBoxSize(measureRef);
  const sizeScale = config.scaleWithSize && box.w > 0 && box.h > 0
    ? Math.min(3, Math.max(0.75, Math.sqrt((box.w * box.h) / REFERENCE_AREA)))
    : 1;
  const resetKey = `${trips.map((t) => t.key).join('|')}|${Object.keys(times).length}|${box.w}x${box.h}|${capped}|${nearCap}`;
  const { boxRef, fontSize } = useFitFontSize(textSize * sizeScale * MAX_GROW, resetKey);
  const showsEstimates = config.showRideshare && trips.length > 0;

  const needsSetup = !config.routes.some((r) => r.destination) && !(config.showCalendar && config.homeAddress);
  const quiet = isQuiet(config, new Date(now), timezone);
  const card = (t: Trip) => (
    <TripCard key={t.key} trip={t} times={times[t.key]} config={config} now={now} clock={clock} pricing={pricing}
      waitUntil={waitUntil(t)} capped={capped} />
  );

  return (
    <div ref={measureRef} style={{ width: '100%', height: '100%' }}>
      <div ref={boxRef} style={{ ...hostFrameStyle(style), fontSize, display: 'flex', flexDirection: 'column', gap: '0.6em' }}>
        {config.showTitle && (
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <span style={{ fontWeight: 750, fontSize: '1.1em' }}>Travel times</span>
            {updated > 0 && (
              <span style={{ fontSize: '0.7em', opacity: 0.6 }}>
                {quiet ? 'paused overnight · ' : ''}updated {clock(updated)}
              </span>
            )}
          </div>
        )}

        {(capped || nearCap) && (
          <div style={{
            fontSize: '0.75em', padding: '0.3em 0.6em', borderRadius: '0.5em',
            color: capped ? RED : AMBER, background: `color-mix(in srgb, ${capped ? RED : AMBER} 14%, transparent)`,
          }}>
            {capped
              ? `Monthly limit of ${config.monthlyCap.toLocaleString()} Google lookups reached. Times resume next month.`
              : `${usage.count.toLocaleString()} of ${config.monthlyCap.toLocaleString()} Google lookups used this month.`}
          </div>
        )}

        {needsSetup && (
          <div style={{ opacity: 0.75, fontSize: '0.85em' }}>
            Add a route, or a home address for calendar events, in this module&apos;s settings.
          </div>
        )}

        {routes.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5em' }}>
            {upcoming.length > 0 && <SectionLabel>Routes</SectionLabel>}
            {routes.map(card)}
          </div>
        )}

        {upcoming.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5em' }}>
            <SectionLabel>Upcoming</SectionLabel>
            {upcoming.map(card)}
          </div>
        )}

        {!needsSetup && trips.length === 0 && (
          <div style={{ opacity: 0.65, fontSize: '0.85em' }}>No trips right now.</div>
        )}

        {showsEstimates && (
          <div style={{ marginTop: 'auto', fontSize: '0.6em', opacity: 0.5 }}>
            ~ estimated · Uber/Lyft prices from Ridewise rate cards{pricing.region ? ` (${pricing.region})` : ''} · rush pricing is a guess
          </div>
        )}
      </div>
    </div>
  );
}
