/* ============================================================================
   EPROSTA — WORKER FLAGS
   ----------------------------------------------------------------------------
   "Flag worker" was a menu item that fired a toast and changed nothing. That is
   worse than a missing feature: an operator flags somebody, sees a
   confirmation, and assumes the workforce now knows. It does not.

   A flag has real consequences already wired into the rest of the build:

     · flagged workers are excluded from the manual assign list
     · portal.eligibility() treats a flag as a hard block on applying
     · the Staff register's Flagged tile counts them

   So the action has to actually set the status — and, because it stops somebody
   earning, it has to record WHY, WHO, and WHEN.

   Two deliberate choices:

     Clearing a flag restores the status the worker had BEFORE it, rather than
     defaulting everyone to 'verified'. A flagged worker who was mid-onboarding
     should go back to 'pending', not be quietly promoted.

     Flags do not touch the rating. The score is earned from attendance and
     nothing an operator types moves it — that is the whole basis for trusting
     it. A flag stops somebody being booked; it does not rewrite their record.
   ========================================================================== */

import { EMPLOYEES, employee as employeeById } from '@/data/db';
import type { Employee, StaffStatus } from '@/data/types';

const KEY = 'epteam.flags';

/* ==========================================================================
   1. WHY SOMEBODY GETS FLAGGED
   --------------------------------------------------------------------------
   A fixed list rather than free text alone, because "attitude" written by four
   different operators is not a thing anybody can report on later. The note is
   where the specifics go.
   ========================================================================== */

export interface FlagReason {
  id: string;
  label: string;
  blurb: string;
}

export const REASONS: FlagReason[] = [
  { id: 'no-show', label: 'Repeated no-shows', blurb: 'Failed to attend booked shifts without notice.' },
  { id: 'conduct', label: 'Conduct on site', blurb: 'Reported by a supervisor or the client.' },
  { id: 'client', label: 'Client asked for them not to return', blurb: 'Barred from a specific venue or account.' },
  { id: 'documents', label: 'Documents lapsed or in doubt', blurb: 'Right to work, licence or certificate needs re-checking.' },
  { id: 'uncontactable', label: 'Cannot be contacted', blurb: 'No response to callouts or confirmation chases.' },
  { id: 'other', label: 'Something else', blurb: 'Use the note to say what.' },
];

export const reason = (id: string | undefined): FlagReason =>
  REASONS.find((r) => r.id === id) || REASONS[REASONS.length - 1];

/* ==========================================================================
   2. STORE
   ========================================================================== */

export interface FlagRecord {
  reasonId: string;
  note: string;
  at: string;
  by: string;
  /** Remembered so clearing restores it rather than promoting anyone. */
  previousStatus: StaffStatus;
}

type FlagMap = Record<string, FlagRecord>;

function loadMap(): FlagMap {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveMap(map: FlagMap): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* private mode */
  }
}

let STORE: FlagMap = loadMap();

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

export const get = (empId: string): FlagRecord | null => STORE[empId] || null;
export const all = (): (FlagRecord & { employeeId: string })[] =>
  Object.entries(STORE).map(([employeeId, f]) => ({ employeeId, ...f }));

export function set(
  empId: string,
  { reasonId, note, by }: { reasonId: string; note?: string; by?: string },
): FlagRecord | null {
  const emp = employeeById(empId);
  if (!emp) return null;
  const rec: FlagRecord = {
    reasonId: reason(reasonId).id,
    note: (note || '').trim(),
    at: new Date().toISOString(),
    by: by || 'Jake Wright',
    previousStatus: emp.status === 'flagged' ? emp.preFlagStatus || 'verified' : emp.status,
  };
  STORE[empId] = rec;
  saveMap(STORE);
  apply(emp, rec);
  emit();
  return rec;
}

export function clear(empId: string): FlagRecord | null {
  const emp = employeeById(empId);
  const rec = STORE[empId];
  delete STORE[empId];
  saveMap(STORE);
  if (emp) {
    emp.status = rec?.previousStatus || emp.preFlagStatus || 'verified';
    emp.flag = null;
    delete emp.preFlagStatus;
  }
  emit();
  return rec || null;
}

function apply(emp: Employee, rec: FlagRecord): void {
  emp.preFlagStatus = rec.previousStatus;
  emp.status = 'flagged';
  emp.flag = { ...rec, label: reason(rec.reasonId).label };
}

/* ==========================================================================
   3. SEED + REHYDRATE
   --------------------------------------------------------------------------
   Three workers arrive from the mock data already flagged but with no reason
   recorded — exactly the state the old toast-only action would have left them
   in. They are given a reason derived from what the register does know, so no
   row in the table shows a flag it cannot explain.
   ========================================================================== */

EMPLOYEES.filter((e) => e.status === 'flagged' && !STORE[e.id]).forEach((e) => {
  STORE[e.id] = {
    reasonId: e.strikes >= 3 ? 'no-show' : 'conduct',
    note: e.strikes
      ? `${e.strikes} strike${e.strikes === 1 ? '' : 's'} from no-shows and late drop-outs.`
      : 'Raised by a site supervisor. Details held on the paper file.',
    at: '2026-06-18T09:40:00.000Z',
    by: 'Gracie Holt',
    previousStatus: 'verified',
  };
});
saveMap(STORE);

Object.entries(STORE).forEach(([id, rec]) => {
  const emp = employeeById(id);
  if (emp) apply(emp, rec);
});

/** One line for a profile panel or a dialog. */
export function flagLine(emp: Employee): string {
  if (!emp.flag) return '';
  const r = reason(emp.flag.reasonId);
  return `${r.label}${emp.flag.note ? ` — ${emp.flag.note}` : ''}`;
}
