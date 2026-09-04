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

   CORRECT THE WORDS HERE, THE MONEY IN A VERSION
   ----------------------------------------------
   The same argument applies to editing. A charge could be added and retired
   but not corrected, so a line typed as `ST-EVNT` or "Two-way radion" stayed
   wrong on every quote after it. `editCharge` fixes the DESCRIPTION — name,
   code, unit, the role a staff line supplies, the warehouse code — and cannot
   touch cost or charge-out, which move only through a new version with an
   effective date. That split is the whole point: an edit that could quietly
   change a price would be a way to re-price signed work without a trace.

   An edit reaches the NEXT quote and none of the sent ones, because a line
   copies the description, the unit and the rate onto itself when it is raised.
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

/**
 * A correction to a charge's DESCRIPTION, never to its money.
 *
 * Separate from `added` on purpose: a seeded row cannot be replaced wholesale
 * without losing the improvements a later seed makes to it, so what is stored
 * is the handful of fields a person actually changed and nothing else.
 */
export interface ChargeEdit {
  name?: string;
  code?: string;
  unit?: ChargeUnit;
  /** `null` clears it. Staff only. */
  role?: string | null;
  /** `null` clears it. Kit only. */
  hireHopCode?: string | null;
}

interface Journal {
  v: 1;
  added: Charge[];
  retired: string[];
  /** By charge id. Last write wins — this is the current text, not a history. */
  edits: Record<string, ChargeEdit>;
}

const empty = (): Journal => ({ v: 1, added: [], retired: [], edits: {} });

function load(): Journal {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null') as Journal | null;
    if (!raw || raw.v !== 1) return empty();
    // `edits` arrived after `added` and `retired`, and a journal written before
    // it simply does not have the key. Defaulting rather than bumping the
    // version keeps everything anyone has already added to their own table.
    return { v: 1, added: raw.added || [], retired: raw.retired || [], edits: raw.edits || {} };
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

/**
 * What each edited row said before anyone touched it.
 *
 * Captured at the moment of the first edit rather than at import, so the cost
 * is nothing on a table nobody has corrected. `resetCharges` is what reads it.
 */
const ORIGINAL = new Map<string, ChargeEdit>();

function applyEdit(c: Charge, e: ChargeEdit): void {
  if (!ORIGINAL.has(c.id)) {
    ORIGINAL.set(c.id, {
      name: c.name, code: c.code, unit: c.unit,
      role: c.role ?? null, hireHopCode: c.hireHopCode ?? null,
    });
  }
  if (e.name !== undefined) c.name = e.name;
  if (e.code !== undefined) c.code = e.code;
  if (e.unit !== undefined) c.unit = e.unit;
  if (e.role !== undefined) {
    if (e.role) c.role = e.role;
    else delete c.role;
  }
  if (e.hireHopCode !== undefined) {
    if (e.hireHopCode) c.hireHopCode = e.hireHopCode;
    else delete c.hireHopCode;
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
    const e = JOURNAL.edits[c.id];
    if (e) applyEdit(c, e);
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
  /**
   * Which rostered role this line supplies. Staff only.
   *
   * It is what `chargeForRole` reads to price a shift, so a staff charge
   * without one is quotable by hand and invisible to the roster — which is a
   * legitimate thing to want (a one-off consultancy day), and the wrong
   * default for a steward.
   */
  role?: string;
}

const CODE_RE = /^[A-Z0-9-]{2,10}$/;

const norm = (s: string) => s.trim().toLowerCase();

/** The row already using this code, other than `selfId`. */
const codeClash = (code: string, selfId?: string): Charge | undefined =>
  CHARGES.find((x) => x.id !== selfId && norm(x.code) === norm(code));

const nameClash = (name: string, selfId?: string): Charge | undefined =>
  CHARGES.find((x) => x.id !== selfId && norm(x.name) === norm(name));

/**
 * The staff charge already supplying this role, other than `selfId`.
 *
 * `chargeForRole` returns the FIRST staff charge holding the role, so two of
 * them means a shift is priced from whichever happens to sit higher in the
 * table — a rate chosen by array order, which nobody would ever find. Retired
 * rows are excluded, and `chargeForRole` prefers a live one, so retiring a
 * line genuinely hands its role to the replacement.
 */
const roleClash = (role: string, selfId?: string): Charge | undefined =>
  CHARGES.find((x) => x.id !== selfId && x.kind === 'staff' && !x.retired && x.role === role);

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
  // Tested in capitals, and clashes compared without case, because the code is
  // stored in capitals whatever is typed — refusing `st-evt` for its case and
  // then accepting it as a duplicate of `ST-EVT` would be two rules disagreeing.
  if (!CODE_RE.test(c.code.toUpperCase())) return 'The code is 2–10 characters: capitals, digits and dashes.';
  const codeTaken = codeClash(c.code);
  if (codeTaken) return `${c.code} is already used by ${codeTaken.name}.`;
  if (nameClash(c.name)) return `There is already a charge called ${c.name.trim()}.`;
  if (c.role) {
    if (c.kind !== 'staff') return 'Only a staff line fills a rostered role.';
    const held = roleClash(c.role);
    if (held) return `${held.name} already supplies the ${c.role} role. Retire it first, or leave this line off the roster.`;
  }
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
    ...(c.role && c.kind === 'staff' ? { role: c.role } : {}),
  };
  if (CHARGES.some((x) => x.id === row.id)) return { ok: false, reason: 'That code has been used before.' };

  CHARGES.push(row);
  JOURNAL.added.push({ ...row });
  persist();
  emit();
  return { ok: true, charge: row };
}

/* --------------------------------------------------------------- editing --- */

/**
 * WHAT AN EDIT IS ALLOWED TO BE
 * -----------------------------
 * A correction, not a re-price. Name, code, unit and what the line supplies —
 * the fields that were typed wrong, or that changed because the thing itself
 * changed name. Money is not here, and deliberately: cost and charge-out move
 * through `EditRate`, which writes a new VERSION with an effective date, so
 * that a job priced last week keeps the rate the client agreed. Letting a
 * "correct the name" form quietly overwrite `charge` would be the one way to
 * re-price history without leaving a trace of it, which is the failure this
 * whole module is arranged to prevent.
 *
 * NOTHING HERE REACHES A LINE ALREADY QUOTED
 * ------------------------------------------
 * A `LineItem` copies the description, the unit and the resolved rate onto
 * itself when it is raised (`description`, `unitLabel`, `snap`). So renaming
 * "Two-way radio (Motorola DP2400)" changes what the NEXT quote says and not
 * one word of the sixty already sent. That is the correct behaviour and not
 * an oversight: those documents were signed as they read.
 *
 * The one thing an edit does reach is the ROSTER, because `chargeForRole`
 * resolves live, by role name. Hence `roleClash`.
 */
export function editChargeBlocker(id: string, e: ChargeEdit): string | null {
  if (!ROLES.can('charges.edit')) return 'Only Finance can edit the table of charges.';
  const c = CHARGES.find((x) => x.id === id);
  if (!c) return 'No such charge.';

  if (e.name !== undefined) {
    if (!e.name.trim()) return 'Give it a name.';
    if (nameClash(e.name, id)) return `There is already a charge called ${e.name.trim()}.`;
  }
  if (e.code !== undefined) {
    if (!CODE_RE.test(e.code.toUpperCase()))
      return 'The code is 2–10 characters: capitals, digits and dashes.';
    const taken = codeClash(e.code, id);
    if (taken) return `${e.code.toUpperCase()} is already used by ${taken.name}.`;
  }
  if (e.unit !== undefined && !['hour', 'day', 'each'].includes(e.unit))
    return 'A charge is priced per hour, per day or per item.';
  if (e.role) {
    const kind = c.kind;
    if (kind !== 'staff') return 'Only a staff line fills a rostered role.';
    const held = roleClash(e.role, id);
    if (held) return `${held.name} already supplies the ${e.role} role.`;
  }
  return null;
}

/**
 * Correct a charge's description. Journalled, so it survives a refresh.
 *
 * Seeded rows are editable as well as custom ones — the seeded table is EP's
 * real rate card, typos and all, and a screen that can only correct the rows it
 * created is one where half the list stays wrong forever.
 */
export function editCharge(id: string, e: ChargeEdit): Result {
  const blocker = editChargeBlocker(id, e);
  if (blocker) return { ok: false, reason: blocker };
  const c = CHARGES.find((x) => x.id === id)!;

  const patch: ChargeEdit = {
    ...(e.name !== undefined ? { name: e.name.trim() } : {}),
    ...(e.code !== undefined ? { code: e.code.toUpperCase().trim() } : {}),
    ...(e.unit !== undefined ? { unit: e.unit } : {}),
    ...(e.role !== undefined ? { role: e.role ? e.role.trim() : null } : {}),
    ...(e.hireHopCode !== undefined
      ? { hireHopCode: e.hireHopCode ? e.hireHopCode.toUpperCase().trim() : null }
      : {}),
  };

  applyEdit(c, patch);
  // Merged, not replaced: two corrections a month apart are one row's worth of
  // journal, and the second must not silently undo the first.
  JOURNAL.edits[id] = { ...(JOURNAL.edits[id] || {}), ...patch };

  // A row created HERE is stored whole, so its stored copy has to move too —
  // otherwise the next reload replays the original name over the correction.
  const added = JOURNAL.added.find((x) => x.id === id);
  if (added) applyEdit(added as Charge, patch);

  persist();
  emit();
  return { ok: true };
}

/** Has this row been corrected since it was seeded? Drives the "edited" note. */
export const isEdited = (id: string): boolean => !!JOURNAL.edits[id];

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

/** Test seam. Drops everything this module added, and undoes retirals and edits. */
export function resetCharges(): void {
  const added = new Set(JOURNAL.added.map((c) => c.id));
  for (let i = CHARGES.length - 1; i >= 0; i--) if (added.has(CHARGES[i].id)) CHARGES.splice(i, 1);
  CHARGES.forEach((c) => {
    delete c.retired;
    const was = ORIGINAL.get(c.id);
    if (was) applyEdit(c, was);
  });
  ORIGINAL.clear();
  JOURNAL = empty();
  persist();
  emit();
}
