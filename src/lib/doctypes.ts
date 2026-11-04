/* ============================================================================
   EPROSTA — DOCUMENT TYPES (adding EP documents without a developer)
   ----------------------------------------------------------------------------
   `DOCUMENT_TYPES` was a hard-coded array, so a new piece of EP paperwork (a
   fire safety plan, a COSHH register) needed a code change before it could
   go on a checklist or hold a standard file. Same journal-over-seed approach
   as `jobtypes.ts`: additions are kept in storage and replayed onto the seed —
   the replay itself sits in `data/db.ts`, next to the seed, so ids on saved
   work orders resolve before anything else loads.

   Only additions, and only removals of what was added here. The seeded types
   are referenced by job types, the seed's own jobs and the reports.
   ========================================================================== */

import { DOCUMENT_TYPES, DOC_TYPES_KEY, JOB_TYPES, docType } from '@/data/db';
import type { DocumentType } from '@/data/types';
import * as WOF from './wof';
import * as JT from './jobtypes';
import * as SD from './standarddocs';

interface Journal {
  v: 1;
  added: DocumentType[];
}

function read(): Journal {
  try {
    const raw = JSON.parse(localStorage.getItem(DOC_TYPES_KEY) || 'null');
    if (raw && raw.v === 1 && Array.isArray(raw.added)) return { v: 1, added: raw.added };
  } catch {
    /* fall through */
  }
  return { v: 1, added: [] };
}

let journal = read();

const listeners = new Set<() => void>();
let version = 0;
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export const getVersion = (): number => version;

function write(): void {
  try {
    localStorage.setItem(DOC_TYPES_KEY, JSON.stringify(journal));
  } catch {
    /* private mode — in memory only */
  }
  version += 1;
  listeners.forEach((fn) => fn());
}

export const isCustom = (id: string): boolean => journal.added.some((d) => d.id === id);

/** Who owns EP paperwork — the owners already in use, never the client. */
export const EP_OWNERS = (): string[] =>
  [...new Set(['EP Operations', 'EP Finance', 'EP Compliance', ...DOCUMENT_TYPES.map((d) => d.owner)])].filter(
    (o) => o !== 'Client',
  );

export interface DocTypeInput {
  label: string;
  owner: string;
  leadDays: number;
  blocking: boolean;
  /** Job types whose checklist gets it from now on. */
  jobTypeIds: string[];
}

export type DocTypeErrors = Partial<Record<'label' | 'owner' | 'leadDays', string>>;

export function validate(input: DocTypeInput): DocTypeErrors {
  const e: DocTypeErrors = {};
  const label = input.label.trim();
  if (!label) e.label = 'Name the document.';
  else if (DOCUMENT_TYPES.some((d) => d.label.trim().toLowerCase() === label.toLowerCase()))
    e.label = 'A document with that name already exists.';
  if (!input.owner.trim() || input.owner.trim() === 'Client') e.owner = 'Pick who at EP provides it.';
  if (!Number.isInteger(input.leadDays) || input.leadDays < 0 || input.leadDays > 365)
    e.leadDays = 'Whole days, 0 to 365.';
  return e;
}

function slug(label: string): string {
  const base =
    label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'doc';
  let id = `doc-${base}`;
  let n = 2;
  while (docType(id)) id = `doc-${base}-${n++}`;
  return id;
}

export function create(input: DocTypeInput): { ok: true; doc: DocumentType } | { ok: false; errors: DocTypeErrors } {
  const errors = validate(input);
  if (Object.keys(errors).length) return { ok: false, errors };
  const doc: DocumentType = {
    id: slug(input.label),
    label: input.label.trim(),
    owner: input.owner.trim(),
    leadDays: input.leadDays,
    blocking: input.blocking,
  };
  DOCUMENT_TYPES.push(doc);
  journal.added.push({ ...doc });
  write();
  input.jobTypeIds.forEach((jt) => JT.setDocIncluded(jt, doc.id, true));
  return { ok: true, doc };
}

/** Why a custom document cannot be removed, or null when it can. */
export function removeBlocker(id: string): string | null {
  if (!isCustom(id)) return 'Built-in documents cannot be removed.';
  const jobs = WOF.all().filter((w) => (w.documents || []).some((d) => d.docId === id)).length;
  if (jobs)
    return `${jobs} work order${jobs === 1 ? ' has' : 's have'} it on the checklist, so it has to stay.`;
  if (SD.current(id)) return 'It has a standard file. Stop using the file first.';
  return null;
}

export function remove(id: string): { ok: boolean; reason?: string } {
  const reason = removeBlocker(id);
  if (reason) return { ok: false, reason };
  JOB_TYPES.filter((j) => j.docs.includes(id)).forEach((j) => JT.setDocIncluded(j.id, id, false));
  const i = DOCUMENT_TYPES.findIndex((d) => d.id === id);
  if (i >= 0) DOCUMENT_TYPES.splice(i, 1);
  journal.added = journal.added.filter((d) => d.id !== id);
  write();
  return { ok: true };
}
