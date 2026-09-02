/* ============================================================================
   EPROSTA — CHARGE RECORDS (reference dataset 4 of 4)
   ----------------------------------------------------------------------------
   The table of charges could be read, filtered, re-priced and version-tracked.
   It could not be ADDED TO. "Add charge line" opened nothing and toasted
   "out of scope for this prototype" — honest, but it meant every new thing EP
   started hiring out needed a developer.

   That was tolerable while the rate card was the only thing reading it. It
   stopped being tolerable when EP HOP arrived: a warehouse that cannot add a
   piece of kit is a warehouse that keeps its real list somewhere else, and the
   whole point of the module is that there is one list.

   THE SAME SHAPE AS `clients.ts`, FOR THE SAME REASON
   ---------------------------------------------------
   `CHARGES` is built once at module load from the seed. A row pushed into it
   survives until the tab is refreshed and no longer. So additions and retirals
   are journalled to localStorage and replayed on load — a journal rather than
   a snapshot, so improvements to the seed still land underneath.

   RETIRE, NEVER DELETE
   --------------------
   A charge is pointed at by every line ever quoted from it, and `LineItem.snap`
   freezes its rate onto historic work. Deleting one would leave picking lists,
   variation schedules and job costings referring to something that no longer
   exists — the class of bug this system spends most of its comments avoiding.

   `retired` therefore removes a charge from what can be QUOTED, and from
   nothing else. Every job that already used it reads exactly as it did.
   ========================================================================== */

import { CHARGES } from '@/data/db';
import type { Charge, ChargeKind, ChargeUnit } from '@/data/types';
import * as ROLES from './roles';

const KEY = 'eprosta.charges.v1';

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
  added: Charge[];
  retired: string[];
}

const empty = (): Journal => ({ v: 1, added: [], retired: [] });

function load(): Journal {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null') as Journal | null;
    if (!raw || raw.v !== 1) return empty();
    return { v: 1, added: raw.added || [], retired: raw.retired || [] };
  } catch {
    return empty();
  }
}

let JOURNAL: Journal = load();

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(JOURNAL));
  } catch {
    /* private mode */
  }
}

/** Replay the journal over the seeded table. Runs at import, before any screen. */
function apply(): void {
  JOURNAL.added.forEach((c) => {
    if (!CHARGES.some((x) => x.id === c.id)) CHARGES.push({ ...c });
  });
  const retired = new Set(JOURNAL.retired);
  CHARGES.forEach((c) => {
    if (retired.has(c.id)) c.retired = true;
  });
}
apply();

/* ------------------------------------------------------------- reading --- */

/** Charges that may be put on a NEW quote line. Retired ones are not offered. */
export const quotable = (): Charge[] => CHARGES.filter((c) => !c.retired);

export const isRetired = (id: string): boolean => !!CHARGES.find((c) => c.id === id)?.retired;

/** Was this row created here rather than shipped? Seeded rows are not retirable. */
export const isCustom = (id: string): boolean => JOURNAL.added.some((c) => c.id === id);

/* ------------------------------------------------------------- writing --- */

export interface Result {
  ok: boolean;
  reason?: string;
}

export interface NewCharge {
  kind: ChargeKind;
  /** 2–8 uppercase letters, digits and dashes. Unique — it is read by humans. */
  code: string;
  name: string;
  unit: ChargeUnit;
  cost: number;
  charge: number;
  /** The warehouse/manufacturer code. Kit only. */
  hireHopCode?: string;
}

const CODE_RE = /^[A-Z0-9-]{2,10}$/;

/**
 * Why this charge cannot be created, or null.
 *
 * The code rule is ENFORCED rather than described, for the reason `clients.ts`
 * gives at length: the client register is full of `YYY` and `ZZZ` precisely
 * because the screen stated a rule and then accepted anything.
 */
export function createChargeBlocker(c: NewCharge): string | null {
  if (!ROLES.can('charges.edit')) return 'Only Finance can add a charge line.';
  if (!c.name.trim()) return 'Give it a name.';
  if (!CODE_RE.test(c.code)) return 'The code is 2–10 characters: capitals, digits and dashes.';
  if (CHARGES.some((x) => x.code.toUpperCase() === c.code.toUpperCase()))
    return `${c.code} is already used by ${CHARGES.find((x) => x.code.toUpperCase() === c.code.toUpperCase())!.name}.`;
  if (CHARGES.some((x) => x.name.trim().toLowerCase() === c.name.trim().toLowerCase()))
    return `There is already a charge called ${c.name.trim()}.`;
  if (![c.cost, c.charge].every((n) => Number.isFinite(n) && n >= 0))
    return 'Cost and charge must be numbers, and not negative.';
  // Not a block — EP sells some things at cost deliberately — but selling
  // BELOW cost by accident is worth stopping at the point of entry.
  if (c.charge < c.cost) return `Charging ${c.charge} against a cost of ${c.cost} loses money on every one.`;
  return null;
}

/** Create a charge. Returns it, or null with the reason on the result. */
export function createCharge(c: NewCharge, effectiveFrom: string): Result & { charge?: Charge } {
  const blocker = createChargeBlocker(c);
  if (blocker) return { ok: false, reason: blocker };

  const row: Charge = {
    id: `ch-x-${c.code.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
    kind: c.kind,
    code: c.code.toUpperCase(),
    name: c.name.trim(),
    unit: c.unit,
    cost: c.cost,
    charge: c.charge,
    effectiveFrom,
    tiers: [],
    // No history: it has never been priced differently, and inventing a
    // previous version would put a rate on the record that was never charged.
    history: [],
    ...(c.hireHopCode ? { hireHopCode: c.hireHopCode } : {}),
  };
  if (CHARGES.some((x) => x.id === row.id)) return { ok: false, reason: 'That code has been used before.' };

  CHARGES.push(row);
  JOURNAL.added.push({ ...row });
  persist();
  emit();
  return { ok: true, charge: row };
}

/**
 * Take a charge off the list of things that can be quoted.
 *
 * Deliberately possible for SEEDED rows too — EP stops hiring things out, and
 * a rate card that can only ever grow is one people stop reading. What is
 * never possible is deletion.
 */
export function retireCharge(id: string, on = true): Result {
  if (!ROLES.can('charges.edit')) return { ok: false, reason: 'Only Finance can retire a charge line.' };
  const c = CHARGES.find((x) => x.id === id);
  if (!c) return { ok: false, reason: 'No such charge.' };
  c.retired = on || undefined;
  JOURNAL.retired = on
    ? [...new Set([...JOURNAL.retired, id])]
    : JOURNAL.retired.filter((x) => x !== id);
  persist();
  emit();
  return { ok: true };
}

/** Test seam. Drops everything this module added and un-retires the rest. */
export function resetCharges(): void {
  const added = new Set(JOURNAL.added.map((c) => c.id));
  for (let i = CHARGES.length - 1; i >= 0; i--) if (added.has(CHARGES[i].id)) CHARGES.splice(i, 1);
  CHARGES.forEach((c) => delete c.retired);
  JOURNAL = empty();
  persist();
  emit();
}
