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

import { CLIENTS, CLIENT_DEFAULTS, CLIENT_DEPARTMENTS, CLIENT_REGIONS, CLIENT_TYPES, DEFAULT_CARD, EVENTS, MANAGERS, RATE_CARDS, SERVICE_TYPES, client as clientById } from '@/data/db';
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

/**
 * What is wrong with an EXISTING code, or null.
 *
 * `validateCode` refuses a bad code at the point of entry; this reports on the
 * ones already in the register, which is a different question — the register
 * holds `YYY`, `ZZZ` and a full event name, and none of those records can be
 * refused retrospectively. Kept here rather than on the list screen so the
 * list and the client's own record cannot disagree about which codes are junk.
 */
export function codeIssue(c: Pick<Client, 'id' | 'code'>): string | null {
  if (!c.code) return 'No code set.';
  if (PLACEHOLDERS.test(c.code)) return 'Placeholder value — replace with a real code.';
  if (c.code.length > 5) return 'Too long — codes should be 2–5 uppercase letters, not a full name.';
  const sharing = CLIENTS.filter((x) => x.code === c.code).length;
  if (sharing > 1) return `Duplicate — ${sharing} clients share this code.`;
  return null;
}

/**
 * The live form marks Email required and then accepts anything, so the
 * register holds addresses like "n/a" and "ask Colin". A required field that
 * is not checked is a field that collects noise.
 */
export function validateEmail(email: string, opts?: { required?: boolean }): string | null {
  const e = email.trim();
  if (!e) return opts?.required ? 'Required' : null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return 'That is not an email address';
  return null;
}

/** Empty is fine; a value has to be plausible. Scheme is optional on entry. */
export function validateWebsite(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  const bare = u.replace(/^https?:\/\//i, '');
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(\/.*)?$/i.test(bare)) return 'That is not a web address';
  return null;
}

/** UK postcodes, loosely — enough to catch a typed phone number. */
export function validatePostcode(pc: string): string | null {
  const c = pc.trim().toUpperCase();
  if (!c) return null;
  if (!/^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/.test(c)) return 'That is not a UK postcode';
  return null;
}

/** Normalised on save so the register does not hold "SO313DA" and "so31 3da". */
export function formatPostcode(pc: string): string {
  const c = pc.trim().toUpperCase().replace(/\s+/g, '');
  if (!c) return '';
  return /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(c) ? `${c.slice(0, -3)} ${c.slice(-3)}` : pc.trim().toUpperCase();
}

export function validateName(name: string, exceptId?: string): string | null {
  const n = name.trim();
  if (!n) return 'Required';
  if (CLIENTS.some((x) => x.id !== exceptId && x.name.toLowerCase() === n.toLowerCase()))
    return 'A client with that name already exists';
  return null;
}

/* --------------------------------------------------------------- queries */

/**
 * The address as one line. `address` is line one now that the form asks for
 * city, region and postcode separately, so anything printing "the address" has
 * to join them or a quote head loses everything below the street.
 */
export function clientAddress(c: Client): string {
  return [c.address, c.address2, c.city, c.region, c.postcode]
    .map((part) => (part || '').trim())
    .filter(Boolean)
    .join(', ');
}


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

  /* Ownership and classification. */
  clientManagerId?: string | null;
  /** One of RATE_CARDS. Anything else lands on Standard rather than nothing. */
  rateCardId?: string | null;
  department?: string | null;
  clientType?: string | null;
  serviceTypes?: string[];

  /* Contact block. */
  mobile?: string;
  landline?: string;
  website?: string;
  address?: string;
  address2?: string;
  city?: string;
  region?: string | null;
  postcode?: string;
  notes?: string;
}

export interface ClientErrors {
  name?: string;
  code?: string;
  email?: string;
  website?: string;
  postcode?: string;
}

/**
 * Reference values are checked rather than trusted. A department or manager
 * that is not on the list means a stale form or a hand-built payload, and
 * storing it produces a client whose owner does not exist.
 */
function cleanRef(value: string | null | undefined, allowed: readonly string[]): string | null {
  const v = (value ?? '').trim();
  return v && allowed.includes(v) ? v : null;
}

function cleanManager(id: string | null | undefined): string | null {
  const v = (id ?? '').trim();
  return v && MANAGERS.some((m) => m.id === v) ? v : null;
}

/**
 * An account is priced from SOMETHING, so an unknown card falls back to the
 * published one rather than to `null`. A nullable card every reader has to
 * remember to default is how a quote ends up priced from nothing at all.
 */
function cleanCard(id: string | null | undefined): string {
  const v = (id ?? '').trim();
  return v && RATE_CARDS.some((c) => c.id === v) ? v : DEFAULT_CARD;
}

function cleanServices(ids: string[] | undefined): string[] {
  if (!Array.isArray(ids)) return [];
  const known = ids.filter((i) => SERVICE_TYPES.some((s) => s.id === i));
  return [...new Set(known)];
}

export interface CreateResult {
  ok: boolean;
  client?: Client;
  errors?: ClientErrors;
}

/** Every check the create form runs, in one place, so the dialog and any other
    caller cannot disagree about what a valid client is. */
export function validateClient(input: ClientInput, exceptId?: string): ClientErrors {
  const errors: ClientErrors = {
    name: validateName(input.name, exceptId) ?? undefined,
    code: validateCode(input.code, exceptId) ?? undefined,
    email: validateEmail(input.email ?? '', { required: true }) ?? undefined,
    website: validateWebsite(input.website ?? '') ?? undefined,
    postcode: validatePostcode(input.postcode ?? '') ?? undefined,
  };
  (Object.keys(errors) as (keyof ClientErrors)[]).forEach((k) => {
    if (!errors[k]) delete errors[k];
  });
  return errors;
}

export const hasErrors = (e: ClientErrors): boolean => Object.keys(e).length > 0;

export function createClient(input: ClientInput): CreateResult {
  const errors = validateClient(input);
  if (hasErrors(errors)) return { ok: false, errors };

  const landline = input.landline?.trim() || input.phone?.trim() || '';

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
    // `phone` is what the rest of the app already reads. It stays the landline
    // unless there is only a mobile, so no existing screen loses its number.
    phone: landline || input.mobile?.trim() || null,
    billingEmail: input.email?.trim() || null,
    termsDays: input.termsDays ?? CLIENT_DEFAULTS.termsDays,
    depositPolicy: input.depositPolicy ?? CLIENT_DEFAULTS.depositPolicy,

    clientManagerId: cleanManager(input.clientManagerId),
    department: cleanRef(input.department, CLIENT_DEPARTMENTS),
    clientType: cleanRef(input.clientType, CLIENT_TYPES),
    serviceTypes: cleanServices(input.serviceTypes),
    rateCardId: cleanCard(input.rateCardId),

    mobile: input.mobile?.trim() || null,
    landline: landline || null,
    website: input.website?.trim() || null,
    address: input.address?.trim() || null,
    address2: input.address2?.trim() || null,
    city: input.city?.trim() || null,
    region: cleanRef(input.region, CLIENT_REGIONS),
    postcode: formatPostcode(input.postcode ?? '') || null,
    notes: input.notes?.trim() || null,
  };

  CLIENTS.push(client);
  journal.added.push(client);
  write();
  return { ok: true, client };
}

export function updateClient(id: string, patch: Partial<Client>): CreateResult {
  const c = clientById(id);
  if (!c) return { ok: false };

  const errors: ClientErrors = {};
  if (patch.name !== undefined) errors.name = validateName(patch.name, id) ?? undefined;
  if (patch.code !== undefined) errors.code = validateCode(patch.code, id) ?? undefined;
  // An existing record may predate the required-email rule, so an edit only has
  // to leave it valid, not fill it in.
  if (patch.email !== undefined) errors.email = validateEmail(patch.email) ?? undefined;
  if (patch.website !== undefined) errors.website = validateWebsite(patch.website ?? '') ?? undefined;
  if (patch.postcode !== undefined) errors.postcode = validatePostcode(patch.postcode ?? '') ?? undefined;
  (Object.keys(errors) as (keyof ClientErrors)[]).forEach((k) => {
    if (!errors[k]) delete errors[k];
  });
  if (hasErrors(errors)) return { ok: false, errors };

  const clean: Partial<Client> = { ...patch };
  if (clean.name) clean.name = clean.name.trim();
  if (clean.code) clean.code = clean.code.trim().toUpperCase();
  if (clean.email !== undefined) clean.email = clean.email.trim();
  if (clean.postcode !== undefined) clean.postcode = formatPostcode(clean.postcode ?? '') || null;
  if (clean.clientManagerId !== undefined) clean.clientManagerId = cleanManager(clean.clientManagerId);
  if (clean.department !== undefined) clean.department = cleanRef(clean.department, CLIENT_DEPARTMENTS);
  if (clean.clientType !== undefined) clean.clientType = cleanRef(clean.clientType, CLIENT_TYPES);
  if (clean.region !== undefined) clean.region = cleanRef(clean.region, CLIENT_REGIONS);
  if (clean.rateCardId !== undefined) clean.rateCardId = cleanCard(clean.rateCardId);
  if (clean.serviceTypes !== undefined) clean.serviceTypes = cleanServices(clean.serviceTypes);
  // Keep the number the rest of the app reads in step with the two it is split
  // into, rather than letting `phone` rot at whatever it was on creation.
  if (clean.landline !== undefined || clean.mobile !== undefined) {
    const landline = clean.landline !== undefined ? clean.landline : c.landline;
    const mobile = clean.mobile !== undefined ? clean.mobile : c.mobile;
    clean.phone = (landline || mobile || null) as string | null;
  }

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
    // A record journalled before the service-type fields existed comes back
    // without them; the spread would then hand it CLIENT_DEFAULTS' own array.
    if (!CLIENTS.some((c) => c.id === a.id))
      CLIENTS.push({ ...CLIENT_DEFAULTS, ...a, serviceTypes: [...(a.serviceTypes ?? [])] });
  });

  journal.removed.forEach((id) => {
    const i = CLIENTS.findIndex((c) => c.id === id);
    if (i >= 0) CLIENTS.splice(i, 1);
  });
})();
