/* ============================================================================
   STANDARD DOCUMENTS — the files EP sends with every job
   ----------------------------------------------------------------------------
   Each job's checklist asked for its own upload, even for paperwork that is
   the same file every time: the Employers & Public Liability certificate, the
   house Method Statement. So staff uploaded the same PDF to every WOF, or
   marked it "approved without a file" and left nothing behind the tick.

   The library holds ONE current file per document type (earlier versions are
   kept). From there:

     · RAISING A WOF attaches it to every checklist row it fits — the row has
       no file yet and the file is valid through the event's last day.
       `attachAllTo` does this; the three places that raise a WOF call it.

     · APPROVAL IS PER DOCUMENT. A certificate is the same certificate on every
       job, so it can count as approved on attach (`autoApprove`). A Risk
       Assessment template still needs reading against the site, so it lands
       as Submitted and waits for a person, like any upload.

     · THE JOB KEEPS ITS OWN COPY. Attaching copies the bytes onto the job, so
       replacing the library file next year never rewrites what an earlier job
       was actually given — the same rule as a checklist edit not reaching a
       live WOF.

     · AN EXPIRED FILE IS NEVER ATTACHED. A certificate that runs out before
       the event ends is worse than no file: it reads as covered. The row stays
       Required and is chased like any other.

   Only EP-owned documents can be standard. A client's documents are theirs to
   send per job.
   ========================================================================== */

import { DOCUMENT_TYPES, NOW, docType } from '@/data/db';
import * as JF from './jobfiles';
import * as ROLES from './roles';
import * as W from './wof';

const KEY = 'eprosta.standarddocs.v1';

export interface StandardDoc {
  id: string;
  docId: string;
  name: string;
  size: number;
  mime: string;
  uploadedBy: string;
  uploadedAt: string;
  /** Last day the file is good for, YYYY-MM-DD. Null = does not expire. */
  validUntil: string | null;
  /** Counts as approved the moment it is attached to a job. */
  autoApprove: boolean;
  note: string;
  stored: boolean;
  /** Set when this version was taken out of use without a replacement. */
  withdrawnAt: string | null;
}

/* ------------------------------------------------------------------ store */

const listeners = new Set<() => void>();
let version = 0;
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export const getVersion = (): number => version;

interface Journal {
  v: 1;
  docs: StandardDoc[];
}

function load(): Journal {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null') as Journal | null;
    if (raw && raw.v === 1 && Array.isArray(raw.docs)) return raw;
  } catch {
    /* private mode or junk */
  }
  return { v: 1, docs: [] };
}

let JOURNAL: Journal = load();

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(JOURNAL));
  } catch {
    /* private mode — in-memory only */
  }
  version += 1;
  listeners.forEach((fn) => fn());
}

export function resetStandardDocs(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  JOURNAL = { v: 1, docs: [] };
  version += 1;
  listeners.forEach((fn) => fn());
}

/* ------------------------------------------------------------------ reads */

/** Document types that can carry a standard file — the ones EP provides. */
export const eligibleTypes = () => DOCUMENT_TYPES.filter((d) => d.owner !== 'Client');
export const isEligible = (docId: string): boolean => !!docType(docId) && docType(docId)!.owner !== 'Client';

/** Every version for one document type, newest first. */
export function versions(docId: string): StandardDoc[] {
  return JOURNAL.docs
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.docId === docId)
    .sort((a, b) => b.d.uploadedAt.localeCompare(a.d.uploadedAt) || b.i - a.i)
    .map(({ d }) => d);
}

/** The file in use for a document type, or null (none yet, or withdrawn). */
export function current(docId: string): StandardDoc | null {
  const v = versions(docId)[0];
  return v && !v.withdrawnAt ? v : null;
}

const day = (iso: string | Date): string => new Date(iso).toISOString().slice(0, 10);
export const today = (): string => day(NOW);

/** Whether a file is good on a given day (inclusive). */
export const validOn = (sd: StandardDoc, date: string | Date): boolean =>
  !sd.validUntil || sd.validUntil >= day(date);

export const isExpired = (sd: StandardDoc): boolean => !validOn(sd, NOW);

/** Days until it runs out; null when it does not expire. Negative once expired. */
export function daysLeft(sd: StandardDoc): number | null {
  if (!sd.validUntil) return null;
  return Math.round((new Date(sd.validUntil).getTime() - new Date(today()).getTime()) / 86400000);
}

/* ----------------------------------------------------------------- writes */

export type Result = { ok: true; doc: StandardDoc } | { ok: false; error: string };

export async function upload(
  docId: string,
  file: File,
  opts: { validUntil?: string | null; autoApprove: boolean; note?: string; actor: W.Actor },
): Promise<Result> {
  if (!isEligible(docId)) return { ok: false, error: 'Only documents EP provides can be standard.' };
  const denied = ROLES.denial('wof.edit');
  if (denied) return { ok: false, error: denied };
  const bad = JF.uploadBlocker(file);
  if (bad) return { ok: false, error: bad };
  const validUntil = opts.validUntil || null;
  if (validUntil && validUntil < today()) return { ok: false, error: 'That date has already passed — the file would be expired on arrival.' };

  const id = `sd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const stored = await JF.storeBlob(id, file);
  const doc: StandardDoc = {
    id,
    docId,
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    uploadedBy: opts.actor.name,
    uploadedAt: new Date().toISOString(),
    validUntil,
    autoApprove: opts.autoApprove,
    note: (opts.note || '').trim(),
    stored,
    withdrawnAt: null,
  };
  JOURNAL.docs.push(doc);
  persist();
  return { ok: true, doc };
}

/** Change the settings of the file in use. */
export function updateCurrent(
  docId: string,
  patch: { validUntil?: string | null; autoApprove?: boolean },
): { ok: true } | { ok: false; error: string } {
  const denied = ROLES.denial('wof.edit');
  if (denied) return { ok: false, error: denied };
  const c = current(docId);
  if (!c) return { ok: false, error: 'There is no standard file for that document.' };
  if (patch.validUntil && patch.validUntil < today()) return { ok: false, error: 'That date has already passed.' };
  if (patch.validUntil !== undefined) c.validUntil = patch.validUntil || null;
  if (patch.autoApprove !== undefined) c.autoApprove = patch.autoApprove;
  persist();
  return { ok: true };
}

/** Stop using the current file. Jobs that already have it keep their copy. */
export function withdraw(docId: string): boolean {
  const c = current(docId);
  if (!c) return false;
  c.withdrawnAt = new Date().toISOString();
  persist();
  return true;
}

/* -------------------------------------------------------- onto a job ---- */

/** Why the standard file cannot go on this job's row, or null. */
export function attachBlocker(w: W.Wof, docId: string): string | null {
  const row = (w.documents || []).find((d) => d.docId === docId);
  if (!row) return 'That document is not on this job.';
  const c = current(docId);
  if (!c) return 'There is no standard file for this document.';
  if (!validOn(c, w.end || w.start))
    return `The standard file runs out on ${c.validUntil}, before this event ends. Upload a current one first.`;
  if (row.status === 'approved') return 'This row is already approved.';
  const latest = JF.latest(w.id, docId);
  if (latest?.standardId === c.id && row.status !== 'required') return 'This job already has the current standard file.';
  return null;
}

export async function attachTo(
  w: W.Wof,
  docId: string,
  actor: W.Actor = ROLES.actingActor(),
): Promise<{ ok: true; approved: boolean } | { ok: false; error: string }> {
  const why = attachBlocker(w, docId);
  if (why) return { ok: false, error: why };
  const c = current(docId)!;
  const bytes = c.stored ? await JF.blob(c.id) : null;
  const note = c.validUntil ? `Standard document, valid until ${c.validUntil}` : 'Standard document';
  const r = await JF.attachStandard(
    w,
    docId,
    { standardId: c.id, name: c.name, size: c.size, mime: c.mime, bytes },
    { note, actor },
  );
  if (!r.ok) return r;
  if (c.autoApprove) {
    const a = JF.review(w, docId, 'approved');
    if (!a.ok) return { ok: true, approved: false };
    return { ok: true, approved: true };
  }
  return { ok: true, approved: false };
}

export interface AutoAttach {
  /** Labels of rows that got a file. */
  attached: string[];
  /** …of which these count as approved already. */
  approved: string[];
  /** Rows with a standard file that runs out before the event ends. */
  expired: string[];
}

/**
 * Called when a WOF is raised: put every applicable standard file on it.
 * Only touches rows that have no file and are still Required, so it is safe to
 * call again and never overwrites anything a person did.
 */
export async function attachAllTo(w: W.Wof, actor: W.Actor = ROLES.actingActor()): Promise<AutoAttach> {
  const out: AutoAttach = { attached: [], approved: [], expired: [] };
  for (const row of w.documents || []) {
    const c = current(row.docId);
    if (!c || row.status !== 'required' || JF.latest(w.id, row.docId)) continue;
    const label = docType(row.docId)?.label || row.docId;
    if (!validOn(c, w.end || w.start)) {
      out.expired.push(label);
      continue;
    }
    const r = await attachTo(w, row.docId, actor);
    if (r.ok) {
      out.attached.push(label);
      if (r.approved) out.approved.push(label);
    }
  }
  return out;
}

/** One line for a toast after raising a job. Empty when nothing happened. */
export function describe(a: AutoAttach): string {
  const parts: string[] = [];
  if (a.attached.length) {
    const n = a.attached.length;
    parts.push(
      `${n} standard document${n === 1 ? '' : 's'} attached${a.approved.length ? ` (${a.approved.length} already approved)` : ''}.`,
    );
  }
  if (a.expired.length) parts.push(`Not attached, expires before the event: ${a.expired.join(', ')}.`);
  return parts.join(' ');
}

/** Open the library file in a new tab, or download it. */
export function openFile(sd: StandardDoc): Promise<boolean> {
  return JF.openFile({ id: sd.id, name: sd.name, mime: sd.mime } as JF.JobFile);
}
