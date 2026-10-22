/* ============================================================================
   CLIENT HISTORY — what changed on an account, who changed it, and when
   ----------------------------------------------------------------------------
   Before this, a client edit kept only the new values. Nobody could answer
   "who changed the sort code?" — which is the question behind invoice fraud
   (a phone call with "our new bank details") — nor "what rate did we agree,
   and when?", which is the question behind every invoice dispute.

   Shape of the log:

     · ONE ENTRY PER AREA PER SAVE. A save that touches the address and the
       bank details is two entries, so filtering to "Bank & billing" never
       hides a bank change inside a "details updated" row.

     · THE CHANGE IS IN THE ROW. Each entry carries field / before / after,
       already formatted. The old screen's "UPDATE CLIENT … [Show]" made every
       row read the same.

     · SENSITIVE VALUES ARE MASKED HERE, at write time. Account number and IBAN
       keep their last four, the sort code its last two. The log is for proving
       a change happened, not a second place to read bank details from.

     · APPEND-ONLY. There is no edit or delete in this module's API, for any
       role. The one way to clear it is the prototype's "Reset everything",
       which wipes the whole browser's data and is not a product feature.

     · JOB EVENTS LIVE ON THE JOB. Quotes, signatures and payments are already
       in each work order's own History tab; repeating them here would bury the
       account changes this log exists for.
   ========================================================================== */

import {
  MANAGERS, SERVICE_TYPES, client as clientById, rateCard, tag as tagById,
} from '@/data/db';
import type { Client } from '@/data/types';
import * as ROLES from './roles';
import * as NOTIFICATIONS from './notifications';

const KEY = 'eprosta.clienthistory.v1';

export type Area = 'details' | 'billing' | 'rates' | 'documents' | 'portal' | 'status';

export const AREAS: { id: Area; label: string; icon: string }[] = [
  { id: 'details', label: 'Details', icon: 'building' },
  { id: 'billing', label: 'Bank & billing', icon: 'trendUp' },
  { id: 'rates', label: 'Rates', icon: 'layers' },
  { id: 'documents', label: 'Documents', icon: 'fileText' },
  { id: 'portal', label: 'Portal access', icon: 'users' },
  { id: 'status', label: 'Status', icon: 'checkCircle' },
];
export const areaLabel = (a: Area): string => AREAS.find((x) => x.id === a)?.label ?? a;

export interface Change {
  label: string;
  from: string;
  to: string;
}

export interface Entry {
  id: string;
  clientId: string;
  at: string;
  by: string;
  area: Area;
  title: string;
  changes: Change[];
  /** Bank details, VAT, a new approver — the changes worth a second look. */
  sensitive: boolean;
  /** Set when the change also raised an alert in the notification feed. */
  alerted?: boolean;
  note?: string;
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
  entries: Entry[];
}

function localIso(t: number): string {
  const d = new Date(t);
  return new Date(t - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}
const ago = (days: number, hour: number): string => {
  const d = new Date(Date.now() - days * 86400000);
  d.setHours(hour, 0, 0, 0);
  return localIso(+d);
};

/* Festival Republic's portal users ship seeded, so their invites ship in the
   log too — otherwise the one account with a story would open on "no history". */
function seed(): Entry[] {
  return [
    {
      id: 'ch-seed-1', clientId: 'c-19', at: ago(220, 10), by: 'Colin Harding', area: 'portal',
      title: 'Portal invite sent to Dana Reilly', sensitive: true,
      changes: [{ label: 'Role', from: '—', to: 'Approver' }, { label: 'Email', from: '—', to: 'dana.reilly@festivalrepublic.com' }],
    },
    {
      id: 'ch-seed-2', clientId: 'c-19', at: ago(220, 15), by: 'Dana Reilly (Festival Republic Ltd)', area: 'portal',
      title: 'Dana Reilly accepted the invite and set a password', sensitive: false, changes: [],
    },
    {
      id: 'ch-seed-3', clientId: 'c-19', at: ago(150, 11), by: 'Colin Harding', area: 'portal',
      title: 'Portal invite sent to Tom Akers', sensitive: false,
      changes: [{ label: 'Role', from: '—', to: 'Viewer' }, { label: 'Email', from: '—', to: 'tom.akers@festivalrepublic.com' }],
    },
    {
      id: 'ch-seed-4', clientId: 'c-19', at: ago(149, 8), by: 'Tom Akers (Festival Republic Ltd)', area: 'portal',
      title: 'Tom Akers accepted the invite and set a password', sensitive: false, changes: [],
    },
    {
      id: 'ch-seed-5', clientId: 'c-19', at: ago(4, 15), by: 'Colin Harding', area: 'portal',
      title: 'Portal invite sent to Priya Shah', sensitive: true,
      changes: [{ label: 'Role', from: '—', to: 'Approver' }, { label: 'Email', from: '—', to: 'ap@festivalrepublic.com' }],
    },
  ];
}

function load(): Journal {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null') as Journal | null;
    if (raw && raw.v === 1 && Array.isArray(raw.entries)) return raw;
  } catch {
    /* private mode or junk */
  }
  return { v: 1, entries: seed() };
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

/** Prototype "Reset everything" only. Not exposed anywhere a user can reach alone. */
export function resetClientHistory(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  JOURNAL = { v: 1, entries: seed() };
  version += 1;
  listeners.forEach((fn) => fn());
}

/* ------------------------------------------------------------------ reads */

/** Newest first. A copy, so nothing outside can reorder or trim the log. */
export function forClient(clientId: string, area?: Area | 'all'): Entry[] {
  // The log is appended in order, so position breaks ties between entries
  // written in the same second (a save that touches two areas, say).
  return JOURNAL.entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.clientId === clientId && (!area || area === 'all' || e.area === area))
    .sort((a, b) => b.e.at.localeCompare(a.e.at) || b.i - a.i)
    .map(({ e }) => ({ ...e, changes: e.changes.map((c) => ({ ...c })) }));
}

export function counts(clientId: string): Record<Area | 'all', number> {
  const out = { all: 0, details: 0, billing: 0, rates: 0, documents: 0, portal: 0, status: 0 } as Record<Area | 'all', number>;
  JOURNAL.entries.forEach((e) => {
    if (e.clientId !== clientId) return;
    out.all++;
    out[e.area]++;
  });
  return out;
}

/* ----------------------------------------------------------------- writes */

export function record(input: Omit<Entry, 'id' | 'at' | 'by' | 'sensitive'> & { by?: string; sensitive?: boolean }): Entry {
  const e: Entry = {
    id: `ch-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    at: localIso(Date.now()),
    by: input.by || ROLES.actingActor().name,
    sensitive: !!input.sensitive,
    ...input,
  } as Entry;
  if (!e.by) e.by = ROLES.actingActor().name;
  JOURNAL.entries.push(e);
  persist();
  return e;
}

/* ------------------------------------------------- client field changes --- */

interface FieldMeta {
  label: string;
  area: Area;
  sensitive?: boolean;
  mask?: 'last4' | 'sort';
  show?: (v: unknown) => string;
}

const joinTags = (v: unknown) => (Array.isArray(v) ? v.map((t) => tagById(t)?.label || t).join(', ') : '');
const joinServices = (v: unknown) =>
  Array.isArray(v) ? v.map((s) => SERVICE_TYPES.find((x) => x.id === s)?.label || s).join(', ') : '';

const FIELDS: Partial<Record<keyof Client, FieldMeta>> = {
  name: { label: 'Trading name', area: 'details' },
  legalName: { label: 'Legal name', area: 'details' },
  code: { label: 'Account code', area: 'details' },
  email: { label: 'Main email', area: 'details' },
  status: { label: 'Status', area: 'status', show: (v) => (v === 'active' ? 'Active' : 'Inactive') },
  tags: { label: 'Requirements', area: 'details', show: joinTags },
  contact: { label: 'Main contact', area: 'details' },
  contactRole: { label: 'Contact role', area: 'details' },
  agreement: { label: 'Agreement', area: 'details' },
  agreementEnds: { label: 'Agreement ends', area: 'details' },
  clientManagerId: {
    label: 'Client manager', area: 'status',
    show: (v) => MANAGERS.find((m) => m.id === v)?.name || '',
  },
  department: { label: 'Department', area: 'details' },
  clientType: { label: 'Client type', area: 'details' },
  serviceTypes: { label: 'Service types', area: 'details', show: joinServices },
  rateCardId: { label: 'Rate card', area: 'rates', show: (v) => (v ? rateCard(String(v)).label : '') },
  mobile: { label: 'Mobile', area: 'details' },
  landline: { label: 'Landline', area: 'details' },
  website: { label: 'Website', area: 'details' },
  address: { label: 'Trading address', area: 'details' },
  address2: { label: 'Trading address line 2', area: 'details' },
  city: { label: 'Trading town', area: 'details' },
  region: { label: 'Region', area: 'details' },
  postcode: { label: 'Trading postcode', area: 'details' },
  notes: { label: 'Notes', area: 'details' },
  companyNumber: { label: 'Company number', area: 'details' },
  legalStructure: { label: 'Legal structure', area: 'details' },
  regAddress: { label: 'Registered address', area: 'details' },
  regAddress2: { label: 'Registered address line 2', area: 'details' },
  regCity: { label: 'Registered town', area: 'details' },
  regPostcode: { label: 'Registered postcode', area: 'details' },
  billingEmail: { label: 'Invoice email', area: 'billing' },
  termsDays: { label: 'Credit terms (days)', area: 'billing' },
  creditLimit: { label: 'Credit limit', area: 'billing' },
  depositPolicy: { label: 'Deposit %', area: 'billing' },
  billingSameAs: { label: 'Billing address', area: 'billing' },
  billAddress: { label: 'Billing address', area: 'billing' },
  billAddress2: { label: 'Billing address line 2', area: 'billing' },
  billCity: { label: 'Billing town', area: 'billing' },
  billPostcode: { label: 'Billing postcode', area: 'billing' },
  vatNumber: { label: 'VAT number', area: 'billing', sensitive: true },
  invoiceContactName: { label: 'Invoice contact', area: 'billing' },
  invoiceContactPhone: { label: 'Invoice contact phone', area: 'billing' },
  paymentMethod: { label: 'Payment method', area: 'billing' },
  bankAccountName: { label: 'Account name', area: 'billing', sensitive: true },
  bankAccountNumber: { label: 'Account number', area: 'billing', sensitive: true, mask: 'last4' },
  bankSortCode: { label: 'Sort code', area: 'billing', sensitive: true, mask: 'sort' },
  bankName: { label: 'Bank', area: 'billing', sensitive: true },
  bankBranch: { label: 'Branch', area: 'billing', sensitive: true },
  iban: { label: 'IBAN', area: 'billing', sensitive: true, mask: 'last4' },
  swift: { label: 'SWIFT / BIC', area: 'billing', sensitive: true },
};

/** Fields the app derives itself; logging them would double every change. */
const SKIP = new Set<keyof Client>(['id', 'phone', 'tone' as keyof Client]);

const BANK_FIELDS = new Set<keyof Client>([
  'bankAccountName', 'bankAccountNumber', 'bankSortCode', 'bankName', 'bankBranch', 'iban', 'swift',
]);

function plain(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

export function maskValue(v: string, mask?: FieldMeta['mask']): string {
  if (!v || !mask) return v;
  const digits = v.replace(/\s|-/g, '');
  if (mask === 'sort') return `••-••-${digits.slice(-2)}`;
  return `••••${digits.slice(-4)}`;
}

function shown(key: keyof Client, v: unknown): string {
  const meta = FIELDS[key];
  const s = meta?.show ? meta.show(v) : plain(v);
  return maskValue(s, meta?.mask) || '—';
}

const same = (a: unknown, b: unknown): boolean => {
  const n = (x: unknown) => (x === undefined || x === '' ? null : x);
  return JSON.stringify(n(a)) === JSON.stringify(n(b));
};

const humanise = (k: string): string =>
  k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

const AREA_TITLE: Record<Area, string> = {
  details: 'Company details changed',
  billing: 'Bank & billing details changed',
  rates: 'Rate card changed',
  documents: 'Documents changed',
  portal: 'Portal access changed',
  status: 'Account changed',
};

/**
 * Called by `clients.updateClient` with the record before and after a save.
 * Writes one entry per area touched; nothing at all when the save changed
 * nothing (the details form saves every field, changed or not).
 */
export function clientChanged(before: Client, after: Client): Entry[] {
  const byArea = new Map<Area, { changes: Change[]; sensitive: boolean; bank: string[] }>();
  (Object.keys(after) as (keyof Client)[]).forEach((k) => {
    if (SKIP.has(k) || same(before[k], after[k])) return;
    const meta = FIELDS[k];
    const area = meta?.area ?? 'details';
    const slot = byArea.get(area) || { changes: [], sensitive: false, bank: [] };
    slot.changes.push({ label: meta?.label ?? humanise(k), from: shown(k, before[k]), to: shown(k, after[k]) });
    if (meta?.sensitive) slot.sensitive = true;
    if (BANK_FIELDS.has(k)) slot.bank.push(meta?.label ?? k);
    byArea.set(area, slot);
  });

  const out: Entry[] = [];
  byArea.forEach((slot, area) => {
    let title = AREA_TITLE[area];
    if (area === 'status' && slot.changes.length === 1) {
      const c = slot.changes[0];
      title = c.label === 'Status' ? `Account made ${c.to.toLowerCase()}` : `${c.label} changed`;
    }
    if (area === 'billing' && slot.bank.length) title = 'Bank details changed';
    if (area === 'rates' && slot.changes.length === 1) title = `Rate card changed to ${slot.changes[0].to}`;

    const entry = record({ clientId: after.id, area, title, changes: slot.changes, sensitive: slot.sensitive });

    /* A bank change is the one edit that can quietly send a client's money —
       or EP's refunds — somewhere else. Finance hears about it immediately,
       from someone other than the person who made it. */
    if (slot.bank.length) {
      NOTIFICATIONS.raise({
        type: 'account',
        severity: 'atRisk',
        title: `Bank details changed — ${after.name}`,
        body: `${entry.by} changed ${slot.bank.join(', ').toLowerCase()}. Check it with the client on a number you already hold before the next payment.`,
        link: `/clients/${after.id}?tab=history`,
      });
      entry.alerted = true;
      const stored = JOURNAL.entries.find((x) => x.id === entry.id);
      if (stored) stored.alerted = true;
      persist();
    }
    out.push(entry);
  });
  return out;
}

export const clientName = (id: string): string => clientById(id)?.name ?? 'the client';
