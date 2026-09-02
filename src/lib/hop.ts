/* ============================================================================
   EP HOP — THE STOCK REGISTER
   ----------------------------------------------------------------------------
   What EP owns, how much of it is on a shelf right now, and what is already
   promised to somebody else.

   `wof.ts` has always been able to quote 400 barriers. It has never been able
   to say whether EP has 400 barriers, because a `Charge` is a price and not a
   thing. This module is the thing.

   WHY THE COUNT IS NOT A COLUMN ON `Charge`
   -----------------------------------------
   The obvious move is `owned: number` on the charge row, and it is wrong for
   the same reason places did not go on `EventLocation`.

   `Charge` is the money layer. It is versioned by `effectiveFrom`, carries
   `history` and `tiers`, and its entire job is answering "what did this cost on
   the day it was quoted" — which is why `LineItem.snap` freezes a
   `ResolvedRate` onto every line. Stock is not that kind of fact. It is
   physical and present tense: it changes when EP buys forty more radios, and it
   must never be frozen onto a line. A quote raised in April keeps April's
   price and is judged against TODAY'S shelf.

   Keeping them apart also keeps the permissions honest. `charges.edit` is
   Finance — what EP pays and what the client is charged. `kit.stock` is the
   warehouse — how many exist. Two different people; one row would have forced
   them onto one screen.

   QUANTITIES, NOT ASSETS
   ----------------------
   EP hires out 250 radios, not radio #187. Barrier #43 is a meaningless
   object. A per-asset register buys serial-level history and costs an asset
   table, a scanning workflow and a reconciliation screen before the first
   useful number appears. The three things where serial identity genuinely
   matters — the buggy, the welfare unit, the cabin — number about a dozen
   objects and are tracked on paper today. If it is ever wanted it is additive:
   a `StockAsset` table keyed by `chargeId`, with `owned` becoming derived.

   AVAILABILITY COMES FROM WINDOWS, NOT FROM SCANS
   -----------------------------------------------
   Kit returns to the shelf because its hire window passed, not because
   somebody scanned it back in. That is what makes the return leg a later
   phase rather than a prerequisite, and it is optimistic in exactly one
   stated way: kit that never came back still frees on schedule. Until the
   return leg exists the warehouse compensates in `outOfService`, by hand.

   THE DIRECTION OF THE IMPORT
   ---------------------------
   This module imports from `wof.ts` and `wof.ts` never imports from here.
   `wof.ts` is 6,150 lines and the module graph must not cycle. The only thing
   the WOF side ever learns about stock is a guard it is handed, later.
   ========================================================================== */

import { CHARGES, NOW, STOCK_SEED, charge as chargeById } from '@/data/db';
import type { Charge, Tone } from '@/data/types';
import { addDays, countLabel } from './format';
import * as ROLES from './roles';
import * as CHARGES_LIB from './charges';
import * as W from './wof';

const KEY = 'eprosta.hop.v1';

/* ==========================================================================
   1. THE ITEM
   ========================================================================== */

export interface StockItem {
  /** Into `CHARGES`. One kit charge, one stock item. The join, and the key. */
  chargeId: string;
  /** Physically owned when nothing is out. Changed by the warehouse. */
  owned: number;
  /**
   * Away for repair, PAT test or written off.
   *
   * Held apart from `owned` rather than subtracted from it so "we own 250" and
   * "we can send 230" stay separable. One is an asset fact that belongs on an
   * insurance schedule; the other is this week.
   */
  outOfService: number;
  /**
   * Days after a job's last hire day before the item is issuable again:
   * collection, check-in, charge, test.
   *
   * Not padding. A radio out on the Sunday is not re-issuable on Monday
   * morning, and without this the register is confidently wrong at exactly the
   * moment two festivals sit back to back — which in August is most of them.
   * Zero is legitimate for a consumable, which never comes back at all.
   */
  turnaround: number;
  /** Which shelf, cage or van. Orders the picking list — a picker walks once. */
  location: string;
  /** Warehouse note: "12 awaiting new batteries". */
  note: string;
  /**
   * Free stock below this badges the register. Consumables only — see
   * `isConsumable`. A re-order level on a rented item is meaningless, because
   * the stock is not being used up, it is out and coming back.
   */
  reorderAt?: number;
  /**
   * Into `CHARGES` — what a client is charged when this does not come back.
   *
   * A pointer rather than a number, so the price lives in the money layer with
   * every other price: versioned, frozen onto a line by `snap`, owned by
   * Finance. The warehouse says what was lost; Finance says what that costs.
   */
  replacementChargeId?: string;
}

/**
 * A consumable is issued, not lent. Branded hi-vis leaves and does not return.
 *
 * The distinction is `Charge.unit`, which already carries it: `'day'` is a
 * rental and occupies a window, `'each'` is issued and draws `owned` down for
 * good. Conflating the two is how a register ends up claiming EP has lost four
 * thousand cones.
 */
export const isConsumable = (c: Charge | undefined): boolean =>
  !!c && c.kind === 'kit' && c.unit === 'each';

/* ==========================================================================
   2. STORE
   --------------------------------------------------------------------------
   Journalled in the shape `clients.ts` uses rather than the full-set shape
   `roles.ts` uses, and the difference is deliberate. Permissions store the
   exact set because a delta would widen access on its own. Stock has no such
   hazard: a count is a count, and journalling the edits means a better seed
   figure in a later release still lands for every item nobody has touched.
   ========================================================================== */

interface StockEdit {
  owned?: number;
  outOfService?: number;
  turnaround?: number;
  location?: string;
  note?: string;
  reorderAt?: number;
}

/**
 * One change to a count, kept forever.
 *
 * "Who wrote 250 down, when, and why" is the first question asked the day the
 * number is wrong, and it is unanswerable from a bare journal of end states.
 * `kit.stock` can unblock any job by typing a bigger number — this is the
 * record that makes that visible rather than merely possible.
 */
export interface StockChange {
  chargeId: string;
  at: string;
  by: string;
  byName: string;
  field: keyof StockEdit;
  from: number | string;
  to: number | string;
  reason: string;
}

interface Journal {
  v: 1;
  edits: Record<string, StockEdit>;
  log: StockChange[];
}

const EMPTY: Journal = { v: 1, edits: {}, log: [] };

function loadJournal(): Journal {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!raw || raw.v !== 1) return { ...EMPTY, edits: {}, log: [] };
    return { v: 1, edits: raw.edits || {}, log: Array.isArray(raw.log) ? raw.log : [] };
  } catch {
    return { ...EMPTY, edits: {}, log: [] };
  }
}

function saveJournal(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(JOURNAL));
  } catch {
    /* private mode */
  }
}

let JOURNAL: Journal = loadJournal();

/**
 * Items created on the stock register rather than shipped in the seed.
 *
 * Journalled separately from the count edits above, because they are different
 * facts: `edits` is "this seeded item's number changed", and this is "this
 * thing exists at all". Merging them would make a store written before the
 * register could grow unreadable by one that can.
 */
const CUSTOM_KEY = 'eprosta.hop.items.v1';

function loadCustom(): StockItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_KEY) || 'null');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveCustom(): void {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(CUSTOM_ITEMS));
  } catch {
    /* private mode */
  }
}

const CUSTOM_ITEMS: StockItem[] = loadCustom();

/** Live register: the seed, plus anything added here, with the journal over it. */
export const STOCK: StockItem[] = [
  ...STOCK_SEED.map((s) => ({ ...s })),
  ...CUSTOM_ITEMS.map((s) => ({ ...s })),
];

function applyJournal(): void {
  STOCK.forEach((item) => {
    const e = JOURNAL.edits[item.chargeId];
    if (!e) return;
    // An item added on the register has no seed row to fall back to — its own
    // stored record IS the baseline.
    const seed = STOCK_SEED.find((s) => s.chargeId === item.chargeId)
      || CUSTOM_ITEMS.find((s) => s.chargeId === item.chargeId)
      || item;
    item.owned = e.owned ?? seed.owned;
    item.outOfService = e.outOfService ?? seed.outOfService;
    item.turnaround = e.turnaround ?? seed.turnaround;
    item.location = e.location ?? seed.location;
    item.note = e.note ?? seed.note;
    item.reorderAt = e.reorderAt ?? seed.reorderAt;
  });
}
applyJournal();

const listeners = new Set<() => void>();
let version = 0;
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export const getVersion = (): number => version;
function emit(): void {
  version += 1;
  listeners.forEach((fn) => fn());
}

/* ==========================================================================
   3. READING THE REGISTER
   ========================================================================== */

export const stockItem = (chargeId: string): StockItem | undefined =>
  STOCK.find((s) => s.chargeId === chargeId);

/**
 * Is this charge stock-controlled at all?
 *
 * A kit charge with no `StockItem` is UNMANAGED, and that is a real state
 * rather than an oversight: EP does not own the diesel tower lights, it
 * sub-hires them from a supplier. Treating a missing item as zero stock would
 * put a false shortfall on every job that quotes four.
 */
export const isManaged = (chargeId: string): boolean => !!stockItem(chargeId);

/**
 * Charges that exist to PRICE a replacement rather than to hire a thing.
 *
 * They are `kind: 'kit'` because that is what they are money for, and Finance
 * should find them beside the day rates. But they are not objects on a shelf:
 * they have no stock, they are never picked, and showing them on the register
 * — even in the "not stock-controlled" list, which means "we sub-hire this" —
 * would be answering a question nobody asked with a fact that is not true.
 *
 * Derived from the register rather than a naming convention, so adding a
 * replacement charge and pointing an item at it is the only step.
 */
const replacementIds = (): Set<string> =>
  new Set(STOCK.map((s) => s.replacementChargeId).filter((id): id is string => !!id));

/** Every kit charge that is a thing EP hires out, in charge-table order. */
export const kitCharges = (): Charge[] => {
  const rep = replacementIds();
  return CHARGES.filter((c) => c.kind === 'kit' && !rep.has(c.id));
};

/**
 * Is this charge a replacement price rather than a thing EP hires out?
 *
 * The same derived set `kitCharges()` uses to keep them off the register,
 * exposed because the quote builder needs the same answer. A replacement
 * charge sold as an ordinary hire line is kit that draws no stock, can never
 * be short, and — because a replacement has no replacement of its own — can
 * never be recharged when it does not come back.
 */
export const isReplacementCharge = (chargeId: string): boolean => replacementIds().has(chargeId);

/** What the client is charged for one of these not coming back. */
export const replacementCharge = (chargeId: string): Charge | undefined => {
  const id = stockItem(chargeId)?.replacementChargeId;
  return id ? chargeById(id) : undefined;
};

export const stockList = (): StockItem[] =>
  kitCharges()
    .map((c) => stockItem(c.id))
    .filter((s): s is StockItem => !!s);

/** On the shelf when nothing is out. The ceiling every window is judged against. */
export const issuable = (item: StockItem): number =>
  Math.max(0, item.owned - item.outOfService);

export const changeLog = (chargeId?: string): StockChange[] =>
  JOURNAL.log
    .filter((c) => !chargeId || c.chargeId === chargeId)
    .slice()
    .sort((a, b) => b.at.localeCompare(a.at));

/* ==========================================================================
   4. WHAT IS ALREADY PROMISED
   --------------------------------------------------------------------------
   ONLY ORDERED JOBS DRAW STOCK. This is the single most important rule in the
   module and every number below depends on it.

   If a quote held stock the register would fill with phantom demand from jobs
   that never happen — quoting is speculative by design and half of these never
   land. Every item would read as fully committed by March and the warning
   would be ignored inside a week, which is worse than no warning at all.

   Quoted-but-unsigned work is real information, so it is computed separately
   and reported as PRESSURE: what is coming, weaker, never a block.

   Cancelled and lost jobs draw nothing. `atLeast` answers true for every
   terminal state — it is asking "has this passed the stage", and a cancelled
   job has passed all of them — so terminals are excluded explicitly here
   rather than leaning on it.
   ========================================================================== */

const dayOf = (iso: string): string => iso.slice(0, 10);

/** One line's claim on one item. Dates inclusive; `to` already includes turnaround. */
export interface Commitment {
  wofId: string;
  ref: string;
  title: string;
  lineId: string;
  qty: number;
  /** The line's own last hire day, before turnaround. What the client sees. */
  hireTo: string;
  from: string;
  to: string;
  /** A consumable is issued, not lent: it never comes back and `to` is open. */
  consumable: boolean;
}

/**
 * The calendar date of day `n` (1-based) of a job's span.
 *
 * Day numbers here are the job's WORKING days — the same ones `liveWindow`,
 * `dayKind` and `LinePattern.days` count, via `spanWindows`. That is not the
 * same as "every date between `start` and `end`" when a job's end timestamp
 * lands on a day boundary, and the working-day count is the one to follow: two
 * answers to "which day is day 4 of this job" is precisely the disagreement
 * the shared coordinate system exists to prevent. The direction of the
 * difference is also the safe one — stock is never held a day longer than the
 * job is actually running.
 */
const dateOfDay = (w: W.Wof, n: number): string => dayOf(addDays(w.start, n - 1));

/**
 * Per LINE, not per job.
 *
 * Two kit lines on one job can be out on different days — the barriers for the
 * whole build, the tower lights for the two event nights — and summing them to
 * a job total would spread both across the union of their windows. That is the
 * failure this function exists to avoid, so the window is read from the line.
 */
function claims(chargeId: string, ordered: boolean): Commitment[] {
  const item = stockItem(chargeId);
  if (!item) return []; // unmanaged: nothing to promise against
  const consumable = isConsumable(chargeById(chargeId));
  const out: Commitment[] = [];

  W.all().forEach((w) => {
    if (!w.active || W.isTerminal(w.stage)) return;
    const isOrdered = W.atLeast(w, 'order');
    if (isOrdered !== ordered) return;

    w.lines.forEach((l) => {
      if (l.kind !== 'kit' || l.chargeId !== chargeId || !l.qty) return;
      // Sub-hired: it comes from a supplier, so EP's shelf is untouched.
      if (l.subHire) return;

      const h = W.hireWindow(w, l);
      if (!h.days) return;
      const lastDay = dateOfDay(w, h.to);

      out.push({
        wofId: w.id, ref: w.ref, title: w.title, lineId: l.id, qty: l.qty, consumable,
        hireTo: lastDay,
        from: dateOfDay(w, h.from),
        to: consumable ? '9999-12-31' : dayOf(addDays(`${lastDay}T12:00:00`, item.turnaround)),
      });
    });
  });

  return out.sort((a, b) => a.from.localeCompare(b.from));
}

/** Everything ordered work has promised of this item. The draw. */
export const commitments = (chargeId: string): Commitment[] => claims(chargeId, true);

/** Everything quoted-but-unsigned work would want. Information, never a block. */
export const pressure = (chargeId: string): Commitment[] => claims(chargeId, false);

/* ==========================================================================
   5. AVAILABILITY
   --------------------------------------------------------------------------
   A single "free" number is a lie the moment two jobs overlap, so the unit of
   truth is a DAY and everything else is derived from a run of them.
   ========================================================================== */

export interface DayFree {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Committed by ordered work on this day. */
  committed: number;
  /** Wanted by quoted work on this day. Not subtracted from `free`. */
  pressure: number;
  /** `issuable - committed`. Negative is a genuine oversubscription. */
  free: number;
}

const covers = (c: Commitment, date: string): boolean => date >= c.from && date <= c.to;

/**
 * Day-by-day availability across a range, inclusive of both ends.
 *
 * Unmanaged charges return an empty array rather than a run of zeroes. "We do
 * not track this" and "we have none of this" are different answers and the
 * screen must be able to tell them apart.
 */
export function availability(chargeId: string, from: string, to: string): DayFree[] {
  const item = stockItem(chargeId);
  if (!item) return [];

  const ceiling = issuable(item);
  const drawn = commitments(chargeId);
  const wanted = pressure(chargeId);
  const out: DayFree[] = [];

  let cursor = dayOf(from);
  const last = dayOf(to);
  // Bounded rather than `while (true)`: a bad range must return nothing useful,
  // not hang the tab. Two years is far past any horizon this screen offers.
  for (let guard = 0; cursor <= last && guard < 800; guard++) {
    const committed = drawn.filter((c) => covers(c, cursor)).reduce((s, c) => s + c.qty, 0);
    out.push({
      date: cursor,
      committed,
      pressure: wanted.filter((c) => covers(c, cursor)).reduce((s, c) => s + c.qty, 0),
      free: ceiling - committed,
    });
    cursor = dayOf(addDays(`${cursor}T12:00:00`, 1));
  }
  return out;
}

/** Free on one day. `null` when the charge is unmanaged. */
export function freeOn(chargeId: string, date: string): number | null {
  const days = availability(chargeId, date, date);
  return days.length ? days[0].free : null;
}

/** The horizon the register renders, and the one `kitShort` is counted over. */
export const HORIZON_DAYS = 28;

/** Days in the horizon where ordered work has oversubscribed the shelf. */
export function shortDays(chargeId: string, fromISO: string = NOW.toISOString()): DayFree[] {
  const from = dayOf(fromISO);
  return availability(chargeId, from, dayOf(addDays(fromISO, HORIZON_DAYS))).filter((d) => d.free < 0);
}

/** Items oversubscribed inside the horizon. The rail badge. */
export const shortItems = (): StockItem[] => stockList().filter((s) => shortDays(s.chargeId).length > 0);

/* ==========================================================================
   6. CHANGING A COUNT
   --------------------------------------------------------------------------
   Guarded and journalled. `kit.stock` is marked sensitive in `roles.ts` for a
   reason that is worth restating at the point of the write: the Order gate
   will refuse a job on these numbers, so anybody who can edit them can unblock
   any job by typing a bigger one. The control is not that it cannot be done —
   somebody has to be able to — it is that it cannot be done quietly.

   Every mutation returns `{ ok, reason }` rather than a bare boolean, the same
   contract `roles.ts` uses, so the UI can say why a button is dead instead of
   hiding it and leaving the action live.
   ========================================================================== */

export interface Result {
  ok: boolean;
  reason?: string;
}

const NUMERIC: (keyof StockEdit)[] = ['owned', 'outOfService', 'turnaround', 'reorderAt'];

/**
 * Why this edit is refused, or null.
 *
 * `outOfService > owned` is the one worth spelling out: it is not merely odd,
 * it makes `issuable` negative, and a register that reports minus twelve
 * radios has stopped being a register.
 */
export function setStockBlocker(chargeId: string, patch: StockEdit): string | null {
  if (!ROLES.can('kit.stock')) return 'You do not have permission to change stock counts.';
  const item = stockItem(chargeId);
  if (!item) {
    return chargeById(chargeId)
      ? 'This item is not stock-controlled — EP sub-hires it rather than owning it.'
      : 'No such item.';
  }
  for (const f of NUMERIC) {
    const v = patch[f] as number | undefined;
    if (v === undefined) continue;
    if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) return 'Counts must be whole numbers, and not negative.';
  }
  const owned = patch.owned ?? item.owned;
  const oos = patch.outOfService ?? item.outOfService;
  if (oos > owned) return `Cannot hold ${oos} out of service out of ${owned} owned.`;
  return null;
}

/**
 * Apply an edit, recording every field that actually moved.
 *
 * `reason` is required for a numeric change and ignored for a note. "Counted
 * it" is a poor reason but it is a reason, and demanding one is what turns the
 * log from a list of numbers into something anybody can audit.
 */
export function setStock(chargeId: string, patch: StockEdit, reason: string): Result {
  const blocker = setStockBlocker(chargeId, patch);
  if (blocker) return { ok: false, reason: blocker };

  const item = stockItem(chargeId)!;
  const moved = (Object.keys(patch) as (keyof StockEdit)[]).filter(
    (f) => patch[f] !== undefined && patch[f] !== item[f],
  );
  if (!moved.length) return { ok: true };

  const numericMoved = moved.some((f) => NUMERIC.includes(f));
  if (numericMoved && !reason.trim())
    return { ok: false, reason: 'Say why the count changed — it is the first thing asked when it is wrong.' };

  const actor = ROLES.actingActor();
  const at = NOW.toISOString();
  const edit: StockEdit = { ...(JOURNAL.edits[chargeId] || {}) };

  moved.forEach((f) => {
    JOURNAL.log.push({
      chargeId, at, by: actor.by, byName: actor.name,
      field: f,
      from: item[f] ?? '',
      to: patch[f] as number | string,
      reason: reason.trim(),
    });
    (edit as unknown as Record<string, unknown>)[f] = patch[f];
    (item as unknown as Record<string, unknown>)[f] = patch[f];
  });

  JOURNAL.edits[chargeId] = edit;
  saveJournal();
  emit();
  return { ok: true };
}

/** Test seam and a real "reset to the shipped figures" action. */
export function resetStock(): Result {
  if (!ROLES.can('kit.stock')) return { ok: false, reason: 'You do not have permission to change stock counts.' };
  JOURNAL = { v: 1, edits: {}, log: [] };
  STOCK.forEach((item) => {
    const seed = STOCK_SEED.find((s) => s.chargeId === item.chargeId)
      || CUSTOM_ITEMS.find((s) => s.chargeId === item.chargeId);
    if (seed) Object.assign(item, seed);
  });
  saveJournal();
  emit();
  return { ok: true };
}

/* ==========================================================================
   7. SHORTFALL
   --------------------------------------------------------------------------
   A warning that says "not enough radios" and stops is a warning that gets
   ignored. "180 radios 22–26 Aug; 90 also committed to Boomtown WOF-114 on
   24–25; short 20 on two days" is a warning somebody can act on — they can
   ring Boomtown, or ring a supplier, and they know which.

   So a `Shortfall` names the item, the days, the quantity AND the jobs it
   collides with. Everything the sentence needs is in the object.
   ========================================================================== */

export interface Shortfall {
  chargeId: string;
  /** The item's name, so callers do not each re-resolve the charge. */
  name: string;
  /** This line's own ask, for the sentence. */
  qty: number;
  /** Days inside this line's window where ordered work exceeds the shelf. */
  days: DayFree[];
  /** The worst single day, as a positive number of items missing. */
  short: number;
  /** Other jobs out on the same days. Never includes the line's own job. */
  clashes: Commitment[];
}

/**
 * What one kit line is short, or null when it fits.
 *
 * Judged against the register as it stands INCLUDING this line when the job is
 * already ordered, and as it would stand WITH it when the job is not — because
 * the question at quote is "if we sign this, does it fit", and the question
 * after Order is "does what we already promised fit".
 */
export function lineShortfall(w: W.Wof, l: W.LineItem): Shortfall | null {
  if (l.kind !== 'kit' || l.subHire || !l.qty) return null;
  const h = W.hireWindow(w, l);
  // A line already on the job may already be IN the register's committed
  // figure — see the doc comment. A line that does not exist yet never is.
  const counted = W.atLeast(w, 'order') && !W.isTerminal(w.stage) && w.active;
  return shortfallOver(w, l.chargeId, l.qty, h, counted, l.description);
}

/**
 * What a line WOULD be short, before anybody adds it.
 *
 * The same arithmetic as `lineShortfall`, asked one step earlier. It exists
 * because the shortfall used to be discoverable only after the fact — as a
 * pill on a line that already existed, and as a refusal at the Order gate. A
 * variation is added to a job that is already ordered, so it passes the gate
 * from behind: the check that was written for exactly this case never runs
 * again, and 1,000 cones against 900 on the shelf reached the client's
 * signature with nothing said.
 *
 * Always uncounted, and always the whole span: the line is hypothetical, so
 * the register cannot be carrying it yet, and a line with no hire window on it
 * covers every day of the job.
 */
export function prospectiveShortfall(w: W.Wof, chargeId: string, qty: number): Shortfall | null {
  const charge = chargeById(chargeId);
  if (!charge || charge.kind !== 'kit' || !(qty > 0)) return null;
  const days = W.eventDays(w);
  return shortfallOver(w, chargeId, qty, { from: 1, to: days, days }, false, charge.name);
}

function shortfallOver(
  w: W.Wof,
  chargeId: string,
  qty: number,
  h: { from: number; to: number; days: number },
  counted: boolean,
  fallbackName: string,
): Shortfall | null {
  const item = stockItem(chargeId);
  if (!item) return null; // unmanaged: sub-hired, so it can never be short
  if (!h.days) return null;

  const from = dayOf(addDays(w.start, h.from - 1));
  const to = dayOf(addDays(w.start, h.to - 1));

  const days = availability(chargeId, from, to)
    .map((day) => (counted ? day : { ...day, free: day.free - qty, committed: day.committed + qty }))
    .filter((day) => day.free < 0);
  if (!days.length) return null;

  const window = new Set(days.map((day) => day.date));
  return {
    chargeId,
    name: chargeById(chargeId)?.name || fallbackName,
    qty,
    days,
    short: Math.max(...days.map((day) => -day.free)),
    clashes: commitments(chargeId).filter(
      (c) => c.wofId !== w.id && availableDates(c).some((date) => window.has(date)),
    ),
  };
}

/** The dates a commitment covers, capped so an open-ended consumable terminates. */
function availableDates(c: Commitment): string[] {
  const out: string[] = [];
  let cursor = c.from;
  for (let guard = 0; cursor <= c.to && guard < 400; guard++) {
    out.push(cursor);
    cursor = dayOf(addDays(`${cursor}T12:00:00`, 1));
  }
  return out;
}

/** Every shortfall on a job. The Order gate's input. */
export const wofShortfalls = (w: W.Wof): Shortfall[] =>
  w.lines.map((l) => lineShortfall(w, l)).filter((s): s is Shortfall => !!s);

/**
 * The sentence the Order gate refuses with, and the quote line's hint.
 *
 * `opts.name` false where the caller has already said which item it is —
 * "Not enough radios in stock. Radios: 120 wanted…" reads like a machine
 * talking to itself, and a block nobody finishes reading is a block nobody
 * acts on.
 */
export function describeShortfall(s: Shortfall, opts: { name?: boolean } = {}): string {
  const when =
    s.days.length === 1
      ? `on ${s.days[0].date}`
      : `on ${s.days.length} days from ${s.days[0].date}`;
  const who = s.clashes.length
    ? ` — ${s.clashes.map((c) => `${c.qty} committed to ${c.ref}`).join(', ')}`
    : '';
  return `${opts.name === false ? '' : `${s.name}: `}${s.qty} wanted, ${s.short} short ${when}${who}.`;
}

/* ==========================================================================
   8. THE ORDER GATE
   --------------------------------------------------------------------------
   Registered rather than imported — see `registerStockGuard` in `wof.ts` for
   why the dependency runs this way round.

   Two escapes are offered by name in the refusal, because a block that does
   not say what to do about it is a block people work around by not using the
   system: reduce the line, or mark it sub-hire. Sub-hire is not a loophole,
   it is what EP already does when the yard is empty.
   ========================================================================== */

W.registerStockGuard((w) =>
  wofShortfalls(w).map(
    (s) =>
      `Not enough ${s.name} in stock — ${describeShortfall(s, { name: false })} Reduce the line, narrow its hire window, or mark it sub-hire.`,
  ),
);

/* ==========================================================================
   9. THE PREP
   --------------------------------------------------------------------------
   The other end of the push.

   `Picking.status` was a free-text string the seed wrote and no screen in the
   running app could ever change — 'Picking in progress' on a job nobody was
   picking. `PrepJob` replaces it with a state somebody moves, a person who
   holds it, and a per-line record of what actually went on the vehicle.

   WHY SHORTAGE IS A FLAG AND NOT A STATE
   --------------------------------------
   A job can be picking, picked and loaded while known to be two tower lights
   short. Modelling that as a state would force the warehouse to choose between
   "picked" and "short" — and they would choose "picked", because the vehicle is
   loaded and the job is going out. The flag is derived from the lines, so it
   cannot be set to disagree with them.

   WHY `wanted` IS COPIED AND NOT READ LIVE
   ----------------------------------------
   The same reason `Picking.manifest` already exists: the difference between
   what the warehouse was TOLD and what the quote NOW says is the number that
   matters, and it cannot be computed if one side is a live read. A quote edit
   after the send must move `kitChangesSincePush`, not silently rewrite what
   the picker was asked for.
   ========================================================================== */

/**
 * Where a job has got to in the warehouse.
 *
 * Ordered, and only ever moved one step at a time — `advancePrep` refuses a
 * skip. A job that reached `loaded` without anybody claiming they picked it is
 * a job with no record of who did.
 */
export const PREP_STATES = ['sent', 'picking', 'picked', 'loaded', 'out', 'returned'] as const;
export type PrepState = (typeof PREP_STATES)[number];

export const PREP_META: Record<PrepState, { label: string; blurb: string; tone: Tone }> = {
  sent:     { label: 'Sent',     blurb: 'The office pushed the list. Nobody has opened it.', tone: 'neutral' },
  picking:  { label: 'Picking',  blurb: 'Somebody is on it.', tone: 'info' },
  picked:   { label: 'Picked',   blurb: 'Every line accounted for, including the short ones.', tone: 'info' },
  loaded:   { label: 'Loaded',   blurb: 'On the vehicle.', tone: 'info' },
  out:      { label: 'Out',      blurb: 'With the job.', tone: 'healthy' },
  returned: { label: 'Returned', blurb: 'Back on site.', tone: 'healthy' },
};

export interface PrepLine {
  lineId: string;
  /** Copied from the manifest at send. Never a live read — see the header. */
  wanted: number;
  /** Actually picked. Less than `wanted` is a real, reportable state. */
  picked: number;
  note: string;
  /* --- the return leg. All three are undefined until check-in. ----------- */
  /** Came back fit to hire again. */
  back?: number;
  /** Came back broken. EP still has the object; it cannot go out. */
  damaged?: number;
  /** Did not come back at all. */
  lost?: number;
  /** Set once the recharge variation has been raised, so it cannot be raised twice. */
  rechargedAt?: string;
  /**
   * The variation line that recharge became.
   *
   * Held so the stamp can be checked against the work order rather than
   * trusted on its own: delete the variation and the charge does not exist, so
   * neither does the reason this line is locked. See `reconcileRecharges`.
   */
  rechargeLineId?: string;
}

export interface PrepJob {
  wofId: string;
  state: PrepState;
  /** Member id of whoever picked it up, or null while it is only `sent`. */
  heldBy: string | null;
  /** When the list first arrived. Does not move on a re-send. */
  openedAt: string;
  /** When the state last moved. */
  updatedAt: string;
  lines: PrepLine[];
  /** Lines the last re-send changed, so the picker sees what to re-pick. */
  amended: string[];
}

/* --------------------------------------------------------------- the store */

interface PrepJournal {
  v: 1;
  jobs: Record<string, PrepJob>;
}

const PREP_KEY = 'eprosta.hop.prep.v1';

function loadPreps(): Record<string, PrepJob> {
  try {
    const raw = JSON.parse(localStorage.getItem(PREP_KEY) || 'null') as PrepJournal | null;
    return raw && raw.v === 1 && raw.jobs ? raw.jobs : {};
  } catch {
    return {};
  }
}

function savePreps(): void {
  try {
    localStorage.setItem(PREP_KEY, JSON.stringify({ v: 1, jobs: PREPS } satisfies PrepJournal));
  } catch {
    /* private mode */
  }
}

let PREPS: Record<string, PrepJob> = loadPreps();

export const prep = (wofId: string): PrepJob | null => PREPS[wofId] || null;

/** Every job in the warehouse, soonest needed first. See `queue`. */
export const preps = (): PrepJob[] => Object.values(PREPS);

/**
 * Short on at least one line — derived, never stored.
 *
 * A stored flag could be set to disagree with the lines under it, and the
 * lines are the thing somebody actually counted.
 */
export const isShort = (p: PrepJob): boolean => p.lines.some((l) => l.picked < l.wanted);

export const prepProgress = (p: PrepJob): { picked: number; wanted: number } => ({
  picked: p.lines.reduce((s, l) => s + l.picked, 0),
  wanted: p.lines.reduce((s, l) => s + l.wanted, 0),
});

/* ------------------------------------------------------------ the transitions */

/**
 * Open or amend a job's prep, from the manifest the office just sent.
 *
 * Called by `sendToHop`. The rule that matters is on a RE-SEND: the prep is not
 * reset. Lines whose quantity moved are marked `amended` and their pick is
 * zeroed; every other line keeps what was already picked. Throwing away a
 * morning's picking because one cone quantity changed is how a warehouse
 * learns to ignore the amendment banner — which is the failure
 * `kitChangesSincePush` exists to prevent, arriving by a different door.
 */
export function openPrep(w: W.Wof, manifest: { lineId: string; qty: number }[]): PrepJob {
  const at = NOW.toISOString();
  const before = PREPS[w.id];
  const amended: string[] = [];

  const lines: PrepLine[] = manifest.map((m) => {
    const was = before?.lines.find((l) => l.lineId === m.lineId);
    if (!was) {
      // New line on an existing prep is an amendment too — nobody has picked it.
      if (before) amended.push(m.lineId);
      return { lineId: m.lineId, wanted: m.qty, picked: 0, note: '' };
    }
    if (was.wanted !== m.qty) {
      amended.push(m.lineId);
      return { ...was, wanted: m.qty, picked: 0 };
    }
    return was;
  });

  PREPS[w.id] = {
    wofId: w.id,
    // A re-send does not send anybody back to the start of the workflow. If
    // the van is loaded and one line changed, the state is still `loaded` and
    // the amendment is what needs attention.
    state: before?.state ?? 'sent',
    heldBy: before?.heldBy ?? null,
    openedAt: before?.openedAt ?? at,
    updatedAt: at,
    lines,
    amended,
  };
  savePreps();
  emit();
  return PREPS[w.id];
}

/** Why this transition is refused, or null. */
export function advancePrepBlocker(w: W.Wof, to: PrepState): string | null {
  if (!ROLES.can('kit.prepare')) return 'You do not have permission to work the warehouse queue.';
  const p = PREPS[w.id];
  if (!p) return 'Nothing has been sent to the warehouse for this job.';

  const from = PREP_STATES.indexOf(p.state);
  const target = PREP_STATES.indexOf(to);
  if (target < 0) return 'No such state.';
  if (target === from) return null;
  // Forward only, one at a time. A job that reached `loaded` without anybody
  // claiming they picked it is a job with no record of who did — and the
  // states are cheap to click through, so there is nothing to save by skipping.
  if (target < from) return `${PREP_META[p.state].label} cannot go back to ${PREP_META[to].label}.`;
  if (target > from + 1)
    return `${PREP_META[p.state].label} goes to ${PREP_META[PREP_STATES[from + 1]].label} next, not ${PREP_META[to].label}.`;

  if (to === 'picked' && p.lines.some((l) => l.picked === 0 && l.wanted > 0))
    return 'Some lines have nothing picked against them. Record what was found, even if it is none of it.';
  return null;
}

/**
 * Move a job on, and write it to the WOF's own history.
 *
 * The history entry is the point. `wofTimeline` used to SYNTHESISE the
 * warehouse leg from the push timestamp because there was no real event to
 * draw it from; there is now, and the synthesis is gone. A synthesised event
 * and a real one for the same fact disagree the first time somebody re-sends.
 */
export function advancePrep(w: W.Wof, to: PrepState): Result {
  const blocker = advancePrepBlocker(w, to);
  if (blocker) return { ok: false, reason: blocker };

  const p = PREPS[w.id];
  if (p.state === to) return { ok: true };
  const actor = ROLES.actingActor();

  p.state = to;
  p.updatedAt = NOW.toISOString();
  // Picking it up claims it. Nobody else should be able to pick the same job
  // from a shelf two people are walking towards.
  if (to === 'picking' && !p.heldBy) p.heldBy = actor.by;
  if (to === 'picked') p.amended = [];

  const short = isShort(p);
  const prog = prepProgress(p);
  W.recordExternal(w, {
    stage: w.stage,
    note:
      to === 'picking'
        ? `Picking started on ${w.picking?.epHopRef ?? 'the kit list'}`
        : to === 'picked'
          ? `Kit picked — ${prog.picked} of ${prog.wanted} items${short ? ', SHORT on at least one line' : ''}`
          : to === 'loaded'
            ? `Kit loaded${short ? ' — going out short' : ''}`
            : to === 'out'
              ? 'Kit left the warehouse'
              : 'Kit returned to the warehouse',
  }, actor);

  savePreps();
  emit();
  return { ok: true };
}

/** Record what was actually found on the shelf for one line. */
export function setPicked(w: W.Wof, lineId: string, picked: number, note = ''): Result {
  if (!ROLES.can('kit.prepare'))
    return { ok: false, reason: 'You do not have permission to work the warehouse queue.' };
  const p = PREPS[w.id];
  if (!p) return { ok: false, reason: 'Nothing has been sent to the warehouse for this job.' };
  const l = p.lines.find((x) => x.lineId === lineId);
  if (!l) return { ok: false, reason: 'That line is not on the list the warehouse was sent.' };
  if (p.state === 'out' || p.state === 'returned')
    return { ok: false, reason: 'The kit has already left. Raise a variation rather than editing the pick.' };
  if (!Number.isInteger(picked) || picked < 0) return { ok: false, reason: 'Whole items, and not negative.' };
  // Over-picking is refused rather than clamped: it means somebody read the
  // wrong row, and silently correcting it hides that.
  if (picked > l.wanted) return { ok: false, reason: `Only ${l.wanted} were asked for.` };

  l.picked = picked;
  l.note = note;
  p.amended = p.amended.filter((id) => id !== lineId);
  p.updatedAt = NOW.toISOString();
  savePreps();
  emit();
  return { ok: true };
}

/** Test seam, and the "somebody else is taking this one" action. */
export function releasePrep(w: W.Wof): Result {
  if (!ROLES.can('kit.prepare'))
    return { ok: false, reason: 'You do not have permission to work the warehouse queue.' };
  const p = PREPS[w.id];
  if (!p) return { ok: false, reason: 'Nothing has been sent to the warehouse for this job.' };
  p.heldBy = null;
  savePreps();
  emit();
  return { ok: true };
}

/* ------------------------------------------------------------- the migration */

/**
 * The old free-text `Picking.status`, read once and thrown away.
 *
 * Those strings were written by the seed and changed by nothing, which is the
 * whole reason `PrepJob` exists. But they are not meaningless — they record
 * where each seeded job had actually got to — so the migration reads them
 * rather than dumping every historic job back into `sent` and telling the
 * warehouse to re-pick work that shipped weeks ago.
 *
 * Anything unrecognised lands on `sent`, which is the safe end: it asks
 * somebody to look, rather than claiming a job went out that did not.
 */
const LEGACY_STATE: [RegExp, PrepState][] = [
  [/return|checked in/i, 'returned'],
  [/dispatch|left|on site|out with/i, 'out'],
  [/packed|loaded/i, 'loaded'],
  [/picked/i, 'picked'],
  [/picking|in progress/i, 'picking'],
];

const stateFromLegacy = (status: string | undefined): PrepState => {
  const hit = LEGACY_STATE.find(([re]) => re.test(status || ''));
  return hit ? hit[1] : 'sent';
};

/**
 * Give every job that was already at the warehouse a prep record.
 *
 * Runs once at import, over whatever `wof.ts` has loaded. Without it the queue
 * is empty on a store full of jobs that are visibly at stage 6, and the
 * warehouse screen would look broken rather than new.
 *
 * A picked count is assumed EQUAL to what was wanted for anything past
 * `picking`. That is an assumption and it is the right one: these jobs
 * shipped, and inventing a shortfall on historic work would raise alarms
 * about kit that came back weeks ago.
 */
export function hydratePreps(): void {
  let wrote = false;
  W.all().forEach((w) => {
    if (!w.picking) return;

    const held = PREPS[w.id];
    if (held) {
      // A prep whose lines resolve to NOTHING has been orphaned: seeded line
      // ids are random per seed run, so `load()` re-seeding underneath a
      // stored prep leaves every id dangling. Rebuild that one.
      //
      // A PARTIAL mismatch is the opposite case and must be left alone — it is
      // a line the office removed from the quote after the send, which is real
      // information `kitChangesSincePush` is there to report. Rebuilding on a
      // partial would silently throw away a picker's work.
      const anyResolves = held.lines.some((pl) => w.lines.some((l) => l.id === pl.lineId));
      if (anyResolves || !held.lines.length) return;
      delete PREPS[w.id];
    }
    const manifest = (w.picking.manifest?.length ? w.picking.manifest : W.kitLines(w)).map((l) => ({
      lineId: 'lineId' in l ? l.lineId : l.id,
      qty: l.qty,
    }));
    if (!manifest.length) return;

    const state = stateFromLegacy(w.picking.status);
    PREPS[w.id] = {
      wofId: w.id,
      state,
      heldBy: state === 'sent' ? null : 'm-pete',
      openedAt: w.picking.pushedAt,
      updatedAt: w.picking.lastSyncAt || w.picking.pushedAt,
      lines: manifest.map((m) => ({
        lineId: m.lineId,
        wanted: m.qty,
        picked: state === 'sent' || state === 'picking' ? 0 : m.qty,
        note: '',
      })),
      amended: [],
    };
    wrote = true;
  });
  if (wrote) savePreps();
}

/**
 * Un-stamp a recharge whose variation is no longer on the work order.
 *
 * `rechargedAt` exists to stop the same radio being billed twice, and it did
 * that by being a one-way latch: raised once, locked forever. But the charge it
 * describes lives on the WOF, and the office can delete a variation line like
 * any other. That left the warehouse looking at "· recharged" and a dead button
 * for money nobody is being asked for — a screen stating a fact that had
 * stopped being true, with no way back from the only page that can see it.
 *
 * So the stamp is now checked against the work order rather than trusted:
 * if the variation is gone, so is the lock, the boxes unlock and the button
 * comes back. That is not an undo — it is the same rule the rest of this module
 * follows, that a derived fact answers to its source.
 *
 * A prep stamped before `rechargeLineId` existed has no line to check and is
 * left alone. Guessing which variation an old stamp meant, and clearing it
 * wrongly, would bill a client twice — the exact thing the stamp is for.
 */
export function reconcileRecharges(): void {
  let wrote = false;
  Object.values(PREPS).forEach((p) => {
    const w = W.all().find((x) => x.id === p.wofId);
    if (!w) return;
    p.lines.forEach((l) => {
      if (!l.rechargedAt || !l.rechargeLineId) return;
      if (w.lines.some((x) => x.id === l.rechargeLineId)) return;
      delete l.rechargedAt;
      delete l.rechargeLineId;
      wrote = true;
    });
  });
  if (wrote) {
    savePreps();
    emit();
  }
}

/* Hydrate after every change to the WOF store, not once at import.
   `wof.ts` populates `WOFS` at import but `load()` re-seeds afterwards, and
   hydrating before that captured line ids the reload immediately replaced —
   a prep full of dangling references and a picking list that rendered empty. */
W.subscribe(() => {
  hydratePreps();
  reconcileRecharges();
});
hydratePreps();
reconcileRecharges();

/* The other side of the push. See `registerSendListener` in `wof.ts`. */
W.registerSendListener((w, manifest) => {
  openPrep(w, manifest.map((m) => ({ lineId: m.lineId, qty: m.qty })));
});

/* ==========================================================================
   10. THE QUEUE
   --------------------------------------------------------------------------
   Ordered by when the kit is NEEDED, not by when the list was sent.

   The warehouse works to a load-out date. Sorting by push time buries a job
   going out on Friday under one sent yesterday for a job in three weeks, and a
   queue that has to be re-read every morning to find the urgent row is a queue
   people keep on paper instead.
   ========================================================================== */

export interface QueueRow {
  prep: PrepJob;
  w: W.Wof;
  /** First day the kit has to be on site. What the queue sorts on. */
  neededAt: string;
  short: boolean;
  /** Lines the office changed after the warehouse was told. */
  amended: number;
  picked: number;
  wanted: number;
}

/**
 * The first day any of THIS job's kit has to be on site.
 *
 * Was the job's start date, which is only right when every line is out for the
 * whole span. A job whose only kit comes off at breakdown was queued five days
 * early and sorted above work that was genuinely due.
 */
function firstKitDay(w: W.Wof, p: PrepJob): string {
  const days = p.lines
    .map((pl) => w.lines.find((l) => l.id === pl.lineId))
    .filter((l): l is W.LineItem => !!l)
    .map((l) => W.hireWindow(w, l).from);
  return days.length ? dateOfDay(w, Math.min(...days)) : dayOf(w.start);
}

export function queue(): QueueRow[] {
  return preps()
    .map((p) => {
      const w = W.all().find((x) => x.id === p.wofId);
      if (!w) return null; // a deleted job leaves no work behind
      const prog = prepProgress(p);
      return {
        prep: p, w,
        neededAt: firstKitDay(w, p),
        short: isShort(p),
        amended: p.amended.length,
        picked: prog.picked,
        wanted: prog.wanted,
      };
    })
    .filter((r): r is QueueRow => !!r)
    .sort((a, b) => {
      // Anything still to do comes before anything finished, and within each
      // group the soonest needed first. A returned job from last month at the
      // top of the list is how the row that matters gets missed.
      const done = (r: QueueRow) => (r.prep.state === 'returned' ? 1 : 0);
      return done(a) - done(b) || a.neededAt.localeCompare(b.neededAt);
    });
}

/** Jobs sent and not yet out the door. The rail badge. */
export const toPick = (): QueueRow[] =>
  queue().filter((r) => r.prep.state !== 'out' && r.prep.state !== 'returned');

/** One shelf's worth of a wave, so a picker walks the building once per trip. */
export interface PickGroup {
  location: string;
  lines: {
    line: W.LineItem;
    prep: PrepLine;
    amended: boolean;
    code: string;
    /** This line's own hire window, in words the yard can act on. */
    out: string;
    back: string;
    days: number;
  }[];
}

/**
 * One trip out of the yard: everything wanted on the same day, wherever it
 * lives and whichever quote line sold it.
 *
 * A festival does not load out once. The radios go with the build crew on the
 * Wednesday and the signage comes off at breakdown on the Monday, and a single
 * flat list says neither - it says "12 radios, 6 signage packs" and lets the
 * picker assume both go on the first van. The hire window has always known
 * better; this is the first screen to ask it.
 */
export interface PickWave {
  /** 1-based day of the job's span this wave goes out on. */
  day: number;
  date: string;
  /** Build, event or breakdown - the word the warehouse uses for that day. */
  kind: W.DayKind;
  groups: PickGroup[];
  wanted: number;
  picked: number;
}

export function pickWaves(w: W.Wof): PickWave[] {
  const p = PREPS[w.id];
  if (!p) return [];
  const waves = new Map<number, PickWave>();

  p.lines.forEach((pl) => {
    const line = w.lines.find((l) => l.id === pl.lineId);
    if (!line) return; // removed from the quote after the send; the diff reports it
    const c = chargeById(line.chargeId);
    const h = W.hireWindow(w, line);
    const location = stockItem(line.chargeId)?.location || 'Sub-hired — not from the yard';

    if (!waves.has(h.from)) {
      waves.set(h.from, {
        day: h.from,
        date: dateOfDay(w, h.from),
        kind: W.dayKind(w, h.from),
        groups: [],
        wanted: 0,
        picked: 0,
      });
    }
    const wave = waves.get(h.from)!;
    let group = wave.groups.find((g) => g.location === location);
    if (!group) {
      group = { location, lines: [] };
      wave.groups.push(group);
    }
    group.lines.push({
      line,
      prep: pl,
      amended: p.amended.includes(pl.lineId),
      code: c?.hireHopCode || c?.code || '—',
      out: dateOfDay(w, h.from),
      back: dateOfDay(w, h.to),
      days: h.to - h.from + 1,
    });
    wave.wanted += pl.wanted;
    wave.picked += pl.picked;
  });

  // Waves in the order they leave; inside a wave, by location, because a picker
  // still walks the building once per trip. A list in the order the estimator
  // happened to type it sends somebody from the radio cage to the yard and back
  // for one more cone.
  return [...waves.values()]
    .sort((a, b) => a.day - b.day)
    .map((wave) => {
      wave.groups.sort((a, b) => a.location.localeCompare(b.location));
      return wave;
    });
}

/* ==========================================================================
   11. THE RETURN
   --------------------------------------------------------------------------
   The leg where kit money is actually lost, and the one the availability model
   named as its single honest gap: until now an item freed when its window
   passed whether or not anybody had seen it again.

   Three numbers per line, and they are kept apart because they mean different
   things to different people:

     back      fit to hire again. The register gets it back.
     damaged   EP still owns the object but cannot send it out. `outOfService`.
     lost      gone. `owned` comes down.

   Anything not accounted for is UNACCOUNTED, and is reported rather than
   quietly folded into `back`. "We think twelve came back and we are not sure
   about the other three" is the true state of most returns, and a system that
   cannot say it teaches people to type a number that balances.
   ========================================================================== */

export interface ReturnCount {
  back: number;
  damaged: number;
  lost: number;
}

/** Everything not yet accounted for on a line. */
export const unaccounted = (l: PrepLine): number =>
  Math.max(0, l.picked - (l.back ?? 0) - (l.damaged ?? 0) - (l.lost ?? 0));

/** Has anybody started checking this line in? */
export const checkedIn = (l: PrepLine): boolean =>
  l.back !== undefined || l.damaged !== undefined || l.lost !== undefined;

export const prepReturn = (p: PrepJob): ReturnCount & { unaccounted: number } => ({
  back: p.lines.reduce((s, l) => s + (l.back ?? 0), 0),
  damaged: p.lines.reduce((s, l) => s + (l.damaged ?? 0), 0),
  lost: p.lines.reduce((s, l) => s + (l.lost ?? 0), 0),
  unaccounted: p.lines.reduce((s, l) => s + unaccounted(l), 0),
});

export function checkInBlocker(w: W.Wof, lineId: string, count: ReturnCount): string | null {
  if (!ROLES.can('kit.prepare')) return 'You do not have permission to work the warehouse queue.';
  const p = PREPS[w.id];
  if (!p) return 'Nothing has been sent to the warehouse for this job.';
  // Checking in what has not gone out yet is not a correction, it is a
  // different mistake — and `setPicked` is the field for it.
  if (p.state !== 'out' && p.state !== 'returned')
    return `Nothing to check in — the kit is ${PREP_META[p.state].label.toLowerCase()}, not out.`;
  const l = p.lines.find((x) => x.lineId === lineId);
  if (!l) return 'That line is not on the list the warehouse was sent.';

  const vals = [count.back, count.damaged, count.lost];
  if (vals.some((n) => !Number.isInteger(n) || n < 0)) return 'Whole items, and not negative.';
  const total = vals.reduce((a, b) => a + b, 0);
  // More back than went out means somebody counted another job's kit onto this
  // one. Refused rather than clamped: the excess is real and belongs somewhere.
  if (total > l.picked) return `Only ${l.picked} went out on this line.`;
  if (l.rechargedAt && (count.damaged || count.lost))
    return 'This line has already been recharged. Amend the variation on the work order instead.';
  return null;
}

/**
 * Record what came back on one line, and move the register to match.
 *
 * THE STOCK ADJUSTMENT DOES NOT GO THROUGH `setStock`, and that is deliberate.
 * `setStock` is guarded by `kit.stock` because it is somebody typing a number
 * into the register from nothing. This is not that: it is the consequence of a
 * physical event the same person just recorded, and requiring a second
 * capability to write down what they were looking at is how the register goes
 * stale while everybody assures each other it is fine. The audit trail is the
 * same either way — every adjustment lands in `changeLog` with the actor, and
 * with the job that caused it in the reason.
 */
export function checkIn(w: W.Wof, lineId: string, count: ReturnCount, note = ''): Result {
  const blocker = checkInBlocker(w, lineId, count);
  if (blocker) return { ok: false, reason: blocker };

  const p = PREPS[w.id];
  const l = p.lines.find((x) => x.lineId === lineId)!;
  const line = w.lines.find((x) => x.id === lineId);
  const item = line ? stockItem(line.chargeId) : undefined;

  // The DELTA, not the new total: check-in is incremental — a van at a time —
  // and applying the absolute figure twice would take stock down twice.
  const dDamaged = count.damaged - (l.damaged ?? 0);
  const dLost = count.lost - (l.lost ?? 0);

  l.back = count.back;
  l.damaged = count.damaged;
  l.lost = count.lost;
  if (note) l.note = note;
  p.updatedAt = NOW.toISOString();

  if (item && (dDamaged || dLost)) {
    const actor = ROLES.actingActor();
    const at = NOW.toISOString();
    const edit: StockEdit = { ...(JOURNAL.edits[item.chargeId] || {}) };
    const why = `${count.lost ? 'Lost' : 'Damaged'} on ${w.ref} — ${w.title}`;

    if (dLost) {
      // Gone. `owned` is the count of objects EP has, and it no longer has
      // these — leaving them in and holding them out of service would report
      // an asset that does not exist.
      const to = Math.max(0, item.owned - dLost);
      JOURNAL.log.push({ chargeId: item.chargeId, at, by: actor.by, byName: actor.name,
        field: 'owned', from: item.owned, to, reason: why });
      item.owned = to;
      edit.owned = to;
    }
    if (dDamaged) {
      // Still owned, cannot be sent out. Exactly what `outOfService` is for,
      // and it stays there until somebody repairs it and says so.
      const to = Math.min(item.owned, item.outOfService + dDamaged);
      JOURNAL.log.push({ chargeId: item.chargeId, at, by: actor.by, byName: actor.name,
        field: 'outOfService', from: item.outOfService, to, reason: why });
      item.outOfService = to;
      edit.outOfService = to;
    }
    // Clamp the pair together AFTER both moves: losing stock can leave more
    // held out of service than owned, and `issuable` would go negative.
    if (edit.outOfService !== undefined || edit.owned !== undefined) {
      item.outOfService = Math.min(item.outOfService, item.owned);
      edit.outOfService = item.outOfService;
      edit.owned = item.owned;
    }
    JOURNAL.edits[item.chargeId] = edit;
    saveJournal();
  }

  savePreps();
  emit();
  return { ok: true };
}

/* ==========================================================================
   12. THE RECHARGE
   --------------------------------------------------------------------------
   Damage and loss are extra money on a signed job — which is exactly what a
   variation already is. So this raises variations and stops.

   No new client-facing concept, no second approval flow, no separate document.
   The client sees a lost radio in the variation schedule, queries or accepts it
   in the portal, and it reaches the invoice, all through machinery that was
   built for a steward who worked two hours over. That is the whole reason this
   phase is small.
   ========================================================================== */

export interface RechargeItem {
  lineId: string;
  chargeId: string;
  name: string;
  qty: number;
  damaged: number;
  lost: number;
}

/**
 * What is owed and not yet raised.
 *
 * Unaccounted stock is NOT here. "We cannot find three of them" is not the
 * same claim as "the client lost three of them", and the second one is the one
 * that reaches an invoice. Somebody has to look again and decide, which is
 * what `unaccounted` being visible on the screen is for.
 */
export function rechargeable(w: W.Wof): RechargeItem[] {
  const p = PREPS[w.id];
  if (!p) return [];
  return p.lines
    .filter((l) => !l.rechargedAt && ((l.damaged ?? 0) > 0 || (l.lost ?? 0) > 0))
    .map((l) => {
      const line = w.lines.find((x) => x.id === l.lineId);
      const rep = line ? replacementCharge(line.chargeId) : undefined;
      // Dropped silently for two very different reasons, which is why
      // `rechargeSkipped` exists: the office deleted the quote line, or the
      // line has no replacement price to charge. Neither is "everything came
      // back", and the button used to say it was.
      if (!line || !rep) return null;
      return {
        lineId: l.lineId,
        chargeId: rep.id,
        name: rep.name,
        qty: (l.damaged ?? 0) + (l.lost ?? 0),
        damaged: l.damaged ?? 0,
        lost: l.lost ?? 0,
      };
    })
    .filter((r): r is RechargeItem => !!r);
}

/**
 * Damage and loss that CANNOT be billed, and why.
 *
 * The counterpart to `rechargeable`. A line was silently dropped when it had
 * no replacement price, so the button read "nothing to recharge" over a broken
 * buggy somebody had just written down — the most misleading thing a screen
 * can do with a number a person entered by hand. Whether it is billable is a
 * fact about the rate card; the warehouse still recorded what came back, and
 * is owed an explanation rather than a silence.
 */
export interface RechargeSkip {
  lineId: string;
  name: string;
  qty: number;
  why: string;
}

export function rechargeSkipped(w: W.Wof): RechargeSkip[] {
  const p = PREPS[w.id];
  if (!p) return [];
  return p.lines
    .filter((l) => !l.rechargedAt && ((l.damaged ?? 0) > 0 || (l.lost ?? 0) > 0))
    .map((l) => {
      const line = w.lines.find((x) => x.id === l.lineId);
      const qty = (l.damaged ?? 0) + (l.lost ?? 0);
      if (!line)
        return {
          lineId: l.lineId, qty, name: 'A line that is no longer on the work order',
          why: 'the office removed it from the quote after the list was sent',
        };
      if (!replacementCharge(line.chargeId))
        return {
          lineId: l.lineId, qty, name: line.description,
          why: isReplacementCharge(line.chargeId)
            ? 'it is itself a replacement charge, so there is nothing further to charge for it'
            : 'it has no replacement price on the rate card',
        };
      return null;
    })
    .filter((r): r is RechargeSkip => !!r);
}

export function rechargeBlocker(w: W.Wof): string | null {
  if (!ROLES.can('kit.prepare')) return 'You do not have permission to work the warehouse queue.';
  if (!w.signoff || !w.signoff.signedAt)
    return 'This job was never signed, so there is no contract to raise a variation against.';
  if (!rechargeable(w).length) {
    const skipped = rechargeSkipped(w);
    if (skipped.length)
      return `Nothing here can be recharged — ${skipped
        .map((s) => `${s.name} (${s.qty}) because ${s.why}`)
        .join('; ')}. Raise it on the work order by hand if the client owes it.`;
    return 'Nothing to recharge — everything came back, or it is already raised.';
  }
  return null;
}

/**
 * Raise one variation line per damaged-or-lost item.
 *
 * `addLine` decides on its own that this is a variation, because the job is
 * signed — so it arrives with `clientApproval: 'pending'` and lands in
 * `unsentVariations` exactly like any other. Nothing here has to know that.
 *
 * `rechargedAt` is stamped on the prep line so a second call cannot bill the
 * same radio twice. That is the only piece of bookkeeping this function does
 * that the variation machinery does not already do for it.
 */
export function raiseRecharge(w: W.Wof): Result & { raised?: number; value?: number } {
  const blocker = rechargeBlocker(w);
  if (blocker) return { ok: false, reason: blocker };

  const items = rechargeable(w);
  const p = PREPS[w.id];
  const at = NOW.toISOString();
  const actor = ROLES.actingActor();
  let value = 0;

  items.forEach((it) => {
    const parts = [
      it.lost ? `${it.lost} lost` : '',
      it.damaged ? `${it.damaged} damaged beyond hire` : '',
    ].filter(Boolean).join(', ');
    const l = W.addLine(w, it.chargeId, {
      qty: it.qty,
      units: 1,
      note: `${parts} on this job — checked in by the warehouse.`,
    }, actor);
    value += W.lineValue(l);
    const pl = p.lines.find((x) => x.lineId === it.lineId);
    if (pl) {
      pl.rechargedAt = at;
      pl.rechargeLineId = l.id;
    }
  });

  savePreps();
  emit();
  return { ok: true, raised: items.length, value };
}

/* ==========================================================================
   13. ADDING A THING EP OWNS
   --------------------------------------------------------------------------
   A register you can correct but not grow is half a register, and it was the
   half this module shipped with: `setStock` could fix a count, and nothing
   could add the light tower EP bought last week.

   THREE ROWS, CREATED TOGETHER OR NOT AT ALL
   ------------------------------------------
   A piece of kit is not one record. It is a day rate, a replacement price and
   a shelf count, and an item missing any of them is broken in a way nobody can
   see until it matters:

     · no day rate      → it cannot be quoted at all
     · no replacement   → it can be lost, and the client cannot be charged
     · no stock row     → it is quotable without limit, silently

   So this is one call. If the second charge fails the first is rolled back,
   because a half-created item is worse than a refusal: the refusal is visible.

   TWO CAPABILITIES, BECAUSE IT IS TWO PEOPLE'S WORK
   -------------------------------------------------
   `charges.edit` is Finance — what EP pays and what a client is charged.
   `kit.stock` is the warehouse — how many exist. This form asks for both
   because it writes both, and demanding both is more honest than letting the
   warehouse invent prices or Finance invent shelf counts. It does mean the
   default Warehouse Manager cannot use it alone, which is the correct
   friction: nobody should be able to price EP's kit on their own say-so.
   ========================================================================== */

export interface NewStockItem {
  name: string;
  /** Warehouse code — becomes `Charge.hireHopCode` and the picking-list code. */
  code: string;
  /** Per day, unless it is a consumable. */
  dayCost: number;
  dayCharge: number;
  /** What the client pays if it does not come back. Per item. */
  replaceCost: number;
  replaceCharge: number;
  owned: number;
  outOfService?: number;
  turnaround: number;
  location: string;
  note?: string;
  /** Issued rather than lent — hi-vis, cable ties. No replacement charge. */
  consumable?: boolean;
}

export function createStockItemBlocker(n: NewStockItem): string | null {
  if (!ROLES.can('kit.stock')) return 'You do not have permission to change stock counts.';
  if (!ROLES.can('charges.edit'))
    return 'Adding kit sets a price as well as a count, which is Finance’s. Ask them to add it, or to grant charge-table access.';
  if (!n.name.trim()) return 'Give it a name.';
  if (!Number.isInteger(n.owned) || n.owned < 0) return 'Owned must be a whole number, and not negative.';
  if (!Number.isInteger(n.turnaround) || n.turnaround < 0)
    return 'Turnaround is a whole number of days, and not negative.';
  if ((n.outOfService ?? 0) > n.owned) return 'Cannot hold more out of service than are owned.';

  const day = CHARGES_LIB.createChargeBlocker({
    kind: 'kit', code: n.code, name: n.name, unit: n.consumable ? 'each' : 'day',
    cost: n.dayCost, charge: n.dayCharge, hireHopCode: n.code,
  });
  if (day) return day;

  // Checked BEFORE anything is written, so the all-or-nothing rule above is a
  // guarantee rather than a rollback that might itself fail.
  if (!n.consumable) {
    const rep = CHARGES_LIB.createChargeBlocker({
      kind: 'kit', code: `RP-${n.code}`.slice(0, 10), name: `${n.name} — replacement`, unit: 'each',
      cost: n.replaceCost, charge: n.replaceCharge,
    });
    if (rep) return rep;
  }
  return null;
}

/**
 * Create the day rate, the replacement charge and the stock row together.
 *
 * The stock row is journalled separately from the charges — `STOCK` is this
 * module's register, `CHARGES` is the money layer's — which is the same
 * separation the whole module rests on, showing up one last time at the point
 * where a thing is born.
 */
export function createStockItem(n: NewStockItem): Result & { item?: StockItem } {
  const blocker = createStockItemBlocker(n);
  if (blocker) return { ok: false, reason: blocker };

  const at = NOW.toISOString().slice(0, 10);
  const day = CHARGES_LIB.createCharge({
    kind: 'kit', code: n.code, name: n.name.trim(), unit: n.consumable ? 'each' : 'day',
    cost: n.dayCost, charge: n.dayCharge, hireHopCode: n.code.toUpperCase(),
  }, at);
  if (!day.ok || !day.charge) return { ok: false, reason: day.reason };

  let replacementChargeId: string | undefined;
  if (!n.consumable) {
    const rep = CHARGES_LIB.createCharge({
      kind: 'kit', code: `RP-${n.code}`.slice(0, 10), name: `${n.name.trim()} — replacement`,
      unit: 'each', cost: n.replaceCost, charge: n.replaceCharge,
    }, at);
    if (!rep.ok || !rep.charge) {
      // All or nothing. A day rate with no replacement price is an item that
      // can be lost and never billed for, and nobody would find out until the
      // return leg quietly offered nothing to recharge.
      CHARGES_LIB.retireCharge(day.charge.id);
      return { ok: false, reason: rep.reason };
    }
    replacementChargeId = rep.charge.id;
  }

  const item: StockItem = {
    chargeId: day.charge.id,
    owned: n.owned,
    outOfService: n.outOfService ?? 0,
    turnaround: n.turnaround,
    location: n.location.trim(),
    note: (n.note || '').trim(),
    ...(replacementChargeId ? { replacementChargeId } : {}),
  };
  STOCK.push(item);
  CUSTOM_ITEMS.push({ ...item });

  const actor = ROLES.actingActor();
  JOURNAL.log.push({
    chargeId: item.chargeId, at: NOW.toISOString(), by: actor.by, byName: actor.name,
    field: 'owned', from: 0, to: n.owned,
    reason: `Added to the register — ${n.name.trim()}, ${n.location.trim() || 'no location set'}`,
  });
  saveJournal();
  saveCustom();
  emit();
  return { ok: true, item };
}

/**
 * Take an item off the register.
 *
 * RETIRE, NEVER DELETE, and the blocker says which of the two reasons applies.
 * Deleting a charge that lines point at would break every picking list,
 * variation and job costing that names it — and unlike a bad count, that is
 * not something anybody notices until a historic job is opened.
 */
export function retireStockItemBlocker(chargeId: string): string | null {
  if (!ROLES.can('kit.stock')) return 'You do not have permission to change the register.';
  if (!ROLES.can('charges.edit'))
    return 'Retiring kit takes it off the rate card too, which is Finance’s.';
  if (!stockItem(chargeId)) return 'No such item.';
  const out = commitments(chargeId).filter((c) => c.to >= dayOf(NOW.toISOString()));
  if (out.length)
    return `${countLabel(out.length, 'job')} still has this booked — ${out.map((c) => c.ref).join(', ')}. Retire it once they are back.`;
  return null;
}

export function retireStockItem(chargeId: string, on = true): Result {
  if (on) {
    const blocker = retireStockItemBlocker(chargeId);
    if (blocker) return { ok: false, reason: blocker };
  } else if (!ROLES.can('kit.stock') || !ROLES.can('charges.edit')) {
    return { ok: false, reason: 'You do not have permission to change the register.' };
  }
  const item = stockItem(chargeId);
  if (!item) return { ok: false, reason: 'No such item.' };

  // The stock row stays. The register still has to answer "how many do we own"
  // for something sitting in the yard unsold, and the picking list of a job
  // that used it still has to resolve. Only the SELLING stops.
  const res = CHARGES_LIB.retireCharge(chargeId, on);
  if (!res.ok) return res;
  if (item.replacementChargeId) CHARGES_LIB.retireCharge(item.replacementChargeId, on);
  emit();
  return { ok: true };
}

export const isItemRetired = (chargeId: string): boolean => CHARGES_LIB.isRetired(chargeId);
