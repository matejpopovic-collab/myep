/* ============================================================================
   EPROSTA — JOB TYPES (the left-hand list on Checklist configuration)
   ----------------------------------------------------------------------------
   Briefing §3 says the document checklist per job type must be definable
   "WITHOUT DEVELOPER INTERVENTION". Ticking documents already worked, but the
   list of job types itself was a hard-coded array in `db.ts` — so the first
   time OPS took on a kind of job the seed did not foresee (a conference, a
   film shoot) they needed a developer. This module closes that gap.

   Same journal-over-seed approach as `schedules.ts` and `clients.ts`:
   `JOB_TYPES` is rebuilt from the seed on every load, and additions, edits and
   removals are replayed over it. It also makes the EXISTING edits on that
   screen (documents, deposit, terms) survive a reload, which they did not —
   they mutated the seed array in memory and were gone on refresh.

   WHAT A JOB TYPE IS STILL USED BY AFTER A WOF IS RAISED
   ------------------------------------------------------
   The checklist is copied onto the WOF at creation (`buildChecklist`), so a
   checklist edit never reaches a live job. But `deposit()` and the quote
   document still read the job type by id for the default deposit %. So a type
   that ANY work order points at — live, complete or cancelled — cannot be
   deleted, nor can one a schedule entry uses. `deleteBlocker()` says why.
   ========================================================================== */

import { EVENT_SCHEDULE, JOB_TYPES, jobType } from '@/data/db';
import type { JobType } from '@/data/types';
import * as WOF from './wof';

const KEY = 'eprosta.jobtypes.v1';

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

export type JobTypeEdit = Partial<Omit<JobType, 'id'>>;

interface Journal {
  v: 1;
  added: JobType[];
  edits: Record<string, JobTypeEdit>;
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

/** Seeded types carry no flag; anything created on screen does. */
export const isCustom = (id: string): boolean => journal.added.some((a) => a.id === id);

/* ------------------------------------------------------------ validation */

export interface JobTypeInput {
  label: string;
  depositPct: number;
  termsDays: number;
  /** Copy the checklist from this type; omit to start with no documents. */
  copyDocsFrom?: string | null;
}

export interface JobTypeErrors {
  label?: string;
  depositPct?: string;
  termsDays?: string;
}

export function validateInput(input: JobTypeInput, exceptId?: string): JobTypeErrors {
  const e: JobTypeErrors = {};
  const label = input.label.trim();
  if (!label) e.label = 'Name the job type.';
  else if (JOB_TYPES.some((j) => j.id !== exceptId && j.label.trim().toLowerCase() === label.toLowerCase()))
    e.label = 'A job type with that name already exists.';
  if (!Number.isFinite(input.depositPct) || input.depositPct < 0 || input.depositPct > 100)
    e.depositPct = 'Between 0 and 100.';
  if (!Number.isFinite(input.termsDays) || input.termsDays < 0 || !Number.isInteger(input.termsDays))
    e.termsDays = 'Whole days, 0 or more.';
  return e;
}

function slug(label: string): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'type';
  let id = `jt-${base}`;
  let n = 2;
  // Removed ids stay reserved: an old WOF in another browser may still point at one.
  while (JOB_TYPES.some((j) => j.id === id) || journal.removed.includes(id)) id = `jt-${base}-${n++}`;
  return id;
}

/* --------------------------------------------------------------- writes */

export interface JobTypeResult {
  ok: boolean;
  jobType?: JobType;
  errors?: JobTypeErrors;
}

export function createJobType(input: JobTypeInput): JobTypeResult {
  const errors = validateInput(input);
  if (Object.keys(errors).length) return { ok: false, errors };

  const source = input.copyDocsFrom ? jobType(input.copyDocsFrom) : undefined;
  const created: JobType = {
    id: slug(input.label),
    label: input.label.trim(),
    depositPct: input.depositPct,
    termsDays: input.termsDays,
    docs: source ? [...source.docs] : [],
  };
  JOB_TYPES.push(created);
  journal.added.push({ ...created, docs: [...created.docs] });
  write();
  return { ok: true, jobType: created };
}

/**
 * Edit any type, seeded or custom. A custom type's journal entry is updated
 * in place; a seeded type gets a diff, so later seed improvements to fields
 * nobody touched still land.
 */
export function updateJobType(id: string, patch: JobTypeEdit): boolean {
  const jt = jobType(id);
  if (!jt) return false;
  const clean: JobTypeEdit = { ...patch };
  if (clean.docs) clean.docs = [...clean.docs];
  Object.assign(jt, clean);

  const added = journal.added.find((a) => a.id === id);
  if (added) Object.assign(added, clean);
  else journal.edits[id] = { ...journal.edits[id], ...clean };
  write();
  return true;
}

export function setDocIncluded(id: string, docId: string, on: boolean): boolean {
  const jt = jobType(id);
  if (!jt) return false;
  const docs = on ? (jt.docs.includes(docId) ? jt.docs : [...jt.docs, docId]) : jt.docs.filter((d) => d !== docId);
  return updateJobType(id, { docs });
}

/** Why a type cannot be deleted, or null if it can. */
export function deleteBlocker(id: string): string | null {
  if (!jobType(id)) return 'That job type no longer exists.';
  if (JOB_TYPES.length <= 1) return 'At least one job type has to remain.';
  const wofs = WOF.all().filter((w) => w.jobTypeId === id).length;
  if (wofs)
    return `${wofs} work order${wofs === 1 ? ' uses' : 's use'} this type. Its deposit default is still read from it, so it has to stay.`;
  const sched = EVENT_SCHEDULE.filter((s) => s.type === id).length;
  if (sched)
    return `${sched} scheduled event${sched === 1 ? ' uses' : 's use'} this type. Change ${sched === 1 ? 'it' : 'them'} first.`;
  return null;
}

export function deleteJobType(id: string): { ok: boolean; reason?: string } {
  const reason = deleteBlocker(id);
  if (reason) return { ok: false, reason };
  const i = JOB_TYPES.findIndex((j) => j.id === id);
  JOB_TYPES.splice(i, 1);
  journal.added = journal.added.filter((a) => a.id !== id);
  delete journal.edits[id];
  if (!journal.removed.includes(id)) journal.removed.push(id);
  write();
  return { ok: true };
}

/** Discard every local change and go back to the seeded list. */
export function resetJobTypes(): void {
  journal = empty();
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  emit();
}

/* ------------------------------------------------------------------ apply */

/** Replay the journal over the freshly seeded list. Runs once, at import. */
(function applyJournal() {
  Object.entries(journal.edits).forEach(([id, patch]) => {
    const jt = jobType(id);
    if (jt) Object.assign(jt, patch, patch.docs ? { docs: [...patch.docs] } : {});
  });
  journal.added.forEach((a) => {
    if (!JOB_TYPES.some((j) => j.id === a.id)) JOB_TYPES.push({ ...a, docs: [...a.docs] });
  });
  journal.removed.forEach((id) => {
    const i = JOB_TYPES.findIndex((j) => j.id === id);
    if (i >= 0) JOB_TYPES.splice(i, 1);
  });
})();
