/* ============================================================================
   EPROSTA — date, time and money formatting
   ----------------------------------------------------------------------------
   ONE format across the whole product. The live app used `27.07.2026 00:00` on
   detail and `Mon, 27 Jul` on the list, and printed `00:00` as if midnight were
   a real start time.

   Fixes carried over from the vanilla build: "In -4 days", "In -1 days", and
   `00:00` shown as a real time.
   ========================================================================== */

import { NOW } from '@/data/db';
import type { Tone } from '@/data/types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export type DateLike = string | number | Date;

const d = (v: DateLike): Date => (v instanceof Date ? v : new Date(v));

/**
 * Copies before truncating. `d()` returns the SAME object when handed a Date,
 * so a naive version mutates its argument: fmtRange() computes `sameDay` first
 * and thereby zeroes the very times it is about to print ("Sat, 1 Aug · All
 * day" for an 07:00–19:00 shift), and any dayDiff(NOW, x) quietly moves NOW
 * back to midnight for the rest of the session.
 */
const startOfDay = (v: DateLike): Date => {
  const x = new Date(d(v).getTime());
  x.setHours(0, 0, 0, 0);
  return x;
};

/** Whole days between two dates, ignoring time-of-day. Signed. */
export function dayDiff(from: DateLike, to: DateLike): number {
  return Math.round((+startOfDay(to) - +startOfDay(from)) / 86400000);
}

/** "Mon, 27 Jul" — the one date format. */
export function fmtDate(v: DateLike): string {
  const x = d(v);
  return `${DAYS[x.getDay()]}, ${x.getDate()} ${MONTHS[x.getMonth()]}`;
}

export function fmtDateFull(v: DateLike): string {
  const x = d(v);
  return `${DAYS[x.getDay()]}, ${x.getDate()} ${MONTHS[x.getMonth()]} ${x.getFullYear()}`;
}

/**
 * "07:00". Returns null for midnight so callers can print "All day" instead of
 * the meaningless 00:00 that was everywhere.
 */
export function fmtTime(v: DateLike): string | null {
  const x = d(v);
  if (x.getHours() === 0 && x.getMinutes() === 0) return null;
  return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`;
}

/** "Mon, 27 Jul · 07:00" or "Mon, 27 Jul · All day" */
export function fmtDateTime(v: DateLike, allDay?: boolean): string {
  const t = allDay ? null : fmtTime(v);
  return `${fmtDate(v)} · ${t || 'All day'}`;
}

/** "Mon, 27 Jul 07:00 → Mon, 3 Aug 19:00", collapsed when same day. */
export function fmtRange(startV: DateLike, endV: DateLike, allDay?: boolean): string {
  const s = d(startV);
  const e = d(endV);
  const sameDay = +startOfDay(s) === +startOfDay(e);
  const st = allDay ? null : fmtTime(s);
  const et = allDay ? null : fmtTime(e);
  if (sameDay) {
    if (!st && !et) return `${fmtDate(s)} · All day`;
    if (st && et && st === et) return `${fmtDate(s)} · ${st}`;
    return `${fmtDate(s)} · ${st || '00:00'}–${et || '00:00'}`;
  }
  return `${fmtDate(s)}${st ? ' ' + st : ''} → ${fmtDate(e)}${et ? ' ' + et : ''}`;
}

/**
 * Shift-length durations read naturally in hours ("12h"); a multi-day festival
 * does not — "180h" is not a number anyone can picture.
 */
export function fmtDuration(startV: DateLike, endV: DateLike): string | null {
  const mins = Math.round((+d(endV) - +d(startV)) / 60000);
  if (mins <= 0) return null;
  if (mins >= 48 * 60) return `${Math.round(mins / 1440)} days`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export type TimingPhase = 'live' | 'past' | 'imminent' | 'soon' | 'later';

export interface Timing {
  label: string;
  tone: Tone;
  phase: TimingPhase;
}

/**
 * Human timing relative to now. Replaces the "In -4 days" bug outright: an
 * event that has already started is Live, not negatively in the future.
 */
export function timing(startV: DateLike, endV?: DateLike | null): Timing {
  const s = d(startV);
  const e = d(endV || startV);
  if (NOW >= s && NOW <= e) return { label: 'Live now', tone: 'critical', phase: 'live' };
  if (NOW > e) {
    const ago = dayDiff(e, NOW);
    if (ago === 0) return { label: 'Ended today', tone: 'neutral', phase: 'past' };
    if (ago === 1) return { label: 'Ended yesterday', tone: 'neutral', phase: 'past' };
    if (ago < 7) return { label: `Ended ${ago} days ago`, tone: 'neutral', phase: 'past' };
    return { label: `Ended ${fmtDate(e)}`, tone: 'neutral', phase: 'past' };
  }
  const inDays = dayDiff(NOW, s);
  if (inDays === 0) return { label: 'Starts today', tone: 'critical', phase: 'imminent' };
  if (inDays === 1) return { label: 'Starts tomorrow', tone: 'atRisk', phase: 'imminent' };
  if (inDays < 7) return { label: `In ${inDays} days`, tone: 'info', phase: 'soon' };
  if (inDays < 14) return { label: 'Next week', tone: 'neutral', phase: 'later' };
  return { label: `In ${Math.round(inDays / 7)} weeks`, tone: 'neutral', phase: 'later' };
}

/* ------------------------------------------------------------------ money -- */

export interface MoneyOptions {
  compact?: boolean;
  /** `false` drops the pence. */
  pence?: boolean;
}

export function money(n: number | null | undefined, opts: MoneyOptions = {}): string {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (opts.compact && abs >= 1000) {
    return `${n < 0 ? '−' : ''}£${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
  }
  return `${n < 0 ? '−' : ''}£${abs.toLocaleString('en-GB', {
    minimumFractionDigits: opts.pence === false ? 0 : 2,
    maximumFractionDigits: opts.pence === false ? 0 : 2,
  })}`;
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** ISO string `n` days from `v`. Negative `n` walks backwards. */
export function addDays(v: DateLike, n: number): string {
  const x = new Date(v);
  x.setDate(x.getDate() + n);
  return x.toISOString();
}

export function countLabel(n: number, one: string, many?: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many || one + 's'}`;
}

/** Percentage, guarding the divide-by-zero that renders as `NaN%`. */
export const safePct = (num: number, den: number): number =>
  den ? Math.round((num / den) * 100) : 0;
