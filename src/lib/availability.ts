/* ============================================================================
   EPROSTA — AVAILABILITY
   ----------------------------------------------------------------------------
   Where every person is on every day, and the one question the spreadsheets
   cannot answer.

   THE PROBLEM THIS EXISTS TO SOLVE
   --------------------------------
   EP Team runs two workbooks. `Master Calendar.xlsx` holds the jobs and who is
   assigned to them. `EP Team – People Planner 2026.xlsx` holds, in twelve
   monthly tabs of free text, where each of 68 people is on each day — `Off`,
   `Annual Leave`, `TOIL`, `EP Warehouse (08:00-17:00)`, `Off - Sick`.

   Nothing joins them. A person can be booked onto a Saturday event in one file
   and booked off in the other, and no formula in either workbook can see it.
   The first anyone knows is when they do not turn up.

   So the invariant this module exists for is a single derived query:

       a person is either free on a date, or they are not,
       and `assign()` asks before it books.

   WHAT AN ENTRY MEANS, AND WHAT NO ENTRY MEANS
   --------------------------------------------
   An entry is a DEPARTURE FROM THE NORM. A weekday with no entry means the
   person is on their `defaultDay` — head office for the ops bands, the
   warehouse for logistics — or on an event, which `events.ts` owns and this
   module does not duplicate.

   That distinction is load-bearing. Writing an entry for every ordinary day
   would triple the store to say nothing, and would make a day nobody has looked
   at indistinguishable from one somebody has actively confirmed.

   THREE DEGREES OF UNAVAILABLE, NOT ONE
   -------------------------------------
   The workbook has one colour for "not here", which flattens three different
   situations into a single ambiguous cell:

     · BLOCKING  — approved leave, sickness, a bank holiday. They are not
                   coming. Booking them is refused.
     · PENDING   — leave requested and not yet granted. They are still bookable
                   today, but if it is approved you have a problem, so this
                   warns rather than refuses.
     · COMMITTED — at work, but not on an event: warehouse, head office, WFH,
                   training. Bookable, and worth saying out loud, because
                   pulling someone off a depot day has a cost somebody should
                   be choosing to pay.

   Collapsing those into one boolean is what makes a spreadsheet cell need a
   phone call to interpret.

   PERSON, NOT REGISTER
   --------------------
   `personId` is a `tm-*` or an `e-*`. Availability is a fact about a human
   being, not about which table they happen to sit in. A casual steward saying
   "I can't do those dates" is the same fact as an ops manager booking annual
   leave, and modelling it twice would rebuild the split this replaces.

   THE JOURNAL IS KEYED ON PERSON AND DATE
   ---------------------------------------
   Not on a record id. "One entry per person per day" is the invariant, so the
   storage key IS `personId|date` and the invariant cannot be violated by
   construction — there is nowhere to put a second one. Seeded entries are
   regenerated on every load against a window that follows today, so a journal
   keyed on synthetic ids would slowly fill with orphans as the window slid.
   ========================================================================== */

import { DAY_ENTRIES, EVENTS, EMPLOYEES, TEAM, NOW } from '@/data/db';
import type { DayEntry, DayEntryStatus, DayStateKind } from '@/data/types';

const KEY = 'eprosta.availability.v1';

/* ------------------------------------------------------------ the taxonomy */

/** Approved, they are not coming. `assign()` refuses these. */
export const BLOCKING: ReadonlySet<DayStateKind> = new Set<DayStateKind>([
  'off', 'annual-leave', 'toil', 'bank-holiday', 'sick', 'parental', 'other-leave',
]);

/** At work, but not on an event. Bookable, with a cost worth naming. */
export const AT_WORK: ReadonlySet<DayStateKind> = new Set<DayStateKind>([
  'head-office', 'back-office', 'warehouse', 'wfh', 'training', 'standby',
]);

export const DAY_STATE_LABEL: Record<DayStateKind, string> = {
  'off': 'Off',
  'annual-leave': 'Annual leave',
  'toil': 'TOIL',
  'bank-holiday': 'Bank holiday',
  'sick': 'Sick',
  'parental': 'Parental leave',
  'other-leave': 'Other leave',
  'head-office': 'EP head office',
  'back-office': 'EP back office',
  'warehouse': 'EP warehouse',
  'wfh': 'Working from home',
  'training': 'Training',
  'standby': 'Duty phone cover',
};

/** The two that somebody has to say yes to. */
export const NEEDS_APPROVAL: ReadonlySet<DayStateKind> = new Set<DayStateKind>([
  'annual-leave', 'toil',
]);

/* ------------------------------------------------------------------ store */

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

/* --------------------------------------------------------------- journal */

interface Journal {
  v: 1;
  /** Upserts, keyed `personId|date`. The invariant, expressed as storage. */
  set: Record<string, DayEntry>;
  /** Keys explicitly emptied, so a seeded entry can be taken back off. */
  cleared: string[];
}

const empty = (): Journal => ({ v: 1, set: {}, cleared: [] });

export const cellKey = (personId: string, date: string): string =>
  `${personId}|${date.slice(0, 10)}`;

function readJournal(): Journal {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!raw || raw.v !== 1) return empty();
    const set: Record<string, DayEntry> = {};
    Object.entries(raw.set && typeof raw.set === 'object' ? raw.set : {}).forEach(
      ([k, v]) => {
        const e = normaliseEntry(v);
        // The key is the invariant; a payload that disagrees is corrected to it
        // rather than allowed to create a second entry for the same day.
        if (e) {
          const [personId, date] = k.split('|');
          if (personId && date) set[k] = { ...e, personId, date };
        }
      },
    );
    return {
      v: 1,
      set,
      cleared: Array.isArray(raw.cleared)
        ? raw.cleared.filter((x: unknown): x is string => typeof x === 'string')
        : [],
    };
  } catch {
    return empty();
  }
}

/** Same reasoning as `normaliseEvent` in `events.ts` — see that header. */
function normaliseEntry(raw: unknown): DayEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const personId = typeof e.personId === 'string' ? e.personId : '';
  const date = typeof e.date === 'string' ? e.date.slice(0, 10) : '';
  const kind = e.kind as DayStateKind;
  if (!personId || !date) return null;
  if (!BLOCKING.has(kind) && !AT_WORK.has(kind)) return null;

  const status = e.status as DayEntryStatus;
  return {
    id: typeof e.id === 'string' && e.id ? e.id : `de-${personId}-${date}`,
    personId,
    date,
    kind,
    note: typeof e.note === 'string' ? e.note : '',
    hours: typeof e.hours === 'string' ? e.hours : null,
    status: status === 'requested' || status === 'declined' ? status : 'approved',
    approvedBy: typeof e.approvedBy === 'string' ? e.approvedBy : null,
    at: typeof e.at === 'string' ? e.at : new Date().toISOString(),
  };
}

let journal = readJournal();

function write(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(journal));
  } catch {
    /* private mode — degrades to in-memory, still correct for a session */
  }
  rebuild();
  emit();
}

/* ------------------------------------------------------------ live state */

/**
 * `personId|date` → entry.
 *
 * A Map rather than a scan. The planner asks this question once per cell —
 * 68 people × 31 days is 2,108 lookups to paint one month — and `assign()`
 * asks it again for every worker in a role group.
 */
let live = new Map<string, DayEntry>();

function rebuild(): void {
  const next = new Map<string, DayEntry>();
  DAY_ENTRIES.forEach((e) => next.set(cellKey(e.personId, e.date), e));
  journal.cleared.forEach((k) => next.delete(k));
  Object.entries(journal.set).forEach(([k, e]) => next.set(k, e));
  live = next;
}

rebuild();

export const all = (): DayEntry[] => [...live.values()];

/* ---------------------------------------------------------------- reading */

export const stateFor = (personId: string, date: string): DayEntry | null =>
  live.get(cellKey(personId, date)) ?? null;

/** Approved and blocking. The one `assign()` refuses on. */
export function isBlocked(personId: string, date: string): boolean {
  const e = stateFor(personId, date);
  return !!e && e.status === 'approved' && BLOCKING.has(e.kind);
}

/** Asked for, not yet granted. Bookable today, a problem tomorrow. */
export function isPending(personId: string, date: string): boolean {
  const e = stateFor(personId, date);
  return !!e && e.status === 'requested' && BLOCKING.has(e.kind);
}

/** At work, but committed elsewhere. Bookable, at a cost worth naming. */
export function isCommitted(personId: string, date: string): boolean {
  const e = stateFor(personId, date);
  return !!e && AT_WORK.has(e.kind);
}

/**
 * The replacement for the stored `Employee.available` boolean.
 *
 * That field answered "is this person taking work at all", which is a standing
 * fact with no date, and was then read as though it answered "is this person
 * free on the day I am trying to book them". Those are different questions and
 * only one of them can be answered by a boolean on a record.
 */
export const availableOn = (personId: string, date: string): boolean =>
  !isBlocked(personId, date);

/** Ids free on a date, optionally narrowed to a candidate pool. */
export function freeOn(date: string, pool?: readonly string[]): string[] {
  const ids = pool ?? [...TEAM.map((t) => t.id), ...EMPLOYEES.map((e) => e.id)];
  return ids.filter((id) => availableOn(id, date));
}

/** Why somebody cannot be booked, in words a person can act on. */
export function blockReason(personId: string, date: string): string | null {
  const e = stateFor(personId, date);
  if (!e || e.status !== 'approved' || !BLOCKING.has(e.kind)) return null;
  return `${DAY_STATE_LABEL[e.kind]} on ${date}`;
}

/* --------------------------------------------------------------- writing */

export interface Result {
  ok: boolean;
  entry?: DayEntry;
  error?: string;
}

const nowISO = (): string => new Date().toISOString();

const isoDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Every date from `from` to `to` inclusive. Order-insensitive. */
export function datesBetween(from: string, to: string): string[] {
  const a = new Date(`${from.slice(0, 10)}T00:00:00`);
  const b = new Date(`${to.slice(0, 10)}T00:00:00`);
  const [lo, hi] = +a <= +b ? [a, b] : [b, a];
  const out: string[] = [];
  for (const d = new Date(lo); +d <= +hi; d.setDate(d.getDate() + 1)) {
    out.push(isoDate(d));
  }
  return out;
}

export interface SetOptions {
  note?: string;
  hours?: string | null;
  status?: DayEntryStatus;
  approvedBy?: string | null;
}

/** Upsert one day. There is no "add" — the key is the person and the date. */
export function set(
  personId: string,
  date: string,
  kind: DayStateKind,
  opts: SetOptions = {},
): Result {
  if (!personId) return { ok: false, error: 'No person given.' };
  const day = date.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, error: 'Not a date.' };
  if (!BLOCKING.has(kind) && !AT_WORK.has(kind)) {
    return { ok: false, error: `Unknown day state "${kind}".` };
  }

  const status = opts.status ?? 'approved';
  const entry: DayEntry = {
    id: `de-${personId}-${day}`,
    personId,
    date: day,
    kind,
    note: opts.note ?? '',
    hours: opts.hours ?? null,
    status,
    // An approver is recorded only where one is meaningful. Stamping a name on
    // a bank holiday would be inventing a decision nobody made.
    approvedBy: NEEDS_APPROVAL.has(kind) && status === 'approved'
      ? (opts.approvedBy ?? null)
      : null,
    at: nowISO(),
  };

  const k = cellKey(personId, day);
  journal.set[k] = entry;
  journal.cleared = journal.cleared.filter((x) => x !== k);
  write();
  return { ok: true, entry };
}

/** Set a block of days. Leave is booked in weeks, not one day at a time. */
export function setRange(
  personId: string,
  from: string,
  to: string,
  kind: DayStateKind,
  opts: SetOptions & { skipWeekends?: boolean } = {},
): { ok: boolean; written: number; error?: string } {
  const days = datesBetween(from, to);
  if (!days.length) return { ok: false, written: 0, error: 'Empty range.' };

  let written = 0;
  for (const d of days) {
    if (opts.skipWeekends) {
      const dow = new Date(`${d}T00:00:00`).getDay();
      if (dow === 0 || dow === 6) continue;
    }
    const r = set(personId, d, kind, opts);
    if (!r.ok) return { ok: false, written, error: r.error };
    written += 1;
  }
  return { ok: true, written };
}

/** Book time off that somebody still has to grant. */
export const request = (
  personId: string,
  from: string,
  to: string,
  kind: DayStateKind,
  note = '',
): { ok: boolean; written: number; error?: string } =>
  setRange(personId, from, to, kind, { note, status: 'requested', skipWeekends: true });

/**
 * Grant a request, and record who granted it.
 *
 * `Sheet25` shows the team reconstructing this months later from memory —
 * "TOIL request", "Messaged Martin", `"personal issue"`. An actor and a
 * timestamp at the moment of the decision is a small change that settles a
 * recurring argument.
 */
export function approve(personId: string, date: string, by: string): Result {
  const e = stateFor(personId, date);
  if (!e) return { ok: false, error: 'Nothing to approve on that day.' };
  if (e.status === 'approved') return { ok: true, entry: e };
  if (!by) return { ok: false, error: 'Record who approved it.' };

  const entry: DayEntry = { ...e, status: 'approved', approvedBy: by, at: nowISO() };
  journal.set[cellKey(personId, e.date)] = entry;
  write();
  return { ok: true, entry };
}

export function decline(personId: string, date: string, by: string, note = ''): Result {
  const e = stateFor(personId, date);
  if (!e) return { ok: false, error: 'Nothing to decline on that day.' };
  if (!by) return { ok: false, error: 'Record who declined it.' };

  const entry: DayEntry = {
    ...e,
    status: 'declined',
    approvedBy: by,
    note: note || e.note,
    at: nowISO(),
  };
  journal.set[cellKey(personId, e.date)] = entry;
  write();
  return { ok: true, entry };
}

/** Take a day back to "nothing said", which is not the same as "off". */
export function clear(personId: string, date: string): Result {
  const k = cellKey(personId, date);
  if (!live.has(k)) return { ok: false, error: 'Nothing set on that day.' };
  delete journal.set[k];
  if (!journal.cleared.includes(k)) journal.cleared.push(k);
  write();
  return { ok: true };
}

/* ------------------------------------------------------------- conflicts */

export type ConflictSeverity = 'blocking' | 'pending' | 'committed';

export interface Conflict {
  personId: string;
  personName: string;
  date: string;
  severity: ConflictSeverity;
  kind: DayStateKind;
  eventId: string;
  eventName: string;
  shiftId: string;
  /** Written to be shown, not parsed. */
  reason: string;
}

const nameOf = (personId: string): string =>
  TEAM.find((t) => t.id === personId)?.name ??
  EMPLOYEES.find((e) => e.id === personId)?.name ??
  personId;

/**
 * Everybody who is both booked on a shift and booked off.
 *
 * This is the query the two workbooks cannot express between them, and it is
 * the reason this module exists. It reads `EVENTS` directly from the seed
 * rather than through `events.ts`, which keeps the dependency one-way:
 * `events.ts` imports this to ask before it assigns, so this must not import
 * `events.ts` back.
 */
export function conflicts(from?: string, to?: string): Conflict[] {
  const lo = from ? from.slice(0, 10) : isoDate(new Date(NOW));
  const hi = to ? to.slice(0, 10) : null;
  const out: Conflict[] = [];

  EVENTS.forEach((ev) => {
    ev.shifts.forEach((sh) => {
      const date = sh.start.slice(0, 10);
      if (date < lo) return;
      if (hi && date > hi) return;

      // The event lead is a team member, and can be on leave like anyone else.
      if (ev.leadId) {
        const sev = severityOf(ev.leadId, date);
        if (sev) {
          out.push(build(ev.leadId, date, sev, ev.id, ev.name, sh.id, 'leading'));
        }
      }

      sh.splits.forEach((sp) => {
        sp.assignments.forEach((a) => {
          // A declined assignment is not a booking, so it cannot clash.
          if (a.confirmation === 'declined') return;
          const sev = severityOf(a.employeeId, date);
          if (sev) {
            out.push(build(a.employeeId, date, sev, ev.id, ev.name, sh.id, sp.role));
          }
        });
      });
    });
  });

  // Worst first: the refusals are what somebody has to act on today.
  const rank: Record<ConflictSeverity, number> = { blocking: 0, pending: 1, committed: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || a.date.localeCompare(b.date));
}

function severityOf(personId: string, date: string): ConflictSeverity | null {
  if (isBlocked(personId, date)) return 'blocking';
  if (isPending(personId, date)) return 'pending';
  if (isCommitted(personId, date)) return 'committed';
  return null;
}

function build(
  personId: string,
  date: string,
  severity: ConflictSeverity,
  eventId: string,
  eventName: string,
  shiftId: string,
  role: string,
): Conflict {
  const e = stateFor(personId, date)!;
  const label = DAY_STATE_LABEL[e.kind];
  const who = nameOf(personId);
  const reason =
    severity === 'blocking'
      ? `${who} is on ${label.toLowerCase()} and booked as ${role} on ${eventName}.`
      : severity === 'pending'
        ? `${who} has requested ${label.toLowerCase()} on a day they are booked as ${role} on ${eventName}.`
        : `${who} is down as ${label.toLowerCase()} and booked as ${role} on ${eventName}.`;

  return { personId, personName: who, date, severity, kind: e.kind, eventId, eventName, shiftId, reason };
}

/** Just the count, for the sidebar badge. Cheap enough to call on every render. */
export const conflictCount = (): number =>
  conflicts().filter((c) => c.severity === 'blocking').length;

/* --------------------------------------------------------------- balances */

export interface LeaveBalance {
  taken: number;
  booked: number;
  requested: number;
}

/**
 * Days of annual leave behind, ahead, and awaiting a decision.
 *
 * Counted from entries rather than stored as a running total, for the same
 * reason `filled` is derived in `coverage.ts`: a stored balance and the days it
 * is supposed to summarise will disagree, and then nobody knows which is right.
 */
export function leaveBalance(personId: string, year?: number): LeaveBalance {
  const y = year ?? new Date(NOW).getFullYear();
  const today = isoDate(new Date(NOW));
  const out: LeaveBalance = { taken: 0, booked: 0, requested: 0 };

  live.forEach((e) => {
    if (e.personId !== personId) return;
    if (e.kind !== 'annual-leave') return;
    if (Number(e.date.slice(0, 4)) !== y) return;
    if (e.status === 'declined') return;
    if (e.status === 'requested') out.requested += 1;
    else if (e.date < today) out.taken += 1;
    else out.booked += 1;
  });

  return out;
}

/** Everything awaiting a decision, newest first. Feeds the approvals queue. */
export const pendingRequests = (): DayEntry[] =>
  all()
    .filter((e) => e.status === 'requested')
    .sort((a, b) => a.date.localeCompare(b.date));

/* ------------------------------------------------------------------ resets */

/** Drop every local change and go back to the seed. Used by the reset control. */
export function resetAvailability(): void {
  journal = empty();
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  rebuild();
  emit();
}
