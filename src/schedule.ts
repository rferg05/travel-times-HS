// When things show, who they're for, and which calendar events need a trip.
// Pure functions of the config, the clock and the host's calendar props, so
// they can be tested without a host.

import { DAYS } from './config';
import type { Config, Day, SavedRoute } from './config';

/** The host's CalendarEvent, as much of it as this module reads. */
export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  allDay: boolean;
  sourceId?: string;
  kind?: 'birthday' | 'holiday' | 'event';
}

/** The host's CalendarPerson: a household member and the calendars that are theirs. */
export interface Person {
  id: string;
  name: string;
  color: string;
  /** The icon picked in Settings > Family. */
  emoji?: string;
  sourceIds: string[];
}

/** A Settings > Family member, as the host's /api/family returns it. */
export interface FamilyMember {
  id: string;
  name: string;
  color: string;
  emoji?: string;
}

/**
 * Everyone in the household with their Family color and icon, plus the
 * calendars that are theirs. The host only hands plugins people who have a
 * calendar linked, so the Family list is the source of who exists, and the
 * calendar list only adds which calendars belong to whom.
 */
export function householdPeople(family: FamilyMember[] | null | undefined, calendarPeople: Person[] | undefined): Person[] {
  const cal = calendarPeople ?? [];
  if (!family?.length) return cal;
  return family
    .filter((m) => m && typeof m.name === 'string' && m.name.trim())
    .map((m) => ({
      id: m.id,
      name: m.name,
      color: m.color || cal.find((c) => c.id === m.id)?.color || '#94a3b8',
      emoji: m.emoji || undefined,
      sourceIds: cal.find((c) => c.id === m.id)?.sourceIds ?? [],
    }));
}

/** Day of week and minutes past midnight on the household's wall clock. */
export function wallClock(now: Date, timezone?: string): { day: Day; minutes: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || undefined, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
    const v: Record<string, string> = {};
    for (const p of parts) v[p.type] = p.value;
    const day = v.weekday.slice(0, 3).toLowerCase() as Day;
    return { day: DAYS.includes(day) ? day : DAYS[now.getDay()], minutes: Number(v.hour) * 60 + Number(v.minute) };
  } catch {
    // An unknown zone name: the display's own clock is the best guess left.
    return { day: DAYS[now.getDay()], minutes: now.getHours() * 60 + now.getMinutes() };
  }
}

function toMinutes(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Inside [from, to), wrapping past midnight when `to` is earlier than `from`.
 *  A missing end means open on that side. */
export function inWindow(minutes: number, from: string, to: string): boolean {
  const a = toMinutes(from);
  const b = toMinutes(to);
  if (a === null && b === null) return true;
  if (a === null) return minutes < b!;
  if (b === null) return minutes >= a;
  if (a === b) return true;
  return a < b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
}

/** Overnight pause: both ends set and the clock between them. */
export function isQuiet(config: Pick<Config, 'quietFrom' | 'quietTo'>, now: Date, timezone?: string): boolean {
  if (!config.quietFrom || !config.quietTo || config.quietFrom === config.quietTo) return false;
  return inWindow(wallClock(now, timezone).minutes, config.quietFrom, config.quietTo);
}

/** A route with somewhere to go and a start (its own, or home). */
export function isComplete(route: SavedRoute, homeAddress: string): boolean {
  return route.destination !== '' && (route.origin !== '' || homeAddress !== '');
}

/** Showing right now: today is one of its days, and the time is inside its window. */
export function isActive(route: SavedRoute, now: Date, timezone?: string): boolean {
  const { day, minutes } = wallClock(now, timezone);
  // A window belongs to the day it starts on, so an overnight one (22:00 to
  // 02:00) on Fridays still shows after midnight into Saturday.
  const from = toMinutes(route.activeFrom);
  const to = toMinutes(route.activeTo);
  const afterMidnight = from !== null && to !== null && from > to && minutes < to;
  const startDay = afterMidnight ? DAYS[(DAYS.indexOf(day) + 6) % 7] : day;
  if (route.days.length > 0 && !route.days.includes(startDay)) return false;
  return inWindow(minutes, route.activeFrom, route.activeTo);
}

const norm = (s: string) => s.trim().toLowerCase();

/** The household member a route names: by name, case-insensitive, first
 *  name alone accepted when it is unambiguous. Null when nobody matches. */
export function findPerson(name: string, people: Person[]): Person | null {
  const n = norm(name);
  if (!n) return null;
  const exact = people.find((p) => norm(p.name) === n);
  if (exact) return exact;
  const byFirst = people.filter((p) => norm(p.name).split(/\s+/)[0] === n);
  return byFirst.length === 1 ? byFirst[0] : null;
}

/** Everyone whose calendars an event came from. */
export function eventPeople(event: CalendarEvent, people: Person[]): Person[] {
  if (!event.sourceId) return [];
  return people.filter((p) => p.sourceIds.includes(event.sourceId!));
}

/** A location that is a meeting link or a dial-in, not a place to go to. */
export function isVirtualLocation(location: string): boolean {
  return /https?:\/\/|www\.|zoom|teams\.microsoft|meet\.google|webex|^\s*(online|virtual|remote|phone|tbd)\s*$/i
    .test(location);
}

/**
 * Events worth a trip: timed (not all-day), with a real address, starting
 * after now and within the look-ahead, not filtered out by title. Soonest
 * first, at most `maxEvents`. The same event on two people's calendars
 * (an invite they both accepted) is one trip.
 */
export function upcomingTrips(
  events: CalendarEvent[] | undefined,
  config: Pick<Config, 'calendarHours' | 'maxEvents' | 'eventFilter'>,
  now: Date,
): CalendarEvent[] {
  if (!Array.isArray(events)) return [];
  const until = now.getTime() + config.calendarHours * 3_600_000;
  const seen = new Set<string>();
  return events
    .filter((e) => {
      if (!e || e.allDay || (e.kind && e.kind !== 'event')) return false;
      const location = typeof e.location === 'string' ? e.location.trim() : '';
      if (!location || isVirtualLocation(location)) return false;
      const start = Date.parse(e.start);
      if (!Number.isFinite(start) || start <= now.getTime() || start > until) return false;
      const title = (e.title ?? '').toLowerCase();
      return !config.eventFilter.some((word) => title.includes(word));
    })
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .filter((e) => {
      const key = `${e.title}|${e.start}|${e.location}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, config.maxEvents);
}
