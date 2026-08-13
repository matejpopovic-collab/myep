/* ============================================================================
   EPROSTA — CHECK-IN APPROVALS
   ----------------------------------------------------------------------------
   Approving a check-in is the moment a worked hour becomes a payable hour. It
   is the single highest-consequence action in the console, and it was a toast.

   Worse, the same queue appears in two places — the event's Check-ins tab and
   the standalone approvals screen — reading the same `CHECK_INS` seed and each
   keeping its own idea of what had been approved. Approve six rows on one and
   the other still showed six. This module is the one truth both read.

   WHAT APPROVAL ACTUALLY DOES
   ---------------------------
   Three things, and they have to happen together or the record contradicts
   itself:

     1. the check-in leaves the queue
     2. an attendance row is written, which is what payroll reads
     3. the assignment is marked confirmed and checked in, which is what the
        staffing screens read

   Doing (1) alone is what the live system did: the row vanished and nothing
   downstream knew. Payroll then reconciled from a spreadsheet.

   ADJUSTED TIMES
   --------------
   The approver can change the actual in and out before approving, because the
   commonest reason a row is flagged is a worker forgetting to clock out. The
   adjustment is recorded on the attendance row rather than overwriting the
   worker's own submission, so "what they clocked" and "what we paid" stay
   separately visible.
   ========================================================================== */

import { ATTENDANCE, CHECK_INS, NOW, employee as employeeById } from '@/data/db';
import { SHIFT_DAYS } from '@/data/clock';
import type { AttendanceOutcome, AttendanceRow, CheckIn } from '@/data/types';
import * as EVENTS from './events';

const KEY = 'eprosta.checkins.v1';

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

interface Decision {
  id: string;
  outcome: 'approved' | 'rejected';
  at: string;
  by: string;
  note: string;
  /** Present when the approver corrected the clock times before approving. */
  actualIn?: string | null;
  actualOut?: string | null;
}

interface Journal {
  v: 1;
  shift: number;
  decisions: Record<string, Decision>;
  /** Attendance rows written by an approval here, rather than shipped in seed. */
  attendance: AttendanceRow[];
}

const empty = (): Journal => ({ v: 1, shift: SHIFT_DAYS, decisions: {}, attendance: [] });

function read(): Journal {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!raw || raw.v !== 1 || raw.shift !== SHIFT_DAYS) return empty();
    return {
      v: 1,
      shift: SHIFT_DAYS,
      decisions: raw.decisions && typeof raw.decisions === 'object' ? raw.decisions : {},
      attendance: Array.isArray(raw.attendance) ? raw.attendance : [],
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
    /* private mode */
  }
  emit();
}

/** Replay saved attendance into the live array so payroll totals include it. */
function apply(): void {
  journal.attendance.forEach((row) => {
    if (!ATTENDANCE.some((a) => a.id === row.id)) ATTENDANCE.push(row);
  });
}

apply();

/* -------------------------------------------------------------- selectors */

/** Check-ins still waiting on a decision. */
export function pending(eventId?: string): CheckIn[] {
  return CHECK_INS.filter(
    (c) => !journal.decisions[c.id] && (!eventId || c.eventId === eventId),
  );
}

export const pendingCount = (eventId?: string): number => pending(eventId).length;

export const decisionFor = (id: string): Decision | null => journal.decisions[id] || null;

/* --------------------------------------------------------------- approving */

/** Hours between two timestamps, to one decimal — the unit payroll bills in. */
function hoursBetween(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  return Math.round(((+new Date(b) - +new Date(a)) / 3_600_000) * 10) / 10;
}

const hhmm = (v: string | null): string => (v ? new Date(v).toTimeString().slice(0, 5) : '—');

/**
 * Which attendance outcome an approved row represents.
 *
 * Derived from the times rather than asked for, so it cannot disagree with
 * them. A no-show is the one case the times cannot express — no clock-in at all
 * — and it is deliberately not inferred from lateness however extreme.
 */
function outcomeFor(c: CheckIn, actualIn: string | null, actualOut: string | null): AttendanceOutcome {
  if (!actualIn) return 'no-show';
  const lateMins = (+new Date(actualIn) - +new Date(c.scheduledIn)) / 60_000;
  const overMins = actualOut ? (+new Date(actualOut) - +new Date(c.scheduledOut)) / 60_000 : 0;
  if (overMins >= 30) return 'overtime';
  if (lateMins >= 10) return 'late';
  return 'worked';
}

export interface ApproveOptions {
  /** Corrected clock times. Omitted means "approve as submitted". */
  actualIn?: string | null;
  actualOut?: string | null;
  note?: string;
  by?: string;
}

export interface ApproveResult {
  ok: boolean;
  hours: number;
  outcome: AttendanceOutcome;
  row?: AttendanceRow;
}

export function approve(id: string, opts: ApproveOptions = {}): ApproveResult {
  const c = CHECK_INS.find((x) => x.id === id);
  if (!c || journal.decisions[id]) return { ok: false, hours: 0, outcome: 'worked' };

  const actualIn = opts.actualIn !== undefined ? opts.actualIn : c.actualIn;
  const actualOut = opts.actualOut !== undefined ? opts.actualOut : c.actualOut;
  const hours = hoursBetween(actualIn, actualOut);
  const outcome = outcomeFor(c, actualIn, actualOut);
  const by = opts.by || 'm-gracie';

  const row: AttendanceRow = {
    id: `att-${c.id}`,
    employeeId: c.employeeId,
    eventId: c.eventId,
    role: c.role,
    date: c.scheduledIn.slice(0, 10),
    scheduled: `${hhmm(c.scheduledIn)}–${hhmm(c.scheduledOut)}`,
    actual: `${hhmm(actualIn)}–${hhmm(actualOut)}`,
    hours,
    outcome,
    approvedBy: by,
  };

  journal.decisions[id] = {
    id,
    outcome: 'approved',
    at: new Date().toISOString(),
    by,
    note: opts.note || '',
    ...(opts.actualIn !== undefined ? { actualIn } : {}),
    ...(opts.actualOut !== undefined ? { actualOut } : {}),
  };
  journal.attendance.push(row);
  if (!ATTENDANCE.some((a) => a.id === row.id)) ATTENDANCE.push(row);

  // Keep the staffing side in step. Somebody whose timesheet is approved plainly
  // worked the shift, so an assignment still reading "awaiting confirmation" is
  // a contradiction the operator would have to resolve by hand.
  EVENTS.approveCheckIn(c.eventId, c.employeeId);

  write();
  return { ok: true, hours, outcome, row };
}

/** Approve every unflagged row, which is the bulk of any queue. */
export function approveClean(eventId?: string, by?: string): { count: number; hours: number } {
  const rows = pending(eventId).filter((c) => !c.flag);
  let hours = 0;
  rows.forEach((c) => {
    const r = approve(c.id, { by });
    hours += r.hours;
  });
  return { count: rows.length, hours: Math.round(hours * 10) / 10 };
}

export function reject(id: string, note: string, by?: string): boolean {
  const c = CHECK_INS.find((x) => x.id === id);
  if (!c || journal.decisions[id]) return false;

  journal.decisions[id] = {
    id,
    outcome: 'rejected',
    at: new Date().toISOString(),
    by: by || 'm-gracie',
    note: note || 'Rejected without a reason given.',
  };
  // No attendance row: a rejected check-in is explicitly not a payable hour.
  EVENTS.rejectCheckIn(c.eventId, c.employeeId, note);
  write();
  return true;
}

/** Undo a decision — the row goes back in the queue and the payment comes out. */
export function reopen(id: string): boolean {
  if (!journal.decisions[id]) return false;
  delete journal.decisions[id];

  const rowId = `att-${id}`;
  journal.attendance = journal.attendance.filter((a) => a.id !== rowId);
  const i = ATTENDANCE.findIndex((a) => a.id === rowId);
  if (i >= 0) ATTENDANCE.splice(i, 1);

  write();
  return true;
}

/* ---------------------------------------------------------------- summary */

/** What the queue is worth, which is the number that makes it urgent. */
export function queueValue(eventId?: string): { rows: number; hours: number; flagged: number } {
  const rows = pending(eventId);
  const hours = rows.reduce((n, c) => n + hoursBetween(c.actualIn, c.actualOut), 0);
  return {
    rows: rows.length,
    hours: Math.round(hours * 10) / 10,
    flagged: rows.filter((c) => c.flag).length,
  };
}

/** Gross cost of an approved row, for the toast that confirms an approval. */
export function payFor(c: CheckIn, hours: number): number {
  const emp = employeeById(c.employeeId);
  if (!emp) return 0;
  return Math.round((emp.payRate + emp.payUplift) * hours * 100) / 100;
}

/** How stale the queue is — a row waiting a week is a worker waiting to be paid. */
export function oldestWaitingDays(eventId?: string): number {
  const rows = pending(eventId);
  if (!rows.length) return 0;
  const oldest = Math.min(...rows.map((c) => +new Date(c.scheduledOut)));
  return Math.max(0, Math.round((+NOW - oldest) / 86_400_000));
}

export function resetCheckIns(): void {
  journal = empty();
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  emit();
}
