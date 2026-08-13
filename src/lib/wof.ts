/* ============================================================================
   EPROSTA — THE WOF (Work Order Form)
   ----------------------------------------------------------------------------
   Briefing §2.2: "The Work Order Form is the central document of the business."

   This file is the spine. Everything else in the new system is either an input
   to a WOF, a stage of a WOF, or a report derived from WOFs.

   THE ONE RULE THAT MAKES THE REPORTS RECONCILE
   ---------------------------------------------
   There is exactly one place a number is computed, and every screen calls it:

       contractValue(w)   what the client will be billed  -> quote, invoice, cash flow
       plannedCost(w)     what we thought it would cost   -> job costing
       actualCost(w)      what it actually cost           -> job costing, margin
       timesheets(w)      who worked, how long, what rate -> payroll, actual staff cost
       cashflow(w)        deposit + balance, expected/paid-> cash flow forecast
       docState(w)        checklist status roll-up        -> document report, calendar

   Job costing's staff cost and payroll's gross pay are THE SAME NUMBERS out of
   THE SAME function. That is the whole point of the briefing's "key reports
   must connect between each other".

   STAGE MODEL
   -----------
   Eight stages, plus terminal outcomes. Payroll and invoicing are OUTPUTS, not
   stages (briefing §3) — payroll branches off `job`, invoicing follows it.

   VERSIONING
   ----------
   Every line item snapshots the rate that applied when it was priced. Editing
   the table of charges later cannot retro-change a signed quote or a raised
   invoice. `repriceLine()` exists and is deliberately explicit + audited.

   REACT NOTE
   ----------
   The store is a plain module-level array with a version counter and a
   subscriber set, read through `useWofs()` (see ./store). Mutations bump the
   version, so every mounted screen re-renders off the same numbers — the
   single-source-of-truth rule holds across components as well as across
   reports.
   ========================================================================== */

import {
  ATTENDANCE, CLIENTS, EMPLOYEES, EVENTS, EVENT_SCHEDULE, NOW,
  charge as chargeById, client as clientById, docType, employee as employeeById,
  event as eventById, jobType, rateAt, schedule as scheduleById, tieredCharge,
} from '@/data/db';
import { SHIFT_DAYS, shiftDeep, shiftISO } from '@/data/clock';
import type {
  AttendanceOutcome, ChargeKind, ChargeUnit, EpEvent, ResolvedRate, Tone,
} from '@/data/types';
import { addDays, countLabel, fmtDate, money, round2, timing } from './format';
import { eventCoverage } from './coverage';

const SCHEMA = 'eprosta.wof.v1';

/* ==========================================================================
   TYPES
   ========================================================================== */

export type StageId =
  | 'wof' | 'quote' | 'signoff' | 'order' | 'documents' | 'picking' | 'job' | 'invoice';
export type TerminalId = 'complete' | 'lost' | 'cancelled';
export type WofStage = StageId | TerminalId;

export interface Stage {
  id: StageId;
  n: number;
  label: string;
  short: string;
  icon: string;
  blurb: string;
  requirement: string;
}

export type LineSource = 'quote' | 'variation';

/**
 * A variation is extra money on a signed job, so the client gets a say before
 * it reaches the invoice. `undefined` on quote lines — those were covered by
 * the signature.
 */
export type ClientApproval = 'pending' | 'accepted' | 'queried';

export interface LineItem {
  id: string;
  chargeId: string;
  kind: ChargeKind;
  description: string;
  qty: number;
  units: number;
  unitLabel: ChargeUnit;
  /** Frozen rate — see the versioning note in the header. */
  snap: ResolvedRate | null;
  source: LineSource;
  addedAt: string;
  addedBy: string;
  duringEvent: boolean;
  note: string;
  /** Variations only: where the client has got to with it. */
  clientApproval?: ClientApproval;
  /** What the client said when they queried it. */
  clientNote?: string;
}

export interface LineConfig {
  id?: string;
  description?: string;
  qty?: number;
  units?: number;
  source?: LineSource;
  pricedAt?: string;
  addedAt?: string;
  addedBy?: string;
  duringEvent?: boolean;
  note?: string;
}

export type DocStatusId = 'required' | 'submitted' | 'approved';
export type EffectiveDocStatus = DocStatusId | 'outstanding';

export interface WofDoc {
  docId: string;
  status: DocStatusId;
  owner: string;
  blocking: boolean;
  dueDate: string;
  note: string;
  updatedAt: string | null;
}

export interface WofDocView extends WofDoc {
  effectiveStatus: EffectiveDocStatus;
  overdue: boolean;
  label: string;
}

export interface Signoff {
  signedBy: string;
  signedByRole: string;
  signedAt: string;
  method: string;
  ref: string;
  ip: string;
}

export interface DepositRecord {
  pct: number | null;
  amount: number | null;
  receivedAt: string | null;
  ref: string | null;
}

/** One kit line as it stood when the list was last sent to the warehouse. */
export interface PickedLine {
  lineId: string;
  description: string;
  qty: number;
  units: number;
}

export interface Picking {
  /**
   * Assigned once, on the FIRST push, and never reissued. A second reference
   * for the same job means the warehouse holds two lists with no way to tell
   * which supersedes which — the same "one job, three versions" failure this
   * system exists to remove.
   */
  hireHopRef: string;
  /** When the list first went over. Does not move on a re-send. */
  pushedAt: string;
  status: string;
  /** When it was last re-sent. This is the one that moves. */
  lastSyncAt: string;
  /** 1 on the original send, incremented on every amendment. */
  version?: number;
  /** What was on the list at the last push, so a re-send can say what changed. */
  manifest?: PickedLine[];
}

/**
 * The kit list as it stood the moment the client confirmed the job — built
 * automatically, held in the office, NOT yet sent to Hire Hop.
 *
 * This exists because "the warehouse knows what is coming" and "the warehouse
 * has been given a list to pick against" are two different facts, and the
 * system only had a word for the second one. Preparing on confirmation gives
 * Pete's team the lead time they were previously getting by reading over
 * somebody's shoulder; withholding the Hire Hop reference until the real push
 * keeps the rule that matters — one job, one reference, issued once. A quote
 * that gains a variation between sign-off and picking would otherwise have
 * burned a reference on a list nobody should pick.
 */
export interface KitPrep {
  /** When the list was first built. Does not move when it is rebuilt. */
  preparedAt: string;
  /** When it last changed. This is the one that moves. */
  updatedAt: string;
  /** What was on the list at that moment. */
  manifest: PickedLine[];
  /** Why it exists: 'confirmation' when the client's signature built it. */
  source: 'confirmation' | 'manual';
}

export interface Invoice {
  number: string;
  issuedAt: string;
  dueAt: string;
  paidAt: string | null;
}

export interface HistoryEntry {
  stage: WofStage;
  at: string;
  /** A manager id, or `client` when the client portal did it. */
  by: string;
  /** Set when `by` is not a manager, so the trail still names a person. */
  byName?: string;
  note: string;
  overrides?: string[];
}

/**
 * Who performed a mutation. Defaults to the operator; the client portal passes
 * its own, so the history never claims EP Team signed the client's own quote.
 */
export interface Actor {
  by: string;
  name: string;
}

const OPERATOR: Actor = { by: 'm-jake', name: 'Jake Wright' };

export interface TimesheetSeed {
  employeeId: string;
  date: string;
  role: string;
  hours: number;
  outcome?: AttendanceOutcome;
  approvedBy?: string;
  sourceId?: string;
}

export interface Timesheet {
  wofId: string;
  employeeId: string;
  employeeName: string;
  date: string;
  role: string;
  hours: number;
  outcome: AttendanceOutcome;
  employmentType: string;
  payRate: number;
  gross: number;
  approvedBy: string;
  sourceId: string | null;
}

export interface Wof {
  id: string;
  ref: string;
  /** EP's own job reference. One job, one number — so it IS the WOF ref. */
  jobCode: string;
  title: string;
  clientId: string;
  scheduleId: string | null;
  eventId: string | null;
  jobTypeId: string;
  office: string;
  departmentId: string;
  ownerId: string;
  raisedBy: string;
  start: string;
  end: string;
  venue: string;
  postcode: string | null;
  staffMeetingPoint: string | null;
  active: boolean;
  staffCalendarVisible: boolean;
  stage: WofStage;
  raisedAt: string;
  quotedAt: string | null;
  orderedAt: string | null;
  signoff: Signoff | null;
  deposit: DepositRecord | null;
  lines: LineItem[];
  documents: WofDoc[];
  /** Built on confirmation; consumed by the push at stage 6. */
  kitPrep?: KitPrep | null;
  picking: Picking | null;
  invoice: Invoice | null;
  timesheets?: TimesheetSeed[];
  history: HistoryEntry[];
  notes: string;
}

/** Seed literals omit the event-info fields; `normaliseEventInfo` fills them. */
type WofSeed = Omit<
  Wof,
  'jobCode' | 'departmentId' | 'postcode' | 'staffMeetingPoint' | 'active' | 'staffCalendarVisible'
> &
  Partial<Wof>;

/* ==========================================================================
   1. STAGES
   ========================================================================== */

export const STAGES: Stage[] = [
  { id: 'wof',       n: 1, label: 'WOF',              short: 'WOF',        icon: 'fileText',
    blurb: 'Potential job captured against a client and an event.',
    requirement: 'Replaces the Google Sheet process.' },
  { id: 'quote',     n: 2, label: 'Quote',            short: 'Quote',      icon: 'trendUp',
    blurb: 'Priced from the table of charges and sent to the client.',
    requirement: 'Pricing must live in the system, not a spreadsheet.' },
  { id: 'signoff',   n: 3, label: 'Client sign-off',  short: 'Sign-off',   icon: 'edit',
    blurb: 'Client approves the quote.',
    requirement: 'Digital signature required.' },
  { id: 'order',     n: 4, label: 'Order + deposit',  short: 'Order',      icon: 'checkCircle',
    blurb: 'Job confirmed, deposit recorded. Seeds the event calendar and shifts.',
    requirement: 'Deposit tracking per job.' },
  { id: 'documents', n: 5, label: 'Job documents',    short: 'Documents',  icon: 'layers',
    blurb: 'Required documents attached and tracked per job.',
    requirement: 'Configurable checklist by job type; status tracking.' },
  { id: 'picking',   n: 6, label: 'Picking & packing',short: 'Picking',    icon: 'inbox',
    blurb: 'Kit and services allocated; staff allocated via the staffing tool.',
    requirement: 'Draws from table of charges and stock list; pushes to Hire Hop.' },
  { id: 'job',       n: 7, label: 'Job + timesheets', short: 'Job',        icon: 'clock',
    blurb: 'Delivered on site; staff complete admin sheets with hours.',
    requirement: 'Timesheet data feeds payroll.' },
  { id: 'invoice',   n: 8, label: 'Invoice',          short: 'Invoice',    icon: 'download',
    blurb: 'Client billed for the completed job, net of deposit.',
    requirement: 'To be scoped with the incoming Finance Director.' },
];

export const TERMINAL: Record<TerminalId, { label: string; tone: Tone }> = {
  complete:  { label: 'Complete',  tone: 'healthy'  },
  lost:      { label: 'Lost',      tone: 'neutral'  },
  cancelled: { label: 'Cancelled', tone: 'neutral'  },
};

export const stage = (id: string): Stage | undefined => STAGES.find((s) => s.id === id);
export const stageIndex = (id: string): number => STAGES.findIndex((s) => s.id === id);
export const isTerminal = (id: string): id is TerminalId => !!TERMINAL[id as TerminalId];

/** Has this WOF reached at least `target`? Terminal states have passed all. */
export function atLeast(w: Wof | WofSeed, target: StageId): boolean {
  if (isTerminal(w.stage)) return true;
  return stageIndex(w.stage) >= stageIndex(target);
}

export interface CalendarStatus {
  id: string;
  label: string;
  tone: Tone;
}

/** Calendar status vocabulary from briefing §2.3. */
export function calendarStatus(w: Wof | null | undefined): CalendarStatus {
  if (!w) return { id: 'no-wof', label: 'No WOF', tone: 'critical' };
  if (w.stage === 'lost' || w.stage === 'cancelled')
    return { id: 'cancelled', label: TERMINAL[w.stage].label, tone: 'neutral' };
  if (w.stage === 'complete' || w.stage === 'invoice')
    return { id: 'complete', label: 'Complete', tone: 'neutral' };
  if (atLeast(w, 'order')) return { id: 'confirmed', label: 'Confirmed', tone: 'healthy' };
  if (atLeast(w, 'quote')) return { id: 'quote-sent', label: 'Quote sent', tone: 'info' };
  return { id: 'in-progress', label: 'In progress', tone: 'atRisk' };
}

/* ==========================================================================
   2. LINE ITEMS
   --------------------------------------------------------------------------
   value = qty x units x tiered charge rate   (tier chosen on qty)
   cost  = qty x units x cost price
   `source: 'variation'` marks anything added after sign-off — briefing §3:
   "Adding of kit/services can happen even during an event. All additions
   should be captured and invoiced."
   ========================================================================== */

export function line(chargeId: string, cfg: LineConfig = {}): LineItem {
  const pricedAt = cfg.pricedAt || cfg.addedAt || '2026-05-01T09:00:00';
  // The charge table has already been moved into shifted time by `db.ts`, so
  // the pricing date has to be moved to match before it is resolved against it.
  // Price in one frame and store in another and a line priced the day before a
  // rate rise silently picks up the new rate. The stored `pricedAt` stays in
  // seed time and is shifted with the rest of the seed at the end of `seed()`;
  // `snap` is excluded from that pass because it is already shifted.
  const snap = rateAt(chargeId, shiftISO(pricedAt));
  const source = cfg.source || 'quote';
  return {
    // A variation starts unanswered by the client. Quote lines carry no
    // approval state at all — the signature covered them.
    ...(source === 'variation' ? { clientApproval: 'pending' as ClientApproval } : {}),
    id: cfg.id || `ln-${Math.random().toString(36).slice(2, 9)}`,
    chargeId,
    kind: snap ? snap.kind : 'kit',
    description: cfg.description || (snap ? snap.name : chargeId),
    qty: cfg.qty ?? 1,
    units: cfg.units ?? 1,
    unitLabel: snap ? snap.unit : 'each',
    snap,
    source: cfg.source || 'quote',
    addedAt: cfg.addedAt || pricedAt,
    addedBy: cfg.addedBy || 'm-colin',
    duringEvent: !!cfg.duringEvent,
    note: cfg.note || '',
  };
}

export const lineRate = (l: LineItem): number => tieredCharge(l.snap, l.qty);
export const lineValue = (l: LineItem): number => round2(l.qty * l.units * lineRate(l));
export const lineCost = (l: LineItem): number =>
  round2(l.qty * l.units * (l.snap ? l.snap.cost : 0));

/** True when the table of charges has moved on since this line was priced. */
export function lineIsStale(l: LineItem): boolean {
  if (!l.snap) return false;
  const now = rateAt(l.chargeId, NOW);
  return (
    !!now &&
    (now.rateVersion !== l.snap.rateVersion ||
      now.charge !== l.snap.charge ||
      now.cost !== l.snap.cost)
  );
}

/* ==========================================================================
   3. DERIVED MONEY — one implementation, every report
   ========================================================================== */

export const quoteLines = (w: Wof): LineItem[] => w.lines.filter((l) => l.source === 'quote');
export const variationLines = (w: Wof): LineItem[] =>
  w.lines.filter((l) => l.source === 'variation');

export const quoteValue = (w: Wof): number =>
  round2(quoteLines(w).reduce((s, l) => s + lineValue(l), 0));
export const variationValue = (w: Wof): number =>
  round2(variationLines(w).reduce((s, l) => s + lineValue(l), 0));

/** Everything the client will be billed: original quote plus every variation. */
export const contractValue = (w: Wof): number => round2(quoteValue(w) + variationValue(w));

/** What we expected the job to cost, from the cost prices on the charge lines. */
export const plannedCost = (w: Wof): number =>
  round2(w.lines.reduce((s, l) => s + lineCost(l), 0));

export const plannedStaffCost = (w: Wof): number =>
  round2(w.lines.filter((l) => l.kind === 'staff').reduce((s, l) => s + lineCost(l), 0));
export const plannedKitCost = (w: Wof): number =>
  round2(w.lines.filter((l) => l.kind !== 'staff').reduce((s, l) => s + lineCost(l), 0));

/**
 * TIMESHEETS — the join that makes payroll and job costing agree.
 *
 * Two sources, one shape:
 *   · WOFs linked to a live operational event read approved attendance rows
 *     from the staff allocation tool (ATTENDANCE).
 *   · Historic WOFs delivered before the link existed carry their own rows.
 *
 * Gross pay = hours x (employee pay rate + role uplift). That single number is
 * what Payroll pays out AND what Job Costing books as actual staff cost.
 */
export function timesheets(w: Wof): Timesheet[] {
  const own = (w.timesheets || []).map((t) => normaliseTimesheet(t, w));
  if (!w.eventId) return own;
  const derived = ATTENDANCE.filter((a) => a.eventId === w.eventId).map((a) =>
    normaliseTimesheet(
      {
        employeeId: a.employeeId, date: a.date, role: a.role,
        hours: a.hours, outcome: a.outcome, approvedBy: a.approvedBy, sourceId: a.id,
      },
      w,
    ),
  );
  return own.concat(derived);
}

function normaliseTimesheet(t: TimesheetSeed, w: Wof): Timesheet {
  const emp = employeeById(t.employeeId);
  const rate = emp ? round2(emp.payRate + (emp.payUplift || 0)) : 0;
  const hours = t.hours || 0;
  return {
    wofId: w.id,
    employeeId: t.employeeId,
    employeeName: emp ? emp.name : t.employeeId,
    date: t.date,
    role: t.role,
    hours,
    outcome: t.outcome || 'worked',
    employmentType: emp ? emp.employmentType : 'PAYE',
    payRate: rate,
    gross: round2(hours * rate),
    approvedBy: t.approvedBy || 'Jake Wright',
    sourceId: t.sourceId || null,
  };
}

/** Actual staff cost = sum of gross pay on approved timesheets. */
export const actualStaffCost = (w: Wof): number =>
  round2(timesheets(w).reduce((s, t) => s + t.gross, 0));

/**
 * Actual total cost. Staff switches from planned to actual as soon as any
 * timesheet exists; kit and services stay at cost price because they are owned
 * stock, not a purchase.
 */
export function actualCost(w: Wof): number {
  const ts = timesheets(w);
  const staff = ts.length ? actualStaffCost(w) : plannedStaffCost(w);
  return round2(staff + plannedKitCost(w));
}

export const margin = (w: Wof): number => round2(contractValue(w) - actualCost(w));
export const marginPct = (w: Wof): number => {
  const v = contractValue(w);
  return v ? Math.round((margin(w) / v) * 100) : 0;
};

export interface DepositView {
  pct: number;
  due: number;
  received: number;
  receivedAt: string | null;
  ref: string | null;
  outstanding: number;
}

/** Deposit due under the job type / client policy, and what has been taken. */
export function deposit(w: Wof): DepositView {
  const jt = jobType(w.jobTypeId);
  const cl = clientById(w.clientId);
  const pct =
    w.deposit && w.deposit.pct != null
      ? w.deposit.pct
      : cl && cl.depositPolicy != null
        ? cl.depositPolicy
        : jt
          ? jt.depositPct
          : 0;
  const due = round2(quoteValue(w) * (pct / 100));
  const received = w.deposit && w.deposit.receivedAt ? (w.deposit.amount ?? due) : 0;
  return {
    pct, due, received,
    receivedAt: w.deposit ? w.deposit.receivedAt : null,
    ref: w.deposit ? w.deposit.ref : null,
    outstanding: round2(due - received),
  };
}

export interface CashflowRow {
  kind: 'deposit' | 'balance';
  label: string;
  amount: number;
  dueAt: string;
  received: boolean;
  receivedAt: string | null;
  receivedAmount: number;
  invoiced?: boolean;
}

export interface Cashflow {
  rows: CashflowRow[];
  expected: number;
  received: number;
  outstanding: number;
  overdue: boolean;
  invoiced: boolean;
  termsDays: number;
}

/**
 * CASH FLOW per WOF: expected income vs received.
 * Deposit is expected at order; the balance (contract net of deposit) is
 * expected at the invoice due date, or projected from the client's payment
 * terms when no invoice has been raised yet.
 */
export function cashflow(w: Wof): Cashflow {
  const dep = deposit(w);
  const cl = clientById(w.clientId);
  const termsDays = (cl && cl.termsDays) || 30;
  const inv = w.invoice || null;

  const balanceDue = round2(contractValue(w) - dep.due);
  const projectedDue = inv && inv.dueAt ? inv.dueAt : addDays(w.end, termsDays + 7);

  const rows: CashflowRow[] = [];
  if (dep.due > 0) {
    rows.push({
      kind: 'deposit', label: `Deposit ${dep.pct}%`, amount: dep.due,
      dueAt: w.orderedAt || w.start, received: dep.received > 0,
      receivedAt: dep.receivedAt, receivedAmount: dep.received,
    });
  }
  rows.push({
    kind: 'balance',
    label: inv ? `Invoice ${inv.number}` : 'Balance (not yet invoiced)',
    amount: balanceDue,
    dueAt: projectedDue,
    received: !!(inv && inv.paidAt),
    receivedAt: inv ? inv.paidAt : null,
    receivedAmount: inv && inv.paidAt ? balanceDue : 0,
    invoiced: !!inv,
  });

  const expected = round2(rows.reduce((s, r) => s + r.amount, 0));
  const received = round2(rows.reduce((s, r) => s + r.receivedAmount, 0));
  const overdue = rows.some((r) => !r.received && new Date(r.dueAt) < NOW);

  return { rows, expected, received, outstanding: round2(expected - received), overdue, invoiced: !!inv, termsDays };
}

/* ==========================================================================
   4. DOCUMENT CHECKLIST
   --------------------------------------------------------------------------
   Built from the job type's document list at the moment the WOF is created, so
   changing a job type's template later does not silently rewrite the checklist
   on a job already in flight.

   Policy: outstanding mandatory documents WARN and, if the operator pushes past
   them, record an override with a reason. `blocking` is honoured as a hard gate
   only when DOC_POLICY is switched to 'block'.
   ========================================================================== */

export const DOC_POLICY: 'warn' | 'block' = 'warn';

export const DOC_STATUS: Record<EffectiveDocStatus, { label: string; tone: Tone; n: number }> =
  {
  required:  { label: 'Required',  tone: 'neutral', n: 0 },
  submitted: { label: 'Submitted', tone: 'info',    n: 1 },
  approved:  { label: 'Approved',  tone: 'healthy', n: 2 },
  /* Nobody has acted and the date has gone. Reserved for `required` + late. */
  outstanding:{label: 'Outstanding',tone:'critical',n: -1 },
};

/**
 * What the Status column should say for one document.
 *
 * Status and lateness are two different axes and they must not be collapsed
 * into one word. 'Outstanding' used to be painted over anything not yet
 * approved once its due date passed, so a document the client had already
 * sent read 'Outstanding' to Operations while the client's own portal read
 * 'With EP Team'. The two roles disagreed about the same row, and whoever
 * trusted the admin view went and chased a client who had done nothing wrong.
 *
 * So: the badge states where the document actually is, and lateness is said
 * separately — `· late` here, plus the red due date the table already draws.
 * 'Outstanding' now means only what it sounds like: we never received it.
 */
export function docStatusMeta(
  d: Pick<WofDocView, 'status' | 'overdue'>,
): { label: string; tone: Tone; n: number } {
  const base = DOC_STATUS[d.status];
  if (!d.overdue) return base;
  if (d.status === 'required') return DOC_STATUS.outstanding;
  // Late, but it is sitting with us — a review job, not a chase job. Sorts
  // just behind the genuinely missing and ahead of everything on time.
  return { label: `${base.label} · late`, tone: 'atRisk', n: -0.5 };
}

export function buildChecklist(jobTypeId: string, eventStart: string | Date): WofDoc[] {
  const jt = jobType(jobTypeId);
  if (!jt) return [];
  return jt.docs.map((id) => {
    const dt = docType(id)!;
    return {
      docId: id, status: 'required' as DocStatusId, owner: dt.owner, blocking: dt.blocking,
      dueDate: addDays(eventStart, -dt.leadDays), note: '', updatedAt: null,
    };
  });
}

export interface DocState {
  docs: WofDocView[];
  total: number;
  approved: number;
  /** Never received and the date has gone — somebody has to be chased. */
  outstanding: number;
  /** Received, not yet approved — the work sits with us, not the client. */
  awaitingReview: number;
  /** Past its due date and not approved, whoever it is with. */
  late: number;
  blocking: number;
  blockingDocs: WofDocView[];
  complete: boolean;
  tone: Tone;
}

/**
 * Roll-up used by the WOF header, the calendar pill and the document report.
 *
 * A document is *overdue* when its due date has passed and it is not approved.
 * Overdue is not a status: it says the clock has run out, not whose desk the
 * thing is on. `outstanding` therefore counts only what never arrived, because
 * that is the number an operator acts on by picking up the phone. Documents
 * that arrived late are counted in `awaitingReview` — the queue is ours.
 */
export function docState(w: Wof): DocState {
  const docs: WofDocView[] = (w.documents || []).map((d) => {
    const overdue = d.status !== 'approved' && new Date(d.dueDate) < NOW;
    return {
      ...d,
      effectiveStatus: overdue && d.status === 'required' ? 'outstanding' : d.status,
      overdue,
      label: docType(d.docId)?.label || d.docId,
    };
  });
  const outstanding = docs.filter((d) => d.effectiveStatus === 'outstanding');
  const awaitingReview = docs.filter((d) => d.status === 'submitted');
  const late = docs.filter((d) => d.overdue);
  const blocking = outstanding.filter((d) => d.blocking);
  const approved = docs.filter((d) => d.status === 'approved');
  return {
    docs,
    total: docs.length,
    approved: approved.length,
    outstanding: outstanding.length,
    awaitingReview: awaitingReview.length,
    late: late.length,
    blocking: blocking.length,
    blockingDocs: blocking,
    complete: docs.length > 0 && approved.length === docs.length,
    tone: blocking.length
      ? 'critical'
      : outstanding.length || late.length
        ? 'atRisk'
        : docs.length && approved.length === docs.length
          ? 'healthy'
          : 'info',
  };
}

export interface Gate {
  ok: boolean;
  warn: string[];
  block: string[];
  target?: WofStage;
}

/**
 * Can this WOF move to the next stage? Warnings never stop the operator under
 * the 'warn' policy — but they are shown, and confirming past one is written
 * into the WOF history.
 */
export function gate(w: Wof, targetStageId?: WofStage): Gate {
  const warn: string[] = [];
  const block: string[] = [];
  const target = targetStageId || nextStage(w);
  if (!target) return { ok: false, warn, block: ['This WOF is already at the end of its lifecycle.'] };

  if (target === 'signoff' && !quoteLines(w).length)
    block.push('The quote has no priced lines. Add items from the table of charges first.');

  if (target === 'order' && !(w.signoff && w.signoff.signedAt))
    block.push(
      'The client has not signed the quote. A digital signature is required before a WOF becomes an order.',
    );

  if (target === 'documents') {
    const dep = deposit(w);
    if (dep.due > 0 && dep.outstanding > 0)
      warn.push(`Deposit of ${money(dep.due)} has not been recorded as received.`);
  }

  if (target === 'picking') {
    const ds = docState(w);
    if (ds.blocking) {
      const names = ds.blockingDocs.map((d) => d.label).join(', ');
      const msg = `${ds.blocking} mandatory document${ds.blocking > 1 ? 's have' : ' has'} not been received: ${names}.`;
      (DOC_POLICY === 'block' ? block : warn).push(msg);
    } else if (ds.outstanding) {
      warn.push(
        `${ds.outstanding} document${ds.outstanding > 1 ? 's have' : ' has'} not been received, none of them mandatory.`,
      );
    }
    // Said separately because it is a different job. These are in, and the
    // only thing standing between them and approved is us looking at them.
    if (ds.awaitingReview)
      warn.push(
        `${ds.awaitingReview} document${ds.awaitingReview > 1 ? 's are' : ' is'} with us for checking and not yet approved.`,
      );
  }

  if (target === 'job') {
    // A job cannot be in delivery before it begins. Same class of nonsense as
    // the "In -4 days" the old app printed: a state that cannot be true. It
    // matters because every downstream report reads `job` as work delivered.
    if (new Date(w.start) > NOW)
      warn.push(
        `This job does not start until ${fmtDate(w.start)} — ${timing(w.start, w.end).label.toLowerCase()}. Marking it in delivery now tells every report the work has happened.`,
      );

    const ev = w.eventId ? eventById(w.eventId) : null;
    if (ev) {
      const cov = eventCoverage(ev);
      if (cov.gap > 0)
        warn.push(`${cov.gap} of ${cov.required} shift roles are still unfilled in the staffing tool.`);
    }
    if (!w.picking || !w.picking.pushedAt) {
      warn.push('The kit list has not been sent to the warehouse via Hire Hop.');
    } else {
      // Sent once and then amended is worse than never sent: the warehouse is
      // confidently picking the wrong list.
      const changes = kitChangesSincePush(w);
      if (changes.length)
        warn.push(
          `The kit list has changed since it went to the warehouse (${w.picking.hireHopRef}): ${changes.map(describeChange).join('; ')}. Re-send it.`,
        );
    }
  }

  if (target === 'invoice') {
    if (new Date(w.end) > NOW)
      warn.push(
        `The job has not finished — it ends ${fmtDate(w.end)}. Invoicing now bills for work that has not been delivered.`,
      );

    const ts = timesheets(w);
    // Only a job with labour on it can have hours to check against. Warning a
    // kit-only hire about missing timesheets is noise, and noise is what
    // teaches operators to click past warnings that matter.
    if (hasStaffWork(w) && !ts.length)
      warn.push(
        'No timesheets have been approved for this job — the invoice cannot be checked against actual hours.',
      );
    const stale = w.lines.filter(lineIsStale);
    if (stale.length)
      warn.push(
        `${stale.length} line${stale.length > 1 ? 's were' : ' was'} priced on a superseded rate. Values are held at the rate agreed with the client.`,
      );
    // Billing a client for extra work they have queried, or never saw, is how
    // an invoice comes back disputed. Both are warnings rather than blocks —
    // sometimes the conversation has happened off-system.
    const queried = queriedVariations(w);
    if (queried.length)
      warn.push(
        `${queried.length} variation${queried.length > 1 ? 's have' : ' has'} been queried by the client and ${queried.length > 1 ? 'are' : 'is'} not agreed: ${queried.map((l) => l.description).join(', ')}.`,
      );
    const unanswered = pendingVariations(w);
    if (unanswered.length)
      warn.push(
        `${unanswered.length} variation${unanswered.length > 1 ? 's are' : ' is'} still with the client for approval, worth ${money(unanswered.reduce((s, l) => s + lineValue(l), 0))}.`,
      );
  }

  return { ok: block.length === 0, warn, block, target };
}

export function nextStage(w: Wof): WofStage | null {
  if (isTerminal(w.stage)) return null;
  const i = stageIndex(w.stage);
  return i < STAGES.length - 1 ? STAGES[i + 1].id : 'complete';
}

/**
 * Does this job involve labour at all?
 *
 * A kit-only hire — a buggy and a welfare unit, no stewards — has no shifts, no
 * check-ins and no timesheets, and never will. Several screens were written
 * assuming every job has staff, which made them report "0/0 fully covered" as
 * though an empty rota were an achievement, and warn about missing hours on a
 * job that has none by design.
 */
export function hasStaffWork(w: Wof): boolean {
  if (w.lines.some((l) => l.kind === 'staff')) return true;
  const ev = w.eventId ? eventById(w.eventId) : null;
  return !!ev && ev.shifts.some((sh) => sh.splits.length > 0);
}

/* ==========================================================================
   5. SEEDING THE CALENDAR AND THE STAFFING TOOL
   --------------------------------------------------------------------------
   Briefing §2.2: "Once a WOF has passed client sign off and becomes an order,
   it will seed the event calendar and subsequently provide shifts for the staff
   allocation tool already built."

   So `order` is the moment an operational event comes into existence. Before
   that the job is a calendar entry only — visible, but with nothing to staff.
   ========================================================================== */

/**
 * One shift per day of the event, not one shift for the whole event.
 *
 * This used to emit a single shift running `w.start` -> `w.end`. On a five-day
 * job that is a 129-hour shift, which is not a shift at all — it is the event,
 * which the event record already holds. It broke everything downstream that
 * assumes a shift is a work period one person does: coverage counted 11 where
 * 55 worker-days were needed and reported the job fully staffed once day one
 * was filled; the worker portal quoted 129h of pay; accreditation exported day
 * one only; and the timesheet layer, which is keyed on employee + DATE, had
 * nothing to map days two onwards to.
 *
 * HOW A DAY IS BOUNDED
 *   Every day inherits the event's start and end times of day. A job running
 *   15 Aug 09:00 -> 16 Aug 18:00 becomes 09:00-18:00 on the 15th and the same
 *   on the 16th, rather than one 33-hour block. Where the end time is at or
 *   before the start time the day is treated as an overnight and closes on the
 *   following morning, which is how night security actually works.
 *
 * WHICH ROLES LAND ON WHICH DAY
 *   Not from `units`. Staff lines are priced per HOUR in practice — `units` is
 *   the length of one shift, not a day count — so there is no structured day
 *   field on a quote line at all. What the real quotes do instead is put the
 *   day in the DESCRIPTION:
 *
 *     "Car Park Steward — Day 1 day shift"     -> day 1
 *     "Event Steward — Day 3"                  -> day 3
 *     "Event Steward — build day"              -> first day
 *     "Event Steward — breakdown"              -> last day
 *     "Car Park Steward — daily x14"           -> every day
 *
 *   So that is what is read. A line naming a day goes on that day only; a line
 *   naming none goes on every day, which is both the plain reading of "7 Event
 *   Stewards" on a two-day job and the safer failure — an over-rostered day is
 *   visible on screen and can be deleted, an unstaffed day is invisible until
 *   nobody turns up.
 *
 *   This is a reading of free text and it should not have to be. The quote line
 *   has qty, units and a rate but no day, which is the same gap that makes
 *   "Quantity" ambiguous in the Add-a-quote-line dialog. A `days` field on the
 *   line would make this exact, and until there is one the parse is confined to
 *   `dayFromDescription` so there is one place to delete.
 */
function seedShifts(w: Wof, evId: string, staffLines: LineItem[]): EpEvent['shifts'] {
  const start = new Date(w.start);
  const end = new Date(w.end);
  const office = w.office || 'EP Event Services';

  // A day counts only if work actually starts on it. Counting calendar dates
  // instead would split an overnight in two: a taxi marshal job running
  // 31 Jul 18:00 -> 1 Aug 03:00 touches two dates but is one night's work, and
  // date-counting invented a second shift on the 1st that nobody sold.
  const starts: Date[] = [];
  for (let i = 0; ; i++) {
    const s = new Date(start);
    s.setDate(s.getDate() + i);
    if (i > 0 && +s >= +end) break;
    starts.push(s);
    if (i > 366) break; // a WOF with a corrupt end date cannot hang the app
  }
  const dayCount = starts.length;

  return starts.map((s, i) => {
    const dayNo = i + 1;

    const e = new Date(s);
    e.setHours(end.getHours(), end.getMinutes(), 0, 0);
    if (+e <= +s) e.setDate(e.getDate() + 1); // overnight
    // The last day finishes when the job finishes, never after it.
    if (+e > +end) e.setTime(+end);

    // Only the roles actually sold for this day.
    const onThisDay = staffLines.filter((l) => {
      const d = dayFromDescription(l.description, dayCount);
      return d === null || d === dayNo;
    });

    return {
      id: `sh-${evId}-${dayNo}`,
      label: dayCount === 1 ? 'Main shift' : `Day ${dayNo}`,
      day: dayNo,
      start: local(s),
      end: local(e),
      splits: onThisDay.map((l, j) => ({
        id: `${evId}-d${dayNo}-sp-${j + 1}`,
        role: chargeById(l.chargeId)?.role || l.description,
        required: l.qty,
        pickupTime: null,
        office,
        uniform: 'White Shirt',
        travel: 'Own transport',
        tags: [],
        assignments: [],
      })),
    };
  });
}

/**
 * Which day of the run a quote line names, or `null` for "every day".
 *
 * The only place free text is read as data. See the note in `seedShifts` for
 * why it has to be, and delete this the moment a quote line carries a real day.
 * Anything it cannot read returns `null` rather than guessing a number: putting
 * a role on every day over-staffs a day visibly, guessing day 4 hides it.
 */
export function dayFromDescription(description: string, dayCount: number): number | null {
  const s = (description || '').toLowerCase();

  // "daily", "x14", "each day" — explicitly the whole run.
  if (/\bdaily\b|\beach day\b|\bevery day\b/.test(s)) return null;

  const named = /\bday\s*(\d{1,2})\b/.exec(s);
  if (named) {
    const n = Number(named[1]);
    if (n >= 1 && n <= dayCount) return n;
    // A quote naming a day the event does not have is a mistake worth seeing,
    // not one to silently round into range.
    return null;
  }

  if (/\bbuild\b|\bset[- ]?up\b|\brig\b/.test(s)) return 1;
  if (/\bbreak[- ]?down\b|\bde[- ]?rig\b|\bstrike\b/.test(s)) return dayCount;

  return null;
}

/** `YYYY-MM-DDTHH:mm:ss` in local time — the shape every seeded date uses. */
function local(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

export function seedEvent(w: Wof): EpEvent | null {
  if (w.eventId && eventById(w.eventId)) return eventById(w.eventId)!;

  const sch = w.scheduleId ? scheduleById(w.scheduleId) : null;
  const evId = `ev-wof-${w.id.replace('wof-', '')}`;
  const staffLines = w.lines.filter((l) => l.kind === 'staff');

  // An event IS the staffing record. A kit-only hire has nobody to roster, so
  // creating one would put an empty job on the staffing screen reading "0/0,
  // fully staffed" — a queue of work that does not exist. The job still shows
  // on the calendar and in the pipeline; it just has no rota.
  if (!staffLines.length) return null;

  // Event info is inherited from the WOF, never re-entered. Typing the venue
  // and postcode a second time is how the two records drift apart.
  const ev: EpEvent = {
    id: evId,
    name: w.title,
    clientId: w.clientId,
    office: w.office || 'EP Event Services',
    start: w.start,
    end: w.end,
    allDay: false,
    requiresAccreditation: (w.documents || []).some((d) => d.docId === 'staff-list'),
    accreditationExportReady: false,
    accreditationBlockedReason: 'No workers assigned yet — nothing to export.',
    locations:
      w.venue || sch
        ? [
            {
              id: `loc-${evId}`,
              name: w.venue || sch!.venue,
              note: w.staffMeetingPoint ? `Staff meeting point: ${w.staffMeetingPoint}` : '',
            },
          ]
        : [],
    additionalInfo: `Seeded automatically from ${w.ref} when the order was confirmed.`,
    shifts: seedShifts(w, evId, staffLines),
    // Inherited like everything else here, rather than re-entered. The WOF's
    // owner is the account manager, not necessarily the person who will lead on
    // the ground, so this stays null until someone says otherwise.
    leadId: null,
  };

  EVENTS.push(ev);
  w.eventId = evId;
  if (sch) sch.wofId = w.id;
  return ev;
}

/**
 * Events for this client that no work order has claimed.
 *
 * Seeding is the only thing that ever writes `w.eventId`, and it only fires on
 * the transition into `order`. An operator who built the event by hand — or who
 * ordered a job whose quote had no staff lines and added them later — ends up
 * with an event and a WOF that cannot see each other, and no amount of
 * advancing the stage will join them. That event is invisible in the client
 * portal, because `clientEvents()` decides a booking is real by looking for the
 * WOF behind it. So the link has to be makeable after the fact.
 *
 * Scoped to the client: attaching one client's event to another's work order
 * would put their staffing on the wrong portal.
 */
export function adoptableEvents(w: Wof): EpEvent[] {
  const claimed = new Set(WOFS.map((x) => x.eventId).filter((id): id is string => !!id));
  return EVENTS.filter((ev) => ev.clientId === w.clientId && !claimed.has(ev.id)).sort(
    (a, b) => +new Date(a.start) - +new Date(b.start),
  );
}

/**
 * Give an ordered WOF the staffing event it never got — either by seeding one
 * from the quote's staff lines, or by adopting an event that already exists.
 *
 * Returns null when there is nothing to do it with, so the caller can say why
 * rather than failing silently.
 */
export function ensureStaffingEvent(
  w: Wof,
  opts: { adopt?: string } = {},
  actor: Actor = OPERATOR,
): EpEvent | null {
  if (w.eventId && eventById(w.eventId)) return eventById(w.eventId)!;

  if (opts.adopt) {
    const ev = eventById(opts.adopt);
    // Re-checked here rather than trusted from the dialog: the picker was built
    // from a snapshot, and the event may have been claimed since.
    if (!ev || ev.clientId !== w.clientId) return null;
    if (WOFS.some((x) => x.id !== w.id && x.eventId === ev.id)) return null;

    w.eventId = ev.id;
    const sch = w.scheduleId ? scheduleById(w.scheduleId) : null;
    if (sch) sch.wofId = w.id;
    record(
      w,
      {
        stage: w.stage,
        note: `Linked to staffing event "${ev.name}" — it now shows as a confirmed booking in the client portal`,
      },
      actor,
    );
    save();
    return ev;
  }

  const ev = seedEvent(w);
  if (!ev) return null;
  record(
    w,
    {
      stage: w.stage,
      note: `Staffing event seeded from the quote — ${countLabel(ev.shifts[0].splits.length, 'role group')}`,
    },
    actor,
  );
  save();
  return ev;
}

/* ==========================================================================
   6. SEED RECORDS
   --------------------------------------------------------------------------
   Nine live WOFs across the pipeline, four historic ones for cash flow and
   margin history, and five known events with no WOF at all.

   Line quantities are set so that a WOF linked to an operational event matches
   the shift requirements in the staffing tool — the numbers on the quote and
   the numbers Jake is trying to fill are the same numbers.
   ========================================================================== */

function seed(): WofSeed[] {

    const W: WofSeed[] = [];

    /* ---- wof-101 Wilderness — LIVE, mid-event variations ---------------- */
    W.push({
      id: 'wof-101', ref: 'WOF-2026-0101', title: 'Wilderness Festival 19th-28th',
      clientId: 'c-19', scheduleId: 'sch-1', eventId: 'ev-1', jobTypeId: 'festival',
      office: 'EP Event Services', ownerId: 'm-colin', raisedBy: 'm-colin',
      start: '2026-07-27T07:00:00', end: '2026-08-03T19:00:00',
      venue: 'Cornbury Park, Oxfordshire', stage: 'job',
      raisedAt: '2026-03-14T10:20:00', quotedAt: '2026-03-28T16:00:00',
      orderedAt: '2026-04-09T11:30:00',
      signoff: { signedBy: 'Dana Reilly', signedByRole: 'Head of Operations',
                 signedAt: '2026-04-08T14:22:00', method: 'DocuSign', ref: 'DS-4471-WLD',
                 ip: '81.134.22.7' },
      deposit: { pct: 25, amount: 43312.50, receivedAt: '2026-04-15T09:00:00', ref: 'BACS 884120' },
      lines: [
        line('ch-st-carpark', { qty: 15, units: 12, pricedAt: '2026-03-28', description: 'Car Park Steward — Day 1 day shift' }),
        line('ch-st-response',{ qty: 6,  units: 12, pricedAt: '2026-03-28', description: 'Response Steward — Day 1 night shift' }),
        line('ch-st-carpark', { qty: 12, units: 12, pricedAt: '2026-03-28', description: 'Car Park Steward — Day 2' }),
        line('ch-st-super',   { qty: 2,  units: 12, pricedAt: '2026-03-28', description: 'Gate Supervisor — Day 2' }),
        line('ch-st-event',   { qty: 20, units: 12, pricedAt: '2026-03-28', description: 'Event Steward — Day 3' }),
        line('ch-st-event',   { qty: 20, units: 12, pricedAt: '2026-03-28', description: 'Event Steward — Day 4' }),
        line('ch-st-event',   { qty: 18, units: 12, pricedAt: '2026-03-28', description: 'Event Steward — Day 5' }),
        line('ch-st-pit',     { qty: 8,  units: 9,  pricedAt: '2026-03-28', description: 'Pit Steward — Day 5' }),
        line('ch-st-event',   { qty: 18, units: 12, pricedAt: '2026-03-28', description: 'Event Steward — Day 6' }),
        line('ch-st-event',   { qty: 10, units: 10, pricedAt: '2026-03-28', description: 'Event Steward — Day 7 breakdown' }),
        line('ch-kit-radio',  { qty: 45, units: 8,  pricedAt: '2026-03-28' }),
        line('ch-kit-charger',{ qty: 8,  units: 8,  pricedAt: '2026-03-28' }),
        line('ch-kit-barrier',{ qty: 420,units: 8,  pricedAt: '2026-03-28' }),
        line('ch-kit-cabin',  { qty: 2,  units: 8,  pricedAt: '2026-03-28' }),
        line('ch-kit-buggy',  { qty: 2,  units: 8,  pricedAt: '2026-03-28' }),
        line('ch-kit-welfare',{ qty: 1,  units: 8,  pricedAt: '2026-03-28' }),
        line('ch-sv-pm',      { qty: 1,  units: 8,  pricedAt: '2026-03-28' }),
        line('ch-sv-accred',  { qty: 1,  units: 1,  pricedAt: '2026-03-28' }),
        line('ch-sv-radiolic',{ qty: 1,  units: 1,  pricedAt: '2026-03-28' }),
        // Variations raised while the event is running — briefing §3.
        line('ch-kit-lighting', { qty: 4, units: 3, source: 'variation', duringEvent: true,
              addedAt: '2026-07-29T18:40:00', addedBy: 'm-colin',
              note: 'Client requested extra lighting on the blue camp footpath after Tuesday night.' }),
        line('ch-st-response',  { qty: 4, units: 12, source: 'variation', duringEvent: true,
              addedAt: '2026-07-30T07:10:00', addedBy: 'm-colin',
              note: 'Additional night response cover requested on site by the client production manager.' }),
      ],
      documents: docsFor('festival', '2026-07-27T07:00:00', {
        'risk-assessment': 'approved', 'method-statement': 'approved', 'insurance': 'approved',
        'sia-licences': 'approved', 'staff-list': 'approved', 'traffic-plan': 'approved',
        'site-plan': 'approved', 'event-licence': 'approved', 'medical-plan': 'approved',
        'radio-licence': 'approved',
      }),
      picking: { hireHopRef: 'HH-2026-8841', pushedAt: '2026-07-22T14:05:00', status: 'Packed and dispatched',
                 lastSyncAt: '2026-07-26T08:15:00' },
      invoice: null,
      history: [],
      notes: 'Largest annual booking. Client production manager is on site and authorises variations verbally — get them into the WOF the same day.',
    });

    /* ---- wof-102 Reggaeland — picking, huge staffing gap ---------------- */
    W.push({
      id: 'wof-102', ref: 'WOF-2026-0102', title: 'Reggaeland 1st-2nd',
      clientId: 'c-19', scheduleId: 'sch-2', eventId: 'ev-2', jobTypeId: 'festival',
      office: 'London', ownerId: 'm-colin', raisedBy: 'm-gracie',
      start: '2026-07-30T08:00:00', end: '2026-08-04T22:00:00',
      venue: 'Crystal Palace Park, London', stage: 'picking',
      raisedAt: '2026-04-02T09:15:00', quotedAt: '2026-04-18T15:40:00', orderedAt: '2026-05-06T10:00:00',
      signoff: { signedBy: 'Dana Reilly', signedByRole: 'Head of Operations',
                 signedAt: '2026-05-05T16:02:00', method: 'DocuSign', ref: 'DS-4602-RGL', ip: '81.134.22.7' },
      deposit: { pct: 25, amount: 66093.75, receivedAt: '2026-05-12T09:00:00', ref: 'BACS 891044' },
      lines: [
        line('ch-st-event',    { qty: 60,  units: 12, pricedAt: '2026-04-18', description: 'Event Steward — build day' }),
        line('ch-st-super',    { qty: 8,   units: 12, pricedAt: '2026-04-18', description: 'Gate Supervisor — build day' }),
        line('ch-st-event',    { qty: 120, units: 15, pricedAt: '2026-04-18', description: 'Event Steward — show day 1' }),
        line('ch-st-sia',      { qty: 24,  units: 15, pricedAt: '2026-04-18', description: 'Response Steward (SIA) — show day 1' }),
        line('ch-st-event',    { qty: 120, units: 15, pricedAt: '2026-04-18', description: 'Event Steward — show day 2' }),
        line('ch-st-bar',      { qty: 40,  units: 13, pricedAt: '2026-04-18', description: 'Bar Staff — show day 2' }),
        line('ch-st-event',    { qty: 44,  units: 10, pricedAt: '2026-04-18', description: 'Event Steward — breakdown' }),
        line('ch-kit-radio',   { qty: 110, units: 6,  pricedAt: '2026-04-18' }),
        line('ch-kit-charger', { qty: 20,  units: 6,  pricedAt: '2026-04-18' }),
        line('ch-kit-barrier', { qty: 600, units: 6,  pricedAt: '2026-04-18' }),
        line('ch-kit-heras',   { qty: 240, units: 6,  pricedAt: '2026-04-18' }),
        line('ch-kit-cabin',   { qty: 3,   units: 6,  pricedAt: '2026-04-18' }),
        line('ch-kit-welfare', { qty: 2,   units: 6,  pricedAt: '2026-04-18' }),
        line('ch-kit-lighting',{ qty: 8,   units: 6,  pricedAt: '2026-04-18' }),
        line('ch-sv-pm',       { qty: 1,   units: 6,  pricedAt: '2026-04-18' }),
        line('ch-sv-accred',   { qty: 1,   units: 1,  pricedAt: '2026-04-18' }),
        line('ch-sv-transport',{ qty: 2,   units: 6,  pricedAt: '2026-04-18' }),
      ],
      documents: docsFor('festival', '2026-07-30T08:00:00', {
        'risk-assessment': 'approved', 'method-statement': 'approved', 'insurance': 'approved',
        'sia-licences': 'submitted', 'staff-list': 'required', 'traffic-plan': 'approved',
        'site-plan': 'approved', 'event-licence': 'approved', 'medical-plan': 'submitted',
        'radio-licence': 'approved',
      }),
      picking: { hireHopRef: 'HH-2026-8907', pushedAt: '2026-07-24T11:20:00', status: 'Picking in progress',
                 lastSyncAt: '2026-07-30T18:02:00' },
      invoice: null, history: [],
      notes: 'Client requires 100% SIA coverage on security splits. Staffing is critically behind — see the staffing tool.',
    });

    /* ---- wof-103 Taxi Marshal — small job, in delivery ------------------ */
    W.push({
      id: 'wof-103', ref: 'WOF-2026-0103', title: 'Taxi Marshal 31st-1st',
      clientId: 'c-4', scheduleId: 'sch-3', eventId: 'ev-3', jobTypeId: 'venue',
      office: 'London', ownerId: 'm-gracie', raisedBy: 'm-gracie',
      start: '2026-07-31T18:00:00', end: '2026-08-01T03:00:00',
      venue: 'OVO Arena Wembley', stage: 'job',
      raisedAt: '2026-07-10T13:00:00', quotedAt: '2026-07-13T09:30:00', orderedAt: '2026-07-16T10:10:00',
      signoff: { signedBy: 'Simon Achebe', signedByRole: 'Venue Operations',
                 signedAt: '2026-07-15T17:44:00', method: 'DocuSign', ref: 'DS-4711-OVO', ip: '194.66.9.12' },
      deposit: { pct: 0, amount: 0, receivedAt: null, ref: null },
      lines: [
        line('ch-st-taxi',  { qty: 4, units: 9, pricedAt: '2026-07-13', description: 'Taxi Marshal — night shift' }),
        line('ch-kit-radio',{ qty: 5, units: 1, pricedAt: '2026-07-13' }),
        line('ch-kit-hivis',{ qty: 4, units: 1, pricedAt: '2026-07-13' }),
      ],
      documents: docsFor('venue', '2026-07-31T18:00:00', {
        'risk-assessment': 'approved', 'insurance': 'approved',
        'sia-licences': 'approved', 'staff-list': 'submitted',
      }),
      picking: { hireHopRef: 'HH-2026-8955', pushedAt: '2026-07-29T09:00:00', status: 'Packed', lastSyncAt: '2026-07-29T09:00:00' },
      invoice: null, history: [],
      notes: 'Late finish; taxis home provided for anyone finishing after 01:00 — recharged at cost.',
    });

    /* ---- wof-104 EDG Phoenix v Welsh Fire — DOCUMENTS, overdue --------- */
    W.push({
      id: 'wof-104', ref: 'WOF-2026-0104', title: 'EDG — 100 Phoenix v Welsh Fire 01.08',
      clientId: 'c-20', scheduleId: 'sch-4', eventId: 'ev-4', jobTypeId: 'sports',
      office: 'South East', ownerId: 'm-colin', raisedBy: 'm-gracie',
      start: '2026-08-01T12:00:00', end: '2026-08-01T23:00:00',
      venue: 'Ageas Bowl, Southampton', stage: 'documents',
      raisedAt: '2026-06-20T11:00:00', quotedAt: '2026-06-26T14:00:00', orderedAt: '2026-07-03T09:20:00',
      signoff: { signedBy: 'Marcus Vane', signedByRole: 'Match Day Manager',
                 signedAt: '2026-07-02T15:10:00', method: 'DocuSign', ref: 'DS-4655-EDG', ip: '92.40.170.3' },
      deposit: { pct: 0, amount: 0, receivedAt: null, ref: null },
      lines: [
        line('ch-st-turnstile',{ qty: 12, units: 11, pricedAt: '2026-06-26', description: 'Turnstile Operator — match day' }),
        line('ch-st-event',    { qty: 10, units: 11, pricedAt: '2026-06-26', description: 'Event Steward — match day' }),
        line('ch-st-hosp',     { qty: 4,  units: 12, pricedAt: '2026-06-26', description: 'Hospitality Host — match day' }),
        line('ch-kit-radio',   { qty: 26, units: 1,  pricedAt: '2026-06-26' }),
        line('ch-kit-signage', { qty: 2,  units: 1,  pricedAt: '2026-06-26' }),
      ],
      documents: docsFor('sports', '2026-08-01T12:00:00', {
        'risk-assessment': 'approved', 'insurance': 'approved',
        'sia-licences': 'submitted',      // due 25 Jul — now overdue
        'staff-list': 'required',         // due 22 Jul — now overdue
        'site-plan': 'approved', 'purchase-order': 'required',
      }),
      picking: null, invoice: null, history: [],
      notes: 'Client has not returned the purchase order. SIA register submitted but not approved by compliance.',
    });

    /* ---- wof-105 Nepalese — order, deposit outstanding ------------------ */
    W.push({
      id: 'wof-105', ref: 'WOF-2026-0105', title: 'Nepalese Community Day 01.08',
      clientId: 'c-21', scheduleId: 'sch-5', eventId: 'ev-5', jobTypeId: 'show',
      office: 'EP Team South', ownerId: 'm-gracie', raisedBy: 'm-gracie',
      start: '2026-08-01T10:00:00', end: '2026-08-01T20:00:00',
      venue: 'Aldershot Community Ground', stage: 'order',
      raisedAt: '2026-06-28T10:00:00', quotedAt: '2026-07-05T12:00:00', orderedAt: '2026-07-20T14:30:00',
      signoff: { signedBy: 'Bishal Gurung', signedByRole: 'Event Lead',
                 signedAt: '2026-07-19T19:05:00', method: 'DocuSign', ref: 'DS-4698-NCT', ip: '86.15.204.88' },
      deposit: { pct: 50, amount: null, receivedAt: null, ref: null },   // NOT received
      lines: [
        line('ch-st-event',   { qty: 15, units: 10, pricedAt: '2026-07-05', description: 'Event Steward — show day' }),
        line('ch-kit-radio',  { qty: 16, units: 1,  pricedAt: '2026-07-05' }),
        line('ch-kit-barrier',{ qty: 80, units: 2,  pricedAt: '2026-07-05' }),
        line('ch-kit-signage',{ qty: 1,  units: 1,  pricedAt: '2026-07-05' }),
      ],
      documents: docsFor('show', '2026-08-01T10:00:00', {
        'risk-assessment': 'approved', 'method-statement': 'submitted', 'insurance': 'approved',
        'traffic-plan': 'required', 'site-plan': 'submitted', 'client-brief': 'approved',
      }),
      picking: null, invoice: null, history: [],
      notes: '50% deposit required under client terms and has not landed. Do not release kit until it does.',
    });

    /* ---- wof-106 EDG Sunrisers — order --------------------------------- */
    W.push({
      id: 'wof-106', ref: 'WOF-2026-0106', title: 'EDG — 100 Phoenix v Sunrisers 07.08',
      clientId: 'c-20', scheduleId: 'sch-6', eventId: 'ev-6', jobTypeId: 'sports',
      office: 'South East', ownerId: 'm-colin', raisedBy: 'm-gracie',
      start: '2026-08-07T12:00:00', end: '2026-08-07T23:00:00',
      venue: 'Ageas Bowl, Southampton', stage: 'order',
      raisedAt: '2026-06-20T11:05:00', quotedAt: '2026-06-26T14:10:00', orderedAt: '2026-07-03T09:25:00',
      signoff: { signedBy: 'Marcus Vane', signedByRole: 'Match Day Manager',
                 signedAt: '2026-07-02T15:12:00', method: 'DocuSign', ref: 'DS-4656-EDG', ip: '92.40.170.3' },
      deposit: { pct: 0, amount: 0, receivedAt: null, ref: null },
      lines: [
        line('ch-st-turnstile',{ qty: 12, units: 11, pricedAt: '2026-06-26', description: 'Turnstile Operator — match day' }),
        line('ch-st-event',    { qty: 14, units: 11, pricedAt: '2026-06-26', description: 'Event Steward — match day' }),
        line('ch-kit-radio',   { qty: 28, units: 1,  pricedAt: '2026-06-26' }),
        line('ch-kit-signage', { qty: 2,  units: 1,  pricedAt: '2026-06-26' }),
      ],
      documents: docsFor('sports', '2026-08-07T12:00:00', {
        'risk-assessment': 'approved', 'insurance': 'approved', 'sia-licences': 'required',
        'staff-list': 'required', 'site-plan': 'approved', 'purchase-order': 'submitted',
      }),
      picking: null, invoice: null, history: [],
      notes: '',
    });

    /* ---- wof-107 Aintree — documents ----------------------------------- */
    W.push({
      id: 'wof-107', ref: 'WOF-2026-0107', title: 'Aintree Race Day 08.08',
      clientId: 'c-12', scheduleId: 'sch-7', eventId: 'ev-7', jobTypeId: 'sports',
      office: 'North East', ownerId: 'm-colin', raisedBy: 'm-colin',
      start: '2026-08-08T09:00:00', end: '2026-08-08T21:00:00',
      venue: 'Aintree Racecourse', stage: 'documents',
      raisedAt: '2026-06-05T09:40:00', quotedAt: '2026-06-12T11:00:00', orderedAt: '2026-06-24T10:00:00',
      signoff: { signedBy: 'Elaine Davis', signedByRole: 'Raceday Operations',
                 signedAt: '2026-06-23T13:35:00', method: 'DocuSign', ref: 'DS-4588-AIN', ip: '78.145.61.20' },
      deposit: { pct: 0, amount: 0, receivedAt: null, ref: null },
      lines: [
        line('ch-st-event',   { qty: 28, units: 12, pricedAt: '2026-06-12', description: 'Event Steward — race day' }),
        line('ch-st-hosp',    { qty: 4,  units: 12, pricedAt: '2026-06-12', description: 'Hospitality Host — race day' }),
        line('ch-kit-radio',  { qty: 34, units: 1,  pricedAt: '2026-06-12' }),
        line('ch-kit-barrier',{ qty: 150,units: 2,  pricedAt: '2026-06-12' }),
        line('ch-sv-accred',  { qty: 1,  units: 1,  pricedAt: '2026-06-12' }),
      ],
      documents: docsFor('sports', '2026-08-08T09:00:00', {
        'risk-assessment': 'approved', 'insurance': 'approved', 'sia-licences': 'approved',
        'staff-list': 'submitted', 'site-plan': 'approved', 'purchase-order': 'approved',
      }),
      picking: null, invoice: null, history: [],
      notes: 'Fully staffed and confirmed in the staffing tool. Accreditation list is the only thing left.',
    });

    /* ---- wof-108 St Albans Half — order -------------------------------- */
    W.push({
      id: 'wof-108', ref: 'WOF-2026-0108', title: 'St Albans Half Marathon',
      clientId: 'c-3', scheduleId: 'sch-8', eventId: 'ev-8', jobTypeId: 'road-race',
      office: 'EP Team South', ownerId: 'm-gracie', raisedBy: 'm-gracie',
      start: '2026-08-09T06:00:00', end: '2026-08-09T15:00:00',
      venue: 'Verulamium Park, St Albans', stage: 'order',
      raisedAt: '2026-05-30T10:00:00', quotedAt: '2026-06-08T09:00:00', orderedAt: '2026-06-19T11:15:00',
      signoff: { signedBy: 'Martin Kaye', signedByRole: 'Race Director',
                 signedAt: '2026-06-18T20:40:00', method: 'DocuSign', ref: 'DS-4571-ATW', ip: '31.53.108.44' },
      deposit: { pct: 20, amount: null, receivedAt: '2026-06-26T09:00:00', ref: 'BACS 877301' },
      lines: [
        line('ch-st-event',   { qty: 22, units: 9,  pricedAt: '2026-06-08', description: 'Event Steward — race morning' }),
        line('ch-sv-tmplan',  { qty: 1,  units: 1,  pricedAt: '2026-06-08' }),
        line('ch-kit-cone',   { qty: 240,units: 2,  pricedAt: '2026-06-08' }),
        line('ch-kit-barrier',{ qty: 120,units: 2,  pricedAt: '2026-06-08' }),
        line('ch-kit-radio',  { qty: 24, units: 1,  pricedAt: '2026-06-08' }),
        line('ch-kit-signage',{ qty: 3,  units: 2,  pricedAt: '2026-06-08' }),
      ],
      documents: docsFor('road-race', '2026-08-09T06:00:00', {
        'risk-assessment': 'approved', 'traffic-plan': 'approved', 'insurance': 'approved',
        'medical-plan': 'submitted', 'staff-list': 'required',
      }),
      picking: null, invoice: null, history: [],
      notes: '',
    });

    /* ---- wof-109 Alresford Show — quote sent, awaiting signature -------- */
    W.push({
      id: 'wof-109', ref: 'WOF-2026-0109', title: 'Alresford Show',
      clientId: 'c-17', scheduleId: 'sch-9', eventId: 'ev-9', jobTypeId: 'show',
      office: 'EP Team South', ownerId: 'm-colin', raisedBy: 'm-gracie',
      start: '2026-08-15T07:00:00', end: '2026-08-15T19:00:00',
      venue: 'Tichborne Park, Alresford', stage: 'signoff',
      raisedAt: '2026-06-14T09:00:00', quotedAt: '2026-07-22T16:20:00', orderedAt: null,
      signoff: null,
      deposit: { pct: 20, amount: null, receivedAt: null, ref: null },
      lines: [
        line('ch-st-event',   { qty: 16, units: 12, pricedAt: '2026-07-22', description: 'Event Steward — show day' }),
        line('ch-kit-radio',  { qty: 18, units: 2,  pricedAt: '2026-07-22' }),
        line('ch-kit-barrier',{ qty: 90, units: 2,  pricedAt: '2026-07-22' }),
        line('ch-sv-survey',  { qty: 1,  units: 1,  pricedAt: '2026-07-22' }),
      ],
      documents: docsFor('show', '2026-08-15T07:00:00', {
        'risk-assessment': 'submitted', 'method-statement': 'required', 'insurance': 'approved',
        'traffic-plan': 'required', 'site-plan': 'required', 'client-brief': 'required',
      }),
      picking: null, invoice: null, history: [],
      notes: 'Quote sent 22 July, chased once. Show is in two weeks — if this is not signed this week the staffing lead time is gone.',
    });

    /* ---- wof-110 / 111 — early stage, no event yet ---------------------- */
    W.push({
      id: 'wof-110', ref: 'WOF-2026-0110', title: 'Ascot Late Summer Raceday',
      clientId: 'c-24', scheduleId: 'sch-10', eventId: null, jobTypeId: 'sports',
      office: 'South East', ownerId: 'm-colin', raisedBy: 'm-colin',
      start: '2026-08-22T10:00:00', end: '2026-08-22T20:00:00',
      venue: 'Ascot Racecourse', stage: 'quote',
      raisedAt: '2026-07-18T09:30:00', quotedAt: '2026-07-30T15:00:00', orderedAt: null,
      signoff: null, deposit: { pct: 0, amount: 0, receivedAt: null, ref: null },
      lines: [
        line('ch-st-event',  { qty: 34, units: 10, pricedAt: '2026-07-30', description: 'Event Steward — race day' }),
        line('ch-st-super',  { qty: 4,  units: 10, pricedAt: '2026-07-30', description: 'Supervisor — race day' }),
        line('ch-st-hosp',   { qty: 8,  units: 11, pricedAt: '2026-07-30', description: 'Hospitality Host — enclosures' }),
        line('ch-kit-radio', { qty: 48, units: 1,  pricedAt: '2026-07-30' }),
        line('ch-sv-accred', { qty: 1,  units: 1,  pricedAt: '2026-07-30' }),
      ],
      documents: docsFor('sports', '2026-08-22T10:00:00', {}),
      picking: null, invoice: null, history: [],
      notes: 'Quote issued 30 July. Ascot normally sign within a week.',
    });

    W.push({
      id: 'wof-111', ref: 'WOF-2026-0111', title: 'AELTC Autumn Members Event',
      clientId: 'c-6', scheduleId: 'sch-13', eventId: null, jobTypeId: 'corporate',
      office: 'London', ownerId: 'm-colin', raisedBy: 'm-colin',
      start: '2026-09-12T09:00:00', end: '2026-09-12T19:00:00',
      venue: 'All England Club, Wimbledon', stage: 'wof',
      raisedAt: '2026-07-28T14:00:00', quotedAt: null, orderedAt: null,
      signoff: null, deposit: { pct: 50, amount: null, receivedAt: null, ref: null },
      lines: [],
      documents: docsFor('corporate', '2026-09-12T09:00:00', {}),
      picking: null, invoice: null, history: [],
      notes: 'Requirements call booked for 5 August. Nothing priced yet.',
    });

    /* ---- Historic, invoiced. Cash flow + margin history ----------------- */
    W.push(historic({
      id: 'wof-091', ref: 'WOF-2026-0091', title: 'Ageas Bowl — Vitality Blast 20.06',
      clientId: 'c-20', scheduleId: 'sch-h1', jobTypeId: 'sports', office: 'South East',
      ownerId: 'm-colin', start: '2026-06-20T12:00:00', end: '2026-06-20T23:00:00',
      venue: 'Ageas Bowl, Southampton',
      lines: [
        line('ch-st-turnstile',{ qty: 14, units: 11, pricedAt: '2026-05-14', description: 'Turnstile Operator' }),
        line('ch-st-event',    { qty: 22, units: 11, pricedAt: '2026-05-14', description: 'Event Steward' }),
        line('ch-st-sia',      { qty: 6,  units: 11, pricedAt: '2026-05-14', description: 'SIA Officer' }),
        line('ch-kit-radio',   { qty: 44, units: 1,  pricedAt: '2026-05-14' }),
        line('ch-kit-signage', { qty: 2,  units: 1,  pricedAt: '2026-05-14' }),
      ],
      invoice: { number: 'INV-26-0418', issuedAt: '2026-06-25T10:00:00', dueAt: '2026-07-25T00:00:00',
                 paidAt: '2026-07-21T00:00:00' },
      staffDays: [{ date: '2026-06-20', roles: [['Turnstile Operator', 14, 11.2], ['Event Steward', 22, 11.4], ['Security Officer', 6, 11.0]] }],
      stage: 'complete',
    }));

    W.push(historic({
      id: 'wof-092', ref: 'WOF-2026-0092', title: 'AELTC Championships — car parks',
      clientId: 'c-6', scheduleId: 'sch-h2', jobTypeId: 'sports', office: 'London',
      ownerId: 'm-colin', start: '2026-06-29T06:00:00', end: '2026-07-12T22:00:00',
      venue: 'All England Club, Wimbledon',
      lines: [
        line('ch-st-carpark', { qty: 40, units: 12, pricedAt: '2026-02-20', description: 'Car Park Steward — daily x14' }),
        line('ch-st-super',   { qty: 6,  units: 12, pricedAt: '2026-02-20', description: 'Supervisor — daily x14' }),
        line('ch-kit-radio',  { qty: 52, units: 14, pricedAt: '2026-02-20' }),
        line('ch-kit-cone',   { qty: 300,units: 14, pricedAt: '2026-02-20' }),
        line('ch-kit-cabin',  { qty: 4,  units: 14, pricedAt: '2026-02-20' }),
        line('ch-sv-pm',      { qty: 1,  units: 14, pricedAt: '2026-02-20' }),
      ],
      invoice: { number: 'INV-26-0433', issuedAt: '2026-07-15T10:00:00', dueAt: '2026-09-13T00:00:00', paidAt: null },
      staffDays: [{ date: '2026-07-06', roles: [['Car Park Steward', 40, 12.1], ['Gate Supervisor', 6, 12.4]] }],
      stage: 'invoice',
      note: 'Priced in February on the 2025/26 rate card — deliberately held at the agreed rate despite the April uplift.',
    }));

    W.push(historic({
      id: 'wof-093', ref: 'WOF-2026-0093', title: 'Aintree Summer Raceday 04.07',
      clientId: 'c-12', scheduleId: 'sch-h3', jobTypeId: 'sports', office: 'North East',
      ownerId: 'm-colin', start: '2026-07-04T09:00:00', end: '2026-07-04T21:00:00',
      venue: 'Aintree Racecourse',
      lines: [
        line('ch-st-event', { qty: 26, units: 12, pricedAt: '2026-05-28', description: 'Event Steward — race day' }),
        line('ch-st-hosp',  { qty: 4,  units: 12, pricedAt: '2026-05-28', description: 'Hospitality Host' }),
        line('ch-kit-radio',{ qty: 32, units: 1,  pricedAt: '2026-05-28' }),
        line('ch-sv-accred',{ qty: 1,  units: 1,  pricedAt: '2026-05-28' }),
      ],
      invoice: { number: 'INV-26-0441', issuedAt: '2026-07-09T10:00:00', dueAt: '2026-08-23T00:00:00', paidAt: null },
      staffDays: [{ date: '2026-07-04', roles: [['Event Steward', 26, 12.3], ['Hospitality Host', 4, 12.0]] }],
      stage: 'invoice',
    }));

    W.push(historic({
      id: 'wof-094', ref: 'WOF-2026-0094', title: 'Abbots Events — Summer Fete 11.07',
      clientId: 'c-2', scheduleId: 'sch-h4', jobTypeId: 'show', office: 'EP Team South',
      ownerId: 'm-gracie', start: '2026-07-11T09:00:00', end: '2026-07-11T18:00:00',
      venue: 'Verulamium Park, St Albans',
      lines: [
        line('ch-st-event',   { qty: 12, units: 9, pricedAt: '2026-06-02', description: 'Event Steward — fete day' }),
        line('ch-kit-radio',  { qty: 14, units: 1, pricedAt: '2026-06-02' }),
        line('ch-kit-barrier',{ qty: 60, units: 2, pricedAt: '2026-06-02' }),
      ],
      // Deliberately unprofitable: overtime blew the margin. Job costing must show it.
      invoice: { number: 'INV-26-0447', issuedAt: '2026-07-16T10:00:00', dueAt: '2026-08-15T00:00:00', paidAt: null },
      staffDays: [{ date: '2026-07-11', roles: [['Event Steward', 12, 13.9]] }],
      stage: 'invoice',
      variation: line('ch-st-event', { qty: 4, units: 6, source: 'variation', duringEvent: true,
        addedAt: '2026-07-11T13:20:00', addedBy: 'm-gracie',
        note: 'Crowd higher than forecast; four extra stewards called in on the day.' }),
      note: 'Ran two hours over. Margin is thin — worth reviewing what was quoted against what was delivered.',
    }));

    // Move the whole seed into shifted time in one pass, for the same reason
    // `db.ts` does: a WOF whose event ran last March is a museum piece, and the
    // stage gates, document lead times and "priced 4 months ago" staleness
    // warnings all read from these dates. `snap` is skipped — it was resolved
    // against the already-shifted charge table inside `line()`.
    return shiftDeep(W, { skip: ['snap'] });

}

interface HistoricConfig {
  id: string;
  ref: string;
  title: string;
  clientId: string;
  scheduleId: string;
  jobTypeId: string;
  office: string;
  ownerId: string;
  start: string;
  end: string;
  venue: string;
  lines: LineItem[];
  invoice: Invoice;
  /** [role, headcount, hours] per day. */
  staffDays?: { date: string; roles: [string, number, number][] }[];
  stage: WofStage;
  variation?: LineItem;
  note?: string;
}

/** Historic WOF helper: fills the stages that already happened. */
function historic(cfg: HistoricConfig): WofSeed {

    const q = cfg.lines.reduce((s, l) => s + lineValue(l), 0);
    const jt = jobType(cfg.jobTypeId)!;
    const client = clientById(cfg.clientId);
    const pct = client && client.depositPolicy != null ? client.depositPolicy : jt.depositPct;
    const lines = cfg.variation ? cfg.lines.concat([cfg.variation]) : cfg.lines;

    const timesheetRows: TimesheetSeed[] = [];
    (cfg.staffDays || []).forEach(day => {
      day.roles.forEach(([role, count, hours]) => {
        const pool = EMPLOYEES.filter((e) => e.department !== 'Bar');
        for (let i = 0; i < count; i++) {
          const emp = pool[(i * 3 + role.length) % pool.length];
          timesheetRows.push({ employeeId: emp.id, date: day.date, role,
                               hours: round2(hours + ((i % 5) - 2) * 0.1), outcome: 'worked' });
        }
      });
    });

    return {
      id: cfg.id, ref: cfg.ref, title: cfg.title, clientId: cfg.clientId,
      scheduleId: cfg.scheduleId, eventId: null, jobTypeId: cfg.jobTypeId,
      office: cfg.office, ownerId: cfg.ownerId, raisedBy: cfg.ownerId,
      start: cfg.start, end: cfg.end, venue: cfg.venue, stage: cfg.stage,
      raisedAt: addDays(cfg.start, -75), quotedAt: addDays(cfg.start, -45),
      orderedAt: addDays(cfg.start, -30),
      signoff: { signedBy: (client && client.contact) || 'Client contact',
                 signedByRole: (client && client.contactRole) || 'Authorised signatory',
                 signedAt: addDays(cfg.start, -31), method: 'DocuSign',
                 ref: `DS-${cfg.id.slice(-4)}`, ip: '—' },
      deposit: { pct, amount: round2(q * pct / 100),
                 receivedAt: pct > 0 ? addDays(cfg.start, -25) : null,
                 ref: pct > 0 ? `BACS ${8600 + Number(cfg.id.slice(-3))}` : null },
      lines,
      documents: docsFor(cfg.jobTypeId, cfg.start, 'all-approved'),
      picking: { hireHopRef: `HH-2026-${8000 + Number(cfg.id.slice(-3))}`,
                 pushedAt: addDays(cfg.start, -6), status: 'Returned and checked in',
                 lastSyncAt: addDays(cfg.end, 1) },
      invoice: cfg.invoice, timesheets: timesheetRows, history: [], notes: cfg.note || '',
    };

}

/** Checklist builder with a status overlay. Pass 'all-approved' for history. */
function docsFor(
  jobTypeId: string,
  eventStart: string,
  overlay?: Record<string, DocStatusId> | 'all-approved',
): WofDoc[] {
  const list = buildChecklist(jobTypeId, eventStart);
  if (overlay === 'all-approved') {
    return list.map((d) => ({ ...d, status: 'approved' as DocStatusId, updatedAt: d.dueDate }));
  }
  const map = overlay || {};
  return list.map((d) =>
    map[d.docId]
      ? {
          ...d,
          status: map[d.docId],
          updatedAt: map[d.docId] === 'required' ? null : addDays(d.dueDate, -2),
        }
      : d,
  );
}

/* ==========================================================================
   7. STORE — live state, persisted so the lifecycle is clickable
   ========================================================================== */

let WOFS: Wof[] = [];
let version = 0;
const listeners = new Set<() => void>();

/** React subscribes here; every mutation bumps the version. */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export const getVersion = (): number => version;

function emit(): void {
  version += 1;
  listeners.forEach((fn) => fn());
}

interface SavedState {
  v: number;
  savedAt: string;
  /**
   * The seed offset in force when this was written.
   *
   * Saved records hold absolute dates. If the seed were re-anchored underneath
   * them — by `reanchor()`, or by a browser whose stored anchor was cleared —
   * the two would be in different time frames, and the symptom would be a WOF
   * quietly pointing at an event a week away from where its own dates say it
   * is. Cheaper to discard state written under a different offset than to
   * reason about which of the two frames a given field belongs to.
   */
  shift?: number;
  wofs: Wof[];
  /**
   * Events seeded from a WOF at the order stage.
   *
   * These have to be saved with the WOFs, not left in memory. A WOF stores
   * `eventId`, and that pointer was being persisted while the event it pointed
   * at was not — so after a reload the job still claimed to have shifts, the
   * staffing screen could not find them, and "Open staffing" landed on whatever
   * happened to be first in the seed data.
   */
  events?: EpEvent[];
}

/** Events that exist because a WOF created them, rather than shipping in the seed. */
const seededEvents = (): EpEvent[] => EVENTS.filter((e) => String(e.id).startsWith('ev-wof-'));

/**
 * Ids that ship in the seed literals.
 *
 * Filled on load and used by `deletable()` to tell a job raised in this browser
 * from one that `load()` will rebuild whatever the store says. Derived from
 * `seed()` rather than hardcoded as a range, so adding a seed record cannot
 * accidentally make it deletable.
 */
const SEEDED_IDS = new Set<string>();

export function load(): Wof[] {
  const seeded = seed();
  seeded.forEach((w) => SEEDED_IDS.add(w.id));
  let saved: SavedState | null = null;
  try {
    saved = JSON.parse(localStorage.getItem(SCHEMA) || 'null');
  } catch {
    saved = null; // private mode
  }

  // v3 and v4 predate the moving clock and stored seed-time dates that the
  // seed no longer uses. v5 stamps the offset; anything written under a
  // different one is from another time frame and cannot be overlaid. See
  // `SavedState.shift`.
  const usable =
    !!saved &&
    ((saved.v === 3 || saved.v === 4) ? SHIFT_DAYS === 0 : saved.v === 5 && saved.shift === SHIFT_DAYS);

  if (usable && saved && Array.isArray(saved.events)) {
    saved.events.forEach((ev) => {
      if (!EVENTS.some((x) => x.id === ev.id)) EVENTS.push(ev);
    });
  }

  if (usable && saved && Array.isArray(saved.wofs)) {
    // Overlay only the mutable fields so seed improvements still land.
    const byId = new Map(saved.wofs.map((w) => [w.id, w]));
    WOFS = seeded.map((w) => {
      const s = byId.get(w.id);
      if (!s) return w as Wof;
      return {
        ...w,
        stage: s.stage,
        lines: s.lines || w.lines,
        documents: s.documents || w.documents,
        signoff: s.signoff !== undefined ? s.signoff : w.signoff,
        deposit: s.deposit !== undefined ? s.deposit : w.deposit,
        // Stamped when the job became an order, in this browser or in the seed.
        // Left off this list once, and every history entry derived from it
        // vanished on reload for jobs ordered here.
        orderedAt: s.orderedAt !== undefined ? s.orderedAt : w.orderedAt,
        kitPrep: s.kitPrep !== undefined ? s.kitPrep : w.kitPrep,
        picking: s.picking !== undefined ? s.picking : w.picking,
        invoice: s.invoice !== undefined ? s.invoice : w.invoice,
        eventId: s.eventId !== undefined ? s.eventId : w.eventId,
        notes: s.notes !== undefined ? s.notes : w.notes,
        // Event info is operator-editable, so saved values win.
        jobCode: s.jobCode !== undefined ? s.jobCode : w.jobCode,
        departmentId: s.departmentId !== undefined ? s.departmentId : w.departmentId,
        venue: s.venue !== undefined ? s.venue : w.venue,
        postcode: s.postcode !== undefined ? s.postcode : w.postcode,
        staffMeetingPoint:
          s.staffMeetingPoint !== undefined ? s.staffMeetingPoint : w.staffMeetingPoint,
        active: s.active !== undefined ? s.active : w.active,
        staffCalendarVisible:
          s.staffCalendarVisible !== undefined ? s.staffCalendarVisible : w.staffCalendarVisible,
        history: s.history || [],
      } as Wof;
    });
    // Any WOF created since the last load.
    saved.wofs.filter((s) => !seeded.some((w) => w.id === s.id)).forEach((s) => WOFS.push(s));
  } else {
    WOFS = seeded as Wof[];
  }

  // Heal any WOF pointing at an event that is not there — saved under v3,
  // before seeded events were persisted. Better a job that honestly has no
  // shifts than one holding a dead reference.
  WOFS.forEach((w) => {
    if (w.eventId && !eventById(w.eventId)) w.eventId = null;
  });

  // Fill event-info fields on seeds and on anything saved under an older schema.
  WOFS.forEach(normaliseEventInfo);

  // Backfill the audit trail for stages that were already passed at seed time.
  WOFS.forEach((w) => {
    if (!w.history || !w.history.length) w.history = backfillHistory(w);
  });

  // Keep the schedule <-> WOF link consistent in both directions.
  EVENT_SCHEDULE.forEach((s) => {
    s.wofId = null;
  });
  WOFS.forEach((w) => {
    if (w.scheduleId) {
      const s = scheduleById(w.scheduleId);
      if (s) s.wofId = w.id;
    }
  });

  emit();
  return WOFS;
}

function backfillHistory(w: Wof): HistoryEntry[] {
  const h: HistoryEntry[] = [];
  const add = (st: WofStage, at: string | null, by?: string, note?: string) => {
    if (at) h.push({ stage: st, at, by: by || w.raisedBy, note: note || '' });
  };
  add('wof', w.raisedAt, w.raisedBy, 'WOF raised');
  add('quote', w.quotedAt, w.ownerId, 'Quote priced and sent to client');
  if (w.signoff)
    add('signoff', w.signoff.signedAt, w.ownerId, `Signed by ${w.signoff.signedBy} via ${w.signoff.method}`);
  add('order', w.orderedAt, w.ownerId, 'Order confirmed — event seeded to the calendar');
  if (atLeast(w, 'documents') && w.orderedAt)
    add('documents', addDays(w.orderedAt, 1), w.ownerId, 'Document checklist opened');
  if (w.picking && w.picking.pushedAt)
    add('picking', w.picking.pushedAt, 'm-pete', `Kit list pushed to Hire Hop (${w.picking.hireHopRef})`);
  if (atLeast(w, 'job')) add('job', w.start, 'm-jake', 'Job started on site');
  if (w.invoice) add('invoice', w.invoice.issuedAt, 'm-fd', `Invoice ${w.invoice.number} raised`);
  if (w.stage === 'complete' && w.invoice && w.invoice.paidAt)
    add('complete', w.invoice.paidAt, 'm-fd', 'Invoice settled — job closed');
  return h.sort((a, b) => +new Date(a.at) - +new Date(b.at));
}

export function save(): void {
  try {
    localStorage.setItem(
      SCHEMA,
      JSON.stringify({
        v: 5,
        savedAt: new Date().toISOString(),
        shift: SHIFT_DAYS,
        wofs: WOFS,
        events: seededEvents(),
      }),
    );
  } catch {
    /* storage full or blocked — prototype degrades to in-memory */
  }
  emit();
}

export function reset(): void {
  try {
    localStorage.removeItem(SCHEMA);
  } catch {
    /* ignore */
  }
  // Drop events that were seeded from WOFs so the demo returns to baseline.
  for (let i = EVENTS.length - 1; i >= 0; i--) {
    if (String(EVENTS[i].id).startsWith('ev-wof-')) EVENTS.splice(i, 1);
  }
  load();
}

/* ==========================================================================
   8. MUTATIONS — every one of them writes history
   ========================================================================== */

function record(
  w: Wof,
  entry: Partial<HistoryEntry> & { stage: WofStage; note: string },
  actor: Actor = OPERATOR,
): void {
  w.history = (w.history || []).concat([
    { at: new Date(NOW).toISOString(), by: actor.by, byName: actor.name, ...entry },
  ]);
}

export interface AdvanceResult {
  ok: boolean;
  gate: Gate;
  stage?: WofStage;
}

export function advance(
  w: Wof,
  opts: { to?: WofStage; force?: boolean; note?: string } = {},
  actor: Actor = OPERATOR,
): AdvanceResult {
  const g = gate(w, opts.to);
  if (!g.ok && !opts.force) return { ok: false, gate: g };
  const to = g.target!;

  if (to === 'order') {
    seedEvent(w);
    // The date the job became real. Every backfilled history entry from
    // `documents` onward is derived from it, and it was previously set only in
    // the seed literals — so a job ordered in the browser had a blank where the
    // seeded ones had a date.
    if (!w.orderedAt) w.orderedAt = new Date(NOW).toISOString();
  }
  if (to === 'invoice' && !w.invoice) {
    const cl = clientById(w.clientId);
    w.invoice = {
      number: `INV-26-${String(500 + WOFS.filter((x) => x.invoice).length).padStart(4, '0')}`,
      issuedAt: new Date(NOW).toISOString(),
      dueAt: addDays(NOW, (cl && cl.termsDays) || 30),
      paidAt: null,
    };
  }

  w.stage = to;
  record(
    w,
    {
      stage: to,
      note: opts.note || `Moved to ${stage(to)?.label || TERMINAL[to as TerminalId]?.label || to}`,
      overrides: g.warn.length ? g.warn : undefined,
    },
    actor,
  );
  save();
  return { ok: true, gate: g, stage: to };
}

/* ------------------------------------------------------------ stepping back */

export interface RevertPreview {
  from: WofStage;
  to: WofStage;
  /** Side effects a step back does NOT undo, named so nobody assumes it did. */
  keeps: string[];
}

const stageLabel = (s: WofStage): string =>
  stage(s)?.label ?? TERMINAL[s as TerminalId]?.label ?? s;

function previousStage(w: Wof): WofStage | null {
  // Reopening a closed job is a step back from complete to invoice.
  if (w.stage === 'complete') return 'invoice';
  // Lost and cancelled are decisions, not positions. Reinstating one is a
  // different act from correcting a mis-click, and it is not this.
  if (isTerminal(w.stage)) return null;
  const i = stageIndex(w.stage);
  return i > 0 ? STAGES[i - 1].id : null;
}

/**
 * What stepping back would do, and — more usefully — what it would NOT.
 *
 * A stage is a marker, not a transaction log. Moving it backwards does not
 * un-seed an event that already has people assigned to it, un-sign a signature,
 * or un-raise an invoice number. Saying so before the operator commits is the
 * difference between a correction and a mess.
 */
export function revertPreview(w: Wof): RevertPreview | null {
  const to = previousStage(w);
  if (!to) return null;

  const keeps: string[] = [];
  if (w.eventId) {
    const ev = eventById(w.eventId);
    const cov = ev ? eventCoverage(ev) : null;
    keeps.push(
      cov && cov.assigned
        ? `The event stays on the calendar, with ${countLabel(cov.assigned, 'assignment')} on it`
        : 'The event stays on the calendar',
    );
  }
  if (w.signoff)
    keeps.push(`The signature stays recorded — ${w.signoff.signedBy}, ${fmtDate(w.signoff.signedAt)}`);
  if (deposit(w).received > 0)
    keeps.push(`The deposit of ${money(deposit(w).received)} stays recorded as received`);
  if (w.picking) keeps.push(`Hire Hop still holds list ${w.picking.hireHopRef}`);
  else if (w.kitPrep)
    keeps.push(
      `The prepared kit list stays — ${countLabel(w.kitPrep.manifest.length, 'line')} held for the warehouse`,
    );
  if (w.invoice)
    keeps.push(`Invoice ${w.invoice.number} stays raised${w.invoice.paidAt ? ' and paid' : ''}`);

  return { from: w.stage, to, keeps };
}

/**
 * Move a WOF back one stage. Requires a reason, because a stage that goes
 * backwards without one is indistinguishable from a bug six months later.
 */
export function revertStage(w: Wof, reason: string, actor: Actor = OPERATOR): RevertPreview | null {
  const p = revertPreview(w);
  if (!p) return null;
  w.stage = p.to;
  record(
    w,
    {
      stage: p.to,
      note: `Stepped back from ${stageLabel(p.from)} to ${stageLabel(p.to)} — ${reason.trim()}`,
      // The side effects that survived are recorded too, so the trail explains
      // why an event still exists for a job that is no longer an order.
      overrides: p.keeps.length ? p.keeps : undefined,
    },
    actor,
  );
  save();
  return p;
}

export function addLine(w: Wof, chargeId: string, cfg: LineConfig = {}): LineItem {
  const isVariation = atLeast(w, 'signoff') && !!w.signoff;
  const during = isVariation && new Date(w.start) <= NOW && NOW <= new Date(w.end);
  const l = line(chargeId, {
    ...cfg,
    pricedAt: cfg.pricedAt || new Date(NOW).toISOString(),
    addedAt: new Date(NOW).toISOString(),
    source: isVariation ? 'variation' : 'quote',
    duringEvent: during,
  });
  w.lines.push(l);
  record(w, {
    stage: w.stage,
    note: `${isVariation ? 'Variation' : 'Quote line'} added: ${l.description} — ${money(lineValue(l))}${during ? ' (added during the event)' : ''}`,
  });
  save();
  return l;
}

export function removeLine(w: Wof, lineId: string): boolean {
  const i = w.lines.findIndex((l) => l.id === lineId);
  if (i < 0) return false;
  const [l] = w.lines.splice(i, 1);
  record(w, { stage: w.stage, note: `Line removed: ${l.description} (${money(lineValue(l))})` });
  save();
  return true;
}

/** Explicit, audited re-pricing. Never automatic. */
export function repriceLine(w: Wof, lineId: string): boolean {
  const l = w.lines.find((x) => x.id === lineId);
  if (!l) return false;
  const before = lineValue(l);
  l.snap = rateAt(l.chargeId, NOW);
  record(w, {
    stage: w.stage,
    note: `Line re-priced to the current rate card: ${l.description}, ${money(before)} → ${money(lineValue(l))}`,
  });
  save();
  return true;
}

export function setDocStatus(
  w: Wof,
  docId: string,
  status: DocStatusId,
  note?: string,
  actor: Actor = OPERATOR,
): boolean {
  const d = (w.documents || []).find((x) => x.docId === docId);
  if (!d) return false;
  const was = d.status;
  d.status = status;
  d.updatedAt = new Date(NOW).toISOString();
  if (note != null) d.note = note;
  record(
    w,
    {
      stage: w.stage,
      note: `Document “${docType(docId)?.label || docId}”: ${DOC_STATUS[was].label} → ${DOC_STATUS[status].label}`,
    },
    actor,
  );
  save();
  return true;
}

/* ------------------------------------------------- confirmation and its wake */

/**
 * What a client's signature actually set in motion, so the caller can say so
 * rather than announcing "signed" and leaving the operator to go and look.
 */
export interface Confirmation {
  signoff: Signoff;
  /** The staffing event, seeded or already present. Null on a kit-only job. */
  event: EpEvent | null;
  /** Shifts on that event — one per day of the run. */
  shifts: number;
  /** Role slots across every shift: what the staffing tool now has to fill. */
  roles: number;
  /** Kit lines held for the warehouse. Null on a staff-only job. */
  kit: KitPrep | null;
  kitItems: number;
  /** True when the signature moved the job to `order` on its own. */
  ordered: boolean;
  /** Why it did not, when it did not. */
  blocked: string[];
}

/**
 * The signature is the event. Everything downstream of it happens here.
 *
 * Briefing §2.2: "Once a WOF has passed client sign off and becomes an order,
 * it will seed the event calendar and subsequently provide shifts for the staff
 * allocation tool." That sentence describes one act, and the system was
 * implementing it as three — sign, then click to sign-off, then click to order
 * — with the seeding hidden behind the third click. A job could sit signed and
 * unstaffed for as long as nobody remembered to advance it, which is precisely
 * the gap the whole rebuild exists to close.
 *
 * So a signature now walks the stage to `order` itself, through `signoff`
 * rather than over it, so the audit trail keeps both moments. It seeds the
 * staffing event and prepares the kit list on the way.
 *
 * `force` is not used. If a gate blocks the walk the job stops where it is and
 * the reason comes back in `blocked` — a signature is a fact about the client,
 * not a licence to skip a check about us.
 */
export function confirmOrder(w: Wof, actor: Actor = OPERATOR): Confirmation {
  const blocked: string[] = [];

  // Walk the stages one at a time. Jumping straight to `order` would leave no
  // `signoff` entry in the history, and "when did they sign" is the first
  // question asked of any disputed job.
  while (!atLeast(w, 'order') && !isTerminal(w.stage)) {
    const next = nextStage(w);
    if (!next) break;
    const r = advance(
      w,
      {
        to: next,
        note:
          next === 'order'
            ? `Order confirmed automatically on ${w.signoff ? `${w.signoff.signedBy}'s` : 'the client’s'} signature`
            : undefined,
      },
      actor,
    );
    if (!r.ok) {
      blocked.push(...r.gate.block);
      break;
    }
  }

  const ordered = atLeast(w, 'order');

  // Seeding is idempotent and safe to call on a job that already has an event
  // — it returns the existing one. Calling it outside `advance` as well means a
  // job whose staff lines were added after it was ordered still gets a rota.
  const ev = ordered ? ensureStaffingEvent(w, {}, actor) : null;
  const shifts = ev ? ev.shifts.length : 0;
  const roles = ev ? ev.shifts.reduce((s, sh) => s + sh.splits.length, 0) : 0;

  const kit = ordered ? prepareKit(w, { source: 'confirmation' }, actor) : null;
  const kitItems = kit ? kit.manifest.reduce((s, l) => s + l.qty, 0) : 0;

  save();
  return { signoff: w.signoff!, event: ev, shifts, roles, kit, kitItems, ordered, blocked };
}

/**
 * What confirming this WOF would create, without creating any of it.
 *
 * Shown before the signature is recorded, because "7 shifts and 41 roles" is a
 * number an operator can check against the quote in front of them, and finding
 * out afterwards means deleting a rota rather than fixing a line.
 *
 * `seedShifts` is pure — it builds an array and returns it — so the preview and
 * the real thing are computed by the same code rather than by an estimate that
 * drifts from it.
 */
export interface OrderPreview {
  shifts: number;
  roles: number;
  kitLines: number;
  kitItems: number;
  /** True when the event already exists, so nothing new would be seeded. */
  alreadySeeded: boolean;
}

export function orderPreview(w: Wof): OrderPreview {
  const existing = w.eventId ? eventById(w.eventId) : null;
  const staffLines = w.lines.filter((l) => l.kind === 'staff');
  const shifts = existing
    ? existing.shifts
    : staffLines.length
      ? seedShifts(w, `ev-wof-${w.id.replace('wof-', '')}`, staffLines)
      : [];
  const kit = kitLines(w);
  return {
    shifts: shifts.length,
    roles: shifts.reduce((s, sh) => s + sh.splits.length, 0),
    kitLines: kit.length,
    kitItems: kit.reduce((s, l) => s + l.qty, 0),
    alreadySeeded: !!existing,
  };
}

/**
 * One sentence naming what the signature created, for the toast that follows
 * it. Written once so the operator's screen and the client portal cannot
 * describe the same act differently.
 */
export function describeConfirmation(c: Confirmation): string {
  if (!c.ordered) {
    return c.blocked.length
      ? `Signature recorded, but the job is not an order yet — ${c.blocked.join(' ')}`
      : 'Signature recorded.';
  }

  const made: string[] = [];
  if (c.shifts)
    made.push(`${countLabel(c.shifts, 'shift')} and ${countLabel(c.roles, 'role')} to fill`);
  if (c.kit) made.push(`${countLabel(c.kit.manifest.length, 'kit line')} (${c.kitItems} items) prepared for the warehouse`);

  if (!made.length) return 'Order confirmed. Nothing to roster or pick on this job.';
  return `Order confirmed — ${made.join(', and ')}.`;
}

/**
 * Record the client's signature, and let it do what a signature does.
 *
 * Returns the `Signoff` as it always did, so existing callers are unaffected.
 * Callers that want to report what the signature created read `lastConfirmation`
 * from the same call via `signQuoteAndConfirm`.
 */
export function signQuote(
  w: Wof,
  {
    signedBy,
    signedByRole,
    method,
  }: { signedBy: string; signedByRole?: string; method?: string },
  actor: Actor = OPERATOR,
): Signoff {
  return signQuoteAndConfirm(w, { signedBy, signedByRole, method }, actor).signoff;
}

/** As `signQuote`, but hands back everything the signature set in motion. */
export function signQuoteAndConfirm(
  w: Wof,
  {
    signedBy,
    signedByRole,
    method,
  }: { signedBy: string; signedByRole?: string; method?: string },
  actor: Actor = OPERATOR,
): Confirmation {
  w.signoff = {
    signedBy,
    signedByRole: signedByRole || 'Authorised signatory',
    signedAt: new Date(NOW).toISOString(),
    method: method || 'DocuSign',
    ref: `DS-${Math.floor(4000 + Math.random() * 900)}-${w.id.slice(-3)}`,
    ip: '—',
  };
  record(
    w,
    {
      stage: w.stage,
      note: `Quote signed by ${signedBy} via ${w.signoff.method} — ${money(quoteValue(w))}`,
    },
    actor,
  );
  save();
  return confirmOrder(w, actor);
}

export function recordDeposit(
  w: Wof,
  { amount, ref }: { amount?: number; ref?: string },
  actor: Actor = OPERATOR,
): DepositRecord {
  const dep = deposit(w);
  w.deposit = {
    ...(w.deposit || {}),
    pct: dep.pct,
    amount: amount ?? dep.due,
    receivedAt: new Date(NOW).toISOString(),
    ref: ref || 'Manual entry',
  };
  record(
    w,
    { stage: w.stage, note: `Deposit received: ${money(w.deposit.amount)} (${w.deposit.ref})` },
    actor,
  );
  save();
  return w.deposit;
}

/* ---------------------------------------------------- kit to the warehouse */

export const kitLines = (w: Wof): LineItem[] => w.lines.filter((l) => l.kind === 'kit');

const toPickedLine = (l: LineItem): PickedLine => ({
  lineId: l.id,
  description: l.description,
  qty: l.qty,
  units: l.units,
});

/**
 * The next free Hire Hop reference.
 *
 * Sequential and checked against every reference already issued, rather than
 * random. A random number in a 900-wide range collides at about a 5% rate over
 * thirty jobs, and two jobs sharing a warehouse reference is exactly the class
 * of bug that produced the duplicate `YYY` client codes.
 */
function nextHireHopRef(): string {
  const used = new Set(WOFS.map((x) => x.picking?.hireHopRef).filter(Boolean));
  let n = 9000;
  while (used.has(`HH-2026-${n}`)) n++;
  return `HH-2026-${n}`;
}

/** What was on the list when it was last sent. */
export function pushedManifest(w: Wof): PickedLine[] {
  const p = w.picking;
  if (!p) return [];
  if (p.manifest) return p.manifest;
  // Records seeded before the manifest existed: reconstruct it from the lines
  // that existed at the moment of the push. Anything added later — a variation
  // raised on site — is correctly reported as a change the warehouse has not
  // seen.
  return kitLines(w)
    .filter((l) => new Date(l.addedAt) <= new Date(p.pushedAt))
    .map(toPickedLine);
}

export interface KitChange {
  kind: 'added' | 'removed' | 'changed';
  description: string;
  /** Total units before and after, for a quantity change. */
  from?: number;
  to?: number;
}

/**
 * Line-by-line difference between a manifest and the kit as it stands now.
 *
 * One implementation, two callers: drift since the warehouse was told
 * (`kitChangesSincePush`) and drift since the list was built on confirmation
 * (`kitChangesSincePrep`). They are the same question asked of two different
 * baselines, and answering it twice is how the two would disagree.
 */
function diffKit(before: PickedLine[], now: LineItem[]): KitChange[] {
  const was = new Map(before.map((p) => [p.lineId, p]));
  const out: KitChange[] = [];

  now.forEach((l) => {
    const b = was.get(l.id);
    if (!b) {
      out.push({ kind: 'added', description: l.description, to: l.qty * l.units });
    } else if (b.qty !== l.qty || b.units !== l.units) {
      out.push({
        kind: 'changed',
        description: l.description,
        from: b.qty * b.units,
        to: l.qty * l.units,
      });
    }
  });

  was.forEach((p) => {
    if (!now.some((l) => l.id === p.lineId)) {
      out.push({ kind: 'removed', description: p.description, from: p.qty * p.units });
    }
  });

  return out;
}

/**
 * What has moved on the kit list since the warehouse was last told. This is the
 * number that matters at stage 6: a picked list that is one variation out of
 * date is how a client gets billed for four tower lights and receives two.
 */
export function kitChangesSincePush(w: Wof): KitChange[] {
  if (!w.picking) return [];
  return diffKit(pushedManifest(w), kitLines(w));
}

/**
 * What has moved since the list was built on confirmation. Nothing has been
 * sent yet at this point, so this is not an error — it is the office seeing
 * that the job it confirmed and the job it is about to pick are not the same
 * job, while there is still time for that to be free.
 */
export function kitChangesSincePrep(w: Wof): KitChange[] {
  if (!w.kitPrep) return [];
  return diffKit(w.kitPrep.manifest, kitLines(w));
}

/**
 * Build (or rebuild) the kit list held in the office.
 *
 * Deliberately does NOT assign a Hire Hop reference — see `KitPrep`. Rebuilding
 * keeps `preparedAt` and moves `updatedAt`, so "when did we first know" and
 * "when did this last change" stay separable.
 *
 * Returns null when there is no kit on the job at all. A staff-only job has
 * nothing to pick, and an empty manifest sitting on the picking screen reading
 * "0 lines prepared" is the same lie as an empty rota reading "fully staffed".
 */
export function prepareKit(
  w: Wof,
  opts: { source?: KitPrep['source'] } = {},
  actor: Actor = OPERATOR,
): KitPrep | null {
  const kit = kitLines(w);
  if (!kit.length) return null;

  // Once the list has gone to Hire Hop the prep is history. The baseline that
  // matters from then on is what the warehouse holds, and rebuilding the prep
  // would give the picking screen two competing answers to "what changed" —
  // the same class of failure as two warehouse references for one job.
  if (w.picking) return w.kitPrep ?? null;

  const at = new Date(NOW).toISOString();
  const changes = w.kitPrep ? kitChangesSincePrep(w) : [];
  const first = !w.kitPrep;
  if (!first && !changes.length) return w.kitPrep!;

  w.kitPrep = {
    preparedAt: w.kitPrep?.preparedAt ?? at,
    updatedAt: at,
    manifest: kit.map(toPickedLine),
    source: opts.source || w.kitPrep?.source || 'manual',
  };

  record(
    w,
    {
      stage: w.stage,
      note: first
        ? `Kit list prepared for the warehouse — ${countLabel(kit.length, 'line')}, ${kit.reduce((s, l) => s + l.qty, 0)} items. Not yet sent to Hire Hop.`
        : `Prepared kit list updated — ${changes.map(describeChange).join('; ')}`,
    },
    actor,
  );
  save();
  return w.kitPrep;
}

const describeChange = (c: KitChange): string =>
  c.kind === 'added'
    ? `added ${c.description}`
    : c.kind === 'removed'
      ? `removed ${c.description}`
      : `${c.description} ${c.from} → ${c.to}`;

/**
 * Send the kit list to the warehouse, or re-send an amended one.
 *
 * The reference is assigned once and kept. A re-send bumps the version, moves
 * `lastSyncAt`, and records WHAT CHANGED rather than just that something did —
 * "re-sent" tells Pete's team nothing they can pick against.
 */
export function pushToHireHop(w: Wof, actor: Actor = OPERATOR): Picking {
  const kit = kitLines(w);
  const items = kit.reduce((s, l) => s + l.qty, 0);
  const at = new Date(NOW).toISOString();
  const changes = kitChangesSincePush(w);
  const first = !w.picking;

  w.picking = {
    hireHopRef: w.picking?.hireHopRef ?? nextHireHopRef(),
    pushedAt: w.picking?.pushedAt ?? at,
    lastSyncAt: at,
    version: (w.picking?.version ?? 1) + (first ? 0 : 1),
    status: first
      ? 'Sent to warehouse'
      : changes.length
        ? 'Amended — re-pick required'
        : 'Re-sent, unchanged',
    manifest: kit.map(toPickedLine),
  };

  record(
    w,
    {
      stage: w.stage,
      note: first
        ? `Kit list sent to Hire Hop (${w.picking.hireHopRef}) — ${countLabel(kit.length, 'line')}, ${items} items`
        : changes.length
          ? `Kit list re-sent to Hire Hop (${w.picking.hireHopRef} v${w.picking.version}) — ${changes.map(describeChange).join('; ')}`
          : `Kit list re-sent to Hire Hop (${w.picking.hireHopRef} v${w.picking.version}) — unchanged, ${countLabel(kit.length, 'line')}`,
    },
    actor,
  );
  save();
  return w.picking;
}



export function markInvoicePaid(w: Wof, actor: Actor = OPERATOR): boolean {
  if (!w.invoice) return false;
  w.invoice.paidAt = new Date(NOW).toISOString();
  record(w, { stage: w.stage, note: `Invoice ${w.invoice.number} settled` }, actor);
  if (w.stage === 'invoice') {
    w.stage = 'complete';
    record(w, { stage: 'complete', note: 'Job closed' }, actor);
  }
  save();
  return true;
}

/* ==========================================================================
   8b. CLIENT-SIDE MUTATIONS
   --------------------------------------------------------------------------
   The same store, written from the other side of the relationship. Three rules
   hold across all of them:

     · The actor is the client, and the history says so. An audit trail that
       claims EP Team signed the client's own quote is worse than none.
     · A client can only touch what is genuinely theirs — their own documents,
       their own variations, their own money. `clientCanTouch()` is the guard,
       and the pages never get handed a WOF that fails it.
     · Nothing here skips a stage. Signing makes the WOF *eligible* to become an
       order; an operator still moves it, because seeding shifts is EP Team's
       call, not the client's.
   ========================================================================== */

/** Guard: is this WOF actually this client's to act on? */
export const clientCanTouch = (w: Wof | null | undefined, clientId: string): boolean =>
  !!w && w.clientId === clientId && !isTerminal(w.stage);

/** Variations the client has not yet responded to. */
export const pendingVariations = (w: Wof): LineItem[] =>
  variationLines(w).filter((l) => (l.clientApproval ?? 'pending') === 'pending');

export const queriedVariations = (w: Wof): LineItem[] =>
  variationLines(w).filter((l) => l.clientApproval === 'queried');

export function acceptVariation(w: Wof, lineId: string, actor: Actor): boolean {
  const l = w.lines.find((x) => x.id === lineId && x.source === 'variation');
  if (!l) return false;
  l.clientApproval = 'accepted';
  l.clientNote = '';
  record(
    w,
    {
      stage: w.stage,
      note: `Variation accepted by the client: ${l.description} — ${money(lineValue(l))}`,
    },
    actor,
  );
  save();
  return true;
}

export function queryVariation(w: Wof, lineId: string, note: string, actor: Actor): boolean {
  const l = w.lines.find((x) => x.id === lineId && x.source === 'variation');
  if (!l) return false;
  l.clientApproval = 'queried';
  l.clientNote = note.trim();
  record(
    w,
    {
      stage: w.stage,
      note: `Variation queried by the client: ${l.description} — ${money(lineValue(l))}. “${note.trim()}”`,
    },
    actor,
  );
  save();
  return true;
}

/** Checklist items the client is responsible for producing. */
export const clientDocs = (w: Wof): WofDocView[] =>
  docState(w).docs.filter((d) => d.owner === 'Client');

/**
 * A client upload lands as SUBMITTED, never approved. EP Compliance approves —
 * letting the client mark their own document approved would make the checklist
 * a self-certification and the report meaningless.
 */
export function clientSubmitDoc(w: Wof, docId: string, note: string, actor: Actor): boolean {
  const d = (w.documents || []).find((x) => x.docId === docId);
  if (!d || d.owner !== 'Client') return false;
  d.status = 'submitted';
  d.updatedAt = new Date(NOW).toISOString();
  if (note.trim()) d.note = note.trim();
  record(
    w,
    {
      stage: w.stage,
      note: `${docType(docId)?.label || docId} supplied by the client — awaiting EP Compliance approval`,
    },
    actor,
  );
  save();
  return true;
}

/* ==========================================================================
   8c. WHAT IS THIS JOB WAITING ON FROM THE CLIENT
   --------------------------------------------------------------------------
   One function, called by the client's job list, the job detail and the rail
   badge, so the three cannot disagree about whether the client owes anything.
   ========================================================================== */

export type ClientTaskId = 'sign' | 'deposit' | 'documents' | 'variations' | 'invoice';

export interface ClientTask {
  id: ClientTaskId;
  label: string;
  detail: string;
  tone: Tone;
  /** Present when the task is a payment. */
  amount?: number;
  /** Present when the task covers several items. */
  count?: number;
  /** Present when there is a deadline the client can miss. */
  dueAt?: string | null;
  overdue?: boolean;
}

export function clientTasks(w: Wof): ClientTask[] {
  const out: ClientTask[] = [];
  // A closed job asks nothing of anybody. That includes `complete`: chasing a
  // site plan for an event that has run and been paid for is noise, and it
  // would leave the client's to-do list permanently non-empty.
  if (isTerminal(w.stage)) return out;

  // 1. Sign the quote. Only once there is something priced to sign.
  if (!w.signoff && quoteLines(w).length) {
    out.push({
      id: 'sign',
      label: 'Sign the quote',
      detail: `${quoteLines(w).length} priced lines totalling ${money(quoteValue(w), { pence: false })}.`,
      tone: 'critical',
      amount: quoteValue(w),
    });
  }

  // 2. Pay the deposit — only after signing, because before that there is no
  //    agreed figure to take a percentage of.
  const dep = deposit(w);
  if (w.signoff && dep.due > 0 && dep.outstanding > 0) {
    out.push({
      id: 'deposit',
      label: `Pay the ${dep.pct}% deposit`,
      detail: `${money(dep.due, { pence: false })} due before kit and staff are released.`,
      tone: 'atRisk',
      amount: dep.outstanding,
    });
  }

  // 3. Documents the client owes — but only once they have signed. Due dates
  //    are worked back from the event date, so an unsigned enquiry can already
  //    have a "late" purchase order against it. Chasing paperwork for a job
  //    nobody has committed to is how a portal trains people to ignore it.
  const docs = w.signoff ? clientDocs(w).filter((d) => d.status !== 'approved') : [];
  if (docs.length) {
    const waiting = docs.filter((d) => d.status === 'submitted');
    // Only what the client still owes can be late *at them*. A document they
    // sent is late in our queue, not theirs, and telling them it is overdue
    // when it is sitting with our Compliance team is a straight untruth.
    const overdue = docs.filter((d) => d.overdue && d.status === 'required');
    const toSend = docs.length - waiting.length;
    out.push({
      id: 'documents',
      label: overdue.length
        ? `${overdue.length} document${overdue.length > 1 ? 's are' : ' is'} overdue`
        : toSend
          ? 'Send us your documents'
          : 'Your documents are with us',
      detail: overdue.length
        ? `${overdue.map((d) => d.label).join(', ')} — past the date we need ${overdue.length > 1 ? 'them' : 'it'} by.`
        : toSend
          ? `${toSend} still to send${waiting.length ? `, ${waiting.length} with us for checking` : ''}.`
          : `${waiting.length === 1 ? 'It is' : 'All ' + waiting.length + ' are'} with us for checking — nothing for you to do.`,
      tone: overdue.length ? 'critical' : toSend ? 'atRisk' : 'info',
      count: docs.length,
      dueAt: docs.map((d) => d.dueDate).sort()[0] ?? null,
      overdue: overdue.length > 0,
    });
  }

  // 4. Variations raised since sign-off that the client has not answered.
  const vars = pendingVariations(w);
  if (vars.length) {
    out.push({
      id: 'variations',
      label: `Approve ${vars.length} change${vars.length > 1 ? 's' : ''} to the job`,
      detail: `${money(vars.reduce((s, l) => s + lineValue(l), 0), { pence: false })} of extra work added since you signed.`,
      tone: 'atRisk',
      count: vars.length,
      amount: vars.reduce((s, l) => s + lineValue(l), 0),
    });
  }

  // 5. Settle the invoice.
  if (w.invoice && !w.invoice.paidAt) {
    const overdue = new Date(w.invoice.dueAt) < NOW;
    out.push({
      id: 'invoice',
      label: overdue ? `Invoice ${w.invoice.number} is overdue` : `Pay invoice ${w.invoice.number}`,
      detail: `${money(round2(contractValue(w) - dep.due), { pence: false })} due ${new Date(w.invoice.dueAt).toDateString().slice(4)}.`,
      tone: overdue ? 'critical' : 'atRisk',
      amount: round2(contractValue(w) - dep.due),
      dueAt: w.invoice.dueAt,
      overdue,
    });
  }

  return out;
}

/**
 * What the client sees as the state of the job, in their language rather than
 * the operator's eight-stage lifecycle. A client does not care that a job is at
 * "picking"; they care that it is confirmed and being prepared.
 */
export interface ClientStatus {
  id: string;
  label: string;
  tone: Tone;
  blurb: string;
}

export function clientStatus(w: Wof): ClientStatus {
  if (w.stage === 'lost' || w.stage === 'cancelled')
    return { id: 'closed', label: TERMINAL[w.stage].label, tone: 'neutral', blurb: 'This job is not going ahead.' };
  if (w.stage === 'complete')
    return { id: 'complete', label: 'Complete', tone: 'healthy', blurb: 'Delivered, invoiced and settled.' };
  if (w.invoice)
    return {
      id: 'invoiced', label: 'Invoiced', tone: w.invoice.paidAt ? 'healthy' : 'atRisk',
      blurb: w.invoice.paidAt ? 'Paid, thank you.' : 'The job has run and the invoice is with you.',
    };
  if (atLeast(w, 'job'))
    return { id: 'running', label: 'In delivery', tone: 'info', blurb: 'Your event is being staffed and delivered.' };
  if (atLeast(w, 'order'))
    return { id: 'confirmed', label: 'Confirmed', tone: 'healthy', blurb: 'Booked in. We are preparing kit and staff.' };
  if (w.signoff)
    return { id: 'signed', label: 'Signed', tone: 'info', blurb: 'Signed and with EP Team to confirm.' };
  if (quoteLines(w).length)
    return { id: 'quoted', label: 'Quote ready', tone: 'critical', blurb: 'Priced and waiting on your signature.' };
  return { id: 'preparing', label: 'Being prepared', tone: 'neutral', blurb: 'We are putting your quote together. Nothing needed from you yet.' };
}

export interface CreateConfig {
  scheduleId?: string | null;
  jobCode?: string;
  title?: string;
  clientId?: string;
  jobTypeId?: string;
  office?: string;
  departmentId?: string;
  ownerId?: string;
  start?: string;
  end?: string;
  venue?: string;
  postcode?: string | null;
  staffMeetingPoint?: string | null;
  active?: boolean;
  staffCalendarVisible?: boolean;
  notes?: string;
}

export function create(cfg: CreateConfig): Wof {
  const n = 112 + WOFS.filter((w) => w.id.startsWith('wof-1')).length;
  const sch = cfg.scheduleId ? scheduleById(cfg.scheduleId) : null;
  const ref = `WOF-2026-0${n}`;
  const jobTypeId = cfg.jobTypeId || (sch ? sch.type : 'sports');
  const start = cfg.start || (sch ? sch.start : new Date(NOW).toISOString());
  const w: Wof = {
    id: `wof-${n}`,
    ref,
    // Job code is EP's own job reference, so it IS the WOF reference. One job,
    // one number. Editable only to preserve a legacy code during migration.
    jobCode: cfg.jobCode || ref,
    title: cfg.title || (sch ? sch.name : 'New work order'),
    clientId: cfg.clientId || (sch ? sch.clientId : CLIENTS[0].id),
    scheduleId: cfg.scheduleId || null,
    eventId: null,
    jobTypeId,
    office: cfg.office || 'EP Event Services',
    departmentId: cfg.departmentId || defaultDepartment(jobTypeId),
    ownerId: cfg.ownerId || (sch ? sch.ownerId : 'm-colin'),
    raisedBy: 'm-jake',
    start,
    end: cfg.end || (sch ? sch.end : new Date(NOW).toISOString()),
    venue: cfg.venue || (sch ? sch.venue : ''),
    postcode: cfg.postcode || null,
    staffMeetingPoint: cfg.staffMeetingPoint || null,
    active: cfg.active !== false,
    staffCalendarVisible: cfg.staffCalendarVisible !== false,
    stage: 'wof',
    raisedAt: new Date(NOW).toISOString(),
    quotedAt: null,
    orderedAt: null,
    signoff: null,
    deposit: { pct: null, amount: null, receivedAt: null, ref: null },
    lines: [],
    documents: buildChecklist(jobTypeId, start),
    picking: null,
    invoice: null,
    history: [],
    notes: cfg.notes || '',
  };
  record(w, { stage: 'wof', note: `WOF raised · job code ${w.jobCode}` });
  WOFS.push(w);
  if (sch) sch.wofId = w.id;
  save();
  return w;
}

/* --------------------------------------------------------------- deleting */

/**
 * Applications live in `portal.ts`, which imports this module. Importing it
 * back would close the cycle, so the key is named here instead. Kept next to
 * `remove()` so the two are read together — if the portal ever renames its
 * store, this is the line that has to move with it.
 */
const KEY_APPS = 'epteam.applications';

export interface Deletable {
  ok: boolean;
  reason: string;
  /** What removing this WOF also destroys, named before the operator commits. */
  destroys: string[];
}

/**
 * May this WOF be deleted, and what goes with it?
 *
 * Only jobs raised in this browser. `load()` rebuilds `WOFS` from the seed
 * array on every boot, so deleting a seeded WOF removes it until the next
 * reload and no further — an undo the operator did not ask for and would not
 * notice until the job reappeared. Rather than fake permanence with a
 * tombstone list, the action is simply not offered: a seeded job is demo
 * furniture, and `cancel` is the honest way to take one out of the pipeline.
 *
 * Deletion is destructive by design. This is the escape hatch for a job raised
 * in error — a mis-keyed test record, a duplicate — not a lifecycle stage.
 * Anything with real history behind it should be cancelled, which keeps the
 * audit trail. That judgement belongs to the operator, so the consequences are
 * listed rather than used to block.
 */
export function deletable(w: Wof | null | undefined): Deletable {
  if (!w) return { ok: false, reason: 'No work order', destroys: [] };

  // Seeded ids are assigned in the seed literals; `create()` starts at 112.
  const raisedHere = SEEDED_IDS.has(w.id) === false;
  if (!raisedHere)
    return {
      ok: false,
      reason:
        'This job ships with the seeded pipeline. Deleting it would only hide it until the next reload — cancel it instead.',
      destroys: [],
    };

  const destroys: string[] = [];
  const ev = w.eventId ? eventById(w.eventId) : null;

  if (ev) {
    const splits = ev.shifts.reduce((n, sh) => n + sh.splits.length, 0);
    const assigned = ev.shifts.reduce(
      (n, sh) => n + sh.splits.reduce((m, sp) => m + (sp.assignments || []).length, 0),
      0,
    );
    destroys.push(
      `The staffing event "${ev.name}" — ${countLabel(splits, 'role')} across ${countLabel(ev.shifts.length, 'shift')}`,
    );
    if (assigned)
      destroys.push(
        `${countLabel(assigned, 'worker')} already assigned to those shifts, and any applications against them`,
      );
    const att = ATTENDANCE.filter((a) => a.eventId === ev.id).length;
    if (att) destroys.push(`${countLabel(att, 'settled attendance row')} — hours already logged against this job`);
  }

  if (w.invoice) destroys.push(`Invoice ${w.invoice.number}, and the number is not reissued`);
  if (w.signoff) destroys.push(`The client's signature from ${fmtDate(w.signoff.signedAt)}`);
  if (w.deposit && w.deposit.receivedAt)
    destroys.push(`A recorded deposit of ${money(w.deposit.amount || 0)}`);
  if (w.scheduleId) destroys.push('The link to its calendar entry — the entry itself survives, unclaimed');
  destroys.push(`${countLabel((w.history || []).length, 'history entry')} — the whole audit trail for this job`);

  return { ok: true, reason: 'Raised in this browser, so it can be removed for good', destroys };
}

/**
 * Delete a WOF and everything that only existed because of it.
 *
 * Order matters. The event goes first, because attendance and applications are
 * keyed on the event id and there is no way to find them once it is gone.
 * Returns false rather than throwing when the job is not deletable, so a stale
 * menu click is a no-op rather than a crash.
 */
export function remove(w: Wof | null | undefined): boolean {
  if (!w || !deletable(w).ok) return false;

  if (w.eventId) {
    const evId = w.eventId;

    // Settled hours for the event. Kept in the shared seed array, so they are
    // spliced rather than filtered — other modules hold the same reference.
    for (let i = ATTENDANCE.length - 1; i >= 0; i--) {
      if (ATTENDANCE[i].eventId === evId) ATTENDANCE.splice(i, 1);
    }

    // Worker applications against the event's splits.
    try {
      const raw = JSON.parse(localStorage.getItem(KEY_APPS) || '[]');
      if (Array.isArray(raw)) {
        localStorage.setItem(
          KEY_APPS,
          JSON.stringify(raw.filter((a: { eventId?: string }) => a && a.eventId !== evId)),
        );
      }
    } catch {
      /* private mode — applications degrade to in-memory anyway */
    }

    const i = EVENTS.findIndex((e) => e.id === evId);
    if (i >= 0) EVENTS.splice(i, 1);
  }

  // Release the calendar entry so it shows as awaiting a WOF again, which is
  // what it was before this job claimed it.
  if (w.scheduleId) {
    const sch = scheduleById(w.scheduleId);
    if (sch && sch.wofId === w.id) sch.wofId = null;
  }

  const i = WOFS.findIndex((x) => x.id === w.id);
  if (i < 0) return false;
  WOFS.splice(i, 1);

  save();
  return true;
}

/* ==========================================================================
   EVENT INFO — the fields the live system collects on event creation
   --------------------------------------------------------------------------
   Taken from the existing EPROSTA "Event Info" form. Four notes on how they are
   modelled here rather than there:

   1. JOB CODE is EP's own job reference, so it is the WOF reference. The live
      form asks an operator to type it, which is how you get duplicates and
      typos — the same failure that produced the `YYY` and `ZZZ` client codes.

   2. MANAGER and the WOF owner are the same person, so there is one field. Two
      fields for one concept is how the old system ended up with five words for
      "the people on a shift".

   3. STAFF CALENDAR VISIBILITY is stored positively. The live form pairs a
      label reading "Hide from Staff Calendar" with a toggle reading "Visible",
      a double negative an operator has to decode under time pressure.

   4. POSTCODE is not decoration. It is what lets the worker app say "14 miles
      away", which every competitor puts on the shift card.
   ========================================================================== */

const DEPT_BY_JOB_TYPE: Record<string, string> = {
  festival: 'Stewarding', sports: 'Stewarding', show: 'Stewarding',
  'road-race': 'Traffic & Car Park', corporate: 'Hospitality', venue: 'Security',
};

export const defaultDepartment = (jt: string): string => DEPT_BY_JOB_TYPE[jt] || 'Stewarding';

/** Venue detail for the seeded jobs, keyed on their schedule entry. */
const VENUE_DETAIL: Record<string, { postcode: string; meet: string }> = {
  'sch-1':  { postcode: 'OX7 3EH', meet: 'Steward cabin, Main Car Park Gate C' },
  'sch-2':  { postcode: 'SE19 2GA', meet: 'Production compound, North Gate' },
  'sch-3':  { postcode: 'HA9 0AA', meet: 'Taxi rank marshal point, Arena Square' },
  'sch-4':  { postcode: 'SO30 3XH', meet: 'Staff entrance, Gate 4' },
  'sch-5':  { postcode: 'GU11 1TW', meet: 'Main pavilion' },
  'sch-6':  { postcode: 'SO30 3XH', meet: 'Staff entrance, Gate 4' },
  'sch-7':  { postcode: 'L9 5AS', meet: 'Steeplechase Enclosure staff gate' },
  'sch-8':  { postcode: 'AL3 4SW', meet: 'Start line marshal tent, Verulamium Park' },
  'sch-9':  { postcode: 'SO24 0NA', meet: 'Showground office' },
  'sch-10': { postcode: 'SL5 7JX', meet: 'Staff gate, Ascot Racecourse' },
  'sch-13': { postcode: 'SW19 5AE', meet: 'Gate 4, Church Road' },
  'sch-h1': { postcode: 'SO30 3XH', meet: 'Staff entrance, Gate 4' },
  'sch-h2': { postcode: 'SW19 5AE', meet: 'Car park control, Somerset Road' },
  'sch-h3': { postcode: 'L9 5AS', meet: 'Steeplechase Enclosure staff gate' },
  'sch-h4': { postcode: 'AL3 4SW', meet: 'Park keeper\'s lodge' },
};

/**
 * Fill the event-info fields on any WOF that predates them — both seed records
 * and anything already saved in a browser. Cheaper and safer than editing
 * thirteen seed literals, and a stored WOF from an older schema version
 * upgrades cleanly rather than rendering blanks.
 */
export function normaliseEventInfo(w: Wof): Wof {
  const sch = w.scheduleId ? scheduleById(w.scheduleId) : null;
  const detail = (w.scheduleId && VENUE_DETAIL[w.scheduleId]) || ({} as { postcode?: string; meet?: string });
  if (!w.jobCode) w.jobCode = w.ref;
  if (!w.departmentId) w.departmentId = defaultDepartment(w.jobTypeId);
  if (w.active === undefined) w.active = w.stage !== 'lost' && w.stage !== 'cancelled';
  if (w.staffCalendarVisible === undefined) w.staffCalendarVisible = atLeast(w, 'order');
  if (!w.postcode) w.postcode = detail.postcode || null;
  if (!w.staffMeetingPoint) w.staffMeetingPoint = detail.meet || null;
  if (!w.venue && sch) w.venue = sch.venue;
  return w;
}

/**
 * Is this job code already taken? Job codes must be unique or two jobs
 * reconcile into one on any report that groups by code.
 */
export function jobCodeInUse(code: string, exceptId?: string): boolean {
  const c = String(code || '').trim().toLowerCase();
  if (!c) return false;
  return WOFS.some((w) => w.id !== exceptId && String(w.jobCode || '').toLowerCase() === c);
}

/**
 * Can workers see this job's shifts?
 *
 * Three conditions, and all three have to hold. This is the rule that the live
 * system's "Hide from Staff Calendar" toggle half-implements: it can hide a
 * job, but nothing stops an unsigned job being visible in the first place. Here
 * the default is derived from the lifecycle and the toggle is an override.
 */
export function visibleToWorkers(w: Wof | null | undefined): { visible: boolean; reason: string } {
  if (!w) return { visible: false, reason: 'No work order' };
  if (w.active === false) return { visible: false, reason: 'Job marked inactive' };
  if (!atLeast(w, 'order'))
    return { visible: false, reason: 'Not yet an order — the client has not signed' };
  if (w.staffCalendarVisible === false)
    return { visible: false, reason: 'Hidden from the staff calendar by an operator' };
  return { visible: true, reason: 'Confirmed order, visible to workers' };
}

/* ==========================================================================
   9. CROSS-CUTTING QUERIES — what the reports actually call
   ========================================================================== */

export const all = (): Wof[] => WOFS;
export const byId = (id: string | null | undefined): Wof | undefined =>
  WOFS.find((w) => w.id === id);
export const byEvent = (evId: string | null | undefined): Wof | undefined =>
  WOFS.find((w) => w.eventId === evId);
export const bySchedule = (schId: string | null | undefined): Wof | undefined =>
  WOFS.find((w) => w.scheduleId === schId);

/**
 * Every job belonging to one client, newest first.
 *
 * Deliberately NOT filtered by stage. The client portal shows a job from the
 * moment it is raised — a client who can see "we are putting your quote
 * together" does not ring up to ask whether anyone has started. What changes by
 * stage is what they can DO, and that is `clientTasks()`, not visibility.
 *
 * Lost and cancelled jobs are excluded: they are not the client's business
 * once EP Team has closed them.
 */
export const byClient = (clientId: string): Wof[] =>
  WOFS.filter((w) => w.clientId === clientId && w.stage !== 'lost' && w.stage !== 'cancelled').sort(
    (a, b) => +new Date(a.start) - +new Date(b.start),
  );

/** Every client with at least one live job — the switcher's picker list. */
export const clientsWithWork = (): string[] => [
  ...new Set(WOFS.filter((w) => w.stage !== 'lost' && w.stage !== 'cancelled').map((w) => w.clientId)),
];

export interface CalendarRow {
  scheduleId: string | null;
  schedule: (typeof EVENT_SCHEDULE)[number] | null;
  wof: Wof | null;
  event: EpEvent | null;
  name: string;
  clientId: string;
  venue: string;
  type: string;
  start: string;
  end: string;
  ownerId: string;
  status: CalendarStatus;
  coverage: ReturnType<typeof eventCoverage> | null;
  docs: DocState | null;
  wofDueBy: string | null;
  wofOverdue: boolean;
  value: number | null;
}

/** Every calendar row: known events, with or without a WOF. */
export function calendarRows(): CalendarRow[] {
  const rows: CalendarRow[] = EVENT_SCHEDULE.map((s) => {
    const w = (s.wofId ? byId(s.wofId) : bySchedule(s.id)) || null;
    const st = calendarStatus(w);
    const ev = w && w.eventId ? eventById(w.eventId) || null : null;
    const cov = ev ? eventCoverage(ev) : null;
    const ds = w ? docState(w) : null;
    // The trigger date belongs to the REGISTER — it is "this event happens
    // annually in September, raise the paperwork 21 days out" — so it is worked
    // back from the schedule's own date, not from whatever the WOF says.
    const wofDueBy = addDays(s.start, -s.leadDays);
    return {
      scheduleId: s.id, schedule: s, wof: w, event: ev,
      // Once a WOF exists it OWNS the job. The schedule entry is the standing
      // expectation — "Rushden home fixtures, fortnightly" — but the moment
      // somebody raises and names an actual job against it, that name, those
      // dates and that venue are the truth. Reading the register instead is how
      // the calendar ends up calling a job something nobody else calls it.
      name: w?.title || s.name,
      clientId: w?.clientId || s.clientId,
      venue: w?.venue || s.venue,
      type: w?.jobTypeId || s.type,
      start: w?.start || s.start,
      end: w?.end || s.end,
      ownerId: w?.ownerId || s.ownerId,
      status: st, coverage: cov, docs: ds,
      wofDueBy,
      wofOverdue: !w && new Date(wofDueBy) < NOW,
      value: w ? contractValue(w) : null,
    };
  });
  // WOFs raised without a schedule entry still belong on the calendar.
  WOFS.filter((w) => !w.scheduleId).forEach((w) => {
    rows.push({
      scheduleId: null, schedule: null, wof: w,
      event: w.eventId ? eventById(w.eventId) || null : null,
      name: w.title, clientId: w.clientId, venue: w.venue, type: w.jobTypeId,
      start: w.start, end: w.end, ownerId: w.ownerId,
      status: calendarStatus(w), coverage: null, docs: docState(w),
      wofDueBy: null, wofOverdue: false, value: contractValue(w),
    });
  });
  return rows.sort((a, b) => +new Date(a.start) - +new Date(b.start));
}

/** Every timesheet row across every WOF — the payroll report's source. */
export const allTimesheets = (): (Timesheet & { wof: Wof })[] =>
  WOFS.flatMap((w) => timesheets(w).map((t) => ({ ...t, wof: w })));

/** Employees are needed by `historic()`; re-exported so pages have one import. */
export { EMPLOYEES };

load();
