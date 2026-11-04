/* ============================================================================
   EPROSTA — INDIVIDUAL PAY RATES
   ----------------------------------------------------------------------------
   Every worker is paid from a band: their department × PAYE or self-employed
   (`PAY_BANDS` in db.ts), plus a per-shift uplift for supervisors and SIA
   holders. That is right for most of the register and wrong for the people who
   matter most — the steward kept on £1 over band because they run the gate
   team, the agreed rate a returning worker was hired back on.

   So a worker can carry a CUSTOM base rate. Three deliberate choices:

     1. IT IS DATED, NOT OVERWRITTEN. Timesheets are priced live from the
        register (`wof.normaliseTimesheet`), so writing a new number onto
        `emp.payRate` would quietly re-price every shift the person has ever
        worked — including ones already paid. Each change is an entry with an
        `from` date, and a shift is priced at the rate in force ON ITS DAY
        (`baseOn`). That is the same rule the table of charges keeps with its
        rate versions, for the same reason.

     2. THE UPLIFT STILL APPLIES. The custom figure replaces the BAND, not the
        supervisor / SIA uplift — that is earned per shift for holding the
        ticket, and is a separate line on the payslip.

     3. "BACK TO BAND" IS AN ENTRY TOO (`rate: null`), not a deletion. Removing
        the custom rate must not erase the fact that it was paid for six weeks.

   `emp.payRate` is kept equal to TODAY's base, so every screen that shows
   "their rate" keeps working unchanged. Only pricing a dated shift needs
   `rateOn`. This module imports nothing but the data layer, so `wof.ts` and
   `checkins.ts` can both depend on it without a cycle.
   ========================================================================== */

import { EMPLOYEES, NOW, employee as employeeById } from '@/data/db';
import type { Employee } from '@/data/types';

const KEY = 'epteam.payrates';

export interface PayRateEntry {
  /** The custom base rate per hour, or null for "back to the band rate". */
  rate: number | null;
  /** YYYY-MM-DD. Shifts on or after this day are paid at `rate`. */
  from: string;
  note: string;
  at: string;
  by: string;
}

type PayMap = Record<string, PayRateEntry[]>;

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Local YYYY-MM-DD — not toISOString, which is a day out after 11pm in BST. */
export function ymd(v: Date | string): string {
  const d = new Date(v);
  if (Number.isNaN(+d)) return String(v).slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const dayOf = (v: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ymd(v));

export const today = (): string => ymd(NOW);

/* --------------------------------------------------------------- store --- */

function loadMap(): PayMap {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}
function saveMap(map: PayMap): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* private mode */
  }
}

let STORE: PayMap = loadMap();

/* The band rate, captured before anything here touches `emp.payRate`. */
const BAND = new Map<string, number>(EMPLOYEES.map((e) => [e.id, e.payRate]));

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

/* --------------------------------------------------------------- reads --- */

/** The department × employment-type band this worker would be paid without a custom rate. */
export const bandRate = (emp: Employee): number => BAND.get(emp.id) ?? emp.payRate;

/** Every change, oldest first. */
export const history = (empId: string): PayRateEntry[] =>
  (STORE[empId] || []).slice().sort((a, b) => a.from.localeCompare(b.from) || a.at.localeCompare(b.at));

/** The entry in force on a day, or null when the band applies. */
export function entryOn(empId: string, date: string): PayRateEntry | null {
  const d = dayOf(date);
  const live = history(empId).filter((h) => h.from <= d);
  const last = live[live.length - 1];
  return last && last.rate !== null ? last : null;
}

/** Base hourly rate on a day — custom if one was in force, otherwise the band. */
export function baseOn(emp: Employee, date: string): number {
  const e = entryOn(emp.id, date);
  return e ? e.rate! : bandRate(emp);
}

/**
 * What one hour on that day pays: base plus the per-shift uplift.
 *
 * `floor` is the job's wage framework on that day (`wages.floorOn`). The base
 * is lifted to it when it falls short — a Living Wage job pays the Living
 * Wage whatever band the worker is on — and the uplift still goes on top.
 */
export const rateOn = (emp: Employee, date: string, floor = 0): number =>
  r2(Math.max(baseOn(emp, date), floor) + (emp.payUplift || 0));

/** Today's custom entry, if any. */
export const current = (empId: string): PayRateEntry | null => entryOn(empId, today());

/** A change dated after today — booked but not yet in force. */
export function scheduled(empId: string): PayRateEntry | null {
  const t = today();
  return history(empId).find((h) => h.from > t) || null;
}

export const isCustom = (emp: Employee): boolean => !!current(emp.id);

/* ------------------------------------------------------------ mutations --- */

export interface SetInput {
  /** null returns the worker to their band rate from `from`. */
  rate: number | null;
  from: string;
  note: string;
  by: string;
  /** Shifts on or before this day are paid and must not move. */
  paidThrough?: string | null;
}

/** Why a change would be refused, or null. The dialog and `set` ask the same question. */
export function problem(emp: Employee, input: Omit<SetInput, 'by'>): string | null {
  if (input.rate !== null) {
    if (!Number.isFinite(input.rate) || input.rate <= 0) return 'Enter an hourly rate above £0.';
    if (input.rate > 500) return 'That is over £500 an hour — check the figure.';
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.from)) return 'Choose the date it takes effect from.';
  if (input.paidThrough && input.from <= input.paidThrough)
    return `Shifts up to ${input.paidThrough} have already been paid. Choose a later date.`;
  if (!input.note.trim()) return 'Say why — payroll will be asked.';
  if (input.rate === null && !entryOn(emp.id, input.from) && !history(emp.id).some((h) => h.from >= input.from))
    return 'They are already on their band rate from that date.';
  return null;
}

export function set(empId: string, input: SetInput): PayRateEntry | null {
  const emp = employeeById(empId);
  if (!emp) return null;
  if (problem(emp, input)) return null;
  const entry: PayRateEntry = {
    rate: input.rate === null ? null : r2(input.rate),
    from: input.from,
    note: input.note.trim(),
    at: new Date().toISOString(),
    by: input.by,
  };
  // A second change on the same day replaces the first; it is a correction,
  // not a period anybody was paid at.
  STORE[empId] = (STORE[empId] || []).filter((h) => h.from !== entry.from).concat(entry);
  saveMap(STORE);
  sync(emp);
  emit();
  return entry;
}

/** Keep `emp.payRate` equal to today's base, for every screen that reads it directly. */
function sync(emp: Employee): void {
  emp.payRate = baseOn(emp, today());
}

/** Forget everything — the test harness and "reset demo data" use it. */
export function reset(): void {
  STORE = {};
  saveMap(STORE);
  EMPLOYEES.forEach((e) => {
    e.payRate = bandRate(e);
  });
  emit();
}

/* ------------------------------------------------------------ rehydrate --- */
EMPLOYEES.forEach(sync);
