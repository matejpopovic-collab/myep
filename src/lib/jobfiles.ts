/* ============================================================================
   JOB DOCUMENT FILES — the actual files behind a work order's checklist
   ----------------------------------------------------------------------------
   The checklist on a job (WOF → Documents) used to be statuses only: a row
   could read "Approved" with nothing behind it, and the client portal's
   "Send it" accepted no file at all. This module keeps the files.

     · VERSIONS, NEVER OVERWRITES. Every upload is a new version on its row.
       When something is sent back and replaced, both are kept, so "what did
       they send us the first time?" has an answer.

     · THE DECISION LIVES ON THE VERSION. Approved or sent back — with who,
       when and, for a send-back, why — is recorded against the exact file it
       was made about, not just the row.

     · STORAGE IS THE BROWSER'S in the prototype: metadata in localStorage,
       bytes in IndexedDB (the same arrangement as client documents). A real
       build swaps `put`/`blob` for server file storage and keeps the rest.
   ========================================================================== */

import * as ROLES from './roles';
import * as W from './wof';

const KEY = 'eprosta.jobfiles.v1';
const DB_NAME = 'eprosta-job-files';
const STORE = 'files';

export const MAX_BYTES = 25 * 1024 * 1024;
const ACCEPT_EXT = ['pdf', 'doc', 'docx', 'png', 'jpg', 'jpeg', 'heic', 'webp', 'gif', 'xls', 'xlsx', 'dwg', 'dxf'];
export const ACCEPT_ATTR = ACCEPT_EXT.map((e) => `.${e}`).join(',');

export interface Review {
  decision: 'approved' | 'returned';
  by: string;
  at: string;
  reason: string;
}

export interface JobFile {
  id: string;
  wofId: string;
  docId: string;
  name: string;
  size: number;
  mime: string;
  side: 'client' | 'ep';
  uploadedBy: string;
  uploadedAt: string;
  note: string;
  /** False when the browser refused to keep the bytes (quota, private mode). */
  stored: boolean;
  review: Review | null;
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
  files: JobFile[];
}

function load(): Journal {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null') as Journal | null;
    if (raw && raw.v === 1 && Array.isArray(raw.files)) return raw;
  } catch {
    /* private mode or junk */
  }
  return { v: 1, files: [] };
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

export function resetJobFiles(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  JOURNAL = { v: 1, files: [] };
  version += 1;
  listeners.forEach((fn) => fn());
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
          tx.onerror = () => resolve(false);
          tx.onabort = () => resolve(false);
        } catch {
          resolve(false);
        }
      }),
  );
}

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

/* ------------------------------------------------------------------ reads */

/** Every version of one row's file, newest first. */
export function versions(wofId: string, docId: string): JobFile[] {
  return JOURNAL.files
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.wofId === wofId && f.docId === docId)
    .sort((a, b) => b.f.uploadedAt.localeCompare(a.f.uploadedAt) || b.i - a.i)
    .map(({ f }) => f);
}

export const latest = (wofId: string, docId: string): JobFile | null => versions(wofId, docId)[0] ?? null;

export const fmtSize = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Why a file cannot be taken, or null. Said in the words of the person dropping it. */
export function uploadBlocker(file: { name: string; size: number }): string | null {
  if (!file.size) return 'That file is empty.';
  if (file.size > MAX_BYTES) return `${fmtSize(file.size)} is over the ${fmtSize(MAX_BYTES)} limit.`;
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  if (!ACCEPT_EXT.includes(ext)) return 'Send a PDF, a Word or Excel file, a drawing or an image.';
  return null;
}

/* ----------------------------------------------------------------- writes */

export type Result = { ok: true; file: JobFile } | { ok: false; error: string };

/**
 * Attach a file to a checklist row and mark the row submitted. The client may
 * only send their own rows; EP may attach to any row but needs `wof.edit`.
 */
export async function submit(
  w: W.Wof,
  docId: string,
  file: File,
  opts: { note?: string; actor: W.Actor; side: 'client' | 'ep' },
): Promise<Result> {
  const bad = uploadBlocker(file);
  if (bad) return { ok: false, error: bad };
  const row = (w.documents || []).find((d) => d.docId === docId);
  if (!row) return { ok: false, error: 'That document is not on this job.' };
  if (opts.side === 'client' && row.owner !== 'Client') return { ok: false, error: 'This document is EP Team’s to provide.' };
  if (opts.side === 'ep') {
    const denied = ROLES.denial('wof.edit');
    if (denied) return { ok: false, error: denied };
  }

  const id = `jf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const stored = await put(id, file);
  const f: JobFile = {
    id,
    wofId: w.id,
    docId,
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    side: opts.side,
    uploadedBy: opts.actor.name,
    uploadedAt: new Date().toISOString(),
    note: (opts.note || '').trim(),
    stored,
    review: null,
  };
  JOURNAL.files.push(f);
  persist();
  W.submitDocFile(w, docId, file.name, f.note, opts.actor, opts.side);
  return { ok: true, file: f };
}

/** Approve or send back the latest version. A send-back needs a reason. */
export function review(
  w: W.Wof,
  docId: string,
  decision: 'approved' | 'returned',
  reason = '',
): { ok: true } | { ok: false; error: string } {
  const denied = ROLES.denial('wof.edit');
  if (denied) return { ok: false, error: denied };
  const actor = ROLES.actingActor();
  const r = W.reviewDoc(w, docId, decision, reason, actor);
  if (!r.ok) return r;
  const f = latest(w.id, docId);
  if (f && !f.review) {
    f.review = { decision, by: actor.name, at: new Date().toISOString(), reason: reason.trim() };
    persist();
  }
  return { ok: true };
}

/** Open the file in a new tab when the browser can show it, else download it. */
export async function openFile(f: JobFile): Promise<boolean> {
  const b = await blob(f.id);
  if (!b) return false;
  const url = URL.createObjectURL(b);
  const viewable = /^(application\/pdf|image\/)/.test(b.type || f.mime);
  if (viewable) {
    window.open(url, '_blank', 'noopener');
  } else {
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}
