/* ============================================================================
   EPROSTA — CLIENT DOCUMENTS (the paperwork that belongs to the ACCOUNT)
   ----------------------------------------------------------------------------
   The document checklist on a WOF tracks paperwork for one job: this event's
   risk assessment, this event's site plan. It has always been the right shape
   for that and the wrong shape for the other half of the filing cabinet — the
   client's insurance certificate, their signed framework, their purchase-order
   template. Those are facts about the ACCOUNT. Tracked per job they were typed
   in eleven times a year, expired in one place and not the other, and were
   re-requested from a client who had sent them in January.

   So they live here, once, on the client.

   WHY THE FILE IS ACTUALLY STORED
   -------------------------------
   The job checklist records a STATUS and no bytes — `submitted` means somebody
   said so. That is honest for a workflow where the document is emailed around,
   and useless for the question this screen exists to answer: "send me their
   EL cert". A register that knows a certificate exists but cannot produce it
   is a register of promises.

   The bytes therefore go in IndexedDB, which is the only browser store that
   will take a multi-megabyte PDF; the METADATA goes in localStorage beside
   every other journal in this app, because it is small, synchronous, and every
   screen already reads its store that way. Two stores, one record, and the
   record says which of them actually has the file — see `stored`.

   WHEN THE BYTES CANNOT BE KEPT
   -----------------------------
   Private windows, a full disk and a browser with site data blocked all refuse
   IndexedDB. The upload is NOT silently accepted in that case: the record is
   kept, `stored` is false, and the screen says the file itself could not be
   held. A document register that quietly loses the document is worse than one
   that never claimed to have it.
   ========================================================================== */

import { DOCUMENT_TYPES, NOW, docType } from '@/data/db';
import { addDays, dayDiff } from './format';
import * as ROLES from './roles';

const KEY = 'eprosta.clientdocs.v1';
const DB_NAME = 'eprosta-client-files';
const STORE = 'files';

/** Per file. Big enough for a scanned framework agreement, small enough that
    a mis-drop of a video does not fill the origin's quota in one go. */
export const MAX_BYTES = 10 * 1024 * 1024;

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

export interface ClientDoc {
  id: string;
  clientId: string;
  /** The original filename, kept as typed by whoever's machine it came off. */
  name: string;
  size: number;
  mime: string;
  /** A DOCUMENT_TYPES id, or '' for something that is not on the list. */
  docTypeId: string;
  /** ISO date. `null` is a real answer: an MSA does not expire. */
  expires: string | null;
  note: string;
  uploadedAt: string;
  uploadedBy: string;
  /** False when the browser refused to keep the bytes. See the header. */
  stored: boolean;
}

interface Journal {
  v: 1;
  docs: ClientDoc[];
}

const empty = (): Journal => ({ v: 1, docs: [] });

function load(): Journal {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null') as Journal | null;
    if (!raw || raw.v !== 1 || !Array.isArray(raw.docs)) return empty();
    return { v: 1, docs: raw.docs };
  } catch {
    return empty();
  }
}

let JOURNAL: Journal = load();

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(JOURNAL));
  } catch {
    /* private mode — degrades to in-memory */
  }
  emit();
}

/* ------------------------------------------------------------- the bytes */

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function put(id: string, blob: Blob): Promise<boolean> {
  return open().then(
    (db) =>
      new Promise<boolean>((resolve) => {
        if (!db) return resolve(false);
        try {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(blob, id);
          tx.oncomplete = () => resolve(true);
          // A quota error lands here, which is exactly the case `stored: false`
          // exists for.
          tx.onerror = () => resolve(false);
          tx.onabort = () => resolve(false);
        } catch {
          resolve(false);
        }
      }),
  );
}

/** The file itself, or null when this browser never managed to keep it. */
export function blob(id: string): Promise<Blob | null> {
  return open().then(
    (db) =>
      new Promise<Blob | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
          req.onsuccess = () => resolve((req.result as Blob) || null);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

function drop(id: string): Promise<void> {
  return open().then((db) => {
    if (!db) return;
    try {
      db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id);
    } catch {
      /* nothing to clean up */
    }
  });
}

/* -------------------------------------------------------------- reading */

/** This account's paperwork, newest first. */
export const forClient = (clientId: string): ClientDoc[] =>
  JOURNAL.docs
    .filter((d) => d.clientId === clientId)
    .sort((a, b) => +new Date(b.uploadedAt) - +new Date(a.uploadedAt));

export const byId = (id: string): ClientDoc | undefined => JOURNAL.docs.find((d) => d.id === id);

export type ExpiryState = 'none' | 'valid' | 'expiring' | 'expired';

/** Inside this many days, a certificate is worth chasing rather than noting. */
export const EXPIRY_WARNING_DAYS = 30;

export function expiryState(d: ClientDoc): ExpiryState {
  if (!d.expires) return 'none';
  const days = dayDiff(NOW, d.expires);
  if (days < 0) return 'expired';
  return days <= EXPIRY_WARNING_DAYS ? 'expiring' : 'valid';
}

/** What needs chasing on this account, worst first. */
export function needsAttention(clientId: string): ClientDoc[] {
  const rank: Record<ExpiryState, number> = { expired: 0, expiring: 1, valid: 2, none: 3 };
  return forClient(clientId)
    .filter((d) => expiryState(d) === 'expired' || expiryState(d) === 'expiring' || !d.stored)
    .sort((a, b) => rank[expiryState(a)] - rank[expiryState(b)]);
}

/** The document types worth offering. The job checklist's list, plus the
    account-level paperwork that never belonged to one event. */
export const DOC_TYPES = (): { id: string; label: string }[] => [
  { id: 'insurance', label: docType('insurance')?.label || 'Insurance certificate' },
  { id: 'framework', label: 'Framework / signed agreement' },
  { id: 'purchase-order', label: 'Purchase order' },
  { id: 'vat-invoice-detail', label: 'Invoicing and VAT details' },
  { id: 'supplier-form', label: 'Supplier onboarding form' },
  ...DOCUMENT_TYPES.filter((t) => !['insurance', 'purchase-order'].includes(t.id)).map((t) => ({
    id: t.id,
    label: t.label,
  })),
];

export const typeLabel = (id: string): string =>
  DOC_TYPES().find((t) => t.id === id)?.label || 'Other';

export const fmtSize = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/* -------------------------------------------------------------- writing */

export interface Result {
  ok: boolean;
  reason?: string;
  doc?: ClientDoc;
  /** True when the record was kept but the browser refused the bytes. */
  recordOnly?: boolean;
}

export interface UploadMeta {
  docTypeId?: string;
  expires?: string | null;
  note?: string;
}

export function uploadBlocker(file: { name: string; size: number }): string | null {
  if (!ROLES.can('clients.edit')) return 'Only an account manager can file a document against a client.';
  if (!file.name.trim()) return 'That file has no name.';
  if (!file.size) return 'That file is empty.';
  if (file.size > MAX_BYTES)
    return `${fmtSize(file.size)} is over the ${fmtSize(MAX_BYTES)} limit for a document.`;
  return null;
}

export async function upload(
  clientId: string,
  file: File,
  meta: UploadMeta = {},
): Promise<Result> {
  const blocker = uploadBlocker(file);
  if (blocker) return { ok: false, reason: blocker };

  const id = `cd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const stored = await put(id, file);

  const doc: ClientDoc = {
    id,
    clientId,
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    docTypeId: meta.docTypeId || '',
    expires: meta.expires || null,
    note: (meta.note || '').trim(),
    uploadedAt: new Date().toISOString(),
    uploadedBy: ROLES.actingActor().name,
    stored,
  };
  JOURNAL.docs.push(doc);
  persist();
  return { ok: true, doc, recordOnly: !stored };
}

/** Amend what the record SAYS. The bytes are never edited — a new version of
    a document is a new upload, so the old one can still be produced. */
export function update(id: string, patch: Partial<Pick<ClientDoc, 'docTypeId' | 'expires' | 'note'>>): Result {
  if (!ROLES.can('clients.edit')) return { ok: false, reason: 'Only an account manager can amend a document.' };
  const d = byId(id);
  if (!d) return { ok: false, reason: 'No such document.' };
  Object.assign(d, {
    ...patch,
    ...(patch.note !== undefined ? { note: patch.note.trim() } : {}),
  });
  persist();
  return { ok: true, doc: d };
}

/** Removes the record AND the bytes. There is no history to protect here —
    unlike a charge line, nothing else in the system points at a document. */
export async function remove(id: string): Promise<Result> {
  if (!ROLES.can('clients.edit')) return { ok: false, reason: 'Only an account manager can remove a document.' };
  const i = JOURNAL.docs.findIndex((d) => d.id === id);
  if (i < 0) return { ok: false, reason: 'No such document.' };
  JOURNAL.docs.splice(i, 1);
  persist();
  await drop(id);
  return { ok: true };
}

/** Hand the file back to the operator. Returns false when there is nothing to
    hand back, so the caller can say so rather than opening a blank tab. */
export async function download(id: string): Promise<boolean> {
  const d = byId(id);
  if (!d) return false;
  const b = await blob(id);
  if (!b) return false;
  const url = URL.createObjectURL(b);
  const a = document.createElement('a');
  a.href = url;
  a.download = d.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick: Safari has not finished with the URL when click()
  // returns, and revoking synchronously produces a silently empty file.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

/** A sensible default expiry for the types that have one. Insurance is annual;
    most of the rest are not dated at all. */
export const suggestedExpiry = (docTypeId: string): string | null =>
  docTypeId === 'insurance' || docTypeId === 'radio-licence' || docTypeId === 'event-licence'
    ? addDays(NOW, 365).slice(0, 10)
    : null;

/** Test seam. Drops the metadata; the bytes go with the next remove(). */
export function resetClientDocs(): void {
  JOURNAL = empty();
  persist();
}
