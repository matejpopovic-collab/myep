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
  ATTENDANCE, CLIENTS, DEFAULT_CARD, EMPLOYEES, EVENTS, EVENT_SCHEDULE, NOW,
  charge as chargeById, client as clientById, docType, employee as employeeById,
  event as eventById, jobType, manager as managerById, rateAt,
  schedule as scheduleById, tieredCharge,
} from '@/data/db';
import { SHIFT_DAYS, shiftDeep, shiftISO } from '@/data/clock';
import type {
  AttendanceOutcome, ChargeKind, ChargeUnit, EpEvent, EventLocation, ResolvedRate, Split, Tone,
} from '@/data/types';
import { addDays, countLabel, fmtDate, money, round2, timing } from './format';
import { eventCoverage } from './coverage';
import * as RATES from './rates';

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

/* ============================================================================
   DEPLOYMENTS — where a line stands, when, and how many on each day
   ----------------------------------------------------------------------------
   A row on a real EP quote is `role x place x time window x headcount per day`.
   `LineItem` carried the role and a rate and nothing else, so the day was
   recovered by running a regex over the description — see the note that used to
   sit on `spanWindows`, and the description parse this replaces.

   Measured from the Reading Festival 2025 quote, 129 staffed rows:

     · 258 start and end times typed by hand, behind them 36 distinct windows.
       TWELVE of those cover 70% of every row on the sheet.
     · `06:00-15:00` is used at 12 different places, `17:00-02:00` at 9.
     · Car Park Steward alone is 38 rows over 12 windows and 16 location labels.
     · Of 34 location labels, 13 are really PLACE + WINDOW — "Green Triangle"
       and "Green Triangle - Nights" are one car park — and two more ("Days",
       "Nights") are only a window, with no place in them at all.

   So the window is not a property of a line. It is a small library the job
   reuses, and the free-text Location column was doing two jobs because the
   spreadsheet had one column and two facts to put in it.
   ========================================================================== */

/**
 * A NAMED time window, reusable across the whole job.
 *
 * The times live here once, not on every deployment that picks them, so
 * correcting an end time fixes every line that uses it in a single edit.
 */
export interface ShiftPattern {
  id: string;
  /** "Early", "Nights", "Long day" — how the operation already talks. */
  name: string;
  /** `HH:mm`. */
  start: string;
  /** `HH:mm`. `end <= start` is an overnight and closes the next morning. */
  end: string;
  /**
   * `company` patterns seed every new job; `job` ones were added on this quote.
   * The picker offers job patterns first, then company, then a custom window.
   */
  scope: 'company' | 'job';
}

/**
 * A named place on the job — "Alley Farm", "Green Triangle".
 *
 * Lives on the `Wof`, NOT on `EpEvent`. `seedEvent` only runs at the order
 * stage, three stages after an operator is typing this in, and it synthesises
 * exactly ONE location from `w.venue` — so a festival with eleven car parks
 * reached the staffing tool as one location called "Richfield Avenue".
 * `seedEvent` now maps this register across instead of inventing one.
 */
export interface Place {
  id: string;
  name: string;
  /** Free text — becomes the worker's meeting-point note on the shift. */
  note: string;
}

/**
 * Where and when a group of quote lines is deployed.
 *
 * Shared by every role standing in the same place, in the same window, on the
 * same days. Shared rather than copied so the grid can group on `patternId`
 * instead of comparing three fields a later edit can desynchronise.
 */
export interface LinePattern {
  id: string;
  /** The sheet's colour banding — "White — Maple Durham". Groups the grid. */
  area: string;
  /** Into `Wof.places`. `null` is legitimate: road closures have no one place. */
  placeId: string | null;
  /** Into `Wof.shiftPatterns`. */
  shiftPatternId: string;
  /**
   * 1-based day numbers into the job's span, ascending and unique.
   *
   * Per pattern, not per deployment: at Lilley Farm the early cover starts in
   * the build and the nights stop before the last event day, and one shared day
   * list would silently flatten that.
   */
  days: number[];
}

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
  /**
   * Into `Wof.patterns`. Absent on every line raised before deployments
   * shipped, and on kit and services, which have no shift.
   */
  patternId?: string;
  /**
   * Headcount per day, aligned index-for-index with the pattern's `days`.
   *
   * A zero is allowed and meaningful — it holds a column open in the grid while
   * an operator works out the number.
   */
  perDay?: number[];
  /**
   * KIT ONLY — which days of the span the item is actually on hire, 1-based
   * and inclusive.
   *
   * Absent means the whole span, which is the right default and needs no
   * backfill: a barrier delivered on the build day and collected after
   * breakdown is out for the lot. Where that is wrong — a tower light wanted on
   * the two event days only — this narrows it.
   *
   * The same coordinate system as `LinePattern.days` on purpose, so a date
   * change remaps through `remapDay` rather than a second implementation of the
   * same arithmetic, and so `liveWindow`'s build/event/breakdown vocabulary
   * reads across without translation. Raw, and possibly out of range after a
   * date change — read it through `hireWindow`, never directly.
   *
   * This is NOT a deployment. A radio is not standing anywhere at 06:00, and
   * nothing in `deploymentBlock` / `linesForWork` / `splitForAttendance` knows
   * about it.
   */
  hire?: { from: number; to: number };
  /**
   * KIT ONLY — EP does not own this one for this job; it comes from a supplier.
   *
   * Draws no stock, so it can never be short. Not a workaround for the Order
   * gate but the thing EP actually does, written down: the alternative to
   * reducing a line is buying the difference in.
   */
  subHire?: boolean;
  /**
   * KIT AND SERVICES ONLY - where on site this thing sits.
   *
   * Not a deployment and not a pattern. `LinePattern` answers "who stands
   * where, in which window, on which days"; a radio is not standing anywhere
   * at 06:00 and a traffic management plan is not standing anywhere at all.
   * But both are bought FOR a place - twelve radios at Alley Farm, forty
   * barriers on the Blue car park - and the deployment builder is where an
   * operator says so.
   *
   * So this is the place stamp WITHOUT the window: the one fact kit shares
   * with the stewards beside it. `area` is copied rather than referenced
   * because it is free text on the pattern too, and `placeId` is nullable for
   * the same reason it is there: "across the site" is a real answer.
   *
   * Absent on everything added through the add-line dialog, which is
   * unchanged - kit with no placement is job-wide kit, exactly as before.
   */
  placement?: { area: string; placeId: string | null };
  /** Variations only: where the client has got to with it. */
  clientApproval?: ClientApproval;
  /** What the client said when they queried it. */
  clientNote?: string;
}

export interface LineConfig {
  id?: string;
  /**
   * The account this line is being priced FOR.
   *
   * Without it a line resolves the published rate, which is what every line
   * quoted before client pricing existed did — so leaving it off is a real
   * default, not a missing argument. Every runtime path that creates a line
   * has a WOF in hand and passes `w.clientId`; the seed does not, and its
   * lines are therefore published-rate lines, which is what they were.
   */
  clientId?: string | null;
  /**
   * Price this line AT a rate already resolved, instead of resolving one.
   *
   * For the case where a new line is not a new sale: overtime on a shift that
   * was sold months ago is billed at the rate that shift was sold at, not at
   * whatever the account is on today. Re-resolving there would quietly bill an
   * hour of the same steward's time at a different price than the hour before
   * it, which is a conversation nobody wants to have with a client holding the
   * timesheet.
   */
  snap?: ResolvedRate | null;
  description?: string;
  qty?: number;
  units?: number;
  source?: LineSource;
  pricedAt?: string;
  addedAt?: string;
  addedBy?: string;
  duringEvent?: boolean;
  note?: string;
  patternId?: string;
  perDay?: number[];
  /** Kit only. See `LineItem.hire`; seed data sets it, `setHire` maintains it. */
  hire?: { from: number; to: number };
  /** Kit only. See `LineItem.subHire`. */
  subHire?: boolean;
  /** Kit and services only. See `LineItem.placement`. */
  placement?: { area: string; placeId: string | null };
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
   *
   * New references read `EPH-2026-nnnn`. Ones issued under the old Hire Hop
   * integration keep their `HH-` prefix VERBATIM — see `normaliseWof`. A
   * reference the warehouse has already picked against is not ours to
   * renumber, and a migration that rewrites live paperwork is the same class
   * of error as issuing a second reference for one job.
   */
  epHopRef: string;
  /** The pre-EP-HOP spelling. Read only by `normaliseWof`, never written. */
  hireHopRef?: string;
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
 * A picking record issued under the old Hire Hop integration.
 *
 * The reference carries over UNTOUCHED — `HH-2026-8841` stays `HH-2026-8841`.
 * Renumbering live paperwork the warehouse has already picked against would
 * be the same class of error as issuing a second reference for one job, and a
 * migration is not an excuse for it. New jobs get `EPH-`; that the two
 * prefixes coexist is what a real migration looks like.
 */
const legacyPicking = (p: Omit<Picking, 'epHopRef'> & { hireHopRef: string }): Picking => ({
  ...p,
  epHopRef: p.hireHopRef,
});

/**
 * The kit list as it stood the moment the client confirmed the job — built
 * automatically, held in the office, NOT yet sent to EP HOP.
 *
 * This exists because "the warehouse knows what is coming" and "the warehouse
 * has been given a list to pick against" are two different facts, and the
 * system only had a word for the second one. Preparing on confirmation gives
 * Pete's team the lead time they were previously getting by reading over
 * somebody's shoulder; withholding the EP HOP reference until the real push
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
  splitId?: string;
  scheduled?: string;
  date: string;
  role: string;
  hours: number;
  outcome?: AttendanceOutcome;
  approvedBy?: string;
  sourceId?: string;
}

export interface Timesheet {
  wofId: string;
  /** The rostered position this was worked against, where it can be named. */
  splitId: string | null;
  /**
   * The quote lines that sold that position. Empty when the hour cannot be
   * attributed — which the variance report shows as unattributed rather than
   * quietly dropping.
   */
  lineIds: string[];
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
  /**
   * First and last EVENT day of the span, 1-based. Days before `liveFrom` are
   * build days, days after `liveTo` are breakdown. Absent means the whole span
   * is the event. Read through `liveWindow`, never directly — these are raw
   * and may be out of range after a date change.
   */
  liveFrom?: number;
  liveTo?: number;
  venue: string;
  postcode: string | null;
  staffMeetingPoint: string | null;
  active: boolean;
  staffCalendarVisible: boolean;
  stage: WofStage;
  raisedAt: string;
  /**
   * When the quote was SENT to the client — not when it was priced. Null means
   * EP Team is still working it up and the client cannot see the job at all.
   * See `sendQuote`.
   */
  quotedAt: string | null;
  /**
   * The quote total at the moment it was sent, and the lines it consisted of.
   *
   * Both, because they answer different halves of "has this changed since we
   * sent it". The total catches a repriced line, which adds and removes
   * nothing; the id list names which lines came and went, which a total cannot.
   * Ids rather than timestamps because `NOW` is a fixed clock — every line
   * added in a session carries the same `addedAt` as the send itself, so a
   * comparison of times finds nothing.
   */
  quotedValue?: number | null;
  quotedLineIds?: string[];
  /**
   * The senior manager's approval to send a quote over
   * `QUOTE_APPROVAL_THRESHOLD`, the request that is waiting on one, and the
   * refusal that sent it back. At most one of the three is set at a time —
   * see `requestQuoteApproval`. All optional: a job priced before this shipped
   * has none of them, and under the threshold none is ever written.
   */
  quoteApproval?: QuoteApproval | null;
  quoteApprovalRequest?: QuoteApprovalRequest | null;
  quoteApprovalRefusal?: QuoteApprovalRefusal | null;
  /**
   * Every version of the quote and of the variation schedule, oldest first.
   * The paper trail — see `issueVersion`. One entry per document actually
   * sent, and nothing else. Optional because a job that has never been sent
   * has none at all.
   */
  quoteVersions?: QuoteVersion[];
  /**
   * Edits to priced lines made since the last document went out — the
   * material of the next one, and unseen by the client until somebody sends
   * it. See `noteChange`.
   */
  quotePending?: PendingChange[];
  orderedAt: string | null;
  signoff: Signoff | null;
  deposit: DepositRecord | null;
  lines: LineItem[];
  /**
   * The deployment registers. All three optional: every job raised before this
   * shipped has none of them, and `normaliseWof` defaults them on load.
   */
  shiftPatterns?: ShiftPattern[];
  patterns?: LinePattern[];
  places?: Place[];
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
    requirement: 'Draws from table of charges and stock list; pushes to EP HOP.' },
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
  // Through the client's card and price list when there is an account in hand,
  // and the published rate when there is not. `rateFor` is the only place the
  // order of precedence is written down — see `lib/rates.ts`. An explicit
  // `snap` bypasses all of it; see the note on `LineConfig.snap`.
  const snap =
    cfg.snap !== undefined ? cfg.snap : RATES.rateFor(chargeId, cfg.clientId, shiftISO(pricedAt));
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
    // `qty` and `units` above are placeholders on a patterned line — the real
    // values are derived from the deployment by `syncDerived`, which needs the
    // WOF this line is about to be pushed onto and so cannot run here.
    ...(cfg.patternId ? { patternId: cfg.patternId, perDay: cfg.perDay || [] } : {}),
    // Kit only, and only when narrower than the whole span — the absence of
    // `hire` is what "out for the whole job" means, so writing a full-span
    // window here would store the same fact twice. `units` is derived from it
    // by `syncDerived` once the line has a WOF to resolve against.
    ...(cfg.hire ? { hire: cfg.hire } : {}),
    ...(cfg.subHire ? { subHire: true } : {}),
    ...(cfg.placement ? { placement: { ...cfg.placement } } : {}),
  };
}

/**
 * True when a line belongs in the flat quote table rather than the deployment
 * grid: job-wide kit and services, and anything quoted before deployments
 * shipped.
 *
 * The complement of what `deployments()` draws, and exported so the two cannot
 * drift. A line that is in neither list is invisible on the quote screen while
 * still being charged for; a line in both is billed once and read twice.
 */
export const isFlatLine = (l: LineItem): boolean => !l.patternId && !l.placement;

/**
 * Where a line sits, however it got there.
 *
 * Staff read it off their pattern, kit and services off their placement, and
 * everything quoted flat reads `null`. One reader so the quote table, the
 * client document and the deployment grid cannot disagree about which car park
 * a barrier is on.
 */
export function linePlacement(
  w: Wof,
  l: LineItem,
): { area: string; placeId: string | null } | null {
  const pat = linePattern(w, l);
  if (pat) return { area: pat.area, placeId: pat.placeId };
  return l.placement ? { area: l.placement.area, placeId: l.placement.placeId } : null;
}

export const lineRate = (l: LineItem): number => tieredCharge(l.snap, l.qty);
export const lineValue = (l: LineItem): number => round2(l.qty * l.units * lineRate(l));
export const lineCost = (l: LineItem): number =>
  round2(l.qty * l.units * (l.snap ? l.snap.cost : 0));

/* -------------------------------------------------- deployment arithmetic ---
   Everything on the right of a quote row falls out of the four facts on the
   left:

     shifts = SUM(perDay)
     hours  = shifts x duration
     value  = hours  x rate

   `qty` and `units` are DERIVED from that, not replaced by it — see
   `syncDerived`. Every money function above stays exactly as it was.
   ------------------------------------------------------------------------ */

/** How long one shift on a named window runs, in hours. Overnight-aware. */
export function patternHours(sp: ShiftPattern | null | undefined): number {
  if (!sp) return 0;
  const [sh, sm] = sp.start.split(':').map(Number);
  const [eh, em] = sp.end.split(':').map(Number);
  if ([sh, sm, eh, em].some((n) => !Number.isFinite(n))) return 0;
  let mins = eh * 60 + em - (sh * 60 + sm);
  // A window closing at or before it opens is a night shift, not a negative
  // one. 17:00-02:00 is nine hours; reading it as -15 priced a steward at a
  // credit and made the line vanish from the quote total.
  if (mins <= 0) mins += 1440;
  return round2(mins / 60);
}

/** The named window a line was sold against, or `null` when it has none. */
export function lineWindow(w: Wof, l: LineItem): ShiftPattern | null {
  const pat = linePattern(w, l);
  if (!pat) return null;
  return (w.shiftPatterns || []).find((sp) => sp.id === pat.shiftPatternId) || null;
}

/** The deployment a line belongs to, or `null` for a legacy line. */
export function linePattern(w: Wof, l: LineItem): LinePattern | null {
  if (!l.patternId) return null;
  return (w.patterns || []).find((p) => p.id === l.patternId) || null;
}

/**
 * Total shifts a line sells — the sheet's SHIFTS column.
 *
 * `qty` on an unpatterned line, which is what it has always meant there.
 */
export function lineShifts(w: Wof, l: LineItem): number {
  const pat = linePattern(w, l);
  if (!pat || !l.perDay) return l.qty;
  // Only days the pattern actually names. A `perDay` longer than `days` is a
  // half-written record; counting the overhang would bill days off the end of
  // the job.
  return pat.days.reduce((n, _d, i) => n + (l.perDay![i] || 0), 0);
}

/** Total hours a line sells — shifts x the length of one shift. */
export function lineHours(w: Wof, l: LineItem): number {
  const sp = lineWindow(w, l);
  if (!sp) return round2(l.qty * l.units);
  return round2(lineShifts(w, l) * patternHours(sp));
}

/**
 * Push a patterned line's totals into the two fields the money layer reads.
 *
 * `qty` becomes total SHIFTS, not headcount, and `units` the length of one
 * shift. That is not a compromise — it is what those fields already meant:
 * `lineValue` is `qty x units x rate`, and 60 steward-shifts of 9 hours is
 * exactly what a festival sells. Keeping `qty` as the shift count also keeps
 * `tieredCharge(l.snap, l.qty)` reading the same number it always did, so a
 * volume tier earned before this change is still earned after it.
 *
 * Called on every mutation of `perDay`, of the pattern a line points at, or of
 * the window that pattern picked. Never called from the UI.
 */
export function syncDerived(w: Wof, l: LineItem): LineItem {
  // Kit has no pattern and no headcount, but it does have a window, and
  // `units` is a count of days on hire. Derived here rather than typed, the
  // same trick the staff branch below plays with shifts and hours: one number
  // instead of two that can disagree.
  if (l.kind === 'kit') {
    if (l.hire) {
      const h = hireWindow(w, l);
      l.units = h.to - h.from + 1;
    }
    return l;
  }
  const pat = linePattern(w, l);
  const sp = lineWindow(w, l);
  if (!pat || !sp || !l.perDay) return l;
  // Kept in step with the days it belongs to, so the two can never disagree:
  // an array cannot drift out of alignment with a list it is re-cut against.
  if (l.perDay.length !== pat.days.length) {
    l.perDay = pat.days.map((_d, i) => l.perDay![i] || 0);
  }
  l.qty = lineShifts(w, l);
  l.units = patternHours(sp);
  return l;
}

/** Re-derive every patterned line on a job. Cheap; call it after any edit. */
export function syncAllDerived(w: Wof): void {
  (w.lines || []).forEach((l) => syncDerived(w, l));
}

/**
 * True when the table of charges has moved on since this line was priced.
 *
 * Compared against the line's OWN rate card, not against the published one. A
 * job priced on the Preferred card is not stale for being cheaper than the
 * published rate — that is what the card IS — and marking it so would put a
 * re-price prompt on every line of every framework account, which is how a
 * warning stops being read.
 *
 * A line carrying an AGREED price is compared on cost and version only. That
 * price was negotiated and is held on purpose; what is worth watching on those
 * is the margin, and `RATES.staleAgreements` watches it on the client record —
 * the one screen where the agreement can actually be changed.
 */
export function lineIsStale(l: LineItem): boolean {
  if (!l.snap) return false;
  const now = rateAt(l.chargeId, NOW, l.snap.cardId || DEFAULT_CARD);
  if (!now) return false;
  if (now.rateVersion !== l.snap.rateVersion || now.cost !== l.snap.cost) return true;
  return l.snap.basis === 'client' ? false : now.charge !== l.snap.charge;
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
        splitId: a.splitId, scheduled: a.scheduled,
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
  const ev = w.eventId ? eventById(w.eventId) : null;
  const split = ev ? splitForAttendance(ev, t) : null;
  // The split where the roster knows it — it is the record of what was actually
  // asked of this person. Falling back to the quote covers every delivered job
  // that never had an event, which is most of the back catalogue.
  const lineIds = split && (split.lineIds || []).length
    ? split.lineIds!
    : linesForWork(w, t).map((l) => l.id);
  return {
    wofId: w.id,
    splitId: split ? split.id : null,
    lineIds,
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


/* ==========================================================================
   SOLD vs WORKED — the join that makes the quote and the payroll agree
   ----------------------------------------------------------------------------
   Three numbers have always been in this codebase and have never been able to
   talk to each other:

     SOLD      a quote line, through its pattern            (Phase 1)
     ROSTERED  a Split's `required`                         (already existed)
     WORKED    an AttendanceRow, becoming a Timesheet       (already existed)

   The first did not exist as data until deployments shipped, so a timesheet
   could say who worked and when but never WHICH LINE it was worked against.
   `Split.lineIds` closes the first half; this closes the second.
   ========================================================================== */

/** `07:00–19:00` or `07:00-19:00` as a pair, or null. */
function parseWindow(s: string): { start: string; end: string } | null {
  const m = /(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})/.exec(s || '');
  if (!m) return null;
  const pad = (t: string) => (t.length === 4 ? `0${t}` : t);
  return { start: pad(m[1]), end: pad(m[2]) };
}

/**
 * Which rostered position an attendance row was worked against.
 *
 * Exact where the staffing tool recorded it. Everything else — every row in
 * the back catalogue, and anything the tool wrote before splits carried
 * identity — is resolved by the three facts an attendance row does carry:
 * the DAY, the ROLE, and the WINDOW it was scheduled for.
 *
 * The window is what makes this safe. Without it a 17:00-02:00 night steward
 * and an 08:00-16:00 day steward at the same car park on the same date are
 * indistinguishable, and half the hours would land on the wrong line. With it,
 * the only remaining ambiguity is two identical windows for the same role on
 * the same day, which is one deployment sold twice — and those share a split
 * anyway.
 *
 * Returns null rather than guessing. An unattributed hour is visible in the
 * variance report as unattributed; a misattributed one is invisible.
 */
export function splitForAttendance(
  ev: EpEvent,
  row: { date: string; role: string; scheduled?: string; splitId?: string },
): Split | null {
  const all = ev.shifts.flatMap((s) => s.splits);
  if (row.splitId) return all.find((sp) => sp.id === row.splitId) || null;

  const onDay = ev.shifts.filter((s) => (s.start || '').slice(0, 10) === row.date);
  const candidates = onDay.flatMap((s) => s.splits).filter((sp) => sp.role === row.role);
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) return null;

  const want = parseWindow(row.scheduled || '');
  if (!want) return null;
  const matched = candidates.filter((sp) => sp.start === want.start && sp.end === want.end);
  return matched.length === 1 ? matched[0] : null;
}



/**
 * The quote lines an hour of work was worked against.
 *
 * Resolved against the QUOTE, not the roster. The roster is derived from the
 * quote anyway, and going straight to the source means this works for a
 * delivered job that never had an event record - which is most of the back
 * catalogue - as well as for a live one.
 *
 * Three facts are matched, and all three have to agree:
 *
 *   THE DAY     which day of the run the date falls on
 *   THE ROLE    the charge's role, as the rota names it
 *   THE WINDOW  when a scheduled window is recorded
 *
 * The window is what makes this safe. Without it a 17:00-02:00 night steward
 * and an 08:00-16:00 day steward at the same car park on the same date are
 * indistinguishable, and half the hours would land on the wrong line.
 *
 * Returns an empty list rather than guessing when the candidates still differ
 * after the window is applied. An unattributed hour shows up in the variance
 * report as unattributed; a misattributed one is invisible.
 *
 * ONE LIMITATION, worth knowing before trusting a number. An attendance row
 * records no PLACE, so the same role working the same window on the same day at
 * two different car parks cannot be told apart here, and the hours are
 * apportioned across both. Where the job has a real event the `splitId` on the
 * assignment resolves it exactly and this is never reached; it only bites on a
 * delivered job that never had one. The fix is a place on the attendance row,
 * not a cleverer guess.
 */
export function linesForWork(
  w: Wof,
  row: { date: string; role: string; scheduled?: string },
): LineItem[] {
  const windows = spanWindowsOf(w.start, w.end);
  const dayNo = windows.findIndex((win) => localDate(win.start) === row.date) + 1;
  if (!dayNo) return [];

  const candidates = (w.lines || []).filter((l) => {
    if (!l.patternId) return false;
    const role = chargeById(l.chargeId)?.role || l.description;
    if (role !== row.role) return false;
    const pat = linePattern(w, l);
    return !!pat && pat.days.includes(dayNo) && headcountOn(w, l, dayNo) > 0;
  });
  if (candidates.length <= 1) return candidates;

  const want = parseWindow(row.scheduled || '');
  if (!want) return [];
  const matched = candidates.filter((l) => {
    const sp = lineWindow(w, l);
    return !!sp && sp.start === want.start && sp.end === want.end;
  });
  // Still several: the same role, place and window sold on more than one line.
  // Those are genuinely one position and the caller apportions across them.
  return matched;
}

/** `YYYY-MM-DD` for a local date, matching the shape attendance rows carry. */
function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Sold against worked, for one quote line. */
export interface LineVariance {
  line: LineItem;
  area: string;
  place: string;
  window: string;
  soldShifts: number;
  soldHours: number;
  soldValue: number;
  workedShifts: number;
  workedHours: number;
  workedCost: number;
  /** worked - sold. Positive means more hours were paid for than were sold. */
  hoursDelta: number;
}

/**
 * Every deployed line, with what was actually worked against it.
 *
 * Where a split sold more than one line - the same role, place and window
 * quoted twice - the worked hours are apportioned PRO RATA by what each line
 * sold. Attributing them whole to the first line would invent an overrun on one
 * and a saving on the other, and the two would cancel in the total while both
 * rows lied.
 */
export function lineVariance(w: Wof): LineVariance[] {
  const sheets = timesheets(w);

  // What the lines an hour resolved to sold between them, so the hour can be
  // apportioned the way the money was. Keyed on the LINE SET rather than the
  // split: a delivered job has no event and so no split, and keying on a null
  // id put every historic row in the same bucket.
  const soldFor = (ids: string[]): number =>
    ids.reduce((s, id) => {
      const l = w.lines.find((x) => x.id === id);
      return s + (l ? lineHours(w, l) : 0);
    }, 0);

  const worked = new Map<string, { hours: number; cost: number; shifts: number }>();
  sheets.forEach((t) => {
    if (!t.lineIds.length) return;
    const total = soldFor(t.lineIds);
    t.lineIds.forEach((id) => {
      const l = w.lines.find((x) => x.id === id);
      if (!l) return;
      // Pro rata by sold hours; an even split when the split sold nothing,
      // which can only happen if a line was emptied after the roster was built.
      const share = total > 0 ? lineHours(w, l) / total : 1 / t.lineIds.length;
      const acc = worked.get(id) || { hours: 0, cost: 0, shifts: 0 };
      acc.hours += t.hours * share;
      acc.cost += t.gross * share;
      acc.shifts += share;
      worked.set(id, acc);
    });
  });

  return w.lines
    .filter((l) => l.patternId)
    .map((l) => {
      const pat = linePattern(w, l);
      const sp = lineWindow(w, l);
      const place = (w.places || []).find((pl) => pl.id === pat?.placeId);
      const got = worked.get(l.id) || { hours: 0, cost: 0, shifts: 0 };
      const soldHours = lineHours(w, l);
      return {
        line: l,
        area: pat ? pat.area : '',
        place: place ? place.name : 'Across the site',
        window: sp ? `${sp.name} ${sp.start}-${sp.end}` : '',
        soldShifts: lineShifts(w, l),
        soldHours,
        soldValue: lineValue(l),
        workedShifts: Math.round(got.shifts * 10) / 10,
        workedHours: round2(got.hours),
        workedCost: round2(got.cost),
        hoursDelta: round2(got.hours - soldHours),
      };
    });
}

/** Sold against worked, rolled up the way the quote reads. */
export interface DeploymentVariance {
  key: string;
  area: string;
  place: string;
  soldHours: number;
  workedHours: number;
  hoursDelta: number;
  soldValue: number;
  workedCost: number;
  lines: LineVariance[];
}

export function deploymentVariance(w: Wof): DeploymentVariance[] {
  const rows = lineVariance(w);
  const order: string[] = [];
  const byKey = new Map<string, DeploymentVariance>();
  rows.forEach((r) => {
    const key = `${r.area} ${r.place}`;
    if (!byKey.has(key)) {
      order.push(key);
      byKey.set(key, {
        key, area: r.area, place: r.place,
        soldHours: 0, workedHours: 0, hoursDelta: 0, soldValue: 0, workedCost: 0, lines: [],
      });
    }
    const g = byKey.get(key)!;
    g.soldHours = round2(g.soldHours + r.soldHours);
    g.workedHours = round2(g.workedHours + r.workedHours);
    g.hoursDelta = round2(g.hoursDelta + r.hoursDelta);
    g.soldValue = round2(g.soldValue + r.soldValue);
    g.workedCost = round2(g.workedCost + r.workedCost);
    g.lines.push(r);
  });
  return order.map((k) => byKey.get(k)!);
}

/**
 * Hours that were paid for and never sold.
 *
 * The point of the whole chain. A steward who stayed three hours past the end
 * of a shift is money EP has spent and not billed, and the paper process for
 * recovering it is somebody remembering. This finds them, prices them at
 * today's rate, and hands the operator a variation ready to raise.
 *
 * Only overruns. An underrun is a job that came in cheap, not a bill to send.
 */
export interface OvertimeClaim {
  line: LineItem;
  area: string;
  place: string;
  window: string;
  extraHours: number;
  /** What the client would be billed, at the line's own agreed rate. */
  value: number;
  /** Named evidence, so the claim can be justified rather than asserted. */
  workers: { name: string; date: string; hours: number }[];
}

export function overtimeClaims(w: Wof, minHours = 1): OvertimeClaim[] {
  const sheets = timesheets(w);
  return lineVariance(w)
    .filter((r) => r.hoursDelta >= minHours)
    .map((r) => ({
      line: r.line,
      area: r.area,
      place: r.place,
      window: r.window,
      extraHours: r.hoursDelta,
      value: round2(r.hoursDelta * lineRate(r.line)),
      workers: sheets
        .filter((t) => t.lineIds.includes(r.line.id))
        .sort((a, b) => b.hours - a.hours)
        .slice(0, 8)
        .map((t) => ({ name: t.employeeName, date: t.date, hours: t.hours })),
    }))
    .sort((a, b) => b.value - a.value);
}

/**
 * Raise a variation for hours that were worked and never sold.
 *
 * Priced at TODAY's rate card, like any other variation, and carrying the
 * evidence in its note so the invoice can be defended rather than argued.
 * Deployed against the same place and window as the line it came from, so the
 * variation reads as what it is - more of the same cover, not a new job.
 */
export function raiseOvertimeVariation(
  w: Wof,
  claim: OvertimeClaim,
  actor: Actor = OPERATOR,
): LineItem | null {
  const pat = linePattern(w, claim.line);
  const sp = lineWindow(w, claim.line);
  if (!pat || !sp) return null;

  const who = claim.workers
    .map((x) => `${x.name} ${fmtDate(x.date)} ${x.hours}h`)
    .join('; ');
  const l = addLine(
    w,
    claim.line.chargeId,
    {
      // Hours, not shifts: this is time past the end of a shift somebody
      // already worked, and pretending it is a fresh shift would round it.
      qty: 1,
      units: claim.extraHours,
      // And at the rate that shift was SOLD at. An overrun is the same hour of
      // the same worker's time as the hour before it; re-pricing it against
      // today's card would put two rates for one continuous shift on one
      // invoice, which is the first thing a client queries and the last thing
      // anyone can explain.
      snap: claim.line.snap,
      description: `${claim.line.description} — overtime, ${claim.place}`,
      note:
        `${claim.extraHours}h worked beyond the ${sp.name} ${sp.start}-${sp.end} cover sold ` +
        `at ${claim.place}. ${who}`,
      addedBy: actor.by,
    },
    actor,
  );
  return l;
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
/* --------------------------------------------------------- the stock seam --

   `lib/hop.ts` imports from here and this module never imports from it: the
   module graph must not cycle, and 6,150 lines of work-order logic has no
   business knowing what a shelf is. So the stock check is HANDED to the gate
   rather than reached for.

   Unregistered is a no-op, deliberately. Every harness that does not bundle
   `hop.ts` still exercises the rest of the gate, and `App.tsx` imports the
   module for its side effect exactly as it already does for `rating`, `flags`
   and `clients`.
*/
export type StockGuard = (w: Wof) => string[];

let STOCK_GUARD: StockGuard = () => [];

export const registerStockGuard = (fn: StockGuard): void => {
  STOCK_GUARD = fn;
};

export function gate(w: Wof, targetStageId?: WofStage): Gate {
  const warn: string[] = [];
  const block: string[] = [];
  const target = targetStageId || nextStage(w);
  if (!target) return { ok: false, warn, block: ['This WOF is already at the end of its lifecycle.'] };

  if (target === 'signoff') {
    if (!quoteLines(w).length)
      block.push('The quote has no priced lines. Add items from the table of charges first.');
    // A client cannot sign what was never sent to them. Blocking rather than
    // warning: sign-off is a record of the client's decision, and there is no
    // decision to record on a quote that never left the building.
    else if (!w.quotedAt) {
      // Why it is unsent matters here. A big quote waiting on a senior
      // manager cannot be sent by the person reading this, and telling them
      // to press a button that is disabled is a dead end.
      const why = quoteSendBlock(w);
      block.push(
        why
          ? `${why} It cannot go for signature until it has been sent.`
          : 'The quote has not been sent to the client. Send it from the Quote tab first.',
      );
    }
    else {
      const d = quoteDrift(w);
      if (d)
        warn.push(
          `The quote has been amended since it was sent — the client is looking at ${money(d.sentValue)}, ` +
            `this job now comes to ${money(d.nowValue)}. Re-send before asking them to sign.`,
        );
    }
  }

  if (target === 'order') {
    if (!(w.signoff && w.signoff.signedAt))
      block.push(
        'The client has not signed the quote. A digital signature is required before a WOF becomes an order.',
      );
    // Order is where a job stops being speculative, so it is where the shelf
    // starts to matter. Blocking earlier would stop an operator PRICING a job
    // on a warehouse constraint, which is how people go back to the
    // spreadsheet; never blocking is how a client is billed for four tower
    // lights and receives two.
    STOCK_GUARD(w).forEach((m) => block.push(m));
  }

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
      warn.push('The kit list has not been sent to the warehouse — nothing is being picked.');
    } else {
      // Sent once and then amended is worse than never sent: the warehouse is
      // confidently picking the wrong list.
      const changes = kitChangesSincePush(w);
      if (changes.length)
        warn.push(
          `The kit list has changed since it went to the warehouse (${w.picking.epHopRef}): ${changes.map(describeChange).join('; ')}. Re-send it.`,
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
    // Different problem, different sentence. These have not been queried or
    // ignored — nobody has sent them, so the client cannot know they exist.
    const unsent = unsentVariations(w);
    if (unsent.length)
      warn.push(
        `${unsent.length} variation${unsent.length > 1 ? 's have' : ' has'} never been sent to the client, worth ${money(unsent.reduce((s, l) => s + lineValue(l), 0))}: ${unsent.map((l) => l.description).join(', ')}.`,
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
 *   From the line's `LinePattern`, which names its days outright — see
 *   `worksDay`. This used to be a regex over the description, because a quote
 *   line carried qty, units and a rate but no day; that gap is closed, and the
 *   parse survives only as `legacyDayFromDescription`, reachable by nothing but
 *   a line journalled before deployments shipped.
 *
 *   A patterned line lands on the days it names, at the headcount it names for
 *   each of them. A legacy line naming no day still goes on every day, which is
 *   both the plain reading of "7 Event Stewards" on a two-day job and the safer
 *   failure — an over-rostered day is visible on screen and can be deleted, an
 *   unstaffed day is invisible until nobody turns up.
 */
/**
 * The working window of each day of a job — when work starts and when it stops.
 *
 * A day counts only if work actually starts on it. Counting calendar dates
 * instead would split an overnight in two: a taxi marshal job running
 * 31 Jul 18:00 -> 1 Aug 03:00 touches two dates but is one night's work, and
 * date-counting invented a second shift on the 1st that nobody sold.
 *
 * Shared rather than local to `seedShifts` because the quote screen measures
 * lines against these same windows. Two definitions of "how long is this job"
 * is how an operator gets told six days by one screen and sold seven shifts by
 * another.
 */
export function spanWindowsOf(startIso: string, endIso: string): { start: Date; end: Date }[] {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const windows: { start: Date; end: Date }[] = [];
  if (Number.isNaN(+start) || Number.isNaN(+end)) return windows;

  for (let i = 0; ; i++) {
    const s = new Date(start);
    s.setDate(s.getDate() + i);
    if (i > 0 && +s >= +end) break;

    const e = new Date(s);
    e.setHours(end.getHours(), end.getMinutes(), 0, 0);
    if (+e <= +s) e.setDate(e.getDate() + 1); // overnight
    // The last day finishes when the job finishes, never after it.
    if (+e > +end) e.setTime(+end);

    windows.push({ start: s, end: e });
    if (i > 366) break; // a WOF with a corrupt end date cannot hang the app
  }
  return windows;
}

function spanWindows(w: Wof): { start: Date; end: Date }[] {
  return spanWindowsOf(w.start, w.end);
}

/** How many days the job runs — the same count the rota is built from. */
export const eventDays = (w: Wof): number => spanWindows(w).length;

/* ----------------------------------------------------------- live window ---
   A job's span is not all the same kind of day. A festival sold as 28 Aug ->
   3 Sep is two days of build, three days of event and two days of breakdown,
   and the three are staffed differently, charged differently and mean
   different things to the client. Until now the only record of that was the
   wording of a quote line, read back by a regex that assumed build was day one
   and breakdown the last day, which is wrong the moment a job has two build
   days. The builder now bands its day picker from this window, so an operator
   selects days already labelled build, event or break.

   Stored as the FIRST and LAST event day rather than a kind per day. Build
   runs before the event and breakdown after it; that is what the words mean,
   and a shape those two numbers cannot express — a break day in the middle of
   the run — is one an operator would be entering by mistake. Two numbers also
   survive a date change gracefully, where a per-day array would silently keep
   a kind against a day that no longer exists.

   Absent on a job means the whole span is event, which is both the truth for
   the single-day jobs that are most of the book and what every WOF raised
   before this field existed meant. -------------------------------------- */

export type DayKind = 'build' | 'event' | 'break';

/**
 * The event days of a job, as 1-based day numbers into its span.
 *
 * Always returns a window inside the span. A job whose dates were shortened
 * after the window was set is clamped rather than trusted — the alternative is
 * a rota that labels a day the job no longer has.
 */
export function liveWindow(w: Wof): { from: number; to: number; days: number } {
  const days = eventDays(w);
  if (!days) return { from: 1, to: 1, days: 0 };
  const from = Math.min(Math.max(w.liveFrom || 1, 1), days);
  const to = Math.min(Math.max(w.liveTo || days, from), days);
  return { from, to, days };
}

/**
 * The days a kit line is on hire, 1-based and clamped into the current span.
 *
 * The only reader of `LineItem.hire`. Clamping rather than trusting, for the
 * reason `liveWindow` clamps: a job shortened after the window was set would
 * otherwise leave a line claiming to be out on day 9 of a 7-day span, and the
 * stock register would believe it.
 *
 * A line with no window is out for the whole span, which is what the field
 * being absent means.
 */
export function hireWindow(w: Wof, l: LineItem): { from: number; to: number; days: number } {
  const days = eventDays(w);
  if (!days) return { from: 1, to: 1, days: 0 };
  if (!l.hire) return { from: 1, to: days, days };
  const from = Math.min(Math.max(l.hire.from, 1), days);
  const to = Math.min(Math.max(l.hire.to, from), days);
  return { from, to, days };
}

/**
 * Narrow a kit line's hire window, or clear it back to the whole span.
 *
 * The ONLY writer, because of an ordering trap this codebase has already paid
 * for once: `setPatternDays` has to assign `pat.days` BEFORE re-cutting its
 * lines or `syncDerived` undoes it. Same shape here — `hire` is assigned, then
 * `units` is re-derived from it. One writer means one place for that order to
 * be right.
 *
 * Returns false on a non-kit line. Staff hours come from a shift pattern and a
 * headcount; giving a steward a hire window would put two different answers to
 * "how long is this line" on the same record.
 */
export function setHire(
  w: Wof,
  lineId: string,
  window: { from: number; to: number } | null,
  actor: Actor = OPERATOR,
): boolean {
  const l = w.lines.find((x) => x.id === lineId);
  if (!l || l.kind !== 'kit') return false;

  const days = eventDays(w);
  const before = hireWindow(w, l);
  if (window) {
    const from = Math.min(Math.max(Math.round(window.from), 1), days);
    const to = Math.min(Math.max(Math.round(window.to), from), days);
    // A window covering everything IS no window. Storing it would leave two
    // encodings of one fact, and a later date change would drift them apart.
    l.hire = from === 1 && to === days ? undefined : { from, to };
  } else {
    l.hire = undefined;
  }
  syncDerived(w, l);

  const after = hireWindow(w, l);
  if (after.from !== before.from || after.to !== before.to) {
    record(
      w,
      {
        stage: w.stage,
        note: `${l.description}: on hire days ${after.from}–${after.to} of ${days}${
          l.hire ? '' : ' (the whole job)'
        }`,
      },
      actor,
    );
    save();
  }
  return true;
}

/** Mark a kit line sub-hired, or bring it back onto EP's own stock. */
export function setSubHire(w: Wof, lineId: string, on: boolean, actor: Actor = OPERATOR): boolean {
  const l = w.lines.find((x) => x.id === lineId);
  if (!l || l.kind !== 'kit') return false;
  if (!!l.subHire === on) return true;
  l.subHire = on || undefined;
  record(
    w,
    {
      stage: w.stage,
      note: on
        ? `${l.description} marked sub-hire — supplied by a third party, drawn from no EP stock`
        : `${l.description} back on EP stock`,
    },
    actor,
  );
  save();
  return true;
}

/** What kind of day the nth day of the job is. */
export function dayKind(w: Wof, dayNo: number): DayKind {
  const { from, to } = liveWindow(w);
  if (dayNo < from) return 'build';
  if (dayNo > to) return 'break';
  return 'event';
}

/**
 * The day range of one phase of a job, or `null` when the job has no such
 * phase - a one-day job has no build and no breakdown.
 *
 * Kit is talked about in these words: the radios go out with the build crew,
 * the signage comes off at breakdown. Offering the phase rather than two day
 * numbers is offering the sentence the warehouse already says, and it stays
 * right when the dates move.
 */
export function phaseWindow(w: Wof, phase: DayKind | 'whole'): { from: number; to: number } | null {
  const { from, to, days } = liveWindow(w);
  if (!days) return null;
  if (phase === 'whole') return { from: 1, to: days };
  if (phase === 'build') return from > 1 ? { from: 1, to: from - 1 } : null;
  if (phase === 'break') return to < days ? { from: to + 1, to: days } : null;
  return { from, to };
}

/**
 * What kind of day a given CALENDAR DATE is for a job — or `null` when the job
 * does not work that date at all.
 *
 * The calendar draws cells, not day numbers, so it needs the question asked the
 * other way round. Matched on the date a working day STARTS, because that is
 * the day the rota counts: a taxi marshal window running 31 Jul 18:00 -> 1 Aug
 * 03:00 is the 31st's shift, and a cell on the 1st that called it a separate
 * day would be inventing one. Where no window starts on the date, a window
 * still running through it — the far side of that overnight — answers instead,
 * so the job does not silently vanish from a cell it visibly occupies.
 */
export function dayKindOn(w: Wof, date: Date): DayKind | null {
  const windows = spanWindows(w);
  if (!windows.length) return null;

  const sameDate = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  let i = windows.findIndex((win) => sameDate(win.start, date));
  if (i < 0) {
    const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const dayEnd = new Date(+dayStart + 86_400_000);
    i = windows.findIndex((win) => +win.start < +dayEnd && +win.end > +dayStart);
  }
  if (i < 0) return null;
  return dayKind(w, i + 1);
}

/**
 * The split in words — `null` when there is nothing to say because the whole
 * job is the event, so the WOF screen does not carry a row that always reads
 * the same.
 */
export function phaseSummary(w: Wof): string | null {
  const { from, to, days } = liveWindow(w);
  if (!days) return null;
  const build = from - 1;
  const brk = days - to;
  if (!build && !brk) return null;
  const parts = [
    build ? countLabel(build, 'build day') : '',
    countLabel(to - from + 1, 'event day'),
    brk ? countLabel(brk, 'break day') : '',
  ].filter(Boolean);
  return parts.join(', ');
}

/**
 * How many hours are actually worked across the job.
 *
 * The sum of the daily windows, NOT wall-clock start to end. A job running
 * 09:00-18:00 across six days is 54 hours of work; the 129 hours between its
 * first morning and its last evening include five nights when nobody is on
 * site, and measuring a steward against that number let 100 hours a head look
 * reasonable on a six-day job.
 */
export const eventHours = (w: Wof): number =>
  round2(spanWindows(w).reduce((h, win) => h + (+win.end - +win.start) / 3_600_000, 0));

/**
 * Why a quote line lasts longer than the job it is quoted against, or `null`.
 *
 * Refuses rather than warns: a line billing time the job does not have is
 * over-quoting the client, and the fix — shorten the line, or correct the job
 * dates — is always available to the operator standing in front of it.
 *
 * Measured in whatever unit the charge is sold in, so it reads the same for a
 * fence panel priced by the day and a steward priced by the hour. Hours are
 * per head: `qty` is how many people, `units` is how long each of them works,
 * and it is the second number the length of the job bounds. A charge sold
 * `each` is a count of things, not a duration, and nothing about the length of
 * the job bounds how many hi-vis vests are wanted.
 */
export function spanBlock(w: Wof, chargeId: string, units: number): string | null {
  const ch = chargeById(chargeId);
  if (!ch || ch.unit === 'each') return null;
  if (!Number.isFinite(units) || units <= 0) return null;

  const day = ch.unit === 'day';
  const noun = day ? 'day' : 'hour';
  const span = day ? eventDays(w) : eventHours(w);
  if (!span || units <= span) return null;

  return (
    `This job is ${countLabel(span, day ? 'day' : 'working hour')} long. ` +
    `${countLabel(units, noun)} of ${ch.name} bills ` +
    `${countLabel(round2(units - span), noun)} the job does not cover. ` +
    'Shorten the line, or change the job dates if the job really does run that long.'
  );
}

function seedShifts(w: Wof, evId: string, staffLines: LineItem[]): EpEvent['shifts'] {
  const office = w.office || 'EP Event Services';

  const windows = spanWindows(w);
  const dayCount = windows.length;

  /**
   * One role group per role, PER PLACE, PER WINDOW, per day.
   *
   * Merging on the role alone was right about one thing and wrong about
   * another. Right: a quote can carry three Event Steward lines — different
   * tiers, or simply added at different times — and one group per LINE reads as
   * three jobs to a worker and three rows to fill to staffing, when it is one
   * role wanting 25 people. Quantities add.
   *
   * Wrong: it also merged the stewards at Alley Farm with the stewards at
   * Ground Yard, and the 08:00-16:00 day shift with the 17:00-02:00 night. Same
   * charge, different car park half a mile away, different briefing, different
   * meeting point, different night's sleep. So the key is role + place +
   * window, and the group carries both across to the shift it becomes.
   */
  const mergeGroups = (lines: LineItem[], dayNo: number) => {
    const order: string[] = [];
    const byKey = new Map<
      string,
      {
        role: string; required: number; placeId: string | null;
        sp: ShiftPattern | null; lineIds: string[];
      }
    >();
    lines.forEach((l) => {
      const role = chargeById(l.chargeId)?.role || l.description;
      const pat = linePattern(w, l);
      const sp = lineWindow(w, l);
      const key = [role, pat ? pat.placeId || '' : '', sp ? sp.id : ''].join('\u0000');
      if (!byKey.has(key)) {
        order.push(key);
        byKey.set(key, { role, required: 0, placeId: pat ? pat.placeId : null, sp, lineIds: [] });
      }
      byKey.get(key)!.required += headcountOn(w, l, dayNo);
      byKey.get(key)!.lineIds.push(l.id);
    });
    return order.map((k) => byKey.get(k)!);
  };

  return windows.map(({ start: s, end: e }, i) => {
    const dayNo = i + 1;

    // Only the roles actually sold for this day.
    const onThisDay = staffLines.filter((l) => worksDay(w, l, dayNo, dayCount));

    return {
      id: `sh-${evId}-${dayNo}`,
      label: dayCount === 1 ? 'Main shift' : `Day ${dayNo}`,
      day: dayNo,
      start: local(s),
      end: local(e),
      splits: mergeGroups(onThisDay, dayNo).map((g, j) => ({
        id: `${evId}-d${dayNo}-sp-${j + 1}`,
        role: g.role,
        required: g.required,
        // The sold-to-rostered link, persisted rather than re-derived. Written
        // here because this is the only place that knows which lines were
        // merged into this group.
        lineIds: g.lineIds,
        // The window the line was sold against, when it has one. Left off, the
        // group inherits the day, which is what every legacy line means.
        ...(g.sp ? { start: g.sp.start, end: g.sp.end } : {}),
        locationId: g.placeId ? `loc-${evId}-${g.placeId}` : null,
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
 * How many people a line puts on ONE day of the run.
 *
 * `qty` is total shifts across the whole deployment, so a patterned line has to
 * be read back through its day list to answer "how many on day 4". An
 * unpatterned line has no day list and its `qty` is a flat headcount — which is
 * what it meant before deployments existed.
 */
export function headcountOn(w: Wof, l: LineItem, dayNo: number): number {
  const pat = linePattern(w, l);
  // No pattern means no day list, and `qty` is the flat headcount it always
  // was. The caller has already established the line works this day.
  if (!pat || !l.perDay) return l.qty;
  const i = pat.days.indexOf(dayNo);
  return i < 0 ? 0 : l.perDay[i] || 0;
}

/**
 * Does this line put anybody on the nth day of the job?
 *
 * Answered from the pattern, exactly, where there is one. Where there is not,
 * it falls back to reading the description — the old behaviour, kept ONLY for
 * lines journalled before deployments shipped. New lines never reach it.
 */
function worksDay(w: Wof, l: LineItem, dayNo: number, dayCount: number): boolean {
  const pat = linePattern(w, l);
  if (pat) {
    const i = pat.days.indexOf(dayNo);
    return i >= 0 && (l.perDay ? (l.perDay[i] || 0) > 0 : true);
  }
  const d = legacyDayFromDescription(l.description, dayCount);
  return d === null || d === dayNo;
}

/**
 * LEGACY. Which day of the run a quote line's free text names, or `null`.
 *
 * This was the only place free text was read as data, and it is now reached by
 * nothing except a line saved before `LinePattern` existed. It is not exported,
 * it is not called for any line an operator can create today, and it should be
 * deleted outright once no journalled quote predates deployments.
 *
 * Anything it cannot read returns `null` rather than guessing a number: putting
 * a role on every day over-staffs a day visibly, guessing day 4 hides it.
 */
function legacyDayFromDescription(description: string, dayCount: number): number | null {
  const s = (description || '').toLowerCase();

  if (/\bdaily\b|\beach day\b|\bevery day\b/.test(s)) return null;

  const named = /\bday\s*(\d{1,2})\b/.exec(s);
  if (named) {
    const n = Number(named[1]);
    if (n >= 1 && n <= dayCount) return n;
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

/** The event's location list: the job's places, or the venue when it has none. */
function seedLocations(w: Wof, evId: string): EventLocation[] {
  const sch = w.scheduleId ? scheduleById(w.scheduleId) : null;
  const meet = w.staffMeetingPoint ? `Staff meeting point: ${w.staffMeetingPoint}` : '';
  const places = w.places || [];

  // Only the places a line actually stands at. A register entry nobody was
  // quoted against is a note to the estimator, not somewhere to send anybody.
  const used = new Set(
    (w.lines || [])
      .map((l) => linePattern(w, l)?.placeId)
      .filter((id): id is string => !!id),
  );

  const fromPlaces = places
    .filter((pl) => used.has(pl.id))
    .map((pl) => ({
      id: `loc-${evId}-${pl.id}`,
      // Qualified by the venue so a worker reading "Alley Farm" on their phone
      // knows which festival it belongs to.
      name: w.venue ? `${w.venue} — ${pl.name}` : pl.name,
      note: pl.note || meet,
    }));
  if (fromPlaces.length) return fromPlaces;

  return w.venue || sch
    ? [{ id: `loc-${evId}`, name: w.venue || sch!.venue, note: meet }]
    : [];
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
    // Every place the quote named, plus the venue itself.
    //
    // This used to synthesise exactly ONE location from `w.venue`, so a
    // festival quoted across eleven car parks arrived at the staffing tool as a
    // single location called "Richfield Avenue" and no worker was ever told
    // which gate to stand at. Ids are derived from the place id so the splits
    // built alongside can point at them without a second lookup.
    locations: seedLocations(w, evId),
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
      picking: legacyPicking({ hireHopRef: 'HH-2026-8841', pushedAt: '2026-07-22T14:05:00', status: 'Packed and dispatched',
                 lastSyncAt: '2026-07-26T08:15:00' }),
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
      picking: legacyPicking({ hireHopRef: 'HH-2026-8907', pushedAt: '2026-07-24T11:20:00', status: 'Picking in progress',
                 lastSyncAt: '2026-07-30T18:02:00' }),
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
      picking: legacyPicking({ hireHopRef: 'HH-2026-8955', pushedAt: '2026-07-29T09:00:00', status: 'Packed', lastSyncAt: '2026-07-29T09:00:00' }),
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

    /* ---- wof-112 Reading Festival — THE DEPLOYMENT FIXTURE -------------
       The job this whole feature was designed against, carrying the real
       shape of `Reading Festival 2025 — Reading 2025 v.1`: areas, real places,
       a window library, and per-day headcounts that genuinely vary.

       Eight days: Mon 17 and Tue 18 build, Wed 19 to Sun 23 event, Mon 24
       break — the same shape as the sheet, and the 2026 weekdays line up.

       Deliberately exercises every edge the grid and the roster have to
       survive: one window across three car parks, one car park across three
       windows, nights that stop before the last event day, a build-only
       deployment, a break-day deployment, a pattern with no place at all, and
       kit lines carrying no deployment whatsoever.                     ---- */
    {
      const pats: LinePattern[] = [];
      const lns: LineItem[] = [];
      const PRICED = '2026-06-12';

      /** One deployment: a place, a window, its days, and the roles standing there. */
      const deploy = (
        area: string,
        placeId: string | null,
        shiftPatternId: string,
        days: number[],
        roles: [string, number[]][],
      ) => {
        const pat: LinePattern = {
          id: `pat-rd-${pats.length + 1}`, area, placeId, shiftPatternId, days,
        };
        pats.push(pat);
        roles.forEach(([chargeId, perDay]) => {
          lns.push(line(chargeId, { pricedAt: PRICED, patternId: pat.id, perDay }));
        });
      };

      const WHITE = 'White — Maple Durham';
      const GREEN = "Green — King's Meadow";
      const PUDO  = 'PUDO — Hills Meadow';
      const ROADS = 'Road Closures';
      const OPS   = 'Operational Management';

      /* --- White — Maple Durham. One place, three windows. --------------- */
      deploy(WHITE, 'pl-rd-lilley', 'sp-early', [2, 3, 4, 5, 6, 7], [
        // Early cover starts in the BUILD and runs the whole event. Counts
        // climb for the weekend — the reason `perDay` is an array.
        ['ch-st-carpark', [2, 2, 2, 4, 6, 6]],
        ['ch-st-super',   [1, 1, 1, 1, 2, 2]],
      ]);
      deploy(WHITE, 'pl-rd-lilley', 'sp-day', [3, 4, 5, 6, 7], [
        ['ch-st-carpark', [3, 3, 5, 8, 8]],
      ]);
      deploy(WHITE, 'pl-rd-lilley', 'sp-nights', [3, 4, 5, 6], [
        // Nights STOP before the last event day. A single shared day list for
        // the place would have quietly put stewards here on the Sunday night.
        ['ch-st-carpark',  [4, 4, 6, 6]],
        ['ch-st-response', [1, 1, 2, 2]],
      ]);

      /* --- Same window, three more car parks. The sheet's real repetition:
             `06:00-15:00` appears at twelve different places.  ------------- */
      deploy(WHITE, 'pl-rd-triangle', 'sp-early', [3, 4, 5, 6, 7], [
        ['ch-st-carpark', [2, 2, 3, 4, 4]],
      ]);
      deploy(WHITE, 'pl-rd-crossroads', 'sp-early', [3, 4, 5, 6, 7], [
        ['ch-st-carpark', [2, 2, 2, 3, 3]],
      ]);
      deploy(WHITE, 'pl-rd-gravel', 'sp-early', [3, 4, 5, 6, 7], [
        ['ch-st-carpark', [1, 1, 2, 2, 2]],
      ]);

      /* --- Green — King's Meadow. Ticket sales, and a PEAK window. ------- */
      deploy(GREEN, 'pl-rd-tickets', 'sp-long', [3, 4, 5, 6, 7], [
        ['ch-st-turnstile', [4, 4, 4, 4, 4]],
      ]);
      deploy(GREEN, 'pl-rd-tickets', 'sp-peak', [4, 5, 6], [
        ['ch-st-turnstile', [3, 5, 5]],
        ['ch-st-super',     [1, 1, 1]],
      ]);

      /* --- PUDO — Hills Meadow. Drop-off, day and night. ---------------- */
      deploy(PUDO, 'pl-rd-dropoff', 'sp-earlyc', [3, 4, 5, 6, 7], [
        ['ch-st-carpark', [4, 4, 4, 4, 4]],
      ]);
      deploy(PUDO, 'pl-rd-dropoff', 'sp-late', [4, 5, 6], [
        ['ch-st-taxi', [2, 3, 3]],
      ]);

      /* --- Road closures. A deployment with NO place: the whole point of
             `placeId: null` — this cover is a ring road, not a spot.  ------ */
      deploy(ROADS, null, 'sp-extend', [1, 2, 8], [
        ['ch-st-event', [3, 3, 3]],
      ]);

      /* --- Build-only, and break-only. -------------------------------- */
      deploy(WHITE, 'pl-rd-minibus', 'sp-half', [1, 2], [
        ['ch-st-carpark', [6, 6]],
      ]);
      deploy(WHITE, 'pl-rd-minibus', 'sp-half', [8], [
        ['ch-st-carpark', [8]],
      ]);

      /* --- Operational management, across the whole run. ---------------- */
      deploy(OPS, null, 'sp-mgmt', [1, 2, 3, 4, 5, 6, 7, 8], [
        ['ch-st-control', [1, 1, 2, 2, 2, 2, 2, 1]],
      ]);

      // Kit carries no deployment: a radio is not standing anywhere at 06:00.
      lns.push(line('ch-kit-radio',   { qty: 120, units: 8, pricedAt: PRICED }));
      lns.push(line('ch-kit-charger', { qty: 20,  units: 8, pricedAt: PRICED }));
      lns.push(line('ch-kit-cabin',   { qty: 4,   units: 8, pricedAt: PRICED }));
      lns.push(line('ch-sv-pm',       { qty: 1,   units: 8, pricedAt: PRICED }));

      W.push({
        id: 'wof-112', ref: 'WOF-2026-0112', title: 'Reading Festival 19th-23rd',
        clientId: 'c-19', scheduleId: null, eventId: null, jobTypeId: 'festival',
        office: 'EP Event Services', ownerId: 'm-colin', raisedBy: 'm-colin',
        start: '2026-08-17T06:00:00', end: '2026-08-24T18:00:00',
        liveFrom: 3, liveTo: 7,
        venue: 'Richfield Avenue, Reading', stage: 'quote',
        raisedAt: '2026-05-28T09:30:00', quotedAt: null,
        orderedAt: null, signoff: null, deposit: null,
        shiftPatterns: COMPANY_SHIFT_PATTERNS.map((sp) => ({ ...sp })),
        places: [
          { id: 'pl-rd-lilley',     name: 'Lilley Farm',    note: 'Report to the farm gate off Old Lane.' },
          { id: 'pl-rd-triangle',   name: 'Green Triangle', note: '' },
          { id: 'pl-rd-crossroads', name: 'Cross Roads',    note: '' },
          { id: 'pl-rd-gravel',     name: 'Gravel Track',   note: '' },
          { id: 'pl-rd-minibus',    name: 'Minibus Gate',   note: '' },
          { id: 'pl-rd-tickets',    name: 'Ticket Sales',   note: 'Cash office briefing at 05:45.' },
          { id: 'pl-rd-dropoff',    name: 'Drop Off',       note: '' },
          { id: 'pl-rd-plum',       name: 'Plum Farm',      note: 'Quoted last year, not used this year.' },
        ],
        patterns: pats,
        lines: lns,
        documents: docsFor('festival', '2026-08-17T06:00:00', {
          'risk-assessment': 'submitted', 'traffic-plan': 'submitted',
        }),
        picking: null,
        invoice: null,
        history: [],
        notes:
          'The job the deployment model was built from. Nine areas on the client sheet; ' +
          'this quote covers the car parks, ticket sales, PUDO and road closures.',
      });
    }

    /* ---- wof-113 Wilderness car parks — DELIVERED, with a real overrun ---
       The fixture the variance report is measured against. A small job, fully
       delivered, whose deployments and timesheets deliberately disagree:

         Ground Yard, Early    sold 2 x 3 days = 6 shifts, worked as sold
         Ground Yard, Nights   sold 2 x 2 nights = 4 shifts, worked 1.5h over
                               each - the gate stayed open for the last coach

       So the job comes in on budget everywhere except one window in one place,
       which is exactly the shape a paper process loses and this one finds. ---- */
    {
      const pats: LinePattern[] = [];
      const lns: LineItem[] = [];
      const PRICED = '2026-05-02';
      const place = { id: 'pl-wc-yard', name: 'Ground Yard', note: '' };

      const deploy = (spId: string, days: number[], roles: [string, number[]][]) => {
        const pat: LinePattern = {
          id: `pat-wc-${pats.length + 1}`,
          area: 'Car parks',
          placeId: place.id,
          shiftPatternId: spId,
          days,
        };
        pats.push(pat);
        roles.forEach(([chargeId, perDay]) => {
          lns.push(line(chargeId, { pricedAt: PRICED, patternId: pat.id, perDay }));
        });
      };

      // Days 1-3 of a 3-day run. The early window is sold on TWO lines - the
      // original two stewards, and a third added later - which is what makes
      // the worked hours have to be apportioned rather than attributed whole.
      // It is also over-sold against what was worked, so the report has an
      // underrun in it as well as an overrun.
      deploy('sp-early', [1, 2, 3], [
        ['ch-st-carpark', [2, 2, 2]],
        ['ch-st-carpark', [1, 1, 1]],
      ]);
      deploy('sp-nights', [2, 3], [['ch-st-carpark', [2, 2]]]);
      lns.push(line('ch-kit-radio', { qty: 8, units: 3, pricedAt: PRICED }));

      /* Timesheets. Early cover worked exactly what was sold; the night shifts
         each ran 1.5 hours over. `scheduled` is what makes the two windows
         distinguishable on the same date - without it the resolver refuses to
         guess, which is the behaviour the harness checks. */
      const CREW = ['e-9', 'e-10', 'e-11', 'e-12'];
      const sheets: TimesheetSeed[] = [];
      [0, 1, 2].forEach((i) => {
        const date = addDays('2026-09-14T06:00:00', i).slice(0, 10);
        for (let n = 0; n < 2; n++) {
          sheets.push({
            employeeId: CREW[n], date, role: 'Car Park Steward',
            scheduled: '06:00–15:00', hours: 9, outcome: 'worked',
          });
        }
        if (i >= 1) {
          for (let n = 0; n < 2; n++) {
            sheets.push({
              employeeId: CREW[2 + n], date, role: 'Car Park Steward',
              scheduled: '17:00–02:00', hours: 10.5, outcome: 'overtime',
            });
          }
        }
      });

      W.push({
        id: 'wof-113', ref: 'WOF-2026-0113', title: 'Wilderness car parks — delivered',
        clientId: 'c-19', scheduleId: null, eventId: null, jobTypeId: 'festival',
        office: 'EP Event Services', ownerId: 'm-colin', raisedBy: 'm-colin',
        start: '2026-09-14T06:00:00', end: '2026-09-16T20:00:00',
        venue: 'Cornbury Park, Oxfordshire', stage: 'complete',
        raisedAt: '2026-05-01T09:00:00', quotedAt: '2026-05-02T11:00:00',
        orderedAt: '2026-05-20T10:00:00',
        signoff: {
          signedBy: 'Dana Reilly', signedByRole: 'Head of Operations',
          signedAt: '2026-05-19T15:00:00', method: 'DocuSign', ref: 'DS-0113', ip: '—',
        },
        deposit: null,
        shiftPatterns: COMPANY_SHIFT_PATTERNS.map((sp) => ({ ...sp })),
        places: [place],
        patterns: pats,
        lines: lns,
        documents: docsFor('festival', '2026-09-14T06:00:00', 'all-approved'),
        picking: null,
        invoice: {
          number: 'INV-26-0511', issuedAt: '2026-09-18T10:00:00',
          dueAt: '2026-10-18T00:00:00', paidAt: '2026-10-09T00:00:00',
        },
        timesheets: sheets,
        history: [],
        notes:
          'Delivered. The night gate ran over on both nights — the variance report ' +
          'finds it and offers the variation that was never raised at the time.',
      });
    }

    /* ---- wof-114 Thames Regatta — THE COLLISION -------------------------
       The fixture EP HOP is measured against, and the reason it exists.

       An ORDERED job whose radio and barrier hire overlaps Reading (wof-112,
       still quoting) by four days in the middle of September. On its own it
       fits: 150 radios against 238 issuable. Reading wants 120 more on the
       same days, and 270 is not 238.

       That is deliberately the interesting shape rather than a job that is
       simply too big:

         · the STOCK REGISTER stays green, because nothing is oversubscribed
           yet — only ordered work draws, and only this job is ordered;
         · the register still shows the pressure, so the warehouse can see
           Reading coming before anybody signs it;
         · Reading's quote carries a soft flag on the radio line, priced and
           sendable, because a warehouse constraint must never stop an
           operator pricing a job;
         · and the moment somebody tries to turn Reading into an order, the
           gate refuses and names THIS job as the clash.

       One fixture, all four rules, and none of them assertable without it. -- */
    {
      const PRICED = '2026-05-21';
      W.push({
        id: 'wof-114', ref: 'WOF-2026-0114', title: 'Thames Regatta — river crossings',
        clientId: 'c-4', scheduleId: null, eventId: null, jobTypeId: 'festival',
        office: 'EP Event Services', departmentId: 'dep-events',
        ownerId: 'm-colin', raisedBy: 'm-gracie',
        /* SEED TIME. Everything below is moved by `SHIFT_DAYS` in the pass at
           the end of `seed()`, exactly like Reading — so these dates are
           chosen to land ON Reading's shifted window, not to read as it. */
        start: '2026-08-19T06:00:00', end: '2026-08-22T20:00:00',
        venue: 'Henley Reach, Oxfordshire', postcode: 'RG9 2LY',
        staffMeetingPoint: null, active: true, staffCalendarVisible: true,
        stage: 'order',
        raisedAt: '2026-05-18T09:00:00', quotedAt: '2026-05-21T14:00:00',
        orderedAt: '2026-06-04T10:00:00',
        signoff: {
          signedBy: 'Marcus Ferreira', signedByRole: 'Event Director',
          signedAt: '2026-06-03T16:20:00', method: 'DocuSign', ref: 'DS-0114', ip: '—',
        },
        deposit: { pct: 25, amount: 4200, receivedAt: '2026-06-10T00:00:00', ref: 'BACS-0114' },
        shiftPatterns: COMPANY_SHIFT_PATTERNS.map((sp) => ({ ...sp })),
        places: [], patterns: [],
        lines: [
          line('ch-kit-radio',   { qty: 150, units: 4, pricedAt: PRICED }),
          line('ch-kit-barrier', { qty: 320, units: 4, pricedAt: PRICED }),
          // Narrowed by hand to the two race days: the barriers go in for the
          // whole job, the lights only for the evenings. This is the `hire`
          // field doing its one job, in seed data, so the register is not
          // only ever exercised against whole-span lines.
          line('ch-kit-lighting', { qty: 6, units: 2, pricedAt: PRICED, hire: { from: 3, to: 4 } }),
        ],
        documents: docsFor('festival', '2026-08-19T06:00:00', 'all-approved'),
        kitPrep: null, picking: null, invoice: null, history: [],
        notes:
          'Ordered and committed. Holds 150 radios across the same four days Reading ' +
          'is quoting 120 on — the collision EP HOP exists to catch before it is a ' +
          'phone call from a site manager.',
      });
    }

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
      picking: legacyPicking({ hireHopRef: `HH-2026-${8000 + Number(cfg.id.slice(-3))}`,
                 pushedAt: addDays(cfg.start, -6), status: 'Returned and checked in',
                 lastSyncAt: addDays(cfg.end, 1) }),
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
/** High-water mark for job numbers. See `nextJobNumber()`. */
let issuedHigh = 0;
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
  /**
   * The highest job number ever issued in this browser.
   *
   * Persisted because a job number cannot be re-derived from the pipeline after
   * a delete — the deleted job is exactly the evidence that is gone. See
   * `nextJobNumber()`.
   */
  issued?: number;
}

/** Where the worker portal keeps applications. Declared here because the
 *  role-group merge has to ask whether anybody has applied before it renames a
 *  split out from under them. */
const KEY_APPS = 'epteam.applications';

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

/** Events left with duplicate role groups because people are already on them. */
let unmerged = 0;

/** How many saved events could not be merged. Reported, never swallowed. */
export const unmergedRoleGroups = (): number => unmerged;

/** Does anybody hold an application against this event? */
function hasApplications(eventId: string): boolean {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY_APPS) || '[]');
    return Array.isArray(raw) && raw.some((a: { eventId?: string }) => a && a.eventId === eventId);
  } catch {
    return false; // private mode — nothing stored, so nothing to protect
  }
}

/**
 * Collapse duplicate role groups on events seeded before the merge existed.
 *
 * `seedEvent()` runs once per event, so a job seeded under the old rule keeps
 * three Event Steward groups a day forever without this.
 *
 * Split ids are positional, so merging renumbers them, and any application or
 * attendance row keyed on an old id would be orphaned. An event with anybody on
 * it is therefore left exactly as it is, and counted — a job that cannot be
 * tidied is something staffing should be told about, not something to hide.
 */
function mergeSavedRoleGroups(): void {
  unmerged = 0;

  EVENTS.forEach((ev) => {
    if (!String(ev.id).startsWith('ev-wof-')) return;

    const dupes = ev.shifts.some(
      (sh) => new Set(sh.splits.map((sp) => sp.role)).size !== sh.splits.length,
    );
    if (!dupes) return;

    const occupied = ev.shifts.some((sh) => sh.splits.some((sp) => sp.assignments.length));
    if (occupied || hasApplications(ev.id)) {
      unmerged += 1;
      return;
    }

    ev.shifts = ev.shifts.map((sh) => {
      const order: string[] = [];
      const byRole = new Map<string, Split>();
      sh.splits.forEach((sp) => {
        const seen = byRole.get(sp.role);
        if (!seen) {
          order.push(sp.role);
          byRole.set(sp.role, { ...sp, assignments: [] });
        } else {
          seen.required += sp.required;
        }
      });
      return {
        ...sh,
        splits: order.map((role, j) => ({
          ...byRole.get(role)!,
          id: `${ev.id}-d${sh.day}-sp-${j + 1}`,
        })),
      };
    });
  });
}

/* ------------------------------------------------------- schema defaults ---
   `load()` overlays saved `lines` and saved WOFs WHOLESALE — a line written
   before a field existed replays without it, and a job created in this browser
   is pushed onto `WOFS` exactly as it was stored. Every field added from here
   on therefore needs a default applied on the way in, in one place, or the
   symptom is a `.map` on an undefined array three screens away from the cause.

   Same mitigation, and the same reason, as the `normaliseEvent` note in
   `PLAN-spreadsheet-parity.md`. Cheap, total, and the only thing that has to
   land before a field is added rather than after. ------------------------- */

/** Default a line's deployment fields. Unpatterned lines stay unpatterned. */
export function normaliseLine(l: LineItem): LineItem {
  if (l.patternId === undefined) l.patternId = undefined;
  // `perDay` is only meaningful alongside a pattern. A line carrying one
  // without the other is a half-written record, and trusting it would price
  // from a day list nothing can resolve.
  if (!l.patternId) delete l.perDay;
  else if (!Array.isArray(l.perDay)) l.perDay = [];
  // A line cannot be in two places at once. `linePlacement` reads the pattern
  // first, so a record carrying both would quietly ignore one of them - drop
  // it here instead, where the contradiction is visible.
  if (l.patternId && l.placement) delete l.placement;
  return l;
}

/** Default a WOF's deployment registers, and every line hanging off it. */
export function normaliseWof(w: Wof): Wof {
  if (!Array.isArray(w.shiftPatterns)) w.shiftPatterns = [];
  if (!Array.isArray(w.patterns)) w.patterns = [];
  if (!Array.isArray(w.places)) w.places = [];
  if (!Array.isArray(w.lines)) w.lines = [];
  w.lines.forEach(normaliseLine);

  // A pattern pointing at a place or window that is not in the register cannot
  // be rendered or priced. Drop the dangling reference rather than the pattern:
  // the line still carries its own qty and units, so it degrades to a legacy
  // line instead of vanishing from the quote total.
  w.patterns.forEach((pat) => {
    if (pat.placeId && !w.places!.some((pl) => pl.id === pat.placeId)) pat.placeId = null;
    if (!Array.isArray(pat.days)) pat.days = [];
  });

  // The same treatment for a placed kit line: keep the line, drop the dangling
  // place. Forty barriers whose car park was deleted are still forty barriers
  // the client is paying for.
  w.lines.forEach((l) => {
    const pl = l.placement;
    if (pl && pl.placeId && !w.places!.some((x) => x.id === pl.placeId)) pl.placeId = null;
  });

  // A picking record written before the EP HOP rename carries `hireHopRef` and
  // no `epHopRef`. Copy the value ACROSS, never rewrite it: the warehouse has
  // already picked against that number. `hireHopRef` is left in place rather
  // than deleted so a record that has been through this is still legible as
  // one that predates the rename.
  if (w.picking && !w.picking.epHopRef && w.picking.hireHopRef)
    w.picking.epHopRef = w.picking.hireHopRef;

  // Re-derive `qty` and `units` from the deployment rather than trusting what
  // was stored. Seed literals then only have to state the truth — days and
  // headcounts — and cannot disagree with the totals they imply.
  syncAllDerived(w);
  return w;
}

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
  // v3 and v4 predate the moving clock; v5 predates deployments — a line saved
  // under it has no `patternId`, and a WOF none of the three registers those
  // patterns resolve against. `normaliseWof` below defaults all of it, but a v5
  // payload is discarded outright rather than half-read: it is seed data, and
  // the alternative is reasoning about which fields a given version owns.
  const usable =
    !!saved &&
    ((saved.v === 3 || saved.v === 4)
      ? SHIFT_DAYS === 0
      // v6 predates the EP HOP rename and the prep record. Both are handled by
      // `normaliseWof` on the way in — the reference is copied across and the
      // prep defaults to absent — so a v6 payload is still readable rather
      // than discarded. v5 was not, because the fields it lacked were
      // structural; these are additive.
      : (saved.v === 6 || saved.v === 7) && saved.shift === SHIFT_DAYS);

  // Restore the job-number high-water mark, then undo any collision the old
  // count-based allocator already wrote. Both happen BEFORE the saved arrays are
  // applied: the restore below skips an event whose id is already present, which
  // is what makes a duplicate unrecoverable once it has been let through.
  issuedHigh = 0;
  let healed = false;
  if (usable && saved && Array.isArray(saved.wofs)) {
    // Records saved before `issued` existed have no mark, so it is rebuilt from
    // the numbers still on file — the best available floor.
    issuedHigh = Math.max(
      saved.issued || 0,
      FIRST_JOB_NUMBER - 1,
      ...saved.wofs.map((w) => jobNumberIn(w.id)),
    );
    healed = healSavedDuplicates(saved);
  }

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
        // When the quote went to the client, and what it said at the time.
        // Left off this list, a quote sent in this browser is un-sent by a
        // page reload and the client's job vanishes from their portal again.
        quotedAt: s.quotedAt !== undefined ? s.quotedAt : w.quotedAt,
        quotedValue: s.quotedValue !== undefined ? s.quotedValue : w.quotedValue,
        quotedLineIds: s.quotedLineIds !== undefined ? s.quotedLineIds : w.quotedLineIds,
        // The approval on a big quote and the documents behind it, for the
        // same reason as `quotedAt` above: left off this list, an approval
        // given in this browser is forgotten by a reload and the quote is
        // held again, and every version of it disappears.
        quoteApproval: s.quoteApproval !== undefined ? s.quoteApproval : w.quoteApproval,
        quoteApprovalRequest:
          s.quoteApprovalRequest !== undefined ? s.quoteApprovalRequest : w.quoteApprovalRequest,
        quoteApprovalRefusal:
          s.quoteApprovalRefusal !== undefined ? s.quoteApprovalRefusal : w.quoteApprovalRefusal,
        quoteVersions: s.quoteVersions !== undefined ? s.quoteVersions : w.quoteVersions,
        // And the unsent edits behind the next document. Left off this list,
        // an afternoon's amendments look like no change at all after a
        // reload, and the next quote goes out unable to say what moved.
        quotePending: s.quotePending !== undefined ? s.quotePending : w.quotePending,
        kitPrep: s.kitPrep !== undefined ? s.kitPrep : w.kitPrep,
        picking: s.picking !== undefined ? s.picking : w.picking,
        invoice: s.invoice !== undefined ? s.invoice : w.invoice,
        eventId: s.eventId !== undefined ? s.eventId : w.eventId,
        notes: s.notes !== undefined ? s.notes : w.notes,
        // Event info is operator-editable, so saved values win.
        jobCode: s.jobCode !== undefined ? s.jobCode : w.jobCode,
        departmentId: s.departmentId !== undefined ? s.departmentId : w.departmentId,
        liveFrom: s.liveFrom !== undefined ? s.liveFrom : w.liveFrom,
        liveTo: s.liveTo !== undefined ? s.liveTo : w.liveTo,
        venue: s.venue !== undefined ? s.venue : w.venue,
        postcode: s.postcode !== undefined ? s.postcode : w.postcode,
        staffMeetingPoint:
          s.staffMeetingPoint !== undefined ? s.staffMeetingPoint : w.staffMeetingPoint,
        active: s.active !== undefined ? s.active : w.active,
        staffCalendarVisible:
          s.staffCalendarVisible !== undefined ? s.staffCalendarVisible : w.staffCalendarVisible,
        history: s.history || [],
        // The deployment registers are operator-editable state, so saved values
        // win — exactly like `quotedAt` above. Left off this list, a car park
        // named in this browser is forgotten by a reload and every line that
        // pointed at it loses its place.
        shiftPatterns: s.shiftPatterns !== undefined ? s.shiftPatterns : w.shiftPatterns,
        patterns: s.patterns !== undefined ? s.patterns : w.patterns,
        places: s.places !== undefined ? s.places : w.places,
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

  // Default the deployment registers before anything reads them. Ahead of
  // `normaliseEventInfo`, which prices a quote version and so walks the lines.
  WOFS.forEach(normaliseWof);

  // Fill event-info fields on seeds and on anything saved under an older schema.
  WOFS.forEach(normaliseEventInfo);

  // Events seeded before role groups merged still carry duplicates.
  mergeSavedRoleGroups();

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

  if (healed) save();

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
  // Neutral wording on purpose. A job whose reference still carries the `HH-`
  // prefix was sent under the old integration, and a backfilled entry claiming
  // it went to EP HOP would be this system rewriting history it was not there
  // for. `backfillHistory` only ever runs on a job with NO history, so it can
  // never duplicate a real entry written by the prep transitions.
  if (w.picking && w.picking.pushedAt)
    add('picking', w.picking.pushedAt, 'm-pete', `Kit list sent to the warehouse (${w.picking.epHopRef})`);
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
        v: 7,
        savedAt: new Date().toISOString(),
        shift: SHIFT_DAYS,
        wofs: WOFS,
        events: seededEvents(),
        issued: issuedHigh,
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

/**
 * `record`, for a module that legitimately writes to a job's history but is
 * not this one.
 *
 * The warehouse (`lib/hop.ts`) is the only caller, and it exists because the
 * dependency runs the other way — see `registerStockGuard`. Narrow on purpose:
 * a history entry and nothing else. Anything that changes the JOB still has to
 * come through a mutation in this file.
 */
export function recordExternal(
  w: Wof,
  entry: Partial<HistoryEntry> & { stage: WofStage; note: string },
  actor: Actor,
): void {
  record(w, entry, actor);
  save();
}

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
  if (w.picking) keeps.push(`EP HOP still holds list ${w.picking.epHopRef}`);
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

export function addLine(
  w: Wof,
  chargeId: string,
  cfg: LineConfig = {},
  actor: Actor = OPERATOR,
): LineItem {
  const isVariation = atLeast(w, 'signoff') && !!w.signoff;
  const during = isVariation && new Date(w.start) <= NOW && NOW <= new Date(w.end);
  const l = line(chargeId, {
    ...cfg,
    clientId: cfg.clientId ?? w.clientId,
    pricedAt: cfg.pricedAt || new Date(NOW).toISOString(),
    addedAt: new Date(NOW).toISOString(),
    source: isVariation ? 'variation' : 'quote',
    duringEvent: during,
  });
  w.lines.push(l);
  // A patterned line arrives with placeholder totals — `line()` cannot derive
  // them because it has no WOF to resolve the pattern against. Do it here,
  // before anything reads the value, so the history entry below quotes the real
  // number rather than one shift of one hour.
  syncDerived(w, l);
  record(
    w,
    {
      stage: w.stage,
      note: `${isVariation ? 'Variation' : 'Quote line'} added: ${l.description} — ${money(lineValue(l))}${during ? ' (added during the event)' : ''}`,
    },
    actor,
  );
  noteChange(
    w,
    isVariation ? 'variation' : 'quote',
    `Added ${l.description}: ${l.qty} × ${l.units} ${l.unitLabel}${l.units === 1 ? '' : 's'} at ${money(lineRate(l))} — ${money(lineValue(l))}`,
    actor,
  );
  save();
  return l;
}

/* ==========================================================================
   DEPLOYMENTS — creating them, grouping them, copying them
   ========================================================================== */

const rid = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2, 9)}`;

/** Give a job the company's standard windows if it has none. Idempotent. */
export function ensureShiftPatterns(w: Wof): ShiftPattern[] {
  if (!w.shiftPatterns) w.shiftPatterns = [];
  if (!w.shiftPatterns.length) {
    w.shiftPatterns = COMPANY_SHIFT_PATTERNS.map((sp) => ({ ...sp }));
  }
  return w.shiftPatterns;
}

/** Add a place to the job's register, or return the one already named that. */
export function addPlace(w: Wof, name: string, note = ''): Place {
  if (!w.places) w.places = [];
  const trimmed = name.trim();
  // Matched case-insensitively: "Alley Farm" and "alley farm" being two places
  // is exactly how the spreadsheet's location column became 34 labels for 10
  // car parks.
  const existing = w.places.find((pl) => pl.name.toLowerCase() === trimmed.toLowerCase());
  if (existing) return existing;
  const pl: Place = { id: rid('pl'), name: trimmed, note };
  w.places.push(pl);
  save();
  return pl;
}

/**
 * Add a one-off window to THIS job's library.
 *
 * Scoped to the job, not the company: 24 of the Reading sheet's 36 windows are
 * used exactly once, and promoting every one of them to a company default would
 * turn a twelve-chip picker into a forty-chip list within a season.
 */
export function addJobPattern(w: Wof, name: string, start: string, end: string): ShiftPattern {
  ensureShiftPatterns(w);
  const existing = w.shiftPatterns!.find((sp) => sp.start === start && sp.end === end);
  if (existing) return existing;
  const sp: ShiftPattern = {
    id: rid('sp'), name: name.trim() || `${start}–${end}`, start, end, scope: 'job',
  };
  w.shiftPatterns!.push(sp);
  save();
  return sp;
}

/**
 * One deployment as the builder creates it: a place, the windows worked there,
 * and a sparse matrix of roles against those windows.
 */
export interface DeploymentSpec {
  area: string;
  placeId: string | null;
  /** One per column of the matrix. Each carries its OWN day selection. */
  columns: { shiftPatternId: string; days: number[] }[];
  /**
   * The matrix, sparse. An absent or all-zero cell means "this role does not
   * work that window here" — a real answer, not a gap.
   */
  cells: { shiftPatternId: string; chargeId: string; perDay: number[] }[];
  /**
   * Kit and services bought FOR this place, alongside the people standing in
   * it: twelve radios and forty barriers on the Blue car park.
   *
   * Not cells, because they have no window. A radio is on hire for DAYS, and
   * the days are the span the deployment covers - the first day anybody works
   * here to the last. `quantity` is items, and the money layer reads it the
   * way it always has: `qty x units x rate`, units being days for a per-day
   * charge and 1 for a per-each one.
   */
  items?: {
    chargeId: string;
    qty: number;
    subHire?: boolean;
    /**
     * Kit only, and only when the caller already knows the window - copy and
     * clone, which carry an existing line's hire across. Left out by the
     * builder, where the days come from the columns.
     */
    hire?: { from: number; to: number };
  }[];
  note?: string;
}

/**
 * The hire window a deployment's kit is out for: the first day anybody works
 * at this place to the last, inclusive.
 *
 * Contiguous on purpose, and NOT the union of the day dots. Kit does not go
 * back to the yard on the Wednesday because nobody is rostered that day - it
 * sits in the car park. `null` means the whole span, which is what the absence
 * of `hire` already means, so a full-span deployment stores nothing extra.
 */
export function itemHire(w: Wof, columns: { days: number[] }[]): { from: number; to: number } | null {
  const days = columns.flatMap((c) => c.days).filter((d) => Number.isFinite(d));
  if (!days.length) return null;
  const from = Math.min(...days);
  const to = Math.max(...days);
  return from === 1 && to === eventDays(w) ? null : { from, to };
}

/** Why this deployment cannot be added, or `null`. */
export function deploymentBlock(w: Wof, spec: DeploymentSpec): string | null {
  const items = (spec.items || []).filter((i) => i.qty > 0);
  // Kit alone is a real deployment: forty barriers on a car park nobody is
  // rostered to is a thing EP sells. With no window to take its days from it
  // is out for the whole span, which is what an absent hire window means.
  if (!spec.columns.length && !items.length) return 'Pick at least one shift pattern.';
  if (spec.columns.some((c) => !c.days.length)) {
    return 'Every shift pattern needs at least one day. Clear the pattern, or pick its days.';
  }
  const days = eventDays(w);
  if (spec.columns.some((c) => c.days.some((d) => d < 1 || d > days))) {
    return `This job is ${countLabel(days, 'day')} long. One of the patterns names a day it does not have.`;
  }
  // Staff are sold by the shift, in a named window, on named days. Put one in
  // the kit list and it would bill a flat quantity against a per-hour rate -
  // silently, and wrongly. The matrix is the only door for a person.
  const person = items.find((i) => (rateAt(i.chargeId, NOW) || { kind: '' }).kind === 'staff');
  if (person) {
    const name = rateAt(person.chargeId, NOW)?.name || 'That role';
    return `${name} is a person, not kit. Put them in the matrix with a shift pattern.`;
  }
  if (!spec.cells.some((c) => c.perDay.some((n) => n > 0)) && !items.length) {
    return 'Nothing is deployed yet. Put a headcount against a role, or a quantity against a kit or service line.';
  }
  // Measured per cell, so one over-long window does not block the other ten.
  for (const c of spec.cells) {
    if (!c.perDay.some((n) => n > 0)) continue;
    const sp = (w.shiftPatterns || []).find((s) => s.id === c.shiftPatternId);
    const over = sp ? spanBlock(w, c.chargeId, patternHours(sp)) : null;
    if (over) return over;
  }
  return null;
}

/**
 * Add a whole deployment in one mutation.
 *
 * Atomic because a pattern and its lines are meaningless apart: a pattern with
 * no lines is invisible on every screen, and a line whose `patternId` dangles
 * cannot be priced. One history entry too — eleven rows for one operator action
 * is a log nobody reads.
 *
 * Returns the lines created, or `null` when `deploymentBlock` refuses. Refusing
 * rather than adding nothing silently: an operator who clicked a button and saw
 * the dialog close is entitled to know what happened.
 */
export function addDeployment(
  w: Wof,
  spec: DeploymentSpec,
  actor: Actor = OPERATOR,
  /**
   * Suppress this block's own history entry and quote version.
   *
   * For the bulk callers - copy-to-places and clone - which add several blocks
   * in one operator action and write ONE entry for the lot. Nine history rows
   * and nine versions for one click is a paper trail nobody reads, and the
   * version picker is where it hurts most.
   */
  quiet = false,
): LineItem[] | null {
  if (deploymentBlock(w, spec)) return null;

  ensureShiftPatterns(w);
  if (!w.patterns) w.patterns = [];

  const isVariation = atLeast(w, 'signoff') && !!w.signoff;
  const during = isVariation && new Date(w.start) <= NOW && NOW <= new Date(w.end);
  const priced = new Date(NOW).toISOString();
  const made: LineItem[] = [];

  spec.columns.forEach((col) => {
    const cells = spec.cells.filter(
      (c) => c.shiftPatternId === col.shiftPatternId && c.perDay.some((n) => n > 0),
    );
    // A column nobody was put against adds no pattern. Otherwise an operator
    // who ticked a window and changed their mind leaves an empty group behind.
    if (!cells.length) return;

    const days = [...col.days].sort((a, b) => a - b);
    const pat: LinePattern = {
      id: rid('pat'),
      area: spec.area.trim(),
      placeId: spec.placeId,
      shiftPatternId: col.shiftPatternId,
      days,
    };
    w.patterns!.push(pat);

    cells.forEach((c) => {
      const l = line(c.chargeId, {
        clientId: w.clientId,
        pricedAt: priced,
        addedAt: priced,
        addedBy: actor.by,
        source: isVariation ? 'variation' : 'quote',
        duringEvent: during,
        note: spec.note || '',
        patternId: pat.id,
        // Re-cut against the sorted days so the two can never disagree.
        perDay: days.map((d) => c.perDay[col.days.indexOf(d)] || 0),
      });
      syncDerived(w, l);
      w.lines.push(l);
      made.push(l);
    });
  });

  /* Kit and services at this place. No pattern, because they have no window -
     a placement instead, and a hire window taken from the days the deployment
     covers. Added after the columns so the operator's reading order and the
     quote's line order are the same one. */
  const shared = itemHire(w, spec.columns);
  const allDays = eventDays(w);
  (spec.items || [])
    .filter((it) => it.qty > 0)
    .forEach((it) => {
      /* The item's own window when it has one - the radios go out with the
         build crew and the signage comes off at breakdown - and the
         deployment's otherwise. A window covering the whole span is stored as
         NO window, because that is already what an absent `hire` means and
         writing it twice gives two places for it to go stale. */
      const own = it.hire || shared;
      const whole = !own || (own.from <= 1 && own.to >= allDays);
      const dayCount = whole ? allDays : own!.to - own!.from + 1;
      const l = line(it.chargeId, {
        clientId: w.clientId,
        pricedAt: priced,
        addedAt: priced,
        addedBy: actor.by,
        source: isVariation ? 'variation' : 'quote',
        duringEvent: during,
        note: spec.note || '',
        qty: it.qty,
        placement: { area: spec.area.trim(), placeId: spec.placeId },
        // `hire` is kit's own field and means nothing on a service - see the
        // note on `LineItem.hire`. A per-day service takes the same day count
        // without pretending to be on hire from the yard.
        ...(rateAt(it.chargeId, NOW)?.kind === 'kit' && !whole ? { hire: own! } : {}),
        ...(it.subHire ? { subHire: true } : {}),
      });
      // An `each` charge bills once, not once a day: a traffic management plan
      // is written one time whether the job runs for two days or ten.
      l.units = l.unitLabel === 'each' ? 1 : dayCount;
      syncDerived(w, l);
      w.lines.push(l);
      made.push(l);
    });

  if (!made.length) return null;

  const place = (w.places || []).find((pl) => pl.id === spec.placeId);
  const value = made.reduce((s, l) => s + lineValue(l), 0);
  // Patterned lines only. A barrier is not a shift, and counting forty of them
  // as forty shifts would put a number in the history nobody could reconcile.
  const shifts = made.filter((l) => l.patternId).reduce((s, l) => s + lineShifts(w, l), 0);
  const where = `${spec.area}${place ? ` — ${place.name}` : ''}`;
  if (!quiet) {
    const what =
      `${where} · ${countLabel(made.length, 'line')}, ` +
      `${countLabel(shifts, 'shift')}, ${money(value)}`;
    record(
      w,
      {
        stage: w.stage,
        note: `${isVariation ? 'Variation' : 'Deployment'} added: ${what}` +
          `${during ? ' (added during the event)' : ''}`,
      },
      actor,
    );
    noteChange(w, isVariation ? 'variation' : 'quote', `Deployed ${what}`, actor);
  }
  save();
  return made;
}


/* ------------------------------------------------------ clone from last year

   Reading 2026 is Reading 2025 with new dates and adjusted counts. Cloning
   turns "type 129 rows" into "change the ones that moved", which is the largest
   single saving in this whole model - larger than the builder it feeds.

   Two things are deliberately NOT copied.

   Rates. A cloned line is priced against TODAY's charge table, not last year's
   frozen snapshot. Carrying a 2025 rate into a 2026 quote is how a job gets
   sold at a price the company no longer charges, and the whole point of
   `rateAt` is that a quote is priced when it is raised.

   Days, literally. The two jobs rarely share a shape - last year's Thursday is
   this year's Friday, and a run can gain a build day. Days are remapped THROUGH
   THE PHASE they belong to, so build day 2 stays build day 2 and event day 3
   stays event day 3, rather than day 4 becoming day 4 and quietly moving a
   night shift into the breakdown.                                         --- */

/**
 * Where day `d` of `from` lands in `to`, or `null` when `to` has no such day.
 *
 * Dropping rather than clamping. A shorter run genuinely has fewer days to
 * staff, and folding two days of cover onto one would double a car park's
 * headcount without anybody asking.
 */
export function remapDay(from: Wof, to: Wof, d: number): number | null {
  const a = liveWindow(from);
  const b = liveWindow(to);
  if (!a.days || !b.days) return null;

  if (d < a.from) {
    // Build, counted BACK from the first event day: the day before the event
    // stays the day before the event even when a build day is added.
    const before = a.from - d;
    const landed = b.from - before;
    return landed >= 1 ? landed : null;
  }
  if (d > a.to) {
    const after = d - a.to;
    const landed = b.to + after;
    return landed <= b.days ? landed : null;
  }
  const offset = d - a.from;
  const landed = b.from + offset;
  return landed <= b.to ? landed : null;
}

/** Jobs whose deployments could be cloned onto this one. */
export function cloneSources(w: Wof): Wof[] {
  return WOFS.filter(
    (x) => x.id !== w.id && x.clientId === w.clientId && deployments(x).length > 0,
  ).sort((a, b) => +new Date(b.start) - +new Date(a.start));
}

export interface CloneResult {
  places: number;
  patterns: number;
  lines: number;
  shifts: number;
  value: number;
  /** Days that had nowhere to land, so the operator can go and look. */
  droppedDays: number;
  /** Patterns whose every day was dropped. */
  droppedPatterns: number;
}

/**
 * Copy another job's whole deployment structure onto this one.
 *
 * Additive, never destructive: an operator who clones onto a quote that already
 * has lines gets both, because deleting somebody's work to make room for a
 * convenience is not a trade the convenience is worth.
 */
export function cloneDeployments(from: Wof, to: Wof, actor: Actor = OPERATOR): CloneResult {
  const out: CloneResult = {
    places: 0, patterns: 0, lines: 0, shifts: 0, value: 0, droppedDays: 0, droppedPatterns: 0,
  };
  ensureShiftPatterns(to);
  if (!to.places) to.places = [];
  if (!to.patterns) to.patterns = [];

  // Places, by NAME. A place already on the target keeps its own id and its own
  // note - the operator may have corrected last year's meeting point.
  const placeMap = new Map<string, string>();
  (from.places || []).forEach((pl) => {
    const before = to.places!.length;
    const landed = addPlace(to, pl.name, pl.note);
    if (to.places!.length > before) out.places++;
    placeMap.set(pl.id, landed.id);
  });

  // Windows, by TIMES. A company pattern matches a company pattern; a one-off
  // window from last year is re-added to this job's library.
  const winMap = new Map<string, string>();
  (from.shiftPatterns || []).forEach((sp) => {
    const same = to.shiftPatterns!.find((x) => x.start === sp.start && x.end === sp.end);
    winMap.set(sp.id, same ? same.id : addJobPattern(to, sp.name, sp.start, sp.end).id);
  });

  const priced = new Date(NOW).toISOString();
  // Cloning onto a job the client has already signed is extra money on an
  // agreed price, whatever the operator's intent was.
  const cloneSource: LineSource =
    atLeast(to, 'signoff') && to.signoff ? 'variation' : 'quote';

  (from.patterns || []).forEach((pat) => {
    const days: number[] = [];
    pat.days.forEach((d) => {
      const landed = remapDay(from, to, d);
      if (landed === null) out.droppedDays++;
      else if (!days.includes(landed)) days.push(landed);
    });
    days.sort((a, b) => a - b);

    const sourceLines = (from.lines || []).filter((l) => l.patternId === pat.id);
    if (!sourceLines.length) return;
    if (!days.length) {
      out.droppedPatterns++;
      return;
    }

    const copy: LinePattern = {
      id: rid('pat'),
      area: pat.area,
      placeId: pat.placeId ? placeMap.get(pat.placeId) || null : null,
      shiftPatternId: winMap.get(pat.shiftPatternId) || pat.shiftPatternId,
      days,
    };
    to.patterns!.push(copy);
    out.patterns++;

    sourceLines.forEach((src) => {
      const l = line(src.chargeId, {
        // TODAY's rate card, not last year's. See the note above.
        clientId: to.clientId,
        pricedAt: priced,
        addedAt: priced,
        addedBy: actor.by,
        description: src.description,
        note: src.note,
        source: cloneSource,
        patternId: copy.id,
        // Headcounts follow the DAY they were quoted for, not its position in
        // the list: a dropped day must take its own number with it, not shunt
        // every later day's headcount one place to the left.
        perDay: days.map((d) => {
          const original = pat.days.find((od) => remapDay(from, to, od) === d);
          const i = original === undefined ? -1 : pat.days.indexOf(original);
          return i < 0 ? 0 : (src.perDay || [])[i] || 0;
        }),
      });
      syncDerived(to, l);
      to.lines.push(l);
      out.lines++;
      out.shifts += lineShifts(to, l);
      out.value = round2(out.value + lineValue(l));
    });
  });

  /* The kit and services placed at those car parks. Same rule as the people:
     the hire window is remapped through its PHASE, and a window with nowhere
     to land falls back to the whole span rather than dropping the line - a
     shorter run still needs its barriers. */
  (from.lines || [])
    .filter((l) => !l.patternId && l.placement)
    .forEach((src) => {
      const where = src.placement!;
      const landedFrom = src.hire ? remapDay(from, to, src.hire.from) : null;
      const landedTo = src.hire ? remapDay(from, to, src.hire.to) : null;
      const hire =
        landedFrom !== null && landedTo !== null && landedTo >= landedFrom
          ? { from: landedFrom, to: landedTo }
          : null;
      if (src.hire && !hire) out.droppedDays++;
      const l = line(src.chargeId, {
        clientId: to.clientId,
        pricedAt: priced,
        addedAt: priced,
        addedBy: actor.by,
        description: src.description,
        note: src.note,
        source: cloneSource,
        qty: src.qty,
        placement: {
          area: where.area,
          placeId: where.placeId ? placeMap.get(where.placeId) || null : null,
        },
        ...(src.kind === 'kit' && hire ? { hire } : {}),
        ...(src.subHire ? { subHire: true } : {}),
      });
      l.units =
        l.unitLabel === 'each' ? 1 : hire ? hire.to - hire.from + 1 : eventDays(to);
      syncDerived(to, l);
      to.lines.push(l);
      out.lines++;
      out.value = round2(out.value + lineValue(l));
    });

  if (out.lines) {
    record(
      to,
      {
        stage: to.stage,
        note:
          `Deployments cloned from ${from.ref} ${from.title}: ` +
          `${countLabel(out.lines, 'line')}, ${countLabel(out.shifts, 'shift')}, ${money(out.value)}` +
          (out.droppedPatterns
            ? ` (${countLabel(out.droppedPatterns, 'pattern')} dropped - no matching days on this run)`
            : ''),
      },
      actor,
    );
    noteChange(
      to,
      // A clone onto a signed job is extra money on an agreed price, and the
      // paper trail has to call it what it is.
      atLeast(to, 'signoff') && to.signoff ? 'variation' : 'quote',
      `Deployments cloned from ${from.ref}: ${countLabel(out.lines, 'line')}, ${money(out.value)}`,
      actor,
    );
    save();
  }
  return out;
}

/** One place's worth of deployment, as the grid and the copy action see it. */
export interface DeploymentView {
  key: string;
  area: string;
  placeId: string | null;
  placeName: string;
  columns: { pattern: LinePattern; window: ShiftPattern | null; lines: LineItem[] }[];
  lines: LineItem[];
  /**
   * Kit and services placed here. Separate from `lines` because they answer a
   * different question - `lines` is who stands here, `items` is what is here -
   * and because every total on the left of this record is about shifts.
   */
  items: LineItem[];
  shifts: number;
  hours: number;
  /** Staff and kit together: what this place costs the client. */
  value: number;
}

/**
 * The job's patterned lines, grouped the way the client sheet is: by area, then
 * by place, then by window.
 *
 * Grouped on `patternId` rather than by comparing area, place and times,
 * because a later edit to any of the three would silently split one group in
 * two on screen while the data still said it was one.
 */
export function deployments(w: Wof, source?: LineSource): DeploymentView[] {
  const lines = (w.lines || []).filter((l) => l.patternId && (!source || l.source === source));
  const order: string[] = [];
  const byKey = new Map<string, DeploymentView>();

  lines.forEach((l) => {
    const pat = linePattern(w, l);
    if (!pat) return;
    const key = `${pat.area} ${pat.placeId || ''}`;
    if (!byKey.has(key)) {
      order.push(key);
      const place = (w.places || []).find((pl) => pl.id === pat.placeId);
      byKey.set(key, {
        key,
        area: pat.area,
        placeId: pat.placeId,
        // A deployment with no place is a real shape — road closures cover a
        // ring road, not a spot — so it is named, not left blank.
        placeName: place ? place.name : 'Across the site',
        columns: [], lines: [], items: [], shifts: 0, hours: 0, value: 0,
      });
    }
    const view = byKey.get(key)!;
    let col = view.columns.find((c) => c.pattern.id === pat.id);
    if (!col) {
      col = { pattern: pat, window: lineWindow(w, l), lines: [] };
      view.columns.push(col);
    }
    col.lines.push(l);
    view.lines.push(l);
    view.shifts += lineShifts(w, l);
    view.hours = round2(view.hours + lineHours(w, l));
    view.value = round2(view.value + lineValue(l));
  });

  /* The kit and services standing with them. A place can have kit and no
     people - forty barriers on a car park nobody is rostered to - so this
     opens a group of its own rather than only joining one. */
  (w.lines || [])
    .filter((l) => !l.patternId && l.placement && (!source || l.source === source))
    .forEach((l) => {
      const where = l.placement!;
      const key = `${where.area} ${where.placeId || ''}`;
      if (!byKey.has(key)) {
        order.push(key);
        const place = (w.places || []).find((pl) => pl.id === where.placeId);
        byKey.set(key, {
          key,
          area: where.area,
          placeId: where.placeId,
          placeName: place ? place.name : 'Across the site',
          columns: [], lines: [], items: [], shifts: 0, hours: 0, value: 0,
        });
      }
      const view = byKey.get(key)!;
      view.items.push(l);
      view.value = round2(view.value + lineValue(l));
    });

  // Windows in clock order within a place, so days read before nights.
  byKey.forEach((v) =>
    v.columns.sort((a, b) => (a.window?.start || '').localeCompare(b.window?.start || '')),
  );
  return order.map((k) => byKey.get(k)!);
}

/**
 * Copy a deployment to other places, wholesale.
 *
 * The strongest repetition on a real quote: `06:00-15:00` appears at twelve
 * different car parks on the Reading sheet. Copy-AFTER-verify, deliberately —
 * an operator duplicates a block they have already checked, rather than a
 * places x windows x roles multi-select generating cells that were never real.
 * Deleting seven wrong lines is worse than adding eleven right ones.
 */
export function copyDeploymentToPlaces(
  w: Wof,
  key: string,
  placeIds: string[],
  actor: Actor = OPERATOR,
): LineItem[] {
  const view = deployments(w).find((d) => d.key === key);
  if (!view || !placeIds.length) return [];

  const made: LineItem[] = [];
  placeIds.forEach((placeId) => {
    // Copying onto the place it came from would double that car park's cover
    // without anybody asking for it.
    if (placeId === view.placeId) return;
    const added = addDeployment(
      w,
      {
        area: view.area,
        placeId,
        columns: view.columns.map((c) => ({
          shiftPatternId: c.pattern.shiftPatternId,
          days: [...c.pattern.days],
        })),
        cells: view.columns.flatMap((c) =>
          c.lines.map((l) => ({
            shiftPatternId: c.pattern.shiftPatternId,
            chargeId: l.chargeId,
            perDay: [...(l.perDay || [])],
          })),
        ),
        // The second car park needs the same barriers as the first. Copying
        // the people and leaving the kit would be a block the operator has
        // NOT already checked, which is the one thing this action promises.
        items: view.items.map((l) => ({
          chargeId: l.chargeId,
          qty: l.qty,
          ...(l.subHire ? { subHire: true } : {}),
          ...(l.hire ? { hire: { ...l.hire } } : {}),
        })),
      },
      actor,
      true,
    );
    if (added) made.push(...added);
  });

  if (made.length) {
    const names = placeIds
      .filter((id) => id !== view.placeId)
      .map((id) => (w.places || []).find((pl) => pl.id === id)?.name)
      .filter(Boolean)
      .join(', ');
    const value = made.reduce((s, l) => s + lineValue(l), 0);
    const what =
      `${view.area} — ${view.placeName} copied to ${names || 'other places'}: ` +
      `${countLabel(made.length, 'line')}, ${money(value)}`;
    record(w, { stage: w.stage, note: what }, actor);
    noteChange(w, made[0].source === 'variation' ? 'variation' : 'quote', what, actor);
    save();
  }
  return made;
}


/* ------------------------------------------------------------ cell edits ---
   The tweak that follows every quote is "make Saturday 15, not 12". Sending an
   operator back through the builder for one number is the kind of friction that
   sends people back to the spreadsheet, so the grid is editable in place and
   these are what it writes through.                                      --- */

/**
 * Set one day's headcount on one line.
 *
 * Refuses a day the line's pattern does not name: putting a number in a cell
 * the deployment does not cover would silently extend the run. Adding the day
 * is `setPatternDays`, and it is a different decision.
 */
export function setHeadcount(
  w: Wof,
  lineId: string,
  dayNo: number,
  n: number,
  actor: Actor = OPERATOR,
): boolean {
  const l = w.lines.find((x) => x.id === lineId);
  if (!l) return false;
  const pat = linePattern(w, l);
  if (!pat || !l.perDay) return false;
  const i = pat.days.indexOf(dayNo);
  if (i < 0) return false;

  const next = Math.max(0, Math.round(n) || 0);
  if (l.perDay[i] === next) return true;

  const before = lineValue(l);
  l.perDay[i] = next;
  syncDerived(w, l);

  record(
    w,
    {
      stage: w.stage,
      note:
        `${l.description}, day ${dayNo}: ${countLabel(next, 'person')} ` +
        `(${money(before)} → ${money(lineValue(l))})`,
    },
    actor,
  );
  noteChange(
    w,
    l.source === 'variation' ? 'variation' : 'quote',
    `${l.description} day ${dayNo} set to ${next} — ${money(before)} to ${money(lineValue(l))}`,
    actor,
  );
  save();
  return true;
}

/**
 * Set the quantity on a kit or services line - forty barriers, not thirty.
 *
 * `setHeadcount` for the things that do not stand a shift. Until this existed
 * the only way to change a number the client had already been quoted was to
 * delete the line and add it again, which threw away its hire window, its
 * sub-hire flag and the place it stands at - three facts nobody was asking to
 * change, lost to changing a fourth.
 *
 * A STAFF line is refused by name. Its `qty` is the shift count, derived by
 * `syncDerived` from the pattern and the per-day headcounts; a number typed
 * here would survive exactly until the next re-cut and until then the money
 * would disagree with the grid it was read off. The number to edit on a staff
 * line is the cell, and there is one under every day.
 *
 * Nought is refused too. A line quoted at nothing is invisible money that
 * still prints on the client's document; removing it is `removeLine`, which
 * says so and is audited as a removal.
 *
 * The rate is not touched but it can MOVE: `lineRate` tiers on `qty`, so
 * crossing a tier boundary reprices the line off the rate card already agreed
 * with the client. That is why the note carries the money and not just the
 * count - "40 cones" is not news, "40 cones, £510 becomes £612" is.
 */
export function setQty(w: Wof, lineId: string, n: number, actor: Actor = OPERATOR): boolean {
  const l = w.lines.find((x) => x.id === lineId);
  if (!l || l.kind === 'staff' || l.patternId) return false;

  const next = Math.round(n);
  if (!(next > 0)) return false;
  if (l.qty === next) return true;

  const wasQty = l.qty;
  const before = lineValue(l);
  const wasRate = lineRate(l);
  l.qty = next;
  syncDerived(w, l);

  const tier =
    lineRate(l) !== wasRate ? ` (tier: ${money(wasRate)} → ${money(lineRate(l))} each)` : '';
  const what =
    `${l.description}: ${wasQty} → ${next}${tier} — ${money(before)} → ${money(lineValue(l))}`;
  record(w, { stage: w.stage, note: what }, actor);
  noteChange(w, l.source === 'variation' ? 'variation' : 'quote', what, actor);
  save();
  return true;
}

/**
 * Add or remove a day from a whole pattern, re-cutting every line under it.
 *
 * A day gained is quoted at the headcount that pattern already runs elsewhere -
 * the median of the days it does cover - because a new column of zeroes reads
 * as "nobody" and an operator who added the day plainly wants somebody. A day
 * lost takes its headcounts with it.
 */
export function setPatternDays(
  w: Wof,
  patternId: string,
  days: number[],
  actor: Actor = OPERATOR,
): boolean {
  const pat = (w.patterns || []).find((p) => p.id === patternId);
  if (!pat) return false;

  const span = eventDays(w);
  const next = [...new Set(days)].filter((d) => d >= 1 && d <= span).sort((a, b) => a - b);
  // A pattern with no days is invisible on every screen while its lines still
  // price. Removing the last day is `removeDeployment`, which says so.
  if (!next.length) return false;
  if (next.join() === pat.days.join()) return true;

  const was = pat.days;
  const before = w.lines
    .filter((l) => l.patternId === patternId)
    .reduce((s, l) => s + lineValue(l), 0);

  // The pattern moves FIRST. `syncDerived` re-cuts any `perDay` that disagrees
  // with the pattern's days, so re-cutting the lines while the pattern still
  // held the old list had it undo the work on the way out.
  pat.days = next;
  w.lines
    .filter((l) => l.patternId === patternId)
    .forEach((l) => {
      const old = l.perDay || [];
      const covered = was.map((_d, i) => old[i] || 0).filter((n) => n > 0).sort((a, b) => a - b);
      const typical = covered.length ? covered[Math.floor(covered.length / 2)] : 0;
      l.perDay = next.map((d) => {
        const i = was.indexOf(d);
        return i >= 0 ? old[i] || 0 : typical;
      });
      syncDerived(w, l);
    });

  const after = w.lines
    .filter((l) => l.patternId === patternId)
    .reduce((s, l) => s + lineValue(l), 0);
  const place = (w.places || []).find((pl) => pl.id === pat.placeId);
  const what =
    `${pat.area}${place ? ` — ${place.name}` : ''} now runs ` +
    `${countLabel(next.length, 'day')} (was ${was.length}) — ` +
    `${money(before)} to ${money(after)}`;
  record(w, { stage: w.stage, note: what }, actor);
  noteChange(w, 'quote', what, actor);
  save();
  return true;
}

/** Remove a whole deployment — its patterns and every line hanging off them. */
export function removeDeployment(w: Wof, key: string, actor: Actor = OPERATOR): number {
  const view = deployments(w).find((d) => d.key === key);
  if (!view) return 0;
  const patIds = new Set(view.columns.map((c) => c.pattern.id));
  const itemIds = new Set(view.items.map((l) => l.id));
  const value = view.value;
  // The kit placed here goes with the people. Leaving forty barriers behind on
  // a car park that no longer has a deployment is an orphan nobody would think
  // to look for, and the operator asked for the place to be cleared.
  const n = view.lines.length + view.items.length;

  w.lines = w.lines.filter((l) => !itemIds.has(l.id))
    .filter((l) => !l.patternId || !patIds.has(l.patternId));
  w.patterns = (w.patterns || []).filter((p) => !patIds.has(p.id));
  record(
    w,
    {
      stage: w.stage,
      note: `Deployment removed: ${view.area} — ${view.placeName} (${countLabel(n, 'line')}, ${money(value)})`,
    },
    actor,
  );
  save();
  return n;
}

export function removeLine(w: Wof, lineId: string, actor: Actor = OPERATOR): boolean {
  const i = w.lines.findIndex((l) => l.id === lineId);
  if (i < 0) return false;
  const [l] = w.lines.splice(i, 1);
  const gone = lineValue(l);
  record(w, { stage: w.stage, note: `Line removed: ${l.description} (${money(gone)})` }, actor);
  noteChange(
    w,
    l.source === 'variation' ? 'variation' : 'quote',
    `Removed ${l.description} — ${money(gone)}`,
    actor,
  );
  save();
  return true;
}

/** Explicit, audited re-pricing. Never automatic. */
export function repriceLine(w: Wof, lineId: string, actor: Actor = OPERATOR): boolean {
  const l = w.lines.find((x) => x.id === lineId);
  if (!l) return false;
  const before = lineValue(l);
  l.snap = RATES.rateFor(l.chargeId, w.clientId, NOW);
  record(
    w,
    {
      stage: w.stage,
      note: `Line re-priced to the current rate card: ${l.description}, ${money(before)} → ${money(lineValue(l))}`,
    },
    actor,
  );
  // Only when the money actually moved. A re-price against the same rate card
  // is a button press, not a change, and putting it on the next document
  // teaches the client to skim what changed instead of reading it.
  if (Math.round(before * 100) !== Math.round(lineValue(l) * 100)) {
    noteChange(
      w,
      l.source === 'variation' ? 'variation' : 'quote',
      `Re-priced ${l.description} to the current rate card — ${money(before)} → ${money(lineValue(l))}`,
      actor,
    );
  }
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

/* --------------------------------------------------------- sending a quote --
   Pricing and sending were the same act, and they are not the same act. A line
   added from the table of charges appeared in the client's portal immediately,
   which meant EP Team could not build a quote in more than one sitting without
   the client watching it happen — reading a half-priced job, seeing a figure
   that was never meant as an offer, and in the worst case signing it.

   `quotedAt` already existed on the model, was already stamped in the seed
   data, and was already read in three places as "sent". Nothing ever wrote it.
   So this is less a new field than the missing half of one.
   --------------------------------------------------------------------------- */

/** Whether the client can see this job at all. */
export const quoteSent = (w: Wof): boolean => !!w.quotedAt;
/* -------------------------------------------------- the quote paper trail --
   A quote is not one document. It is a sequence of them: priced, sent, argued
   about, repriced, sent again, signed. Keeping only the latest is why, when a
   client says "that is not what you quoted us", the only answer available is
   the current figure — which is precisely the thing in dispute.

   What is kept here is the VERSION, not the file. There is no server to put a
   PDF on, and even with one, a stored file and a live job record are two
   accounts of the same quote that can disagree. Instead SENDING freezes what
   the lines were at that moment, and the document is rendered from that
   snapshot on demand — see `lib/quotedoc`. Change the letterhead next year
   and a two-year-old version still prints correctly.

   Three rules hold the trail together:

     · A version is a DOCUMENT THAT WAS SENT. Nothing else writes one. Pricing
       is not publishing: an extra steward typed at 4pm while the account
       manager works out whether it is chargeable is a note on `quotePending`,
       and it stays there until a person decides the client should see it.
       So the trail says what it appears to say — every entry is a document
       the client was actually given, and `v4` names the same piece of paper
       on both sides of the conversation. The alternative, a version per
       keystroke, produces a fifteen-entry history of which the client has
       seen two, and nobody can tell which two without reading every row.

     · A version is IMMUTABLE. Nothing after it rewrites what it says. The
       stamps that follow — approved, queried, answered, signed — are recorded
       ON the version, because they are facts about that document rather than
       edits to it.

     · Variations run in their OWN sequence — VAR-1, VAR-2 — because they are
       agreed separately, line by line, after the quote is signed. Numbering
       them into the quote would imply the signed quote had changed, and it
       has not.
   --------------------------------------------------------------------------- */

export type QuoteDocKind = 'quote' | 'variation';

/**
 * A line as it was, not as it is. Fully resolved, so nothing has to be looked
 * up again to print it — the rate card can move underneath and this will not.
 */
export interface VersionLine {
  id: string;
  code: string;
  description: string;
  qty: number;
  units: number;
  unitLabel: ChargeUnit;
  rate: number;
  /** The standard rate, when a volume tier beat it. Null when none applied. */
  standardRate: number | null;
  value: number;
  note: string;
  /** The rate card this line was priced against. */
  pricedAt: string;
  addedBy: string;
  /** Variations only: where the client had got to with it. */
  clientApproval?: ClientApproval;
  /**
   * Where and when this line stood, frozen with everything else.
   *
   * The document renders from the snapshot, never from the live job, so the
   * grouping has to be IN the snapshot: re-deriving it from `w.patterns` at
   * print time would redraw a document the client already holds whenever
   * somebody renamed a car park.
   *
   * All three absent on kit, on services, and on anything quoted before
   * deployments shipped.
   */
  area?: string;
  place?: string;
  /** The window as words - "Nights 17:00-02:00". */
  window?: string;
}

/** The client's own words, kept verbatim, against the version they were sent. */
export interface QuoteObjection {
  at: string;
  by: string;
  byName: string;
  note: string;
}

/**
 * One edit to a priced line, made and not yet sent.
 *
 * Kept on the job rather than turned into a document, because an edit is not
 * an offer. These accumulate until somebody sends the quote, and the document
 * that goes out carries the lot as what changed since the last one — so the
 * client reads "three changes since v2", named, instead of receiving three
 * documents nobody meant to publish.
 */
export interface PendingChange {
  kind: QuoteDocKind;
  at: string;
  by: string;
  byName: string;
  /** The edit in one line, exactly as the next document will print it. */
  text: string;
}

/**
 * The client's answer to one line of a schedule they were sent.
 *
 * Recorded ON the version they were holding, not as a new one. Their answer
 * is a fact about that document — the same reasoning as `objection` on the
 * quote — and EP Team did not send anything when it arrived.
 */
export interface VersionAnswer {
  lineId: string;
  description: string;
  approval: ClientApproval;
  /** Their words, when they queried it. Empty on an acceptance. */
  note: string;
  at: string;
  by: string;
  byName: string;
}

export interface QuoteVersion {
  kind: QuoteDocKind;
  /** 1-based within its own sequence. */
  no: number;
  /** What the document calls itself: `v3`, or `VAR-2`. */
  label: string;
  at: string;
  by: string;
  byName: string;
  /** Why it went out, in one line: the edit itself, or a count of them. */
  change: string;
  /** Every edit this document carried, oldest first. Empty on a first send. */
  changes: PendingChange[];
  lines: VersionLine[];
  value: number;
  /**
   * When this version reached the client — which is when it was written, a
   * version being a send. Nullable only for the documents `normaliseEventInfo`
   * backfills onto jobs that predate the trail.
   */
  issuedAt: string | null;
  /** The approval in force over this figure, when one was needed. */
  approval: { by: string; byName: string; at: string; value: number } | null;
  /** Set when the client came back on this version. */
  objection: QuoteObjection | null;
  /** Variations only: what the client said to the lines on this document. */
  answers?: VersionAnswer[];
  /** Set when the client signed this version. */
  signedAt: string | null;
}

const versionSeq = (w: Wof, kind: QuoteDocKind): QuoteVersion[] =>
  (w.quoteVersions || []).filter((v) => v.kind === kind);

/** Every version of the quote, oldest first. */
export const quoteVersions = (w: Wof): QuoteVersion[] => versionSeq(w, 'quote');

/** Every version of the variation schedule, oldest first. */
export const variationVersions = (w: Wof): QuoteVersion[] => versionSeq(w, 'variation');

/**
 * The last document written for this sequence.
 *
 * Which is also the one the client is holding, versions being sends. The live
 * lines may well have moved past it — `pendingChanges` is that gap, and the
 * next send closes it.
 */
export const currentVersion = (w: Wof, kind: QuoteDocKind = 'quote'): QuoteVersion | null => {
  const seq = versionSeq(w, kind);
  return seq.length ? seq[seq.length - 1] : null;
};

/** Versions the client has actually been given. The only ones they may open. */
export const issuedVersions = (w: Wof, kind: QuoteDocKind = 'quote'): QuoteVersion[] =>
  versionSeq(w, kind).filter((v) => !!v.issuedAt);

/** The document the client is holding right now. */
export const latestIssued = (w: Wof, kind: QuoteDocKind = 'quote'): QuoteVersion | null => {
  const seq = issuedVersions(w, kind);
  return seq.length ? seq[seq.length - 1] : null;
};

/** Freeze the lines of one kind as they stand. */
function freezeLines(w: Wof, kind: QuoteDocKind): VersionLine[] {
  return w.lines
    .filter((l) => (kind === 'variation' ? l.source === 'variation' : l.source === 'quote'))
    .map((l) => {
      const rate = lineRate(l);
      const standard = l.snap ? l.snap.charge : rate;
      return {
        id: l.id,
        code: l.snap ? l.snap.code : '',
        description: l.description,
        qty: l.qty,
        units: l.units,
        unitLabel: l.unitLabel,
        rate,
        // Only when the tier actually beat the standard rate. Printing
        // "from £18.50" beside £18.50 is noise the reader has to decode.
        standardRate: standard !== rate ? standard : null,
        value: lineValue(l),
        note: l.note || '',
        pricedAt: l.snap ? l.snap.rateVersion : '',
        addedBy: l.addedBy,
        ...(l.source === 'variation' ? { clientApproval: l.clientApproval } : {}),
        ...deploymentStamp(w, l),
      };
    });
}

/** A line's deployment context, as words, for the frozen version. */
function deploymentStamp(
  w: Wof,
  l: LineItem,
): { area?: string; place?: string; window?: string } {
  // Kit and services placed at a car park get the area and the place and NO
  // window - which is the truth about them, and the reason `window` was
  // optional here from the start. The document groups them under the same
  // heading as the stewards, where the client is expecting to find them.
  const where = linePlacement(w, l);
  if (!where) return {};
  const place = (w.places || []).find((pl) => pl.id === where.placeId);
  const sp = lineWindow(w, l);
  return {
    area: where.area,
    place: place ? place.name : 'Across the site',
    ...(sp ? { window: `${sp.name} ${sp.start}-${sp.end}` } : {}),
  };
}

const kindValue = (w: Wof, kind: QuoteDocKind): number =>
  kind === 'variation' ? variationValue(w) : quoteValue(w);

/** The approval as a version stamps it — the four facts, none of the workflow. */
const approvalStamp = (a: QuoteApproval): { by: string; byName: string; at: string; value: number } => ({
  by: a.by,
  byName: a.byName,
  at: a.at,
  value: a.value,
});

/**
 * Note an edit to a priced line. What every line-changing function calls.
 *
 * Deliberately not a document. The client's copy of a quote is a thing they
 * were sent, so an edit made in the office has no version of its own — it is
 * a line on a list, waiting for somebody to decide it is worth sending. The
 * job history keeps its own entry for every one of these regardless, so
 * nothing is lost by not publishing it.
 */
function noteChange(w: Wof, kind: QuoteDocKind, text: string, actor: Actor = OPERATOR): void {
  w.quotePending = (w.quotePending || []).concat([
    { kind, at: new Date(NOW).toISOString(), by: actor.by, byName: actor.name, text },
  ]);
}

/** What has changed since the client was last sent this document. */
export const pendingChanges = (w: Wof, kind: QuoteDocKind = 'quote'): PendingChange[] =>
  (w.quotePending || []).filter((c) => c.kind === kind);

/** Has the priced work moved since the client was last sent it? */
export function hasUnsentChanges(w: Wof, kind: QuoteDocKind = 'quote'): boolean {
  if (pendingChanges(w, kind).length) return true;
  const last = currentVersion(w, kind);
  const lines = kind === 'variation' ? variationLines(w) : quoteLines(w);
  if (!last) return !!lines.length;
  // The value is the backstop for anything that moved a figure without going
  // through `noteChange` — seed data, an import, a path added later and
  // wired up wrong. Better a document that says "re-sent" than one that
  // quietly claims nothing changed.
  return Math.round(last.value * 100) !== Math.round(kindValue(w, kind) * 100);
}

/**
 * The one line a document leads with, given the edits it is carrying.
 *
 * One edit and it names itself; several and it counts them, because a
 * five-line summary in a table cell is not a summary. `first` is for the
 * opening document of a sequence, which supersedes nothing and has no edits
 * behind it — everything before it went into the quote itself.
 */
function changeHeadline(changes: PendingChange[], previous: QuoteVersion | null, first: string): string {
  if (changes.length === 1) return changes[0].text;
  if (changes.length)
    return `${countLabel(changes.length, 'change')}${previous ? ` since ${previous.label}` : ''}`;
  return previous ? `Sent again, superseding ${previous.label}` : first;
}

/**
 * Write a version — that is, send one. The only thing that writes to the
 * trail, and it is called only by the acts that put a document in front of
 * the client: `sendQuote`, `sendVariations`, and the signature back-stamp
 * that proves one must have gone out before it could be signed.
 *
 * It sweeps up every pending edit of this kind, prints them on the document
 * as what changed since the last one, and clears the list — so a version
 * carries the work of an afternoon rather than one keystroke of it.
 */
function issueVersion(
  w: Wof,
  kind: QuoteDocKind,
  first: string,
  actor: Actor = OPERATOR,
  at?: string,
): QuoteVersion | null {
  const lines = freezeLines(w, kind);
  // Nothing to document. Removing the last variation line leaves an empty
  // schedule, and an empty schedule is not a document — it is the absence of
  // one. The removal is in the history either way.
  if (!lines.length) return null;

  const seq = versionSeq(w, kind);
  const no = seq.length + 1;
  const stamp = at || new Date(NOW).toISOString();
  const changes = pendingChanges(w, kind);
  const approved =
    kind === 'quote' &&
    w.quoteApproval &&
    Math.round(w.quoteApproval.value * 100) >= Math.round(quoteValue(w) * 100);

  const v: QuoteVersion = {
    kind,
    no,
    label: kind === 'variation' ? `VAR-${no}` : `v${no}`,
    at: stamp,
    by: actor.by,
    byName: actor.name,
    change: changeHeadline(changes, seq[seq.length - 1] || null, first),
    changes,
    lines,
    value: kindValue(w, kind),
    // Written because it was sent. The two were separate fields when a
    // version could exist unsent; they cannot disagree any more.
    issuedAt: stamp,
    // Read now rather than copied later: an approval that has lapsed is not an
    // approval this version ever had.
    approval: approved ? approvalStamp(w.quoteApproval!) : null,
    objection: null,
    signedAt: null,
  };
  w.quoteVersions = (w.quoteVersions || []).concat([v]);
  w.quotePending = (w.quotePending || []).filter((c) => c.kind !== kind);
  return v;
}

/** The reference a document prints: `WOF-2026-0128 v3`. */
export const versionRef = (w: Wof, v: QuoteVersion): string => `${w.jobCode || w.ref} ${v.label}`;

/**
 * The client's outstanding objection, if there is one.
 *
 * Derived rather than stored. An objection is answered when EP Team has issued
 * the client something newer, which is a fact about the sequence — not a flag
 * somebody has to remember to clear. Stored flags are how a job ends up
 * showing a resolved complaint for a fortnight.
 */
export function openObjection(w: Wof): { version: QuoteVersion; objection: QuoteObjection } | null {
  const seq = quoteVersions(w);
  for (let i = seq.length - 1; i >= 0; i--) {
    const v = seq[i];
    if (!v.objection) continue;
    const answered = seq.slice(i + 1).some((x) => !!x.issuedAt);
    return answered ? null : { version: v, objection: v.objection };
  }
  return null;
}

/** Why the client cannot query the quote, or `null` when they can. */
export function queryQuoteBlock(w: Wof): string | null {
  if (!latestIssued(w, 'quote')) return 'There is no quote with you yet.';
  if (w.signoff) return 'You have signed this quote. Anything to change now is raised as a variation.';
  if (isTerminal(w.stage)) return 'This job is closed.';
  if (openObjection(w)) return 'You have already raised a query on this quote, and EP Team is looking at it.';
  return null;
}

/**
 * The client comes back on a quote: wrong numbers, wrong dates, too much.
 *
 * Recorded against the VERSION they were sent rather than against the job,
 * because the job will have moved on by the time anybody reads this, and "the
 * client objected" without saying to what is not a paper trail. Their words
 * are kept verbatim for the same reason.
 */
export function queryQuote(w: Wof, note: string, actor: Actor): boolean {
  if (queryQuoteBlock(w)) return false;
  const why = note.trim();
  if (!why) return false;

  const v = latestIssued(w, 'quote')!;
  v.objection = { at: new Date(NOW).toISOString(), by: actor.by, byName: actor.name, note: why };
  record(w, { stage: w.stage, note: `Quote queried by the client on ${v.label} — “${why}”` }, actor);
  save();
  return true;
}

/* ------------------------------------------------- approving a big quote ---
   A quote is priced by one person and, the moment it is sent, it is an offer
   the client can sign. Below a certain figure that is a reasonable amount of
   trust to place in one pair of eyes. Above it, a mistyped quantity — 100
   stewards where 10 were meant — is a five-figure mistake that reaches the
   client before anybody else in the building has read it.

   So a large quote is held until a second, senior person has approved the
   figure. Three things make that a control rather than a formality:

     · The approver cannot be the person who priced it. An approval you can
       give yourself is a checkbox, not a check.

     · What is approved is a NUMBER, not a job. Push the total up afterwards
       and the approval lapses, because otherwise approval is a door propped
       open behind whoever first walked through it. Bringing the total DOWN
       leaves it standing — the manager has already agreed to more.

     · Refusal is a first-class outcome and carries a reason, recorded in the
       history where the next person to open the job will read it.

   Only the quote is weighed. Variations are approved by the client line by
   line after signature, and are not EP Team's number to get wrong in the same
   way.
   --------------------------------------------------------------------------- */

/**
 * The figure a quote has to EXCEED before it needs approval. A quote of
 * exactly this much goes out on its own; a penny more does not.
 *
 * A constant rather than a setting: it is a company rule, not a preference,
 * and one place to change it is enough.
 */
/**
 * The company's standard shift patterns — the ones every job starts with.
 *
 * Twelve, because twelve is what the book actually runs on: parsing the Reading
 * Festival 2025 quote, these twelve windows cover 70% of its 129 staffed rows.
 * Anything rarer is typed once as a `job` pattern and offered back for the rest
 * of that quote; 24 of that sheet's 36 windows appear exactly once and are
 * genuinely bespoke.
 *
 * Named the way the operation talks, not by their times, so an estimator picks
 * "Nights" rather than reconstructing 17:00-02:00 from memory.
 */
export const COMPANY_SHIFT_PATTERNS: ShiftPattern[] = [
  { id: 'sp-early',   name: 'Early',       start: '06:00', end: '15:00', scope: 'company' },
  { id: 'sp-day',     name: 'Day',         start: '08:00', end: '17:00', scope: 'company' },
  { id: 'sp-long',    name: 'Long day',    start: '06:00', end: '17:00', scope: 'company' },
  { id: 'sp-short',   name: 'Short',       start: '08:00', end: '16:00', scope: 'company' },
  { id: 'sp-earlyc',  name: 'Early close', start: '06:00', end: '16:00', scope: 'company' },
  { id: 'sp-half',    name: 'Half day',    start: '08:00', end: '14:00', scope: 'company' },
  { id: 'sp-peak',    name: 'Peak',        start: '10:00', end: '20:00', scope: 'company' },
  { id: 'sp-mgmt',    name: 'Management',  start: '10:00', end: '18:00', scope: 'company' },
  { id: 'sp-extend',  name: 'Extended',    start: '08:00', end: '22:00', scope: 'company' },
  { id: 'sp-evening', name: 'Evening',     start: '16:00', end: '00:00', scope: 'company' },
  { id: 'sp-late',    name: 'Late',        start: '16:00', end: '02:00', scope: 'company' },
  { id: 'sp-nights',  name: 'Nights',      start: '17:00', end: '02:00', scope: 'company' },
];

export const QUOTE_APPROVAL_THRESHOLD = 5000;

/** Money compared in pence, for the reason given in `quoteDrift`. */
const pence = (n: number): number => Math.round(n * 100);

export interface QuoteApprovalRequest {
  by: string;
  byName: string;
  at: string;
  /** What the quote came to when it was sent up. */
  value: number;
  note: string;
  /**
   * The figure this request supersedes, when an earlier approval had lapsed.
   * Kept on the request rather than left as a stale `quoteApproval` because
   * `NOW` is a fixed clock — two records written in one session carry the same
   * timestamp, so "which came last" cannot be answered by comparing them.
   */
  replacing: number | null;
}

export interface QuoteApproval {
  by: string;
  byName: string;
  at: string;
  /** The figure that was approved. Anything above this is not approved. */
  value: number;
  /** Who asked for it. Null when a manager approved it without being asked. */
  requestedBy: string | null;
  note: string;
}

export interface QuoteApprovalRefusal {
  by: string;
  byName: string;
  at: string;
  /** What it came to when it was turned down. */
  value: number;
  reason: string;
}

export type QuoteApprovalState =
  /** Under the threshold. Nobody needs to be asked. */
  | 'not-required'
  /** Over it, and nothing has been raised yet. */
  | 'required'
  /** With a senior manager, waiting on a decision. */
  | 'requested'
  /** Approved, and the quote has not gone above what was approved. */
  | 'approved'
  /** Approved, then the total went up past the approved figure. */
  | 'lapsed'
  /** A senior manager read it and sent it back. */
  | 'refused';

/** Whether this quote is big enough to need a second signature. */
export const quoteNeedsApproval = (w: Wof): boolean =>
  pence(quoteValue(w)) > pence(QUOTE_APPROVAL_THRESHOLD);

/** Where the quote has got to with approval. The one question the UI asks. */
export function quoteApprovalState(w: Wof): QuoteApprovalState {
  if (!quoteNeedsApproval(w)) return 'not-required';
  const a = w.quoteApproval;
  if (a) return pence(quoteValue(w)) > pence(a.value) ? 'lapsed' : 'approved';
  if (w.quoteApprovalRequest) return 'requested';
  if (w.quoteApprovalRefusal) return 'refused';

  // Grandfathered. The client is already looking at this figure and there is
  // no approval on file, so the quote predates the control — every job in the
  // seed data is in exactly this position. Demanding an approval now would
  // announce that the client cannot see a job they have had for a fortnight.
  // The moment the total goes ABOVE what they were sent, this stops applying
  // and the re-send is held like any other big quote.
  if (w.quotedAt && pence(w.quotedValue ?? 0) >= pence(quoteValue(w))) return 'not-required';

  return 'required';
}

/**
 * Everyone who put a line on this quote — the people who cannot approve it.
 *
 * Read off the lines rather than off the job's owner, because the owner is
 * whose account it is and the pricing is what is being checked.
 */
export const quotePricedBy = (w: Wof): string[] => [
  ...new Set(quoteLines(w).map((l) => l.addedBy)),
];

/**
 * Why this person cannot approve this quote, or `null` when they can.
 *
 * Note what it does NOT check: whether they hold the capability. That question
 * belongs to `roles.ts` and is answered once, there — asking it in two places
 * is how the two answers start to differ.
 */
export function approveQuoteBlock(w: Wof, actor: Actor): string | null {
  const state = quoteApprovalState(w);
  if (state === 'not-required')
    return `This quote is ${money(quoteValue(w), { pence: false })} — under the ${money(QUOTE_APPROVAL_THRESHOLD, { pence: false })} threshold, so it can be sent without an approval.`;
  if (state === 'approved') return 'This quote is already approved at the figure it now comes to.';
  if (isTerminal(w.stage)) return 'This job is closed.';
  if (quotePricedBy(w).includes(actor.by))
    return 'You priced lines on this quote. The approval has to come from somebody who did not.';
  if (w.quoteApprovalRequest?.by === actor.by)
    return 'You raised this request. The approval has to come from somebody else.';
  return null;
}

/** Send a quote up for approval. Returns false when there is nothing to ask. */
export function requestQuoteApproval(w: Wof, note = '', actor: Actor = OPERATOR): boolean {
  const state = quoteApprovalState(w);
  if (state === 'not-required' || state === 'approved' || state === 'requested') return false;
  if (isTerminal(w.stage)) return false;

  const value = quoteValue(w);
  const replacing = state === 'lapsed' ? (w.quoteApproval?.value ?? null) : null;
  const trimmed = note.trim();

  w.quoteApprovalRequest = {
    by: actor.by,
    byName: actor.name,
    at: new Date(NOW).toISOString(),
    value,
    note: trimmed,
    replacing,
  };
  // Cleared together: a live request is the only thing the job is waiting on,
  // and leaving a superseded approval or an answered refusal beside it gives
  // the banner two stories to tell about one quote.
  w.quoteApproval = null;
  w.quoteApprovalRefusal = null;

  record(
    w,
    {
      stage: w.stage,
      note:
        `Quote sent for approval — ${money(value)}` +
        (replacing != null ? `, re-approval needed (was approved at ${money(replacing)})` : '') +
        (trimmed ? ` — ${trimmed}` : ''),
    },
    actor,
  );
  save();
  return true;
}

/** A senior manager agrees the figure. The quote can now be sent. */
export function approveQuote(w: Wof, note = '', actor: Actor = OPERATOR): boolean {
  if (approveQuoteBlock(w, actor)) return false;

  const value = quoteValue(w);
  const trimmed = note.trim();
  w.quoteApproval = {
    by: actor.by,
    byName: actor.name,
    at: new Date(NOW).toISOString(),
    value,
    requestedBy: w.quoteApprovalRequest?.by ?? null,
    note: trimmed,
  };
  w.quoteApprovalRequest = null;
  w.quoteApprovalRefusal = null;

  // Not stamped onto any existing version. The documents on the trail have
  // all been sent, and reaching back to add an approval to one the client is
  // already holding would rewrite their copy. The approval reaches paper the
  // next time the quote goes out, where `issueVersion` reads it.

  record(
    w,
    { stage: w.stage, note: `Quote approved for sending — ${money(value)}${trimmed ? ` — ${trimmed}` : ''}` },
    actor,
  );
  save();
  return true;
}

/**
 * A senior manager sends it back. A reason is required, because "refused" on
 * its own tells the person who priced it nothing they can act on.
 */
export function refuseQuoteApproval(w: Wof, reason: string, actor: Actor = OPERATOR): boolean {
  if (approveQuoteBlock(w, actor)) return false;
  const why = reason.trim();
  if (!why) return false;

  const value = quoteValue(w);
  w.quoteApprovalRefusal = {
    by: actor.by,
    byName: actor.name,
    at: new Date(NOW).toISOString(),
    value,
    reason: why,
  };
  w.quoteApprovalRequest = null;

  record(w, { stage: w.stage, note: `Quote approval refused at ${money(value)} — ${why}` }, actor);
  save();
  return true;
}

/** Why the quote cannot be sent yet, or `null` when it can. */
export function quoteSendBlock(w: Wof): string | null {
  if (isTerminal(w.stage)) return 'This job is closed.';
  if (!quoteLines(w).length)
    return 'Nothing is priced yet. Add lines from the table of charges before sending.';

  // The approval gate. Last, because "nothing is priced yet" is the truer
  // answer on an empty quote and a quote of nothing is never over the
  // threshold anyway.
  const value = quoteValue(w);
  switch (quoteApprovalState(w)) {
    case 'required':
      return `This quote is ${money(value, { pence: false })}. Anything over ${money(QUOTE_APPROVAL_THRESHOLD, { pence: false })} needs a senior manager's approval before it goes to the client.`;
    case 'requested':
      return `Waiting on approval. ${w.quoteApprovalRequest!.byName} sent this up at ${money(w.quoteApprovalRequest!.value, { pence: false })} — a senior manager has to approve it before it can go out.`;
    case 'lapsed':
      return `Approved at ${money(w.quoteApproval!.value, { pence: false })}, but this quote now comes to ${money(value, { pence: false })}. It needs approving again before it goes out.`;
    case 'refused':
      return `Approval was refused by ${w.quoteApprovalRefusal!.byName} — ${w.quoteApprovalRefusal!.reason}`;
    default:
      return null;
  }
}

export interface QuoteDrift {
  /** The total the client was shown. */
  sentValue: number;
  /** What it comes to now. */
  nowValue: number;
  /** Lines that were not on the quote the client was sent. */
  added: LineItem[];
  /**
   * How many lines were on the quote the client was sent and are not on it now.
   * A count rather than names: a deleted line takes its description with it,
   * and the history records deletions as prose rather than as structured line
   * data, so there is nothing left to name it honestly with.
   */
  removed: number;
  /** True when the money moved without a line arriving or leaving. */
  repriced: boolean;
}

/**
 * Whether the quote has moved since the client was sent it.
 *
 * Sent once and then quietly amended is worse than never sent: the client is
 * reading one number and EP Team is working to another, and whichever one turns
 * up on the invoice, somebody is surprised. The same reasoning as
 * `kitChangesSincePush` — a warehouse picking confidently from a superseded
 * list — one step earlier in the job.
 *
 * `null` once signed. After signature the mechanism for a change is a variation,
 * which the client approves line by line, and describing that as unsent drift
 * would be a second, weaker story about the same event.
 */
export function quoteDrift(w: Wof): QuoteDrift | null {
  if (!w.quotedAt || w.signoff) return null;

  const sentValue = w.quotedValue ?? 0;
  const nowValue = quoteValue(w);
  const lines = quoteLines(w);

  const sentIds = new Set(w.quotedLineIds || lines.map((l) => l.id));
  const added = lines.filter((l) => !sentIds.has(l.id));
  const nowIds = new Set(lines.map((l) => l.id));
  const removed = (w.quotedLineIds || []).filter((id) => !nowIds.has(id)).length;

  // Compared in pence. Two floats differing in the fifteenth decimal place are
  // the same quote, and a "changed" banner nobody can explain is worse than no
  // banner at all.
  const moneyMoved = Math.round(sentValue * 100) !== Math.round(nowValue * 100);
  if (!moneyMoved && !added.length && !removed) return null;

  return { sentValue, nowValue, added, removed, repriced: moneyMoved && !added.length && !removed };
}

/**
 * Send the quote to the client — the moment the job becomes visible to them.
 *
 * Also used to RE-send after an amendment, which is why it stamps the value
 * every time rather than only on the first send: the stamp is "what they are
 * looking at now", not "what we first offered".
 */
export function sendQuote(w: Wof, actor: Actor = OPERATOR): boolean {
  if (quoteSendBlock(w)) return false;

  const resend = !!w.quotedAt;
  const drift = quoteDrift(w);
  w.quotedAt = new Date(NOW).toISOString();
  w.quotedValue = quoteValue(w);
  w.quotedLineIds = quoteLines(w).map((l) => l.id);

  // The document the client is now holding — written here, because this is
  // the moment there is one. A re-send with nothing changed writes nothing:
  // the client already has that piece of paper, and a second identical
  // version dated an hour later is noise in the very record people come to
  // this screen to read.
  const changed = hasUnsentChanges(w, 'quote');
  const version = changed
    ? issueVersion(w, 'quote', 'The quote as first sent to the client', actor)
    : currentVersion(w, 'quote');

  record(
    w,
    {
      stage: w.stage,
      note: resend
        ? changed
          ? `Quote re-sent to the client as ${version ? version.label : 'a new version'} — ` +
            `${money(w.quotedValue)}${drift ? ` (was ${money(drift.sentValue)})` : ''}`
          : // Nothing moved, so no new document was written and none needed to
            // be. Said plainly, because "re-sent" beside an unchanged version
            // number otherwise reads as a document somebody has lost.
            `Quote re-sent to the client unchanged — ${version ? `${version.label}, ` : ''}${money(w.quotedValue)}`
        : `Quote sent to the client as ${version ? version.label : 'v1'} — ` +
          `${countLabel(quoteLines(w).length, 'line')}, ${money(w.quotedValue)}`,
    },
    actor,
  );

  // A job still sitting at stage 1 has plainly reached stage 2 the moment a
  // priced quote leaves the building. Moved here rather than left to the
  // operator, because a stage that has to be advanced by hand after an action
  // that already happened is a stage that goes stale.
  if (w.stage === 'wof') {
    w.stage = 'quote';
    record(w, { stage: 'quote', note: 'Moved to Quote' }, actor);
  }

  save();
  return true;
}

/** Pull a sent quote back — it disappears from the client's portal again. */
export function unsendQuote(w: Wof, actor: Actor = OPERATOR): boolean {
  // A signed quote cannot be withdrawn. The client has agreed to it, and
  // hiding an agreement from the party who made it is not a state this app
  // should be able to reach.
  if (!w.quotedAt || w.signoff) return false;
  w.quotedAt = null;
  w.quotedValue = null;
  w.quotedLineIds = undefined;
  record(w, { stage: w.stage, note: 'Quote withdrawn — no longer visible to the client' }, actor);
  save();
  return true;
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
  // A signature is itself proof the quote reached the client — stronger proof
  // than the send flag, which only records that EP Team pressed a button. So a
  // quote signed without ever having been marked as sent is back-stamped here
  // rather than deadlocking against the sign-off gate. It matters for the seed
  // data, which has signed jobs predating the field, and for any path that
  // records a signature taken outside the portal.
  if (!w.quotedAt) {
    w.quotedAt = new Date(NOW).toISOString();
    w.quotedValue = quoteValue(w);
    w.quotedLineIds = quoteLines(w).map((l) => l.id);
    // And the document that was signed, by the same reasoning: a signature
    // proves a quote reached them, so there has to be one on the trail to
    // point at. Stamped at the back-dated send, not at now.
    if (!currentVersion(w, 'quote'))
      issueVersion(w, 'quote', 'Recorded as the quote stood when it was signed', actor, w.quotedAt);
  }

  const signedVersion = latestIssued(w, 'quote');

  w.signoff = {
    signedBy,
    signedByRole: signedByRole || 'Authorised signatory',
    signedAt: new Date(NOW).toISOString(),
    method: method || 'DocuSign',
    ref: `DS-${Math.floor(4000 + Math.random() * 900)}-${w.id.slice(-3)}`,
    ip: '—',
  };
  // A signature is a fact about one document — the one they were holding when
  // they signed it. Read before `w.signoff` is set, because the back-stamp
  // above can issue a version in the same breath.
  if (signedVersion && !signedVersion.signedAt) signedVersion.signedAt = w.signoff.signedAt;

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
 * The next free EP HOP reference.
 *
 * Sequential and checked against every reference already issued, rather than
 * random. A random number in a 900-wide range collides at about a 5% rate over
 * thirty jobs, and two jobs sharing a warehouse reference is exactly the class
 * of bug that produced the duplicate `YYY` client codes.
 */
function nextEpHopRef(): string {
  const used = new Set(WOFS.map((x) => x.picking?.epHopRef).filter(Boolean));
  let n = 9000;
  while (used.has(`EPH-2026-${n}`)) n++;
  return `EPH-2026-${n}`;
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
 * Deliberately does NOT assign an EP HOP reference — see `KitPrep`. Rebuilding
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

  // Once the list has gone to EP HOP the prep is history. The baseline that
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
        ? `Kit list prepared for the warehouse — ${countLabel(kit.length, 'line')}, ${kit.reduce((s, l) => s + l.qty, 0)} items. Not yet sent to EP HOP.`
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
 *
 * Was `pushToHireHop`, and it used to end here: a write to a record with
 * nothing on the other side of it. `SEND_LISTENER` is that other side.
 */
/**
 * Fired after every send, so the warehouse can open or amend its prep.
 *
 * Registered rather than called, for the same reason as `registerStockGuard`:
 * `lib/hop.ts` imports this module and this module must not import it back.
 */
export type SendListener = (w: Wof, manifest: PickedLine[]) => void;

let SEND_LISTENER: SendListener = () => {};

export const registerSendListener = (fn: SendListener): void => {
  SEND_LISTENER = fn;
};

export function sendToHop(w: Wof, actor: Actor = OPERATOR): Picking {
  const kit = kitLines(w);
  const items = kit.reduce((s, l) => s + l.qty, 0);
  const at = new Date(NOW).toISOString();
  const changes = kitChangesSincePush(w);
  const first = !w.picking;

  w.picking = {
    epHopRef: w.picking?.epHopRef ?? nextEpHopRef(),
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

  SEND_LISTENER(w, w.picking.manifest!);

  record(
    w,
    {
      stage: w.stage,
      note: first
        ? `Kit list sent to EP HOP (${w.picking.epHopRef}) — ${countLabel(kit.length, 'line')}, ${items} items`
        : changes.length
          ? `Kit list re-sent to EP HOP (${w.picking.epHopRef} v${w.picking.version}) — ${changes.map(describeChange).join('; ')}`
          : `Kit list re-sent to EP HOP (${w.picking.epHopRef} v${w.picking.version}) — unchanged, ${countLabel(kit.length, 'line')}`,
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
/**
 * Variation lines the client has actually been sent.
 *
 * Read off the last ISSUED variation version rather than a flag on the line,
 * for the same reason the quote's visibility is read off `issuedAt`: the
 * document is the thing that was sent, so the document is what decides what
 * they have seen. A line added since is EP Team's working note.
 */
export function clientVariations(w: Wof): LineItem[] {
  const issued = latestIssued(w, 'variation');
  if (!issued) return [];
  const sent = new Set(issued.lines.map((l) => l.id));
  return variationLines(w).filter((l) => sent.has(l.id));
}

/** Variations priced but not yet sent — EP Team's side of the same list. */
export function unsentVariations(w: Wof): LineItem[] {
  const issued = latestIssued(w, 'variation');
  const sent = new Set(issued ? issued.lines.map((l) => l.id) : []);
  return variationLines(w).filter((l) => !sent.has(l.id));
}

/**
 * The same two sums as `variationValue` and `contractValue`, counting only
 * what the client has been sent.
 *
 * Separate functions rather than a flag on the originals, because the two
 * numbers answer different questions and both are legitimate: EP Team's job
 * costing has to include a variation typed this morning, and the client's
 * portal must not show them money they have never been told about.
 */
export const clientVariationValue = (w: Wof): number =>
  round2(clientVariations(w).reduce((sum, l) => sum + lineValue(l), 0));

export const clientContractValue = (w: Wof): number =>
  round2(quoteValue(w) + clientVariationValue(w));

/** Whether this line is with the client at all. */
export const variationSent = (w: Wof, l: LineItem): boolean =>
  clientVariations(w).some((x) => x.id === l.id);

/**
 * Still waiting on the client. Only counts variations they have been given —
 * a line nobody sent is not "awaiting approval", it is awaiting sending, and
 * conflating the two is how a job sits for a week with everyone waiting on
 * everyone else.
 */
export const pendingVariations = (w: Wof): LineItem[] =>
  clientVariations(w).filter((l) => (l.clientApproval ?? 'pending') === 'pending');

export const queriedVariations = (w: Wof): LineItem[] =>
  clientVariations(w).filter((l) => l.clientApproval === 'queried');

/** Why the variation schedule cannot go out, or `null` when it can. */
export function variationSendBlock(w: Wof): string | null {
  if (isTerminal(w.stage)) return 'This job is closed.';
  if (!variationLines(w).length) return 'There are no variations to send.';
  if (!unsentVariations(w).length) return 'Everything here is already with the client.';
  return null;
}

/**
 * Send the variation schedule to the client — the moment those lines become
 * their business rather than EP Team's working note.
 *
 * Issues the current version, exactly as `sendQuote` does, so the client is
 * looking at a document with a number on it rather than at a live list that
 * changes under them.
 */
export function sendVariations(w: Wof, actor: Actor = OPERATOR): boolean {
  if (variationSendBlock(w)) return false;

  const adding = unsentVariations(w);
  const v = issueVersion(w, 'variation', 'The first variation schedule sent to the client', actor);
  if (!v) return false;

  record(
    w,
    {
      stage: w.stage,
      note:
        `${v.label} sent to the client — ${countLabel(adding.length, 'new variation')}, ` +
        `${money(v.value)} of variations in total`,
    },
    actor,
  );
  save();
  return true;
}

/**
 * Record what the client said about a line, on the document they said it
 * about.
 *
 * Not a new version. A version is something EP Team sent, and nobody sent
 * anything when the client pressed Accept — the schedule they are holding is
 * still the current one, now with their answer written on it. The same shape
 * as `objection` on the quote, for the same reason.
 */
function stampAnswer(w: Wof, l: LineItem, note: string, actor: Actor): void {
  const v = latestIssued(w, 'variation');
  if (!v) return;
  v.answers = (v.answers || []).concat([
    {
      lineId: l.id,
      description: l.description,
      approval: l.clientApproval ?? 'pending',
      note,
      at: new Date(NOW).toISOString(),
      by: actor.by,
      byName: actor.name,
    },
  ]);
}

export function acceptVariation(w: Wof, lineId: string, actor: Actor): boolean {
  const l = w.lines.find((x) => x.id === lineId && x.source === 'variation');
  if (!l || !variationSent(w, l)) return false;
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
  stampAnswer(w, l, '', actor);
  save();
  return true;
}

export function queryVariation(w: Wof, lineId: string, note: string, actor: Actor): boolean {
  const l = w.lines.find((x) => x.id === lineId && x.source === 'variation');
  if (!l || !variationSent(w, l)) return false;
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
  stampAnswer(w, l, note.trim(), actor);
  save();
  return true;
}

/** Checklist items the client is responsible for producing. */
export const clientDocs = (w: Wof): WofDocView[] =>
  docState(w).docs.filter((d) => d.owner === 'Client');

/**
 * Whether the client's own checklist is open to them yet.
 *
 * A checklist is a commitment on both sides, and until the job is one it should
 * not be asking for anything. Due dates are worked back from the EVENT date,
 * so a quote sent three weeks out is already showing a site plan two weeks
 * overdue for a job the client has not agreed to, will not be charged for and
 * may never confirm. That is not a chase, it is a portal training its users
 * that red means nothing.
 *
 * Signature AND deposit, because those are the two moments EP treats as
 * commitment everywhere else: staff and kit are not released until the deposit
 * lands, and paperwork is chased for jobs that are being delivered. Where no
 * deposit is due — a nil policy, or a client billed wholly in arrears — the
 * signature alone opens it, since there is no payment to wait on and holding
 * the checklist shut would mean it never opened at all.
 *
 * This is a VISIBILITY rule, not a scheduling one. The documents exist from the
 * moment the WOF is raised, their deadlines do not move, and EP Team sees the
 * whole checklist throughout. What changes is only when the client is asked.
 */
export function clientDocsOpen(w: Wof): boolean {
  if (!w.signoff) return false;
  const dep = deposit(w);
  return !(dep.due > 0 && dep.outstanding > 0);
}

/** What the client is still waiting on, for the note that stands in for the
 *  checklist. `null` once it is open. */
export function clientDocsGate(w: Wof): string | null {
  if (clientDocsOpen(w)) return null;
  if (!w.signoff) return 'once you have signed the quote and paid the deposit';
  return 'once your deposit reaches us';
}

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

  // 3. Documents the client owes — but only once the job is committed on both
  //    sides. See `clientDocsOpen`: due dates are worked back from the event
  //    date, so an unsigned enquiry can already have a "late" purchase order
  //    against it, and chasing paperwork for a job nobody has paid a deposit on
  //    is how a portal trains people to ignore it.
  const docs = clientDocsOpen(w) ? clientDocs(w).filter((d) => d.status !== 'approved') : [];
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
  liveFrom?: number;
  liveTo?: number;
  venue?: string;
  postcode?: string | null;
  staffMeetingPoint?: string | null;
  active?: boolean;
  staffCalendarVisible?: boolean;
  notes?: string;
}

/** The first job number this browser may issue. The seed runs out at 111. */
const FIRST_JOB_NUMBER = 112;

/**
 * The next job number.
 *
 * Monotonic, and persisted across reloads. It replaces a COUNT of the pipeline
 * — `112 + WOFS.filter((w) => w.id.startsWith('wof-1')).length` — and a count
 * goes down when a job is deleted. The next job raised then re-issued a number
 * that was still in use: two WOFs shared an id, both seeded `ev-wof-<n>`, and
 * `event(id)` is a plain `find`, so it returned whichever was pushed first.
 * The symptom was a staffing card that opened somebody else's job.
 *
 * A number freed by a delete is never handed back out either, which is why this
 * is a high-water mark rather than the scan-for-the-first-gap `nextEpHopRef()`
 * uses. Deleting a WOF splices `EVENTS` directly and cannot reach the events
 * journal, so `edited['ev-wof-<n>']` outlives the job — and re-issuing <n> would
 * let a deleted job's rota reappear on top of the new one at the next reload.
 *
 * The live pipeline is still scanned on every call, so a browser whose stored
 * mark predates this function cannot collide with what is already on screen.
 */
function peekJobNumber(): number {
  const num = (id: string): number => {
    const m = /^(?:wof|ev-wof)-(\d+)$/.exec(id);
    return m ? Number(m[1]) : 0;
  };
  return Math.max(
    issuedHigh,
    FIRST_JOB_NUMBER - 1,
    ...WOFS.map((w) => num(w.id)),
    ...EVENTS.map((e) => num(String(e.id))),
  ) + 1;
}

/** One job, one number — so the reference IS the number, formatted once here. */
const refForNumber = (n: number): string => `WOF-2026-0${n}`;

/**
 * The reference the next job will be given, without issuing it.
 *
 * The raise dialog previews the job code before the operator commits, and it
 * used to derive that preview from its own copy of the old count. Two
 * expressions for one number is how a dialog ends up promising `0123` and the
 * pipeline handing back `0112`, so the preview reads from the allocator itself.
 */
export const nextRef = (): string => refForNumber(peekJobNumber());

/** Issue the next job number, consuming it. */
function nextJobNumber(): number {
  issuedHigh = peekJobNumber();
  return issuedHigh;
}

/**
 * Move an event, and everything keyed under it, onto a new id.
 *
 * Shift, split and location ids all embed the event's own id, so the rename is
 * a prefix rewrite rather than a regeneration — which is the point: regenerating
 * would hand back fresh split ids and drop the assignments hanging off them.
 */
function rekeyEvent(ev: EpEvent, oldEvId: string, newEvId: string): void {
  const swap = (id: string): string => String(id).split(oldEvId).join(newEvId);
  ev.id = swap(ev.id);
  ev.locations = ev.locations.map((l) => ({ ...l, id: swap(l.id) }));
  ev.shifts = ev.shifts.map((sh) => ({
    ...sh,
    id: swap(sh.id),
    splits: sh.splits.map((sp) => ({ ...sp, id: swap(sp.id) })),
  }));
}

/** The job number embedded in a `wof-<n>` or `ev-wof-<n>` id, or 0. */
function jobNumberIn(id: string): number {
  const m = /^(?:wof|ev-wof)-(\d+)$/.exec(String(id));
  return m ? Number(m[1]) : 0;
}

/**
 * Repair jobs that the old count-based allocator issued the same number to.
 *
 * The fix in `nextJobNumber()` stops new collisions; it cannot undo the ones
 * already written to somebody's browser. Those present as a staffing card that
 * opens a different job — two events share one id and `event(id)` returns the
 * first — so the record is not merely untidy, it is unreachable through the very
 * UI that would let someone clean it up by hand.
 *
 * This runs on the SAVED state, before `load()` applies it, because applying it
 * destroys the evidence: the restore loop skips an event whose id is already
 * present, so by the time the arrays are live the second event is simply gone.
 *
 * The LATER claimant moves. The earlier one is what every existing link,
 * notification and attendance row already resolves to.
 */
function healSavedDuplicates(saved: SavedState): boolean {
  const wofs = saved.wofs || [];
  const events = saved.events || [];
  const seen = new Set<string>();
  let healed = false;

  wofs.forEach((w) => {
    if (!seen.has(w.id)) {
      seen.add(w.id);
      return;
    }

    const oldEvId = `ev-wof-${w.id.replace('wof-', '')}`;
    const n = nextJobNumber();
    const newRef = refForNumber(n);

    // The job code is the reference unless an operator overrode it to preserve
    // a legacy code, and an override is exactly what not to overwrite.
    if (w.jobCode === w.ref) w.jobCode = newRef;
    w.ref = newRef;
    w.id = `wof-${n}`;

    if (w.eventId === oldEvId) {
      // Saved in push order, so the last event on the shared id is the one this
      // later job seeded.
      const shared = events.filter((e) => String(e.id) === oldEvId);
      if (shared.length > 1) {
        const newEvId = `ev-wof-${n}`;
        rekeyEvent(shared[shared.length - 1], oldEvId, newEvId);
        w.eventId = newEvId;
      } else {
        // Its own event was already lost to the de-dupe on an earlier load, so
        // this pointer resolves to the OTHER job's rota. Better a job that
        // honestly has no shifts than one quietly showing somebody else's.
        w.eventId = null;
      }
    }

    seen.add(w.id);
    healed = true;
  });

  return healed;
}

export function create(cfg: CreateConfig): Wof {
  const n = nextJobNumber();
  const sch = cfg.scheduleId ? scheduleById(cfg.scheduleId) : null;
  const ref = refForNumber(n);
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
    liveFrom: cfg.liveFrom,
    liveTo: cfg.liveTo,
    venue: cfg.venue || (sch ? sch.venue : ''),
    postcode: cfg.postcode || null,
    staffMeetingPoint: cfg.staffMeetingPoint || null,
    active: cfg.active !== false,
    staffCalendarVisible: cfg.staffCalendarVisible !== false,
    stage: 'wof',
    raisedAt: new Date(NOW).toISOString(),
    quotedAt: null,
    quotedValue: null,
    quotedLineIds: undefined,
    orderedAt: null,
    signoff: null,
    deposit: { pct: null, amount: null, receivedAt: null, ref: null },
    lines: [],
    // Every job starts with the company's standard windows, so the first
    // deployment an estimator builds is a picker rather than a clock.
    shiftPatterns: COMPANY_SHIFT_PATTERNS.map((sp) => ({ ...sp })),
    patterns: [],
    places: [],
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

  /* Backfill the quote-sent stamp on jobs that plainly reached the client.
     `quotedAt` existed on the model long before anything wrote it, so every job
     signed, ordered or delivered in a browser before `sendQuote` shipped has a
     null stamp — and the portal now reads that stamp as "the client cannot see
     this". Without this, the change would hide the client's OWN CONFIRMED JOBS
     from them, which is the opposite of what it is for.

     A signature is the evidence: a client cannot have signed a quote that never
     reached them. Stamped at the signing date rather than now, so the history
     does not claim the quote was sent after it was agreed. */
  if (!w.quotedAt && (w.signoff || atLeast(w, 'signoff'))) {
    w.quotedAt = w.signoff?.signedAt || w.orderedAt || w.raisedAt;
    if (w.quotedValue == null) w.quotedValue = quoteValue(w);
    if (!w.quotedLineIds) w.quotedLineIds = quoteLines(w).map((l) => l.id);
  }

  /* And the paper trail. Every seeded job predates versioning, so a job that
     plainly reached the client gets one document written from the lines as
     they stand — stamped at the dates the job already carries, and honestly
     described as the point the record begins rather than pretending to be the
     original quote. Inventing the versions that came before it would be worse
     than having none.

     A job never sent gets NOTHING, which is the whole rule stated once more:
     the trail is a list of documents the client was given, so a quote still
     being typed has an empty one. Its first version is written the day
     somebody sends it. */
  if (!w.quoteVersions || !w.quoteVersions.length) {
    const author: Actor = {
      by: w.ownerId,
      name: managerById(w.ownerId)?.name || 'EP Team',
    };
    if (w.quotedAt) {
      const first = issueVersion(
        w,
        'quote',
        'Recorded as the job stood when version history began',
        author,
        w.quotedAt,
      );
      if (first) first.signedAt = w.signoff ? w.signoff.signedAt : null;
      // Seeded variations were already with the client — the portal showed
      // them the moment they existed, and several carry the client's own
      // answer. That makes them sent, whatever the rule says about lines
      // priced from now on.
      issueVersion(
        w,
        'variation',
        'Recorded as the job stood when version history began',
        author,
        w.orderedAt || w.quotedAt,
      );
    }
  }

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
