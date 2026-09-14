/* ============================================================================
   EPROSTA — THE CLOCK
   ----------------------------------------------------------------------------
   `NOW` used to be `new Date('2026-07-31T09:20:00')` — a frozen constant, so
   the prototype behaved identically for everyone. That was the right call while
   the seed was the only data in the system. It stopped being the right call the
   moment records could be created: you add an event dated today, the list
   window is computed from a `NOW` eleven days in the past, and your event is
   either missing or filed under the wrong week. The screen looks broken and the
   user has no way to know the clock is the reason.

   So the clock is real: `NOW` is `new Date()`.

   THE PROBLEM THAT CREATES, AND THE FIX
   -------------------------------------
   A real clock against a fixed seed means the seed rots. Every event drifts
   into the past, "in 3 days" becomes "started 40 days ago", every coverage
   urgency score collapses, and the dashboard reads as a museum.

   The fix is to move the seed rather than freeze the clock. On first run we
   record today's date as the install anchor and derive a whole-number-of-weeks
   offset from the date the seed was authored against. Every date in the seed is
   shifted by that offset as it loads.

   WHY WHOLE WEEKS
   ---------------
   Weekday alignment is load-bearing in this data. Festivals run Fri–Sun, race
   days are Saturdays, the build days are midweek. Shifting by an arbitrary
   number of days would put Reading Festival on a Tuesday. Shifting by whole
   weeks moves the data forward while keeping every event on the day of the week
   it was designed for, and keeps the Monday-first week grouping honest.

   WHY THE OFFSET IS PERSISTED RATHER THAN RECOMPUTED
   --------------------------------------------------
   Records the user creates are stored with absolute dates. If the offset were
   recomputed from `new Date()` on every load, the seed would creep forward each
   week while the user's own records stayed put, and the two would slowly pull
   apart. Pinning the offset at first run keeps them in the same frame of
   reference for the life of the browser profile. `reanchor()` moves the whole
   world forward deliberately, which is a different thing from it happening by
   accident.
   ========================================================================== */

/** The date the seed data was written against. Nothing else may reference it. */
export const SEED_ANCHOR = '2026-07-31';

const KEY = 'eprosta.clock.v1';
const DAY = 86_400_000;

/** Real wall-clock time. Everything date-related in the app derives from this. */
export const NOW = new Date();

/* --------------------------------------------------------------- anchoring */

function todayISO(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Midnight local on a `YYYY-MM-DD`, avoiding the UTC parse of `new Date(s)`. */
function midnight(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function readAnchor(): string {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  } catch {
    /* private mode — fall through to a session-only anchor */
  }
  const fresh = todayISO();
  try {
    localStorage.setItem(KEY, fresh);
  } catch {
    /* private mode — degrades to a per-session shift, which is still correct */
  }
  return fresh;
}

/** The install anchor: the real date this browser first opened the app. */
export const INSTALL_ANCHOR = readAnchor();

/**
 * Whole weeks between the seed anchor and the install anchor.
 *
 * Rounded to nearest rather than floored. Flooring can leave the seed up to
 * six days behind real time, which is enough to push the events the seed
 * designed to be "live now" into the past and empty the dashboard of the
 * states it exists to demonstrate. Rounding caps the drift at three and a half
 * days in either direction.
 */
export const SHIFT_DAYS: number =
  Math.round((+midnight(INSTALL_ANCHOR) - +midnight(SEED_ANCHOR)) / DAY / 7) * 7;

/* ---------------------------------------------------------------- shifting */

/** `YYYY-MM-DD`, optionally `THH:MM`, `THH:MM:SS`, or with a trailing `Z`. */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?$/;

/**
 * Move one date string by the install offset, preserving its exact shape.
 *
 * Date arithmetic goes through local `Date` parts rather than `toISOString()`.
 * `toISOString()` converts to UTC, and in any timezone ahead of UTC — BST, for
 * one — that rolls an 00:00 date back to the previous day. The same bug the
 * events list had in its week grouping.
 */
export function shiftISO(value: string): string {
  const m = DATE_RE.exec(value);
  if (!m) return value;
  if (SHIFT_DAYS === 0) return value;

  const [, y, mo, d, time = ''] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d) + SHIFT_DAYS);
  const shifted =
    `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  return shifted + time;
}

export interface ShiftOptions {
  /**
   * Property names whose values are already in shifted time and must not move
   * again. The one real case is a WOF line's `snap`: it is resolved from the
   * charge table *after* the table has been shifted, so its `rateVersion` is
   * already a shifted date. Shifting it a second time would make
   * `lineIsStale()` compare two different time frames and report every line as
   * stale the moment the offset is non-zero.
   */
  skip?: readonly string[];
}

/**
 * Recursively shift every date-shaped string in a structure, in place.
 *
 * Only strings matching `DATE_RE` in full are touched, so free text that
 * happens to mention a date, NI numbers, job codes and ids are all left alone.
 * Cycles are tracked because the seed cross-links events and WOFs.
 */
export function shiftDeep<T>(value: T, opts: ShiftOptions = {}): T {
  if (SHIFT_DAYS === 0) return value;
  return walk(value, new WeakSet<object>(), opts.skip ? new Set(opts.skip) : null);
}

function walk<T>(value: T, seen: WeakSet<object>, skip: Set<string> | null): T {
  if (typeof value === 'string') return shiftISO(value) as unknown as T;
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = walk(value[i], seen, skip);
    return value;
  }

  if (value instanceof Date) return value;

  const rec = value as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    if (skip && skip.has(k)) continue;
    rec[k] = walk(rec[k], seen, skip);
  }
  return value;
}

/* ------------------------------------------------------------------ resets */

/**
 * Re-anchor the world to today.
 *
 * The caller is responsible for clearing the other stores and reloading — a
 * re-anchor moves the seed but not the records the user has created, and
 * leaving both in place would put them in two different frames of reference.
 */
export function reanchor(): void {
  try {
    localStorage.setItem(KEY, todayISO());
  } catch {
    /* private mode */
  }
}

/** How far the seed has been moved, for the "why does this say 2026?" question. */
export function clockNote(): string {
  if (SHIFT_DAYS === 0) return 'Sample data is shown against its original dates.';
  const weeks = SHIFT_DAYS / 7;
  return `Sample data shifted forward ${weeks} ${weeks === 1 ? 'week' : 'weeks'} so it sits around today.`;
}

/**
 * How many days real today has run past the seed's idea of today.
 *
 * The offset is pinned at first run on purpose (see above), so a profile that
 * has been open for a couple of months is looking at a seed anchored to a
 * couple of months ago: jobs designed to be "next week" read as "ended three
 * weeks ago" and the whole board files itself under the wrong month. That is
 * not a bug to fix silently — re-anchoring discards the user's own records —
 * but it is something the settings screen has to be able to SAY, and offer to
 * put right. Positive means the seed is behind; it is never meaningfully
 * negative outside a clock that has been wound back.
 */
export function seedDrift(): number {
  const elapsed = Math.round((+midnight(todayISO()) - +midnight(SEED_ANCHOR)) / DAY);
  return elapsed - SHIFT_DAYS;
}

/** The seed's own "today" as a real date — what the sample data is posed around. */
export function seedToday(): Date {
  return new Date(+midnight(todayISO()) - seedDrift() * DAY);
}
