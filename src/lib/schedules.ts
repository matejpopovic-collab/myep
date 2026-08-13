/* ============================================================================
   EPROSTA — EVENT SCHEDULES (reference dataset 3 of 4)
   ----------------------------------------------------------------------------
   "Add scheduled event" opened nothing, fired a toast reading "out of scope for
   this prototype", and left the register exactly as it was. That is the same
   class of failure `clients.ts` was written to kill — a primary action on a
   reference-data screen that acknowledges the click and changes nothing.

   It matters more here than anywhere else in the product. The register IS the
   nag. An event that is not in `EVENT_SCHEDULE` has no trigger date, so nothing
   ever turns red for it, so nobody is ever told the paperwork is late. A user
   who wants to track a new event and cannot add one has to hold it in their
   head, which is the precise problem this screen exists to remove.

   WHY A JOURNAL RATHER THAN A SNAPSHOT
   ------------------------------------
   Same reasoning as the client register: `EVENT_SCHEDULE` is rebuilt from the
   seed on every load, so additions, edits and removals are recorded as a diff
   and replayed over the top. Seed improvements still land, and a saved edit is
   applied over whatever the seed now says.

   WHY `wofId` IS NOT JOURNALLED
   -----------------------------
   It is derived. `wof.ts:load()` clears every `wofId` and re-links from the WOF
   side, because the WOF owns the relationship — it is the thing with the
   `scheduleId`. Persisting the back-pointer as well would give us two copies of
   one fact and a way for them to disagree. A new entry is therefore always
   written with `wofId: null` and picks up its WOF, if one is ever raised
   against it, from `bySchedule()`.
   ========================================================================== */

import { EVENT_SCHEDULE, JOB_TYPES, MANAGERS, schedule as scheduleById } from '@/data/db';
import type { EventScheduleEntry } from '@/data/types';
import * as WOF from './wof';

const KEY = 'eprosta.schedules.v1';

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

/** The mutable half of an entry. `wofId` is excluded on purpose — see header. */
export type ScheduleEdit = Partial<Omit<EventScheduleEntry, 'id' | 'wofId'>>;

interface Journal {
  v: 1;
  added: EventScheduleEntry[];
  edits: Record<string, ScheduleEdit>;
  removed: string[];
}

const empty = (): Journal => ({ v: 1, added: [], edits: {}, removed: [] });

function read(): Journal {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!raw || raw.v !== 1) return empty();
    return {
      v: 1,
      added: Array.isArray(raw.added) ? raw.added : [],
      edits: raw.edits && typeof raw.edits === 'object' ? raw.edits : {},
      removed: Array.isArray(raw.removed) ? raw.removed : [],
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
    /* private mode — degrades to in-memory */
  }
  emit();
}

/* ------------------------------------------------------------ validation */

export interface ScheduleErrors {
  name?: string;
  clientId?: string;
  venue?: string;
  start?: string;
  end?: string;
  leadDays?: string;
}

export function validateName(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Required';
  if (n.length < 3) return 'Too short to recognise on a calendar';
  // Deliberately NOT unique. "100 — Phoenix v Welsh Fire" and "100 — Phoenix v
  // Sunrisers" are two rows of one fixture list, and "OVO Arena — September
  // residency" has an October twin. Same name on the same DAY is a
  // double-entry — that is what `validateDuplicate` stops.
  return null;
}

/** A duplicate is the same event on the same day, not merely the same name. */
export function validateDuplicate(name: string, start: string, exceptId?: string): string | null {
  const n = name.trim().toLowerCase();
  if (!n || !start) return null;
  const day = start.slice(0, 10);
  return EVENT_SCHEDULE.some(
    (s) => s.id !== exceptId && s.name.trim().toLowerCase() === n && s.start.slice(0, 10) === day,
  )
    ? 'That event is already in the register on that date'
    : null;
}

export function validateInput(input: ScheduleInput, exceptId?: string): ScheduleErrors {
  const e: ScheduleErrors = {};

  const nameError = validateName(input.name);
  if (nameError) e.name = nameError;

  if (!input.clientId) e.clientId = 'Required — the register is per client';
  if (!input.venue?.trim()) e.venue = 'Required';
  if (!input.start) e.start = 'Required';
  if (!input.end) e.end = 'Required';

  if (input.start && input.end && new Date(input.end) < new Date(input.start))
    e.end = 'Ends before it starts';

  const lead = Number(input.leadDays);
  if (!Number.isFinite(lead) || lead < 0) e.leadDays = 'Must be 0 or more';
  else if (lead > 365) e.leadDays = 'More than a year of lead time is almost certainly a typo';

  if (!e.name && !e.start) {
    const dup = validateDuplicate(input.name, input.start, exceptId);
    if (dup) e.name = dup;
  }

  return e;
}

export const hasErrors = (e: ScheduleErrors): boolean => Object.values(e).some(Boolean);

/* --------------------------------------------------------------- queries */

/** Ids in use, so a new entry cannot land on a seeded one. */
function nextId(): string {
  const used = new Set(EVENT_SCHEDULE.map((s) => s.id));
  let n = EVENT_SCHEDULE.length + 1;
  while (used.has(`sch-${n}`)) n++;
  return `sch-${n}`;
}

/**
 * The WOF raised against this entry, if any. Checked before a destructive
 * action rather than described after it: removing a register entry that a live
 * job points at would leave that job with a dangling `scheduleId` and strip the
 * trigger date the calendar draws its red row from.
 */
export function scheduleCommitments(id: string): { wof: WOF.Wof | null; live: boolean } {
  const s = scheduleById(id);
  const w = (s?.wofId ? WOF.byId(s.wofId) : WOF.bySchedule(id)) || null;
  return { wof: w, live: !!w && !WOF.isTerminal(w.stage) };
}

/** Whether this entry came from the seed or was added in this browser. */
export const isLocal = (id: string): boolean => journal.added.some((a) => a.id === id);

/* -------------------------------------------------------------- mutations */

export interface ScheduleInput {
  name: string;
  clientId: string;
  venue: string;
  type: string;
  recurrence: string;
  /** Local ISO, `YYYY-MM-DDTHH:mm`, matching the seed's naive-local convention. */
  start: string;
  end: string;
  leadDays: number;
  triggerRule?: string;
  ownerId?: string;
}

export interface ScheduleResult {
  ok: boolean;
  entry?: EventScheduleEntry;
  errors?: ScheduleErrors;
}

/**
 * The trigger rule is prose shown in a tooltip under the lead time — it is what
 * tells an operator WHY the date is what it is. Leaving it blank is allowed but
 * unhelpful, so an unstated one is generated from the lead time rather than
 * rendering an empty tooltip.
 */
const defaultTriggerRule = (leadDays: number): string =>
  leadDays === 0 ? 'Raise WOF on the day' : `Raise WOF ${leadDays} days before the event`;

/** Normalise to the seed's naive-local `YYYY-MM-DDTHH:mm:ss`, no timezone. */
function normaliseStamp(v: string): string {
  if (!v) return v;
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return `${s}:00`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T09:00:00`;
  return s;
}

export function createSchedule(input: ScheduleInput): ScheduleResult {
  const errors = validateInput(input);
  if (hasErrors(errors)) return { ok: false, errors };

  const leadDays = Number(input.leadDays);
  const entry: EventScheduleEntry = {
    id: nextId(),
    name: input.name.trim(),
    clientId: input.clientId,
    venue: input.venue.trim(),
    type: input.type || JOB_TYPES[0].id,
    recurrence: input.recurrence?.trim() || 'One-off',
    start: normaliseStamp(input.start),
    end: normaliseStamp(input.end),
    leadDays,
    triggerRule: input.triggerRule?.trim() || defaultTriggerRule(leadDays),
    ownerId: input.ownerId || MANAGERS[0].id,
    wofId: null,
  };

  EVENT_SCHEDULE.push(entry);
  journal.added.push(entry);
  write();
  return { ok: true, entry };
}

export function updateSchedule(id: string, patch: ScheduleEdit): ScheduleResult {
  const s = scheduleById(id);
  if (!s) return { ok: false };

  const merged: ScheduleInput = {
    name: patch.name ?? s.name,
    clientId: patch.clientId ?? s.clientId,
    venue: patch.venue ?? s.venue,
    type: patch.type ?? s.type,
    recurrence: patch.recurrence ?? s.recurrence,
    start: patch.start ?? s.start,
    end: patch.end ?? s.end,
    leadDays: patch.leadDays ?? s.leadDays,
    triggerRule: patch.triggerRule ?? s.triggerRule,
    ownerId: patch.ownerId ?? s.ownerId,
  };
  const errors = validateInput(merged, id);
  if (hasErrors(errors)) return { ok: false, errors };

  const clean: ScheduleEdit = { ...patch };
  if (clean.name) clean.name = clean.name.trim();
  if (clean.venue) clean.venue = clean.venue.trim();
  if (clean.recurrence) clean.recurrence = clean.recurrence.trim();
  if (clean.start) clean.start = normaliseStamp(clean.start);
  if (clean.end) clean.end = normaliseStamp(clean.end);
  if (clean.leadDays !== undefined) clean.leadDays = Number(clean.leadDays);
  if (clean.triggerRule !== undefined)
    clean.triggerRule = clean.triggerRule.trim() || defaultTriggerRule(clean.leadDays ?? s.leadDays);

  Object.assign(s, clean);

  const addedIndex = journal.added.findIndex((a) => a.id === id);
  if (addedIndex >= 0) journal.added[addedIndex] = { ...journal.added[addedIndex], ...clean };
  else journal.edits[id] = { ...(journal.edits[id] || {}), ...clean };

  write();
  return { ok: true, entry: s };
}

export function removeSchedule(id: string): boolean {
  const i = EVENT_SCHEDULE.findIndex((s) => s.id === id);
  if (i < 0) return false;
  EVENT_SCHEDULE.splice(i, 1);

  journal.added = journal.added.filter((a) => a.id !== id);
  delete journal.edits[id];
  if (!journal.removed.includes(id)) journal.removed.push(id);

  write();
  return true;
}

/** Discard every local change and go back to the seeded register. */
export function resetSchedules(): void {
  journal = empty();
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  emit();
}

/* ------------------------------------------------------------------ apply */

/**
 * Replay the journal over the freshly seeded register. Runs once, at import.
 *
 * Note this necessarily runs AFTER `wof.ts` has loaded and re-linked, because
 * importing `./wof` evaluates that module first. An entry added here therefore
 * carries `wofId: null` even if a WOF was raised against it in an earlier
 * session — which is correct and harmless: every reader resolves the link with
 * `s.wofId ? byId(s.wofId) : bySchedule(s.id)`, and the WOF's own `scheduleId`
 * is the persisted side of the relationship. The back-pointer is repaired below
 * anyway so the two agree from the first render.
 */
(function applyJournal() {
  Object.entries(journal.edits).forEach(([id, patch]) => {
    const s = scheduleById(id);
    if (s) Object.assign(s, patch);
  });

  journal.added.forEach((a) => {
    if (!EVENT_SCHEDULE.some((s) => s.id === a.id)) EVENT_SCHEDULE.push({ ...a, wofId: null });
  });

  journal.removed.forEach((id) => {
    const i = EVENT_SCHEDULE.findIndex((s) => s.id === id);
    if (i >= 0) EVENT_SCHEDULE.splice(i, 1);
  });

  // Re-link the derived back-pointer for anything we just added.
  WOF.all().forEach((w) => {
    if (!w.scheduleId) return;
    const s = scheduleById(w.scheduleId);
    if (s && !s.wofId) s.wofId = w.id;
  });
})();
