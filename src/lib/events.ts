/* ============================================================================
   EPROSTA — EVENTS, SHIFTS, ROLE GROUPS AND ASSIGNMENTS
   ----------------------------------------------------------------------------
   The staffing screens were the last part of the product where the primary
   actions did nothing. "New Event" opened a form whose inputs were never read
   and fired a toast saying "Event created". Assigning a worker, adding a shift,
   adding a role group, marking somebody confirmed, approving a timesheet — all
   of them acknowledged the click and changed no state. The coverage numbers the
   whole product is built around therefore could not move.

   That is a worse failure here than anywhere else, because coverage is the
   thing the operator is making decisions from. A screen that says "12 assigned
   to Car Park Steward" after you assigned twelve people, while the gap still
   reads 15, does not just fail to save — it actively misinforms.

   WHAT THIS MODULE OWNS
   ---------------------
   Everything nested under an event: shifts, role groups (splits), assignments,
   locations. `wof.ts` still owns event *creation from an order* via
   `seedEvent()`; this module owns everything that happens to an event
   afterwards, plus the standalone events an operator creates by hand.

   THE JOURNAL, AND WHY IT IS COARSER THAN THE OTHERS
   -------------------------------------------------
   `clients.ts` and `schedules.ts` journal individual field edits over a seed
   that is rebuilt on every load, so seed improvements keep landing on records
   the user has touched. That works because those records are flat.

   An event is four levels deep — event → shift → role group → assignment — and
   a field-level journal over that shape means reconciling "the seed added a
   role group to shift 2" against "the user deleted shift 2", every load, for
   every level. The failure mode is silent and unresolvable.

   So the granularity here is the whole event: touch any part of an event and
   that event is stored whole and thereafter comes from the journal, not the
   seed. Events you have never touched keep tracking the seed. The tradeoff is
   explicit and it is the right way round — a user's assignments must never be
   silently reconciled away by a seed edit.

   COVERAGE IS STILL DERIVED
   -------------------------
   Nothing here stores a `filled` count. `split.required` and
   `assignment.confirmation` remain the only facts; `lib/coverage.ts` derives
   the rest. That is the invariant the seed's header comment is about, and every
   mutation below preserves it.
   ========================================================================== */

import { EVENTS, NOW, event as eventById } from '@/data/db';
import { SHIFT_DAYS } from '@/data/clock';
// One-way on purpose: this module asks availability whether somebody can be
// booked, and availability never imports back. See its header.
import * as AVAIL from './availability';
import { eventRoles } from './coverage';
import type { EventScale } from './classification';
import type {
  Assignment, AssignmentStatus, CheckInState, ConfirmationState, EpEvent,
  EventLocation, Shift, Split,
} from '@/data/types';

const KEY = 'eprosta.events.v1';

/**
 * Journal format version, which is NOT the storage key.
 *
 * The key stays at `.v1` deliberately. Bumping it would orphan every event a
 * user has already created, staffed and confirmed in their browser — the exact
 * work this module exists to stop losing. `read()` accepts any version up to
 * this one and pours it through `normaliseEvent`, so an old record is migrated
 * rather than discarded. Old builds reading a v2 journal will fall back to the
 * seed, which is the correct way round: new code understands old data.
 */
const JOURNAL_VERSION = 2;

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

/* ---------------------------------------------------------- normalisation */

/**
 * Bring a journalled record up to the current `EpEvent` shape.
 *
 * WHY THIS EXISTS
 * ---------------
 * The granularity note in the header is the whole reason: touch any part of an
 * event and that event is stored WHOLE and thereafter comes from the journal,
 * not the seed. That is the right tradeoff for assignments, and it has one
 * consequence nobody pays for until later — a record written today is replayed
 * verbatim tomorrow, against whatever `EpEvent` has become in the meantime.
 *
 * Add a field to `EpEvent` and every event a user has already touched replays
 * without it. Not as `undefined` that TypeScript would catch, but as a hole in
 * a value the compiler has been told is complete, reached through a cast at the
 * `JSON.parse` boundary where all type safety ends. The screens then read
 * `event.status` and get `undefined`, `event.resources` and get `undefined`,
 * and call `.length` on it. The failure is at render, in the browser, on the
 * user's data only — never in CI, because the seed always has every field.
 *
 * So: nothing enters `EVENTS` from storage without passing through here. Every
 * field is defaulted explicitly, and this function is the one place a future
 * field addition has to be remembered. Adding a field to `EpEvent` without
 * adding it here is now a compile error, because the return type is the full
 * `EpEvent` and TypeScript will demand the property.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * Invent identity or a span. An event with no id cannot be indexed, and one
 * with no start or end produces `NaN` durations that propagate silently through
 * coverage and the calendar. Those are dropped and counted. Everything else is
 * repaired, because a repaired record keeps the user's assignments and a
 * dropped one does not.
 */

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const bool = (v: unknown, fallback = false): boolean =>
  typeof v === 'boolean' ? v : fallback;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strList = (v: unknown): string[] =>
  list(v).filter((x): x is string => typeof x === 'string');

/** Non-negative whole number, or the fallback. Guards `required` against NaN. */
const count = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

const ASSIGNMENT_STATUS: readonly AssignmentStatus[] = ['invited', 'accepted', 'declined'];
const CONFIRMATION: readonly ConfirmationState[] = ['confirmed', 'awaiting', 'declined'];
const CHECK_IN: readonly Exclude<CheckInState, null>[] = ['pending', 'approved'];

function normaliseAssignment(raw: unknown): Assignment | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;

  // An assignment names a person. Without one there is nobody assigned, and a
  // blank row would still be counted by `splitCoverage`.
  const employeeId = str(a.employeeId);
  if (!employeeId) return null;

  const confirmation = oneOf(a.confirmation, CONFIRMATION, 'awaiting');

  const out: Assignment = {
    employeeId,
    status: oneOf(a.status, ASSIGNMENT_STATUS, 'invited'),
    confirmation,
    checkIn: CHECK_IN.includes(a.checkIn as Exclude<CheckInState, null>)
      ? (a.checkIn as CheckInState)
      : null,
    note: str(a.note),
  };

  // The invariant the rest of the module keeps: `declinedFrom` is present only
  // on a declined record. Materialising the documented fallback here rather
  // than leaving the field absent makes the record say what it means; it reads
  // identically, because every consumer already spells it `?? 'confirmed'`.
  if (confirmation === 'declined') {
    out.declinedFrom = oneOf(a.declinedFrom, ['confirmed', 'awaiting'] as const, 'confirmed');
  }

  return out;
}

function normaliseSplit(raw: unknown): Split | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;

  const id = str(s.id);
  if (!id) return null;

  return {
    id,
    role: str(s.role, 'Event Steward'),
    required: count(s.required),
    // `null` is a real state here — the UI renders "Not set" for it and must
    // never be handed the meaningless "00:00" instead.
    pickupTime: typeof s.pickupTime === 'string' ? s.pickupTime : null,
    office: str(s.office),
    uniform: str(s.uniform),
    travel: str(s.travel),
    tags: strList(s.tags),
    assignments: list(s.assignments)
      .map(normaliseAssignment)
      .filter((a): a is Assignment => a !== null),
  };
}

function normaliseShift(raw: unknown): Shift | null {
  if (!raw || typeof raw !== 'object') return null;
  const sh = raw as Record<string, unknown>;

  const id = str(sh.id);
  const start = str(sh.start);
  const end = str(sh.end);
  if (!id || !start || !end) return null;

  return {
    id,
    label: str(sh.label, 'Shift'),
    day: count(sh.day),
    start,
    end,
    splits: list(sh.splits)
      .map(normaliseSplit)
      .filter((s): s is Split => s !== null),
  };
}

function normaliseLocation(raw: unknown): EventLocation | null {
  if (!raw || typeof raw !== 'object') return null;
  const l = raw as Record<string, unknown>;
  const id = str(l.id);
  if (!id) return null;
  return { id, name: str(l.name), note: str(l.note) };
}

/** How many records the last `read()` could not repair. Surfaced by tests. */
let dropped = 0;
export const droppedOnLoad = (): number => dropped;

export function normaliseEvent(raw: unknown): EpEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;

  const id = str(e.id);
  const start = str(e.start);
  const end = str(e.end);
  if (!id || !start || !end) return null;

  return {
    id,
    name: str(e.name, 'Untitled event'),
    // Left blank rather than guessed. A wrong client is worse than a visibly
    // missing one, and `validateEvent` already treats blank as an error the
    // operator is shown on the next edit.
    clientId: str(e.clientId),
    office: str(e.office),
    start,
    end,
    allDay: bool(e.allDay),
    requiresAccreditation: bool(e.requiresAccreditation),
    accreditationExportReady: bool(e.accreditationExportReady),
    accreditationBlockedReason: str(e.accreditationBlockedReason),
    locations: list(e.locations)
      .map(normaliseLocation)
      .filter((l): l is EventLocation => l !== null),
    additionalInfo: str(e.additionalInfo),
    shifts: list(e.shifts)
      .map(normaliseShift)
      .filter((s): s is Shift => s !== null),
    // Added after the first records were journalled. `null` is the honest
    // default: an old record genuinely does not say who led the event, and
    // guessing at it would put a name against a job nobody assigned.
    leadId: typeof e.leadId === 'string' && e.leadId ? e.leadId : null,
  };
}

/* ------------------------------------------------------------------ journal */

interface Journal {
  v: number;
  /** The seed offset these records were written under. See `wof.ts SavedState`. */
  shift: number;
  /** Events created by hand, stored whole. */
  added: EpEvent[];
  /** Seed events the user has touched, stored whole from that point on. */
  edited: Record<string, EpEvent>;
  /** Seed events deleted. Kept as ids so the seed can still be rebuilt. */
  removed: string[];
}

const empty = (): Journal => ({
  v: JOURNAL_VERSION,
  shift: SHIFT_DAYS,
  added: [],
  edited: {},
  removed: [],
});

function read(): Journal {
  dropped = 0;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!raw || typeof raw !== 'object') return empty();
    // Anything from the future was written by a build that knows something this
    // one does not; falling back to the seed is safer than guessing at it.
    if (typeof raw.v !== 'number' || raw.v < 1 || raw.v > JOURNAL_VERSION) return empty();
    // Records written against a different seed offset are in another time
    // frame — see the note on `wof.ts SavedState.shift`.
    if (raw.shift !== SHIFT_DAYS) return empty();

    const rawAdded = list(raw.added);
    const added = rawAdded
      .map(normaliseEvent)
      .filter((ev): ev is EpEvent => ev !== null);
    dropped += rawAdded.length - added.length;

    const rawEdited: Record<string, unknown> =
      raw.edited && typeof raw.edited === 'object' ? raw.edited : {};
    const edited: Record<string, EpEvent> = {};
    Object.entries(rawEdited).forEach(([id, ev]) => {
      const norm = normaliseEvent(ev);
      if (!norm) {
        dropped += 1;
        return;
      }
      // `apply()` trusts the key, not the payload, when it splices into
      // `EVENTS`. Reconcile the two here so the two can never disagree.
      edited[id] = norm.id === id ? norm : { ...norm, id };
    });

    return {
      v: JOURNAL_VERSION,
      shift: SHIFT_DAYS,
      added,
      edited,
      removed: strList(raw.removed),
    };
  } catch {
    return empty();
  }
}

let journal = read();

function write(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(journal));
  } catch {
    /* private mode — degrades to in-memory, which is still correct for a session */
  }
  emit();
}

/* ------------------------------------------------------------ seed overlay */

/**
 * Apply the journal to the live `EVENTS` array, in place.
 *
 * In place because `EVENTS` is imported by identity all over the app — and by
 * `wof.ts`, which pushes seeded events into it. Replacing the array would leave
 * half the product holding the old one.
 */
function apply(): void {
  // Removals first, so an id cannot be both removed and re-added below.
  journal.removed.forEach((id) => {
    const i = EVENTS.findIndex((e) => e.id === id);
    if (i >= 0) EVENTS.splice(i, 1);
  });

  Object.entries(journal.edited).forEach(([id, saved]) => {
    const i = EVENTS.findIndex((e) => e.id === id);
    if (i >= 0) EVENTS[i] = saved;
    else if (!journal.removed.includes(id)) EVENTS.push(saved);
  });

  journal.added.forEach((ev) => {
    if (!EVENTS.some((e) => e.id === ev.id)) EVENTS.push(ev);
  });
}

apply();

/* ------------------------------------------------------- legacy shift repair */

/**
 * A shift is one day's work. Clamp any record that is not.
 *
 * Events ordered before the WOF seeder was fixed hold a single shift running
 * the whole event — 33 hours on a two-day job, 129 on a five-day one — and any
 * shift added by hand on top of one inherited the span and compounded it. Those
 * records are already in the journal, so fixing the seeder alone leaves them
 * broken: they carry the user's real assignments and cannot simply be dropped.
 *
 * The repair is deliberately conservative. It moves each shift's END back to
 * its own start day and does nothing else — no shifts created, none deleted, no
 * assignments touched. Fanning a spanning shift out into one per day would have
 * to either duplicate its assignments, which silently commits fourteen people
 * to a second day nobody booked them for, or drop them. Neither is a decision
 * this function is entitled to make on the user's behalf. It makes the record
 * honest and leaves the judgement — which days actually need role groups — with
 * the operator, who can now see the days on screen.
 *
 * Genuine overnights are preserved: anything up to 16 hours is left alone, so
 * a 22:00-06:00 night security shift survives untouched.
 */
const MAX_SHIFT_HOURS = 16;

function clampShift(sh: Shift): boolean {
  const s = new Date(sh.start);
  const e = new Date(sh.end);
  const hours = (+e - +s) / 3_600_000;
  if (!(hours > MAX_SHIFT_HOURS)) return false;

  const fixed = new Date(s);
  fixed.setHours(e.getHours(), e.getMinutes(), 0, 0);
  // End time at or before the start time means the shift really does cross
  // midnight; give it the following morning rather than a negative length.
  if (+fixed <= +s) fixed.setDate(fixed.getDate() + 1);

  sh.end = local(fixed);
  return true;
}

/** Repair every event in place. Returns how many shifts were changed. */
export function normaliseShiftSpans(): number {
  let fixed = 0;
  EVENTS.forEach((ev) => {
    let touched = false;
    ev.shifts.forEach((sh) => {
      if (clampShift(sh)) {
        touched = true;
        fixed += 1;
      }
    });
    // Only re-journal events the user already owns. Rewriting a pristine seed
    // event into the journal would freeze it against future seed improvements
    // for no reason — see the granularity note in the header.
    if (touched && isLocal(ev.id)) commit(ev);
  });
  return fixed;
}

/** True when this event came from the journal rather than the seed. */
export const isLocal = (id: string): boolean =>
  journal.added.some((e) => e.id === id) || id in journal.edited;

// Runs after `isLocal` rather than beside `apply()` above: `isLocal` is a const
// binding, so calling the repair any earlier hits its temporal dead zone.
normaliseShiftSpans();

/* ------------------------------------------------------------- persistence */

/**
 * Record the current state of one event and save.
 *
 * Every mutation below funnels through here. Deep-cloning at the boundary is
 * deliberate: the journal must hold a snapshot, not a live reference that later
 * mutations would edit retroactively and inconsistently with what was emitted.
 */
function commit(ev: EpEvent): void {
  const snapshot: EpEvent = structuredClone(ev);
  const addedIndex = journal.added.findIndex((e) => e.id === ev.id);
  if (addedIndex >= 0) journal.added[addedIndex] = snapshot;
  else journal.edited[ev.id] = snapshot;
  write();
}

/** Find the live event, or throw — every caller here has already resolved one. */
function must(eventId: string): EpEvent {
  const ev = EVENTS.find((e) => e.id === eventId);
  if (!ev) throw new Error(`No event ${eventId}`);
  return ev;
}

const uid = (p: string): string => `${p}-${Math.random().toString(36).slice(2, 9)}`;

/* ------------------------------------------------------------- validation */

export interface EventInput {
  name: string;
  clientId: string;
  office: string;
  start: string;
  end: string;
  allDay: boolean;
  requiresAccreditation: boolean;
}

export interface EventErrors {
  name?: string;
  clientId?: string;
  start?: string;
  end?: string;
}

export function validateEvent(input: EventInput, exceptId?: string): EventErrors {
  const e: EventErrors = {};
  const name = input.name.trim();

  if (!name) e.name = 'Give the event a name.';
  else if (name.length < 3) e.name = 'At least three characters.';
  else if (
    EVENTS.some(
      (ev) => ev.id !== exceptId && ev.name.trim().toLowerCase() === name.toLowerCase(),
    )
  )
    e.name = 'An event with this name already exists.';

  if (!input.clientId) e.clientId = 'Every event belongs to a client.';
  if (!input.start) e.start = 'Set a start.';
  if (!input.end) e.end = 'Set an end.';
  // The live form let an operator save an event that ended before it started,
  // which produces a negative duration and a coverage bar that never resolves.
  if (input.start && input.end && new Date(input.end) <= new Date(input.start))
    e.end = 'The end must be after the start.';

  return e;
}

export const hasErrors = (e: object): boolean => Object.values(e).some(Boolean);

/* ------------------------------------------------------------------ events */

export interface EventResult {
  ok: boolean;
  event?: EpEvent;
  errors?: EventErrors;
}

export function createEvent(input: EventInput): EventResult {
  const errors = validateEvent(input);
  if (hasErrors(errors)) return { ok: false, errors };

  const ev: EpEvent = {
    id: uid('ev-new'),
    name: input.name.trim(),
    clientId: input.clientId,
    office: input.office,
    start: input.start,
    end: input.end,
    allDay: !!input.allDay,
    requiresAccreditation: !!input.requiresAccreditation,
    accreditationExportReady: false,
    accreditationBlockedReason: 'No workers assigned yet — nothing to export.',
    locations: [],
    additionalInfo: '',
    // No shifts. An event with an invented shift would report a coverage gap
    // nobody asked for; the empty state on the staffing tab asks for one
    // instead, which is the honest prompt.
    shifts: [],
    // Same reasoning as the shifts: the form does not ask who is leading, so
    // the record does not claim to know.
    leadId: null,
  };

  EVENTS.push(ev);
  journal.added.push(structuredClone(ev));
  write();
  return { ok: true, event: ev };
}

export function updateEvent(id: string, input: EventInput): EventResult {
  const ev = EVENTS.find((e) => e.id === id);
  if (!ev) return { ok: false, errors: { name: 'That event no longer exists.' } };

  const errors = validateEvent(input, id);
  if (hasErrors(errors)) return { ok: false, errors };

  ev.name = input.name.trim();
  ev.clientId = input.clientId;
  ev.office = input.office;
  ev.start = input.start;
  ev.end = input.end;
  ev.allDay = !!input.allDay;
  ev.requiresAccreditation = !!input.requiresAccreditation;

  commit(ev);
  return { ok: true, event: ev };
}

export function removeEvent(id: string): boolean {
  const i = EVENTS.findIndex((e) => e.id === id);
  if (i < 0) return false;

  EVENTS.splice(i, 1);
  journal.added = journal.added.filter((e) => e.id !== id);
  delete journal.edited[id];
  if (!journal.removed.includes(id)) journal.removed.push(id);
  write();
  return true;
}

/**
 * Put a deleted event back exactly as it was, assignments included.
 *
 * The confirmation dialog stops the accident; this is for the one that gets
 * confirmed anyway. Deleting an event unassigns everybody on it, and asking an
 * operator to re-staff four hundred roles because they deleted the wrong row is
 * not a recovery story.
 */
export function restoreEvent(ev: EpEvent): EpEvent {
  journal.removed = journal.removed.filter((id) => id !== ev.id);
  const snapshot: EpEvent = structuredClone(ev);

  if (!EVENTS.some((e) => e.id === ev.id)) EVENTS.push(snapshot);
  // Back into whichever half of the journal it came from, so a restored
  // hand-made event does not start pretending to be an edited seed event.
  if (String(ev.id).startsWith('ev-new')) journal.added.push(structuredClone(snapshot));
  else journal.edited[ev.id] = structuredClone(snapshot);

  write();
  return snapshot;
}

/**
 * Copy an event, its shifts and its role groups — but not its assignments.
 *
 * Duplicating the staff too would be the wrong default and a quiet way to
 * promise thirty workers a shift they never agreed to. The structure is the
 * reusable part; who works it is decided again each time.
 */
export function duplicateEvent(id: string): EventResult {
  const src = EVENTS.find((e) => e.id === id);
  if (!src) return { ok: false };

  const copy: EpEvent = structuredClone(src);
  copy.id = uid('ev-new');
  copy.name = nextCopyName(src.name);
  copy.accreditationExportReady = false;
  copy.accreditationBlockedReason = 'No workers assigned yet — nothing to export.';
  copy.locations = copy.locations.map((l) => ({ ...l, id: uid('loc') }));
  copy.shifts = copy.shifts.map((sh) => ({
    ...sh,
    id: uid('sh'),
    splits: sh.splits.map((sp) => ({ ...sp, id: uid('sp'), assignments: [] })),
  }));

  EVENTS.push(copy);
  journal.added.push(structuredClone(copy));
  write();
  return { ok: true, event: copy };
}

/** "Reading Festival" -> "Reading Festival (copy)" -> "... (copy 2)". */
function nextCopyName(name: string): string {
  const base = name.replace(/ \(copy(?: \d+)?\)$/, '');
  if (!EVENTS.some((e) => e.name === `${base} (copy)`)) return `${base} (copy)`;
  let n = 2;
  while (EVENTS.some((e) => e.name === `${base} (copy ${n})`)) n++;
  return `${base} (copy ${n})`;
}

export function setAdditionalInfo(eventId: string, text: string): void {
  const ev = must(eventId);
  ev.additionalInfo = text;
  commit(ev);
}

/** Event-level requirements are expressed as the accreditation flag today. */
export function setEventRequirements(eventId: string, tags: string[]): void {
  const ev = must(eventId);
  ev.requiresAccreditation = tags.includes('accredited');
  commit(ev);
}

/**
 * Set, or clear, the manual scale override — see `lib/classification.ts`.
 *
 * `null` clears it back to the computed figure. The one band the computed
 * figure can never produce on its own (`day-to-day`) only ever reaches an
 * event through here.
 */
export function setScaleOverride(eventId: string, scale: EventScale | null): void {
  const ev = must(eventId);
  ev.scaleOverride = scale;
  commit(ev);
}

/* --------------------------------------------------------------- locations */

export function addLocation(eventId: string, name: string, note: string): EventLocation | null {
  if (!name.trim()) return null;
  const ev = must(eventId);
  const loc: EventLocation = { id: uid('loc'), name: name.trim(), note: note.trim() };
  ev.locations.push(loc);
  commit(ev);
  return loc;
}

export function updateLocation(eventId: string, locId: string, name: string, note: string): void {
  const ev = must(eventId);
  const loc = ev.locations.find((l) => l.id === locId);
  if (!loc) return;
  loc.name = name.trim();
  loc.note = note.trim();
  commit(ev);
}

export function removeLocation(eventId: string, locId: string): void {
  const ev = must(eventId);
  ev.locations = ev.locations.filter((l) => l.id !== locId);
  commit(ev);
}

/* ------------------------------------------------------------------ shifts */

export interface ShiftInput {
  label: string;
  start: string;
  end: string;
}

export interface ShiftErrors {
  label?: string;
  start?: string;
  end?: string;
}

export function validateShift(input: ShiftInput): ShiftErrors {
  const e: ShiftErrors = {};
  if (!input.label.trim()) e.label = 'Name the shift.';
  if (!input.start) e.start = 'Set a start time.';
  if (!input.end) e.end = 'Set an end time.';
  if (input.start && input.end && new Date(input.end) <= new Date(input.start))
    e.end = 'The end must be after the start.';
  return e;
}

/**
 * `day` is the 1-based day of the event the shift falls on, and it drives the
 * day grouping on the staffing tab. Derived rather than asked for: a form field
 * for it is a field an operator can get wrong, and there is exactly one right
 * answer given the event start.
 */
function dayIndex(ev: EpEvent, start: string): number {
  const a = new Date(ev.start);
  const b = new Date(start);
  a.setHours(0, 0, 0, 0);
  b.setHours(0, 0, 0, 0);
  return Math.max(1, Math.round((+b - +a) / 86_400_000) + 1);
}

export function addShift(
  eventId: string,
  input: ShiftInput,
): { ok: boolean; shift?: Shift; errors?: ShiftErrors } {
  const errors = validateShift(input);
  if (hasErrors(errors)) return { ok: false, errors };

  const ev = must(eventId);
  const shift: Shift = {
    id: uid('sh'),
    label: input.label.trim(),
    day: dayIndex(ev, input.start),
    start: input.start,
    end: input.end,
    splits: [],
  };
  ev.shifts.push(shift);
  ev.shifts.sort((a, b) => +new Date(a.start) - +new Date(b.start));
  commit(ev);
  return { ok: true, shift };
}

export function updateShift(
  eventId: string,
  shiftId: string,
  input: ShiftInput,
): { ok: boolean; shift?: Shift; errors?: ShiftErrors } {
  const errors = validateShift(input);
  if (hasErrors(errors)) return { ok: false, errors };

  const ev = must(eventId);
  const shift = ev.shifts.find((s) => s.id === shiftId);
  if (!shift) return { ok: false };

  shift.label = input.label.trim();
  shift.start = input.start;
  shift.end = input.end;
  shift.day = dayIndex(ev, input.start);
  ev.shifts.sort((a, b) => +new Date(a.start) - +new Date(b.start));
  commit(ev);
  return { ok: true, shift };
}

export function removeShift(eventId: string, shiftId: string): void {
  const ev = must(eventId);
  ev.shifts = ev.shifts.filter((s) => s.id !== shiftId);
  commit(ev);
}

/* ------------------------------------------------------------- role groups */

export interface SplitInput {
  role: string;
  required: number;
  pickupTime: string | null;
  office: string;
  uniform: string;
  travel: string;
  tags: string[];
}

export interface SplitErrors {
  role?: string;
  required?: string;
}

export function validateSplit(input: SplitInput): SplitErrors {
  const e: SplitErrors = {};
  if (!input.role.trim()) e.role = 'Pick a role.';
  if (!Number.isFinite(input.required) || input.required < 1)
    e.required = 'A role group needs at least one person.';
  else if (input.required > 500) e.required = '500 is the most a single role group can hold.';
  return e;
}

export function addSplit(
  eventId: string,
  shiftId: string,
  input: SplitInput,
): { ok: boolean; split?: Split; errors?: SplitErrors } {
  const errors = validateSplit(input);
  if (hasErrors(errors)) return { ok: false, errors };

  const ev = must(eventId);
  const shift = ev.shifts.find((s) => s.id === shiftId);
  if (!shift) return { ok: false };

  const split: Split = {
    id: uid('sp'),
    role: input.role,
    required: Math.round(input.required),
    pickupTime: input.pickupTime || null,
    office: input.office || ev.office,
    uniform: input.uniform,
    travel: input.travel,
    tags: [...input.tags],
    assignments: [],
  };
  shift.splits.push(split);
  commit(ev);
  return { ok: true, split };
}

/**
 * Edit a role group.
 *
 * Reducing `required` below the number already assigned is allowed and does not
 * unassign anybody — the screen shows it as over-filled, which is a real state
 * an operator needs to see and resolve deliberately. Silently dropping the last
 * three people off a shift they have confirmed would be far worse.
 */
export function updateSplit(
  eventId: string,
  shiftId: string,
  splitId: string,
  input: SplitInput,
): { ok: boolean; split?: Split; errors?: SplitErrors } {
  const errors = validateSplit(input);
  if (hasErrors(errors)) return { ok: false, errors };

  const ev = must(eventId);
  const split = ev.shifts.find((s) => s.id === shiftId)?.splits.find((p) => p.id === splitId);
  if (!split) return { ok: false };

  split.role = input.role;
  split.required = Math.round(input.required);
  split.pickupTime = input.pickupTime || null;
  split.office = input.office;
  split.uniform = input.uniform;
  split.travel = input.travel;
  split.tags = [...input.tags];
  commit(ev);
  return { ok: true, split };
}

export function setSplitRequirements(
  eventId: string,
  shiftId: string,
  splitId: string,
  tags: string[],
): void {
  const ev = must(eventId);
  const split = ev.shifts.find((s) => s.id === shiftId)?.splits.find((p) => p.id === splitId);
  if (!split) return;
  split.tags = [...tags];
  commit(ev);
}

export function removeSplit(eventId: string, shiftId: string, splitId: string): void {
  const ev = must(eventId);
  const shift = ev.shifts.find((s) => s.id === shiftId);
  if (!shift) return;
  shift.splits = shift.splits.filter((p) => p.id !== splitId);
  commit(ev);
}

/** Same rule as duplicating an event: the shape is copied, the people are not. */
export function duplicateSplit(eventId: string, shiftId: string, splitId: string): Split | null {
  const ev = must(eventId);
  const shift = ev.shifts.find((s) => s.id === shiftId);
  const src = shift?.splits.find((p) => p.id === splitId);
  if (!shift || !src) return null;

  const copy: Split = { ...structuredClone(src), id: uid('sp'), assignments: [] };
  shift.splits.splice(shift.splits.indexOf(src) + 1, 0, copy);
  commit(ev);
  return copy;
}

/* ------------------------------------------------------------- assignments */

/** Every place a worker can be found on an event, resolved in one walk. */
function locate(
  ev: EpEvent,
  splitId: string,
): { shift: Shift; split: Split } | null {
  for (const shift of ev.shifts) {
    const split = shift.splits.find((p) => p.id === splitId);
    if (split) return { shift, split };
  }
  return null;
}

/**
 * Assign workers to a role group.
 *
 * They land as `invited` / `awaiting`, never as confirmed. An operator putting
 * somebody on a shift is not the same event as that worker agreeing to it, and
 * collapsing the two is how a coverage bar comes to claim a shift is filled by
 * people who have not answered.
 *
 * Somebody already on the group and still on it is skipped rather than
 * duplicated. Somebody who DECLINED is re-invited in place — their existing
 * record is reset to invited/awaiting rather than a second one being pushed
 * next to it. Skipping them, which is what this used to do, made re-inviting a
 * declined worker a no-op: the operator picked the name, the dialog reported
 * success, and nothing happened. That is the exact failure this rebuild exists
 * to remove, and it also left "staffing must re-invite them" — the rule that
 * governs a worker who drops out of a confirmed shift — with no working way to
 * do it.
 *
 * SOMEBODY ON APPROVED LEAVE IS REFUSED, BY NAME
 * ----------------------------------------------
 * This is the join the two workbooks never had. `Master Calendar.xlsx` knows
 * who is booked; `EP Team – People Planner 2026.xlsx` knows who is off; nothing
 * compares them, so a person can be booked onto a Saturday in one file and on
 * annual leave in the other, and the first anyone knows is when they do not
 * turn up.
 *
 * `availability.isBlocked()` is asked before every write, and a refusal comes
 * back naming the person and the reason. It returns a result rather than a
 * count precisely because a silent zero — "you clicked, nothing happened" — is
 * the failure this whole module was written to remove. A pending request or a
 * warehouse day does NOT refuse: those are the operator's call to make, and
 * `availability.conflicts()` surfaces them for the decision.
 */
export interface AssignRefusal {
  employeeId: string;
  reason: string;
}

export interface AssignResult {
  assigned: number;
  refused: AssignRefusal[];
}

export function assign(
  eventId: string,
  splitId: string,
  employeeIds: string[],
): AssignResult {
  const ev = must(eventId);
  const found = locate(ev, splitId);
  if (!found) return { assigned: 0, refused: [] };

  const onGroup = new Map(found.split.assignments.map((a) => [a.employeeId, a]));
  const refused: AssignRefusal[] = [];
  let added = 0;

  // One day per shift — `normaliseShiftSpans()` above guarantees it, which is
  // what makes a single date the right thing to check.
  const date = found.shift.start.slice(0, 10);

  employeeIds.forEach((employeeId) => {
    const blocked = AVAIL.blockReason(employeeId, date);
    if (blocked) {
      refused.push({ employeeId, reason: blocked });
      return;
    }
    const held = onGroup.get(employeeId);
    if (held) {
      if (held.confirmation !== 'declined') return; // already on it, leave alone
      // A fresh invitation, on the same record. The decline is spent: the
      // history of it lives in notifications, not in a field that would keep
      // the role off their open list after we have asked them back.
      held.status = 'invited';
      held.confirmation = 'awaiting';
      held.checkIn = null;
      delete held.declinedFrom;
      added++;
      return;
    }
    const a: Assignment = {
      employeeId,
      status: 'invited',
      confirmation: 'awaiting',
      checkIn: null,
      note: '',
    };
    found.split.assignments.push(a);
    onGroup.set(employeeId, a);
    added++;
  });

  if (added) commit(ev);
  return { assigned: added, refused };
}

export function assignRole(
  eventId: string,
  roleName: string,
  employeeIds: string[],
): AssignResult {
  const ev = must(eventId);
  const roles = eventRoles(ev);
  const r = roles.find((x) => x.role === roleName);
  if (!r) return { assigned: 0, refused: [] };

  let totalAssigned = 0;
  const totalRefused: AssignRefusal[] = [];

  for (const part of r.parts) {
    const res = assign(eventId, part.split.id, employeeIds);
    totalAssigned += res.assigned;
    totalRefused.push(...res.refused);
  }

  return { assigned: totalAssigned, refused: totalRefused };
}

export function assignEvent(
  eventId: string,
  employeeIds: string[],
  roleName?: string | null,
): AssignResult {
  const ev = must(eventId);
  const roles = eventRoles(ev);
  const targetRoles = roleName ? roles.filter((r) => r.role === roleName) : roles;

  let totalAssigned = 0;
  const totalRefused: AssignRefusal[] = [];

  for (const r of targetRoles) {
    for (const part of r.parts) {
      const res = assign(eventId, part.split.id, employeeIds);
      totalAssigned += res.assigned;
      totalRefused.push(...res.refused);
    }
  }

  return { assigned: totalAssigned, refused: totalRefused };
}

export function unassign(eventId: string, splitId: string, employeeIds: string[]): number {
  const ev = must(eventId);
  const found = locate(ev, splitId);
  if (!found) return 0;

  const drop = new Set(employeeIds);
  const before = found.split.assignments.length;
  found.split.assignments = found.split.assignments.filter((a) => !drop.has(a.employeeId));
  const removed = before - found.split.assignments.length;
  if (removed) commit(ev);
  return removed;
}

/** Remove workers from every role group on a shift, wherever they sit. */
export function unassignFromShift(eventId: string, shiftId: string, employeeIds: string[]): number {
  const ev = must(eventId);
  const shift = ev.shifts.find((s) => s.id === shiftId);
  if (!shift) return 0;

  const drop = new Set(employeeIds);
  let removed = 0;
  shift.splits.forEach((sp) => {
    const before = sp.assignments.length;
    sp.assignments = sp.assignments.filter((a) => !drop.has(a.employeeId));
    removed += before - sp.assignments.length;
  });
  if (removed) commit(ev);
  return removed;
}

export function unassignRole(eventId: string, roleName: string, employeeIds: string[]): number {
  const ev = must(eventId);
  const roles = eventRoles(ev);
  const r = roles.find((x) => x.role === roleName);
  if (!r) return 0;

  let totalRemoved = 0;
  for (const part of r.parts) {
    totalRemoved += unassign(eventId, part.split.id, employeeIds);
  }
  return totalRemoved;
}

/**
 * Set confirmation state for workers on a shift.
 *
 * `status` moves with it because the two are not independent: a worker who has
 * confirmed has accepted, and one who has declined has declined. Leaving
 * `status` on `invited` after a confirmation is how the staff list and the
 * coverage bar came to disagree in the live system.
 */
export function setConfirmation(
  eventId: string,
  shiftId: string,
  employeeIds: string[],
  confirmation: ConfirmationState,
): number {
  const ev = must(eventId);
  const shift = ev.shifts.find((s) => s.id === shiftId);
  if (!shift) return 0;

  const target = new Set(employeeIds);
  let changed = 0;
  shift.splits.forEach((sp) =>
    sp.assignments.forEach((a) => {
      if (!target.has(a.employeeId)) return;
      stampDecline(a, confirmation);
      a.confirmation = confirmation;
      a.status =
        confirmation === 'confirmed' ? 'accepted' : confirmation === 'declined' ? 'declined' : 'invited';
      changed++;
    }),
  );
  if (changed) commit(ev);
  return changed;
}

/**
 * Set confirmation state for workers across all days of an event (or a target role across all days).
 */
export function setConfirmationEvent(
  eventId: string,
  employeeIds: string[],
  confirmation: ConfirmationState,
  roleName?: string | null,
): number {
  const ev = must(eventId);
  const target = new Set(employeeIds);
  let changed = 0;

  ev.shifts.forEach((sh) => {
    sh.splits.forEach((sp) => {
      if (roleName && sp.role !== roleName) return;
      sp.assignments.forEach((a) => {
        if (!target.has(a.employeeId)) return;
        stampDecline(a, confirmation);
        a.confirmation = confirmation;
        a.status =
          confirmation === 'confirmed' ? 'accepted' : confirmation === 'declined' ? 'declined' : 'invited';
        changed++;
      });
    });
  });

  if (changed) commit(ev);
  return changed;
}

/**
 * Remember what a decline cost, before `confirmation` collapses and the answer
 * is no longer recoverable. See `Assignment.declinedFrom`.
 */
function stampDecline(a: Assignment, next: ConfirmationState): void {
  if (next === 'declined') {
    if (a.confirmation !== 'declined') a.declinedFrom = a.confirmation;
  } else {
    delete a.declinedFrom;
  }
}

/**
 * A worker's own answer to an invitation, from the staff portal.
 *
 * Exists because the portal was writing `assignment.confirmation` straight into
 * the shared record and never committing it. The operator's coverage bar moved,
 * because both screens read the same object in memory — and then the answer
 * evaporated on reload, because nothing had been journalled. A worker who
 * confirmed on Friday was back to "awaiting" on Monday, and the staffing team
 * had no way to know the difference between that and someone who never replied.
 *
 * Returns the assignment so the caller can report what changed, or null when
 * the worker is not on that role group at all.
 */
export function respond(
  eventId: string,
  splitId: string,
  employeeId: string,
  answer: Exclude<ConfirmationState, 'awaiting'>,
): Assignment | null {
  const ev = must(eventId);
  const found = locate(ev, splitId);
  const a = found?.split.assignments.find((x) => x.employeeId === employeeId);
  if (!a) return null;

  stampDecline(a, answer);
  a.confirmation = answer;
  a.status = answer === 'confirmed' ? 'accepted' : 'declined';
  commit(ev);
  return a;
}

export function setAssignmentNote(
  eventId: string,
  splitId: string,
  employeeId: string,
  note: string,
): void {
  const ev = must(eventId);
  const found = locate(ev, splitId);
  const a = found?.split.assignments.find((x) => x.employeeId === employeeId);
  if (!a) return;
  a.note = note;
  commit(ev);
}

/* ---------------------------------------------------------------- check-in */

/**
 * Approve a check-in.
 *
 * Approval is also a confirmation: somebody who is standing on site plainly
 * accepted the shift, and a record that says "awaiting confirmation" next to an
 * approved check-in is the kind of contradiction the rebuild exists to remove.
 */
export function approveCheckIn(eventId: string, employeeId: string): boolean {
  const ev = must(eventId);
  let hit = false;
  ev.shifts.forEach((sh) =>
    sh.splits.forEach((sp) =>
      sp.assignments.forEach((a) => {
        if (a.employeeId !== employeeId || a.checkIn !== 'pending') return;
        a.checkIn = 'approved';
        a.confirmation = 'confirmed';
        a.status = 'accepted';
        hit = true;
      }),
    ),
  );
  if (hit) commit(ev);
  return hit;
}

export function rejectCheckIn(eventId: string, employeeId: string, note: string): boolean {
  const ev = must(eventId);
  let hit = false;
  ev.shifts.forEach((sh) =>
    sh.splits.forEach((sp) =>
      sp.assignments.forEach((a) => {
        if (a.employeeId !== employeeId || a.checkIn !== 'pending') return;
        a.checkIn = null;
        a.note = note || 'Check-in rejected.';
        hit = true;
      }),
    ),
  );
  if (hit) commit(ev);
  return hit;
}

/* ------------------------------------------------------------------ resets */

/** Drop every local change and go back to the seed. Used by the reset control. */
export function resetEvents(): void {
  journal = empty();
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  emit();
}

/* ---------------------------------------------------------------- defaults */

/**
 * Sensible start/end for a brand new event.
 *
 * Next Saturday, 07:00–19:00. Not "today", because an event created for today
 * is already half over and lands in the list flagged live; and not a hardcoded
 * date, which is what the old form did — it shipped `2026-08-20`, so the value
 * silently went stale and, past that date, every new event was created in the
 * past and filtered straight out of the default four-week window.
 */
export function defaultEventTimes(): { start: string; end: string } {
  const d = new Date(NOW);
  d.setHours(7, 0, 0, 0);
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
  const end = new Date(d);
  end.setHours(19, 0, 0, 0);
  return { start: local(d), end: local(end) };
}

/**
 * A shift defaults to a SINGLE DAY on the day after the last one.
 *
 * This used to add a day to both ends of the last shift. That is correct only
 * when the last shift is itself one day long — and it was not, because the WOF
 * seeder emitted one shift spanning the whole event. Adding a day to both ends
 * of a five-day shift produced another five-day shift starting on day two and
 * ending a day AFTER the event, so every shift added by hand compounded the
 * error and overlapped its neighbours (which the clash check in the worker
 * portal then read as a double-booking).
 *
 * A shift is a work period one person can actually do, so the default is now a
 * day: same hours as the last shift's start, ending the same calendar day, and
 * never running past the event's own end.
 */
export function defaultShiftTimes(eventId: string): { start: string; end: string } {
  const ev = eventById(eventId);
  if (!ev) return defaultEventTimes();

  const evEnd = new Date(ev.end);
  const last = ev.shifts[ev.shifts.length - 1];

  if (last) {
    const s = new Date(last.start);
    const e = new Date(last.end);
    s.setDate(s.getDate() + 1);
    // Take the last shift's TIME of day, not its date, so a spanning legacy
    // shift cannot drag the new one across days.
    e.setFullYear(s.getFullYear(), s.getMonth(), s.getDate());
    if (+e <= +s) e.setDate(e.getDate() + 1); // genuine overnight shift
    return { start: local(s), end: local(clampTo(e, evEnd)) };
  }

  // First shift on the event: day one of the event, clamped to a single day.
  const s = new Date(ev.start);
  const e = new Date(ev.end);
  if (!sameDay(s, e)) {
    e.setFullYear(s.getFullYear(), s.getMonth(), s.getDate());
    if (+e <= +s) e.setHours(s.getHours() + 8, s.getMinutes(), 0, 0);
  }
  return { start: local(s), end: local(e) };
}

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Never propose a shift that runs past the event it belongs to. */
const clampTo = (d: Date, max: Date): Date => (+d > +max ? new Date(max) : d);

/** `YYYY-MM-DDTHH:mm` in local time — what `<input type="datetime-local">` wants. */
export function local(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
