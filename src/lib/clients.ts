/* ============================================================================
   EPROSTA — CLIENT RECORDS (reference dataset 2 of 4)
   ----------------------------------------------------------------------------
   "New client" opened a form, took what you typed, threw it away, and said
   "Client created." That is the single worst failure mode in this system and
   the one the original critique named first: an action that fires a
   confirmation and changes nothing. An operator adds an account, sees the
   green toast, and finds out a week later it was never there.

   So this module exists to make the Clients screen mean what it says.

   THE CODE RULE IS ENFORCED, NOT JUST DESCRIBED
   --------------------------------------------
   The page already tells you codes should be "2–5 uppercase letters, unique
   across clients", and already flags the `YYY`, `ZZZ` and full-event-name junk
   sitting in the live data. Stating a rule while letting new records break it
   is how that junk got there. `validateCode()` is the same rule the list
   screen complains about, applied at the point of entry.

   WHY THERE IS A STORE AT ALL
   ---------------------------
   `CLIENTS` is built once at module load from the seed. A new record pushed
   into it survives until the tab is refreshed and no longer — the same
   in-memory-only bug that made seeded events vanish. Additions, edits and
   removals are therefore journalled to localStorage and replayed on load.

   A journal rather than a snapshot: seed improvements still land, and a saved
   edit is applied over the top of whatever the seed now says.
   ========================================================================== */

import { CLIENTS, CLIENT_DEFAULTS, EVENTS, client as clientById } from '@/data/db';
import type { Client } from '@/data/types';
import * as WOF from './wof';

const KEY = 'eprosta.clients.v1';

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

interface Journal {
  v: 1;
  added: Client[];
  edits: Record<string, Partial<Client>>;
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

const PLACEHOLDERS = /^(YYY|ZZZ|XXX|TBC|N\/A)$/i;

/**
 * The rule the list screen already states. Returns an error string, or null
 * when the code is good.
 */
export function validateCode(code: string, exceptId?: string): string | null {
  const c = code.trim().toUpperCase();
  if (!c) return 'Required';
  if (!/^[A-Z]{2,5}$/.test(c)) return '2–5 letters, no spaces or numbers';
  if (PLACEHOLDERS.test(c)) return 'That is a placeholder, not a code';
  if (CLIENTS.some((x) => x.id !== exceptId && x.code.toUpperCase() === c))
    return 'Already used by another client';
  return null;
}

export function validateName(name: string, exceptId?: string): string | null {
  const n = name.trim();
  if (!n) return 'Required';
  if (CLIENTS.some((x) => x.id !== exceptId && x.name.toLowerCase() === n.toLowerCase()))
    return 'A client with that name already exists';
  return null;
}

/* --------------------------------------------------------------- queries */

/** Ids in use, so a new record cannot land on one. */
function nextId(): string {
  const used = new Set(CLIENTS.map((c) => c.id));
  let n = CLIENTS.length + 1;
  while (used.has(`c-${n}`)) n++;
  return `c-${n}`;
}

/**
 * Work that would be orphaned by deleting this client. Checked before the
 * destructive action rather than described after it.
 */
export function clientCommitments(id: string): { events: number; wofs: number; live: number } {
  const mine = WOF.all().filter((w) => w.clientId === id);
  return {
    events: EVENTS.filter((e) => e.clientId === id).length,
    wofs: mine.length,
    live: mine.filter((w) => !WOF.isTerminal(w.stage)).length,
  };
}

/* -------------------------------------------------------------- mutations */

export interface ClientInput {
  name: string;
  code: string;
  email?: string;
  status?: 'active' | 'inactive';
  contact?: string;
  contactRole?: string;
  phone?: string;
  termsDays?: number;
  /**
   * Percentage taken on signing. Worth asking for at creation: the client's own
   * policy overrides the job type's default everywhere it is read, so leaving it
   * implicit means every new account silently inherits 25% whatever kind of work
   * they book.
   */
  depositPolicy?: number;
}

export interface CreateResult {
  ok: boolean;
  client?: Client;
  errors?: { name?: string; code?: string };
}

export function createClient(input: ClientInput): CreateResult {
  const errors = {
    name: validateName(input.name) ?? undefined,
    code: validateCode(input.code) ?? undefined,
  };
  if (errors.name || errors.code) return { ok: false, errors };

  const client: Client = {
    ...CLIENT_DEFAULTS,
    id: nextId(),
    name: input.name.trim(),
    code: input.code.trim().toUpperCase(),
    email: input.email?.trim() || '',
    status: input.status || 'active',
    tags: [],
    legalName: input.name.trim(),
    contact: input.contact?.trim() || null,
    contactRole: input.contactRole?.trim() || null,
    phone: input.phone?.trim() || null,
    billingEmail: input.email?.trim() || null,
    termsDays: input.termsDays ?? CLIENT_DEFAULTS.termsDays,
    depositPolicy: input.depositPolicy ?? CLIENT_DEFAULTS.depositPolicy,
  };

  CLIENTS.push(client);
  journal.added.push(client);
  write();
  return { ok: true, client };
}

export function updateClient(id: string, patch: Partial<Client>): CreateResult {
  const c = clientById(id);
  if (!c) return { ok: false };

  const errors = {
    name: patch.name !== undefined ? (validateName(patch.name, id) ?? undefined) : undefined,
    code: patch.code !== undefined ? (validateCode(patch.code, id) ?? undefined) : undefined,
  };
  if (errors.name || errors.code) return { ok: false, errors };

  const clean: Partial<Client> = { ...patch };
  if (clean.name) clean.name = clean.name.trim();
  if (clean.code) clean.code = clean.code.trim().toUpperCase();
  if (clean.email !== undefined) clean.email = clean.email.trim();

  Object.assign(c, clean);

  // A record created in this browser is edited in place in the journal; a
  // seeded one gets an overlay applied on top of the seed next time.
  const addedIndex = journal.added.findIndex((a) => a.id === id);
  if (addedIndex >= 0) journal.added[addedIndex] = { ...journal.added[addedIndex], ...clean };
  else journal.edits[id] = { ...(journal.edits[id] || {}), ...clean };

  write();
  return { ok: true, client: c };
}

export function removeClient(id: string): boolean {
  const i = CLIENTS.findIndex((c) => c.id === id);
  if (i < 0) return false;
  CLIENTS.splice(i, 1);

  journal.added = journal.added.filter((a) => a.id !== id);
  delete journal.edits[id];
  if (!journal.removed.includes(id)) journal.removed.push(id);

  write();
  return true;
}

/** Discard every local change and go back to the seeded register. */
export function resetClients(): void {
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
 * Edits first so an edited-then-removed client does not reappear.
 */
(function applyJournal() {
  Object.entries(journal.edits).forEach(([id, patch]) => {
    const c = clientById(id);
    if (c) Object.assign(c, patch);
  });

  journal.added.forEach((a) => {
    if (!CLIENTS.some((c) => c.id === a.id)) CLIENTS.push({ ...CLIENT_DEFAULTS, ...a });
  });

  journal.removed.forEach((id) => {
    const i = CLIENTS.findIndex((c) => c.id === id);
    if (i >= 0) CLIENTS.splice(i, 1);
  });
})();
