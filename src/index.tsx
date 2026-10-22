import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { PluginComponentProps } from './hs-plugin';
import { hostFrameStyle } from './host-style';
import { useFitFontSize } from './fit';
import { Baby, Cat, CircleUser, Crown, Dog, Heart, PersonStanding, ShieldUser, Smile, Star, User, UserRound } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { readConfig } from './config';
import type { Config } from './config';
import { hostFetcher, loadTrip } from './providers';
import { geocode, milesBetween } from './geo';
import { alertLevel, browserStore, cappedFetcher, currentUsage, remaining } from './usage';
import type { DriveTime, Fetcher, LatLon, Mode, Reason, TransitLine, TripTimes } from './providers';
import {
  estimateFare, findCard, formatFare, loadRates, pickRegion, pickupWait, rushMultiplier, SERVICE_LABEL,
} from './fares';
import type { RateCard } from './fares';
import { isQuiet } from './schedule';
import { householdPeople } from './schedule';
import type { CalendarEvent, FamilyMember, Person } from './schedule';
import { NEUTRAL_PALETTE, paletteFor } from './colors';
import type { Palette } from './colors';
import { buildTrips, fastestOf, FIRST_LOOK_MS, googleCost, isDue, NEARBY_MILES, transitRoutes } from './trips';
import type { ModeName, TransitRoute, Trip } from './trips';

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
  badKey: 'key refused',
  notFound: 'no route found',
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
  // "8:04 AM" as "8:04am": no space, lower case.
  return (ms: number) => f.format(new Date(ms)).replace(/\s?([AaPp])\.?\s?[Mm]\.?$/, (_m, ap: string) => `${ap.toLowerCase()}m`);
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

/** "CTA Blue Line" as "Blue": the agency and "Line" are already clear from
 *  the logo and the chip's color. Bus numbers and short names pass through. */
export function lineLabel(line: TransitLine): string {
  const name = line.name.trim();
  const short = name.replace(/^(cta|metra|pace)\s+/i, '').replace(/\s+line$/i, '');
  return short || name;
}

function LineChip({ line }: { line: TransitLine }) {
  const bg = line.color ?? 'rgba(255,255,255,0.18)';
  return (
    <span style={{
      display: 'inline-block', padding: '0.05em 0.4em', borderRadius: '0.35em', fontWeight: 700,
      background: bg, color: line.textColor ?? '#fff', lineHeight: 1.3, whiteSpace: 'nowrap',
    }}>
      {lineLabel(line)}
    </span>
  );
}

const firstName = (name: string) => name.trim().split(/\s+/)[0];

/** The icons Settings > Family offers for a member, stored as "lucide:<name>"
 *  (the host's MEMBER_ICONS). Bundled from the same lucide-react version the
 *  host uses, so they match the Family page. */
const MEMBER_ICONS: Record<string, LucideIcon> = {
  user: User, 'user-round': UserRound, baby: Baby, 'circle-user': CircleUser, 'person-standing': PersonStanding,
  smile: Smile, crown: Crown, star: Star, heart: Heart, 'shield-user': ShieldUser, cat: Cat, dog: Dog,
};

/** What goes in a member's disc: their Family icon, an emoji they typed, or
 *  their initial. Icon kinds a plugin can't draw (custom uploads, Font
 *  Awesome) fall back to the initial rather than showing their stored name. */
export function avatarContent(value: string | undefined, name: string): { icon: string } | { text: string } {
  const v = (value ?? '').trim();
  const lucide = /^lucide:(.+)$/.exec(v);
  if (lucide && MEMBER_ICONS[lucide[1]]) return { icon: lucide[1] };
  // Anything else with a "kind:" prefix is a stored reference, not something to print.
  if (v && !/^[a-z-]+:/i.test(v) && [...v].length <= 4) return { text: v };
  return { text: firstName(name).charAt(0).toUpperCase() };
}

/** The rider's Family icon (or initial) on a disc of their color: readable
 *  as "whose" from across the room before any name is. */
function Avatar({ person, palette }: { person: Person; palette: Palette }) {
  const content = avatarContent(person.emoji, person.name);
  const Icon = 'icon' in content ? MEMBER_ICONS[content.icon] : null;
  return (
    <span aria-label={person.name} style={{
      width: '1.8em', height: '1.8em', borderRadius: '50%', background: palette.base, flexShrink: 0,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      color: palette.onBase, fontWeight: 800, fontSize: '1em', lineHeight: 1,
      boxShadow: `0 0 0 0.13em ${palette.ring}`,
    }}>
      {Icon
        ? <Icon size="1.1em" color={palette.onBase} strokeWidth={2.4} aria-hidden />
        : <span style={{ fontSize: '1.05em' }}>{'text' in content ? content.text : ''}</span>}
    </span>
  );
}

function PersonTag({ people }: { people: { name: string; palette: Palette }[] }) {
  if (!people.length) return null;
  return (
    <span style={{ display: 'inline-flex', gap: '0.3em', flexShrink: 0 }}>
      {people.map((p) => (
        <span key={p.name} style={{
          padding: '0.15em 0.65em', borderRadius: '1em', fontSize: '0.85em', fontWeight: 750,
          background: p.palette.base, color: p.palette.onBase,
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
  /** Show the "fastest" badge with the highlight (once per tie). */
  badge?: boolean;
  palette: Palette;
}

function Tile({ mode, agency, big, estimated, sub, highlight, badge = true, palette }: TileProps) {
  const style: CSSProperties = {
    minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.15em',
    padding: '0.4em 0.55em', borderRadius: '0.55em', position: 'relative',
    background: highlight ? palette.highlightSurface : palette.tile,
    border: `0.12em solid ${highlight ? palette.highlight : 'rgba(255,255,255,0.08)'}`,
  };
  // Logo and time share a row, so the time can be large without the tile
  // growing tall; the details sit underneath. `data-fit="x"` has the
  // module's fit shrink the type if a tile's contents would spill sideways.
  return (
    <div style={style}>
      {highlight && badge && (
        <span style={{
          position: 'absolute', top: '-0.6em', right: '0.5em', fontSize: '0.62em', fontWeight: 800, letterSpacing: '0.04em',
          padding: '0.05em 0.45em', borderRadius: '0.4em', background: palette.highlight, color: palette.onHighlight,
          textTransform: 'uppercase',
        }}>
          fastest
        </span>
      )}
      <div data-fit="x" style={{ display: 'flex', alignItems: 'center', gap: '0.4em', minWidth: 0, overflow: 'hidden' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3em', fontSize: '0.85em', flexShrink: 0 }}>
          <ModeMark mode={mode} agency={agency} />
        </span>
        {big === null ? (
          <span style={{ fontSize: '1.6em', fontWeight: 700, opacity: 0.35, lineHeight: 1 }}>—</span>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: '0.15em', whiteSpace: 'nowrap' }}>
            <span style={{ fontSize: '1.6em', fontWeight: 750, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
              {estimated ? '~' : ''}{big}
            </span>
            <span style={{ fontSize: '0.75em', opacity: 0.7 }}>min</span>
          </span>
        )}
      </div>
      <div style={{
        fontSize: '0.86em', opacity: 0.92, lineHeight: 1.3, minHeight: '1.3em',
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

interface TileBase {
  trip: Trip;
  now: number;
  clock: (ms: number) => string;
  palette: Palette;
  highlight?: boolean;
  badge?: boolean;
}

/** One transit route: its lines, when to leave, and the departures after. */
function TransitTile({ route, now, clock, palette, highlight, badge }: TileBase & { route: TransitRoute }) {
  const main = route.main;
  const note = main.leaveAt !== null ? leaveNote(main.leaveAt, now, clock) : null;
  const lines = route.lines.slice(0, 3);
  return (
    <Tile
      mode="transit"
      agency={route.lines.find((l) => l.agency)?.agency}
      big={minutesText(main.minutes)}
      highlight={highlight}
      badge={badge}
      palette={palette}
      sub={(
        <>
          {lines.map((l, i) => <LineChip key={i} line={l} />)}
          {!lines.length && <span>walk</span>}
          {note && <span style={{ color: note.tone, fontWeight: 650 }}>{note.text}</span>}
          {route.next.length > 0 && (
            // Later departures on the same lines, as leave-home times.
            <span style={{ opacity: 0.8, flexBasis: '100%' }}>
              Next - {route.next.map((o) => clock(o.leaveAt!)).join(', ')}
            </span>
          )}
        </>
      )}
    />
  );
}

interface RideQuote {
  service: string;
  minutes: number;
  wait: number;
  price: string | null;
  surge: number;
}

/** Estimated time and price for each ride type picked, for one service. */
function rideQuotes(
  mode: 'uber' | 'lyft', services: string[], drive: DriveTime, pricing: Pricing, config: Config,
  when: (minutes: number) => number,
): RideQuote[] {
  return services.map((service) => {
    // Wait and surge are read at the time the car would be called: now for a
    // route, the leave time for an event (which depends on the wait itself,
    // so it's taken from a typical wait first).
    const at = when(drive.minutes + 6);
    const wait = pickupWait(service, pricing.region, new Date(at), pricing.timezone);
    const surge = rushMultiplier(new Date(at), pricing.timezone, config);
    const card = pricing.cards ? findCard(pricing.cards, pricing.region, mode, service) : null;
    const fare = card && drive.miles ? estimateFare(card, drive.miles, drive.minutes, surge) : null;
    return { service, minutes: drive.minutes + wait, wait, price: fare ? formatFare(fare) : null, surge };
  });
}

/** Uber or Lyft: the first ride type's time up top, a price for each type picked. */
function RideTile({ mode, quotes, leave, now, clock, palette, highlight, badge }: TileBase & {
  mode: 'uber' | 'lyft';
  quotes: RideQuote[];
  leave?: number;
}) {
  const first = quotes[0];
  const note = leave !== undefined ? leaveNote(leave, now, clock) : null;
  const surge = Math.max(...quotes.map((q) => q.surge));
  return (
    <Tile
      mode={mode}
      big={minutesText(first.minutes)}
      estimated
      highlight={highlight}
      badge={badge}
      palette={palette}
      sub={(
        <>
          {quotes.map((q) => (
            <span key={q.service} style={{ flexBasis: '100%', display: 'flex', flexWrap: 'wrap', columnGap: '0.4em', alignItems: 'baseline' }}>
              <span style={{ opacity: 0.8, whiteSpace: 'nowrap' }}>{SERVICE_LABEL[q.service] ?? q.service}</span>
              <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{q.price ?? 'price n/a'}</span>
              {q.minutes !== first.minutes && <span style={{ opacity: 0.7, whiteSpace: 'nowrap' }}>~{minutesText(q.minutes)} min</span>}
            </span>
          ))}
          <span style={{ opacity: 0.7 }}>car ~{first.wait} min</span>
          {surge > 1 && <span style={{ color: AMBER, fontWeight: 650 }}>rush ×{Number(surge.toFixed(2))}</span>}
          {note && <span style={{ color: note.tone, fontWeight: 650 }}>{note.text}</span>}
        </>
      )}
    />
  );
}

function DriveTile({ drive, leave, now, clock, palette, highlight, badge }: TileBase & { drive: DriveTime; leave?: number }) {
  const note = leave !== undefined ? leaveNote(leave, now, clock) : null;
  return (
    <Tile
      mode="drive"
      big={minutesText(drive.minutes)}
      highlight={highlight}
      badge={badge}
      palette={palette}
      sub={(
        <>
          <span style={{ color: drive.delayMinutes >= 10 ? RED : drive.delayMinutes >= 4 ? AMBER : GREEN }}>
            {drive.delayMinutes > 0 ? `+${drive.delayMinutes} traffic` : 'clear'}
          </span>
          {note && <span style={{ color: note.tone, fontWeight: 650 }}>{note.text}</span>}
        </>
      )}
    />
  );
}

/** A striped bar for an event on several people's calendars. */
function barFor(palettes: Palette[]): string {
  if (palettes.length < 2) return palettes[0]?.base ?? NEUTRAL_PALETTE.base;
  const n = palettes.length;
  return `linear-gradient(to bottom, ${palettes.map((p, i) => `${p.base} ${(i / n) * 100}% ${((i + 1) / n) * 100}%`).join(', ')})`;
}

interface CardProps {
  trip: Trip;
  times: TripTimes | undefined;
  config: Config;
  now: number;
  clock: (ms: number) => string;
  pricing: Pricing;
  waitUntil?: number;
  capped?: boolean;
  /** Tiles per row, from the module's layout plan. */
  tilesPerRow: number;
}

function TripCard({ trip, times, config, now, clock, pricing, waitUntil, capped, tilesPerRow }: CardProps) {
  // The first rider's color drives the card; more riders add stripes and discs.
  const palettes = trip.people.map((p) => paletteFor(p.color));
  const palette = palettes[0] ?? NEUTRAL_PALETTE;
  const tags = trip.people.length
    ? trip.people.map((p, i) => ({ name: p.name, palette: palettes[i] }))
    : trip.personName ? [{ name: trip.personName, palette: NEUTRAL_PALETTE }] : [];
  const r = trip.request;
  const isEvent = trip.kind === 'event' && trip.arriveBy !== null;

  // What each tile shows, worked out once so "fastest" can compare them.
  const transit = r.transit && times?.transit?.ok
    ? transitRoutes(times.transit.value, now, trip.arriveBy, config.transitRoutes, config.transitOptions)
    : [];
  const drive = times?.drive?.ok ? times.drive.value : null;
  // When the car would be called, for a trip of `minutes`.
  const callAt = (minutes: number) => (isEvent ? Math.max(now, trip.arriveBy! - minutes * 60_000) : now);
  const uber = r.rideshare && config.uberEstimates && drive ? rideQuotes('uber', config.uberTypes, drive, pricing, config, callAt) : null;
  const lyft = r.rideshare && config.lyftEstimates && drive ? rideQuotes('lyft', config.lyftTypes, drive, pricing, config, callAt) : null;

  const leave: Record<string, number | undefined> = {};
  const arrive: Record<string, number | undefined> = {};
  for (const t of transit) {
    leave[`transit:${t.key}`] = t.main.leaveAt ?? undefined;
    arrive[`transit:${t.key}`] = t.main.arriveAt ?? undefined;
  }
  if (uber) { leave.uber = isEvent ? trip.arriveBy! - uber[0].minutes * 60_000 : undefined; arrive.uber = now + uber[0].minutes * 60_000; }
  if (lyft) { leave.lyft = isEvent ? trip.arriveBy! - lyft[0].minutes * 60_000 : undefined; arrive.lyft = now + lyft[0].minutes * 60_000; }
  if (drive && r.drive) { leave.drive = isEvent ? trip.arriveBy! - drive.minutes * 60_000 : undefined; arrive.drive = now + drive.minutes * 60_000; }
  // Fastest is for leaving now, so only routes get it; one badge per tie.
  const best = trip.kind === 'route' ? fastestOf(arrive) : new Set<string>();
  let badged = false;
  const mark = (id: string) => {
    const highlight = best.has(id);
    const badge = highlight && !badged;
    if (badge) badged = true;
    return { highlight, badge };
  };
  const base = { trip, now, clock, palette };

  return (
    <div style={{
      display: 'flex', borderRadius: '0.75em', overflow: 'hidden', minWidth: 0,
      background: palette.surface, border: `0.14em solid ${palette.rim}`,
    }}>
      <div style={{ width: '0.6em', flexShrink: 0, background: barFor(palettes) }} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.5em', padding: '0.6em 0.7em' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.55em', minWidth: 0 }}>
          {trip.people.length > 0 && (
            <span style={{ display: 'inline-flex' }}>
              {trip.people.map((p, i) => (
                <span key={p.id} style={{ marginLeft: i ? '-0.45em' : 0 }}><Avatar person={p} palette={palettes[i]} /></span>
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
          <PersonTag people={tags} />
        </div>
        {!times && (capped || waitUntil !== undefined) ? (
          <div style={{ fontSize: '0.8em', opacity: 0.75 }}>
            {capped ? 'Paused for the rest of the month' : `Travel times from ${clock(waitUntil!)}`}
          </div>
        ) : (
          <div style={{
            display: 'grid', gridTemplateColumns: `repeat(${tilesPerRow}, minmax(0, 1fr))`, gap: '0.45em', paddingTop: '0.3em',
          }}>
            {r.transit && (transit.length
              ? transit.map((t) => <TransitTile key={t.key} {...base} route={t} {...mark(`transit:${t.key}`)} />)
              : (
                <Tile mode="transit" big={null} palette={palette}
                  sub={times?.transit?.ok ? 'checking for the next departures' : failText(times?.transit)} />
              ))}
            {r.rideshare && config.uberEstimates && (uber
              ? <RideTile {...base} mode="uber" quotes={uber} leave={leave.uber} {...mark('uber')} />
              : <Tile mode="uber" big={null} palette={palette} sub={failText(times?.drive)} />)}
            {r.rideshare && config.lyftEstimates && (lyft
              ? <RideTile {...base} mode="lyft" quotes={lyft} leave={leave.lyft} {...mark('lyft')} />
              : <Tile mode="lyft" big={null} palette={palette} sub={failText(times?.drive)} />)}
            {r.drive && (drive
              ? <DriveTile {...base} drive={drive} leave={leave.drive} {...mark('drive')} />
              : <Tile mode="drive" big={null} palette={palette} sub={failText(times?.drive)} />)}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Layout ──────────────────────────────────────────────────────────────────
//
// The module plans its grid from its own size: how many trip cards side by
// side, and how many tiles per row inside a card. For each choice it works
// out how large the text could be (in em, the sizes below are what a card
// and a tile take up per em of text), and keeps the one that allows the
// largest. Fixing the grid first, rather than letting tiles wrap as they
// please, keeps the auto-fit steady: the layout no longer changes shape as
// the text grows or shrinks.

/** Width of one tile plus its gap, in em. */
const TILE_W = 7.2;
/** Height of one row of tiles plus its gap, in em. */
const TILE_ROW_H = 5.6;
/** A card's own width (color bar, padding) and height (header, padding), in em. */
const CARD_W = 2.6;
const CARD_H = 4.2;
/** Space between cards, in em. */
const GAP = 0.5;
/** The title, footer, padding and section labels, in em. */
const CHROME_H = 3.6;
const LABEL_H = 1.4;

export interface Layout {
  /** Trip cards per row. */
  columns: number;
  /** Tiles per row inside a card. */
  tilesPerRow: number;
}

/**
 * The grid that lets the text be largest in a `width` x `height` px module
 * holding `cards` trip cards of up to `tiles` tiles each. `columns` fixes
 * the number of cards across (0 picks it too).
 */
export function planLayout(
  width: number, height: number, cards: number, tiles: number, opts: { columns?: number; sections?: number } = {},
): Layout {
  const n = Math.max(1, cards);
  const t = Math.max(1, tiles);
  if (width <= 0 || height <= 0) return { columns: Math.min(opts.columns || 1, n), tilesPerRow: t };
  const chrome = CHROME_H + Math.max(0, (opts.sections ?? 1) - 1) * LABEL_H;
  let best: Layout = { columns: 1, tilesPerRow: t };
  let bestEm = 0;
  const columnChoices = opts.columns ? [Math.min(opts.columns, n)] : Array.from({ length: Math.min(n, 4) }, (_, i) => i + 1);
  for (const c of columnChoices) {
    const cardRows = Math.ceil(n / c);
    for (let k = t; k >= 1; k--) {
      const tileRows = Math.ceil(t / k);
      const emWide = c * (k * TILE_W + CARD_W) + (c - 1) * GAP;
      const emTall = chrome + cardRows * (CARD_H + tileRows * TILE_ROW_H) + (cardRows - 1) * GAP;
      const em = Math.min(width / emWide, height / emTall);
      // Ties go to fewer cards across and more tiles per row.
      if (em > bestEm * 1.02) { bestEm = em; best = { columns: c, tilesPerRow: k }; }
    }
  }
  return best;
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: '0.75em', fontWeight: 750, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.6, flexShrink: 0 }}>
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

// ── Family ──────────────────────────────────────────────────────────────────

/** Stands in for the host's fetch hook where there is none (tests). */
const noFetch = <T,>(_url: string | null, _ms: number): [T | null, string | null] => [null, null];

/**
 * Settings > Family, through the host's own fetch hook (which carries the
 * display's credentials and shares the host's cache). The calendar props only
 * include people who have a calendar linked; this has everyone, with their
 * color and icon.
 */
function useFamily(): FamilyMember[] | null {
  const useFetch = window.__HS_SDK__?.useFetchData ?? noFetch;
  const [data] = useFetch<{ members?: FamilyMember[] }>('/api/family', 5 * 60_000);
  return Array.isArray(data?.members) ? data.members : null;
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
  const family = useFamily();
  const people = useMemo(() => householdPeople(family, props.people as Person[] | undefined), [family, props.people]);
  // Where trips start: the home address, else the household location from Settings.
  const hostHome = typeof props.latitude === 'number' && typeof props.longitude === 'number'
    ? `${props.latitude},${props.longitude}` : '';
  const homeOrigin = config.homeAddress || hostHome;
  const trips = useMemo(
    () => buildTrips(config, new Date(minute * 60_000), { timezone, events, people, home: homeOrigin }),
    [config, minute, timezone, events, people, homeOrigin],
  );
  const home = useHome(fetcher, config.homeAddress, props.latitude, props.longitude);
  const miles = useEventDistances(trips, fetcher, home);
  const { times, usage } = useTripTimes(trips, config, timezone, googleFetcher, miles);
  const cards = useRates(fetcher, config.uberEstimates || config.lyftEstimates);
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
  const resetKey = `${trips.map((t) => t.key).join('|')}|${Object.keys(times).length}|${box.w}x${box.h}|${capped}|${nearCap}`
    + `|${config.cardColumns}|${config.transitRoutes}|${config.transitOptions}|${config.uberEstimates}|${config.lyftEstimates}`
    + `|${config.uberTypes.join()}|${config.lyftTypes.join()}`;
  const { boxRef, fontSize } = useFitFontSize(textSize * sizeScale * MAX_GROW, resetKey);
  const showsEstimates = (config.uberEstimates || config.lyftEstimates) && trips.length > 0;
  // Cards across and tiles per row, planned from the module's size and shape.
  const tilesPerCard = Math.max(1, ...trips.map((t) => (t.request.transit ? config.transitRoutes : 0)
    + (t.request.rideshare && config.uberEstimates ? 1 : 0) + (t.request.rideshare && config.lyftEstimates ? 1 : 0)
    + (t.request.drive ? 1 : 0)));
  const layout = planLayout(box.w, box.h, trips.length, tilesPerCard, {
    columns: config.cardColumns, sections: (routes.length > 0 ? 1 : 0) + (upcoming.length > 0 ? 1 : 0),
  });
  const grid: CSSProperties = {
    display: 'grid', gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`,
    gap: '0.5em', flexShrink: 0, alignItems: 'start',
  };

  const needsSetup = !config.routes.some((r) => r.destination) && !(config.showCalendar && homeOrigin);
  const quiet = isQuiet(config, new Date(now), timezone);
  const card = (t: Trip) => (
    <TripCard key={t.key} trip={t} times={times[t.key]} config={config} now={now} clock={clock} pricing={pricing}
      waitUntil={waitUntil(t)} capped={capped} tilesPerRow={layout.tilesPerRow} />
  );

  return (
    <div ref={measureRef} style={{ width: '100%', height: '100%' }}>
      <div ref={boxRef} style={{ ...hostFrameStyle(style), fontSize, display: 'flex', flexDirection: 'column', gap: '0.6em' }}>
        {config.showTitle && (
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexShrink: 0 }}>
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
            fontSize: '0.75em', padding: '0.3em 0.6em', borderRadius: '0.5em', flexShrink: 0,
            color: capped ? RED : AMBER, background: `color-mix(in srgb, ${capped ? RED : AMBER} 14%, transparent)`,
          }}>
            {capped
              ? `Monthly limit of ${config.monthlyCap.toLocaleString()} Google lookups reached. Times resume next month.`
              : `${usage.count.toLocaleString()} of ${config.monthlyCap.toLocaleString()} Google lookups used this month.`}
          </div>
        )}

        {needsSetup && (
          <div style={{ opacity: 0.75, fontSize: '0.85em', flexShrink: 0 }}>
            Add a route, or a home address for calendar events, in this module&apos;s settings.
          </div>
        )}

        {routes.length > 0 && upcoming.length > 0 && <SectionLabel>Routes</SectionLabel>}
        {routes.length > 0 && <div style={grid}>{routes.map(card)}</div>}

        {upcoming.length > 0 && <SectionLabel>Upcoming</SectionLabel>}
        {upcoming.length > 0 && <div style={grid}>{upcoming.map(card)}</div>}

        {!needsSetup && trips.length === 0 && (
          <div style={{ opacity: 0.65, fontSize: '0.85em', flexShrink: 0 }}>No trips right now.</div>
        )}

        {showsEstimates && (
          <div style={{ marginTop: 'auto', fontSize: '0.55em', opacity: 0.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 0 }}>
            ~ estimated · prices: Ridewise rate cards{pricing.region ? ` (${pricing.region})` : ''} · rush pricing is a guess
          </div>
        )}
      </div>
    </div>
  );
}
