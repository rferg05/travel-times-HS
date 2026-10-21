import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { PluginComponentProps } from './hs-plugin';
import { hostFrameStyle } from './host-style';
import { useFitFontSize } from './fit';
import { readConfig } from './config';
import type { Config } from './config';
import { hostFetcher, loadTrip } from './providers';
import type { Fetcher, Mode, Reason, RideQuote, TransitLine, TransitOption, TripTimes } from './providers';
import { isQuiet } from './schedule';
import type { CalendarEvent, Person } from './schedule';
import { bestTransit, buildTrips, fastest, leaveTimes, rideMinutes } from './trips';
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
  unavailable: 'no answer',
};

// ── Data ────────────────────────────────────────────────────────────────────

const cacheKey = (key: string) => `travel-times:${key}`;

function readCache(key: string): TripTimes | undefined {
  try {
    const hit = window.__HS_SDK__?.displayCache?.get<TripTimes>(cacheKey(key));
    return hit?.data ?? undefined;
  } catch {
    return undefined;
  }
}

function writeCache(key: string, value: TripTimes, ttlMs: number): void {
  try { window.__HS_SDK__?.displayCache?.set(cacheKey(key), value, ttlMs); } catch { /* preview without host */ }
}

function hasFailure(t: TripTimes): boolean {
  return [t.transit, t.drive, t.uber, t.lyft].some((m) => m && !m.ok && m.reason === 'unavailable');
}

/**
 * Times for every trip, refreshed every `refreshMinutes` (sooner after a
 * failure), paused during quiet hours. Answers are kept in the host's display
 * cache, so a screen rotating back in shows them at once instead of asking
 * Google again.
 */
function useTripTimes(trips: Trip[], config: Config, timezone: string | undefined, fetcher: Fetcher) {
  const [times, setTimes] = useState<Record<string, TripTimes>>(() => {
    const out: Record<string, TripTimes> = {};
    for (const t of trips) {
      const hit = readCache(t.key);
      if (hit) out[t.key] = hit;
    }
    return out;
  });
  const [poll, setPoll] = useState(0);
  const timesRef = useRef(times);
  timesRef.current = times;
  const keys = trips.map((t) => t.key).join('\n');
  const refreshMs = config.refreshMinutes * 60_000;

  useEffect(() => {
    const id = setInterval(() => setPoll((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const now = Date.now();
      const quiet = isQuiet(config, new Date(now), timezone);
      for (const trip of trips) {
        if (cancelled) return;
        const have = timesRef.current[trip.key] ?? readCache(trip.key);
        const maxAge = have && hasFailure(have) ? Math.min(RETRY_MS, refreshMs) : refreshMs;
        if (have && now - have.fetchedAt < maxAge) {
          if (!timesRef.current[trip.key]) setTimes((s) => ({ ...s, [trip.key]: have }));
          continue;
        }
        // Overnight, keep showing what we have; only a trip with nothing yet is looked up.
        if (quiet && have) continue;
        const fresh = await loadTrip(fetcher, trip.request);
        if (cancelled) return;
        writeCache(trip.key, fresh, refreshMs * 2);
        setTimes((s) => ({ ...s, [trip.key]: fresh }));
      }
    })();
    return () => { cancelled = true; };
    // `trips` is captured through `keys`; the requests are part of the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, poll, refreshMs, config.quietFrom, config.quietTo, timezone, fetcher]);

  return times;
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

// ── Pieces ──────────────────────────────────────────────────────────────────

const ICONS: Record<ModeName, ReactNode> = {
  transit: (
    <path d="M7 3h10a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3l1.5 2.5h-2.3L14.7 18H9.3l-1.5 2.5H5.5L7 18a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Zm-1 4v4h12V7H6Zm2 7.5a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Zm8 0a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z" />
  ),
  drive: (
    <path d="M6.5 5h11l2.5 6.2V19h-2.5v-2h-11v2H4v-7.8L6.5 5Zm1.3 2-1.6 4h11.6l-1.6-4H7.8ZM7.5 13a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm9 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z" />
  ),
  uber: null,
  lyft: null,
};

const MODE_LABEL: Record<ModeName, string> = { transit: 'Transit', uber: 'Uber', lyft: 'Lyft', drive: 'Drive' };

function ModeIcon({ mode }: { mode: ModeName }) {
  if (ICONS[mode]) {
    return (
      <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden style={{ flexShrink: 0 }}>
        {ICONS[mode]}
      </svg>
    );
  }
  return null;
}

function LineChip({ line }: { line: TransitLine }) {
  const bg = line.color ?? 'rgba(255,255,255,0.18)';
  return (
    <span style={{
      display: 'inline-block', padding: '0.05em 0.4em', borderRadius: '0.35em', fontWeight: 700,
      background: bg, color: line.textColor ?? '#fff', fontSize: '0.85em', lineHeight: 1.3, whiteSpace: 'nowrap',
    }}>
      {line.name}
    </span>
  );
}

function PersonTag({ people, name }: { people: Person[]; name: string | null }) {
  if (!people.length && !name) return null;
  const items = people.length ? people.map((p) => ({ key: p.id, name: p.name.split(/\s+/)[0], color: p.color }))
    : [{ key: name!, name: name!, color: 'rgba(255,255,255,0.5)' }];
  return (
    <span style={{ display: 'inline-flex', gap: '0.3em', flexShrink: 0 }}>
      {items.map((p) => (
        <span key={p.key} style={{
          display: 'inline-flex', alignItems: 'center', gap: '0.3em', padding: '0.1em 0.5em', borderRadius: '1em',
          fontSize: '0.72em', fontWeight: 600, background: `color-mix(in srgb, ${p.color} 28%, transparent)`,
          border: `1px solid ${p.color}`,
        }}>
          <span style={{ width: '0.55em', height: '0.55em', borderRadius: '50%', background: p.color }} />
          {p.name}
        </span>
      ))}
    </span>
  );
}

interface TileProps {
  mode: ModeName;
  big: string | null;
  estimated?: boolean;
  sub: ReactNode;
  highlight?: boolean;
  tone?: string;
}

function Tile({ mode, big, estimated, sub, highlight, tone }: TileProps) {
  const style: CSSProperties = {
    flex: '1 1 0', minWidth: '5.6em', display: 'flex', flexDirection: 'column', gap: '0.15em',
    padding: '0.4em 0.55em', borderRadius: '0.55em',
    background: highlight ? 'rgba(56, 189, 248, 0.16)' : 'rgba(255,255,255,0.06)',
    border: `1px solid ${highlight ? ACCENT : 'rgba(255,255,255,0.08)'}`,
  };
  return (
    <div style={style}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.35em', fontSize: '0.72em', opacity: 0.8, fontWeight: 600 }}>
        <ModeIcon mode={mode} />
        <span>{MODE_LABEL[mode]}</span>
        {highlight && <span style={{ marginLeft: 'auto', color: ACCENT }}>fastest</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.2em' }}>
        {big === null ? (
          <span style={{ fontSize: '1.45em', fontWeight: 700, opacity: 0.35, lineHeight: 1.1 }}>—</span>
        ) : (
          <>
            <span style={{ fontSize: '1.45em', fontWeight: 700, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums', color: tone }}>
              {estimated ? '~' : ''}{big}
            </span>
            <span style={{ fontSize: '0.72em', opacity: 0.65 }}>min</span>
          </>
        )}
      </div>
      <div style={{ fontSize: '0.72em', opacity: 0.8, lineHeight: 1.35, minHeight: '1.35em', display: 'flex', flexWrap: 'wrap', gap: '0.3em', alignItems: 'center' }}>
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
      big={minutesText(best.minutes)}
      highlight={highlight}
      tone={note?.tone}
      sub={(
        <>
          {lines.map((l, i) => <LineChip key={i} line={l} />)}
          {!lines.length && <span>walk</span>}
          {note && <span style={{ color: note.tone }}>{note.text}</span>}
          {others.length > 0 && <span style={{ opacity: 0.7 }}>· then {others.map((o) => clock(o.leaveAt!)).join(', ')}</span>}
        </>
      )}
    />
  );
}

interface TileCommon {
  trip: Trip;
  times: TripTimes | undefined;
  config: Config;
  now: number;
  clock: (ms: number) => string;
  highlight?: boolean;
}

function RideTile({ mode, trip, times, now, clock, highlight, leave }: TileCommon & { mode: 'uber' | 'lyft'; leave?: number }) {
  const m = times?.[mode] as Mode<RideQuote> | undefined;
  if (!m || !m.ok) return <Tile mode={mode} big={null} sub={failText(m)} />;
  const q = m.value;
  const { minutes, estimated } = rideMinutes(q, times?.drive);
  const note = trip.kind === 'event' ? leaveNote(leave, now, clock) : null;
  const parts = [q.price, q.pickupMinutes !== null ? `car ${q.pickupMinutes}m` : null].filter(Boolean);
  return (
    <Tile
      mode={mode}
      big={minutes === null ? null : minutesText(minutes)}
      estimated={estimated}
      highlight={highlight}
      tone={note?.tone}
      sub={(
        <>
          <span>{parts.join(' · ') || q.name}</span>
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

function TripCard({ trip, times, config, now, clock }: Omit<TileCommon, 'highlight'>) {
  const best = trip.kind === 'route' ? fastest(times, now) : null;
  const leave = trip.kind === 'event' ? leaveTimes(trip, times) : {};
  const common = { trip, times, config, now, clock };
  const edge = trip.people[0]?.color ?? (trip.kind === 'event' ? 'rgba(255,255,255,0.35)' : ACCENT);
  const r = trip.request;
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: '0.4em', padding: '0.55em 0.65em',
      borderRadius: '0.7em', background: 'rgba(255,255,255,0.05)', borderLeft: `0.22em solid ${edge}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5em', minWidth: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
          <span style={{ fontWeight: 650, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {trip.title}
          </span>
          <span style={{ fontSize: '0.72em', opacity: 0.65, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {trip.startsAt !== null ? `${clock(trip.startsAt)} · ` : 'to '}{shortPlace(trip.destination)}
          </span>
        </div>
        <PersonTag people={trip.people} name={trip.personName} />
      </div>
      <div style={{ display: 'flex', gap: '0.4em', flexWrap: 'wrap' }}>
        {r.transit && <TransitTile {...common} highlight={best === 'transit'} leave={leave.transit} />}
        {r.uber && <RideTile {...common} mode="uber" highlight={best === 'uber'} leave={leave.uber} />}
        {r.lyft && <RideTile {...common} mode="lyft" highlight={best === 'lyft'} leave={leave.lyft} />}
        {r.drive && <DriveTile {...common} highlight={best === 'drive'} leave={leave.drive} />}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: '0.68em', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.55 }}>
      {children}
    </div>
  );
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
  const times = useTripTimes(trips, config, timezone, fetcher);
  const clock = useMemo(() => clockFormatter(config, props.timeFormat, timezone), [config, props.timeFormat, timezone]);

  const routes = trips.filter((t) => t.kind === 'route');
  const upcoming = trips.filter((t) => t.kind === 'event');
  const updated = Math.max(0, ...Object.values(times).map((t) => t.fetchedAt));
  const resetKey = `${trips.map((t) => t.key).join('|')}|${Object.keys(times).length}`;
  const { boxRef, fontSize } = useFitFontSize(style.fontSize || 16, resetKey);

  const needsSetup = !config.routes.some((r) => r.destination) && !(config.showCalendar && config.homeAddress);
  const quiet = isQuiet(config, new Date(now), timezone);

  return (
    <div ref={boxRef} style={{ ...hostFrameStyle(style), fontSize, display: 'flex', flexDirection: 'column', gap: '0.55em' }}>
      {config.showTitle && (
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 700, fontSize: '1.05em' }}>Travel times</span>
          {updated > 0 && (
            <span style={{ fontSize: '0.65em', opacity: 0.5 }}>
              {quiet ? 'paused overnight · ' : ''}updated {clock(updated)}
            </span>
          )}
        </div>
      )}

      {needsSetup && (
        <div style={{ opacity: 0.7, fontSize: '0.85em' }}>
          Add a route, or a home address for calendar events, in this module&apos;s settings.
        </div>
      )}

      {routes.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45em' }}>
          {upcoming.length > 0 && <SectionLabel>Routes</SectionLabel>}
          {routes.map((t) => <TripCard key={t.key} trip={t} times={times[t.key]} config={config} now={now} clock={clock} />)}
        </div>
      )}

      {upcoming.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45em' }}>
          <SectionLabel>Upcoming</SectionLabel>
          {upcoming.map((t) => <TripCard key={t.key} trip={t} times={times[t.key]} config={config} now={now} clock={clock} />)}
        </div>
      )}

      {!needsSetup && trips.length === 0 && (
        <div style={{ opacity: 0.6, fontSize: '0.85em' }}>No trips right now.</div>
      )}
    </div>
  );
}
