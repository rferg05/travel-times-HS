// A monthly cap on Google Routes requests, counted where they're sent.
//
// The count lives in this browser's localStorage, so it survives reloads and
// reboots of the display, and every Travel Times module on the display adds
// to the same count. It can't see other browsers: a second display, or the
// editor open on a laptop, keeps its own count. Google's own per-day quota
// (see the README) is the backstop that covers all of them.

import type { Fetcher } from './providers';

const STORAGE_KEY = 'travel-times:google-usage';

export interface Usage {
  /** "2026-10": the household's calendar month the count belongs to. */
  month: string;
  count: number;
  /** Already logged that the alert level / the cap was reached this month. */
  alerted: boolean;
  capped: boolean;
}

/** The household's calendar month, "YYYY-MM". */
export function monthKey(now: Date, timezone?: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone || undefined, year: 'numeric', month: '2-digit' })
      .formatToParts(now);
    const v: Record<string, string> = {};
    for (const p of parts) v[p.type] = p.value;
    return `${v.year}-${v.month}`;
  } catch {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
}

/** Where the count is kept: localStorage, or memory where storage is blocked. */
export interface UsageStore {
  load(): Usage | null;
  save(u: Usage): void;
}

let memory: Usage | null = null;

export const browserStore: UsageStore = {
  load() {
    try {
      const raw = window.localStorage?.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw) as Usage;
    } catch { /* blocked or corrupt: fall back to memory */ }
    return memory;
  },
  save(u) {
    memory = u;
    try { window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(u)); } catch { /* memory only */ }
  },
};

/** This month's usage; a new month starts from zero. */
export function currentUsage(store: UsageStore, now: Date, timezone?: string): Usage {
  const month = monthKey(now, timezone);
  const u = store.load();
  return u && u.month === month && Number.isFinite(u.count)
    ? u
    : { month, count: 0, alerted: false, capped: false };
}

export interface CapSettings {
  monthlyCap: number;
  /** Percent of the cap at which the module warns. */
  alertPercent: number;
}

export const alertLevel = (s: CapSettings) => Math.floor((s.monthlyCap * s.alertPercent) / 100);

/** Requests left this month. */
export function remaining(store: UsageStore, s: CapSettings, now: Date, timezone?: string): number {
  return Math.max(0, s.monthlyCap - currentUsage(store, now, timezone).count);
}

const isGoogle = (url: string) => url.startsWith('https://routes.googleapis.com/');

function log(level: 'warn' | 'error', message: string): void {
  try { window.__HS_SDK__?.emit({ type: 'log', level, message }); } catch { /* preview without host */ }
}

/**
 * Wraps a fetcher so every Google request is counted before it is sent, and
 * refused once the month's cap is used up. A refused request never leaves
 * the display: it comes back as a 429 the providers read as `capped`.
 */
export function cappedFetcher(
  inner: Fetcher,
  settings: () => CapSettings,
  opts: { store?: UsageStore; timezone?: () => string | undefined; now?: () => Date } = {},
): Fetcher {
  const store = opts.store ?? browserStore;
  const now = opts.now ?? (() => new Date());
  return async (req) => {
    if (!isGoogle(req.url)) return inner(req);
    const s = settings();
    const u = currentUsage(store, now(), opts.timezone?.());
    if (u.count >= s.monthlyCap) {
      if (!u.capped) {
        log('error', `Travel Times: monthly limit of ${s.monthlyCap} Google requests reached; lookups paused until next month.`);
        store.save({ ...u, capped: true });
      }
      return { status: 429, body: { error: 'monthly_cap' } };
    }
    const next = { ...u, count: u.count + 1 };
    if (!next.alerted && next.count >= alertLevel(s)) {
      next.alerted = true;
      log('warn', `Travel Times: ${next.count} of ${s.monthlyCap} monthly Google requests used.`);
    }
    store.save(next);
    return inner(req);
  };
}
