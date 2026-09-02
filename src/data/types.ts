/* ============================================================================
   EPROSTA — domain types
   ----------------------------------------------------------------------------
   The vanilla prototype carried these shapes in comments; here they are the
   compiler's problem. Two of them earn their keep immediately:

     · `Tone` is the status scale and nothing else. It is deliberately NOT the
       button variant union — the rule that status colour is never reused for
       an action is now enforced at the type level.
     · `Split.required` / `Assignment.confirmation` are the single source of
       truth for coverage. `filled` is derived, never stored, so the four
       irreconcilable numbers the live app showed for one shift cannot recur.
   ========================================================================== */

export type Tone = 'critical' | 'atRisk' | 'healthy' | 'info' | 'neutral';

export interface Tag {
  id: string;
  label: string;
  tone: Tone;
}

/* -------------------------------------------------------------- clients --- */

export interface ClientBase {
  id: string;
  name: string;
  code: string;
  email: string;
  status: 'active' | 'inactive';
  tags: string[];
}

/** CRM fields layered on by the reference-data module. */
export interface ClientExtra {
  legalName: string | null;
  contact: string | null;
  contactRole: string | null;
  phone: string | null;
  billingEmail: string | null;
  termsDays: number;
  creditLimit: number;
  agreement: string;
  agreementEnds: string | null;
  depositPolicy: number;
  address: string | null;

  /* --- account ownership and classification -------------------------------
     The fields the live client form asks for. `clientManagerId` points at a
     MANAGERS row rather than carrying a typed name, so a manager leaving is a
     lookup that fails loudly instead of a string nobody notices is stale. */
  clientManagerId: string | null;
  department: string | null;
  clientType: string | null;
  /** Ids from SERVICE_TYPES. What EP sells this account, not what it books. */
  serviceTypes: string[];

  /**
   * Which of the three published rate cards this account is priced from.
   *
   * `null` means Standard — the published card — rather than "not set". An
   * account has to be priced from something, and a nullable field that every
   * reader has to remember to default is how half the register ended up
   * priced from nothing at all.
   *
   * A card is a blanket position. Anything negotiated line by line lives in
   * the client's own price list (`lib/rates.ts`) and beats the card.
   */
  rateCardId: string | null;

  /* --- contact block ------------------------------------------------------
     `phone` was the only number a client had, so an office landline and a
     site mobile were the same field and whichever was typed second won. */
  mobile: string | null;
  landline: string | null;
  website: string | null;
  /** Second address line. `address` above is line one. */
  address2: string | null;
  city: string | null;
  region: string | null;
  postcode: string | null;
  notes: string | null;
}

export type Client = ClientBase & ClientExtra;

/* ------------------------------------------------------------ employees --- */

export type StaffStatus = 'verified' | 'flagged' | 'pending';
export type RtwStatus = 'verified' | 'pending' | 'expiring';

export interface EmployeeBase {
  id: string;
  name: string;
  email: string;
  phone: string;
  office: string;
  department: string;
  rating: number;
  ratedShifts: number;
  status: StaffStatus;
  strikes: number;
  tags: string[];
  available: boolean;
  shiftsWorked: number;
  initials: string;
  hue: number;
}

/** Payroll and compliance fields from the staff register (briefing §2.1). */
export interface EmployeeExtra {
  employmentType: 'PAYE' | 'Self-employed';
  payRate: number;
  payUplift: number;
  niNumber: string;
  rtw: RtwStatus;
  rtwExpiry: string | null;
  rtwNote: string;
  qualifications: string[];
  startedAt: string;
  /** Set by the rating engine: the pre-derivation number, kept for the fill. */
  priorRating?: number;
  /** Cache of `rating.score(emp).band.id` — never a rival opinion. */
  ratingBand?: string;
  /** Set by the flags module; restored when a flag is cleared. */
  preFlagStatus?: StaffStatus;
  flag?: { reasonId: string; note: string; at: string; by: string; label: string } | null;
}

export type Employee = EmployeeBase & EmployeeExtra;

/* ----------------------------------------------------- the permanent team --- */
/*
   Two populations, and they are not the same people.

   `Employee` above is the casual event workforce — stewards, bar, hospitality.
   They have ratings, SIA licences and a count of shifts worked, because that is
   what you need to know when you are filling a role group.

   `TeamMember` is the permanent salaried team: ops managers, account managers,
   warehouse crew, finance, payroll, technology. You never assign one of them to
   a "Car Park Steward" role group, and none of them has a rating. What you need
   to know about them is where they are on a given day — which event they are
   leading, or whether they are at head office, in the warehouse, or on leave.

   That is what the People Planner workbook has always tracked, and it is why it
   is a separate register rather than a flag on `Employee`. The six records in
   `MANAGERS` are the stub this grew out of; they are carried through by
   `managerId` so the ownership links on schedules and WOFs keep resolving.
*/

/** The People Planner's column bands, in the order the workbook groups them. */
export type TeamBand =
  | 'Operations'
  | 'Special Events'
  | 'Traffic Management'
  | 'Greenfield'
  | 'Stadia and Venues'
  | 'Wembley'
  | 'Logistics'
  | 'Central'
  | 'Finance and Payroll'
  | 'Training'
  | 'Staffing and Compliance'
  | 'Technology';

export interface TeamMember {
  id: string;
  name: string;
  band: TeamBand;
  role: string;
  email: string;
  initials: string;
  hue: number;
  /**
   * Where this person is on a working day with no event and no explicit entry.
   * The warehouse crew default to `warehouse`, the office bands to
   * `head-office`. It is a default, not a fact: it is never stored as a
   * `DayEntry`, so an untouched day stays visibly untouched.
   */
  defaultDay: DayStateKind;
  /** The `MANAGERS` record this person is, when they are one. */
  managerId: string | null;
  active: boolean;
}

/* --------------------------------------------------------- availability --- */
/*
   Where a person is on a day when they are not on an event.

   The People Planner's cells are free text — `Off`, `Annual Leave`, `TOIL`,
   `EP Warehouse (08:00-17:00)`, `Off - Sick` — with the meaning that matters
   carried in the font colour. Typed here instead, because the one question the
   spreadsheet cannot answer is the one that costs money: is this person both
   booked on a shift and booked off? Two tabs, one person, no link between them.
*/

export type DayStateKind =
  /* not available to work */
  | 'off'
  | 'annual-leave'
  | 'toil'
  | 'bank-holiday'
  | 'sick'
  | 'parental'
  | 'other-leave'
  /* at work, but not on an event */
  | 'head-office'
  | 'back-office'
  | 'warehouse'
  | 'wfh'
  | 'training'
  | 'standby';

export type DayEntryStatus = 'requested' | 'approved' | 'declined';

export interface DayEntry {
  id: string;
  /**
   * A `tm-*` or an `e-*`.
   *
   * Availability is a fact about a person, not about which register they happen
   * to sit in. A casual worker saying "I can't do those dates" is the same fact
   * as an ops manager booking annual leave, and modelling it twice would
   * recreate the split this replaces.
   */
  personId: string;
  /** ISO `yyyy-mm-dd`. One entry per person per day — the module enforces it. */
  date: string;
  kind: DayStateKind;
  /** Free text, e.g. "Northampton Balloon AWS". What the sheet's cells held. */
  note: string;
  /** e.g. `"08:00-17:00"`. `null` renders "Not set", never "00:00". */
  hours: string | null;
  status: DayEntryStatus;
  /**
   * Who approved it. `Sheet25` shows the team reconstructing this from memory
   * months later — "TOIL request", "Messaged Martin" — which is the argument
   * for recording it at the time.
   */
  approvedBy: string | null;
  at: string;
}

/* --------------------------------------------------------------- events --- */

export type ConfirmationState = 'confirmed' | 'awaiting' | 'declined';
export type AssignmentStatus = 'invited' | 'accepted' | 'declined';
export type CheckInState = 'pending' | 'approved' | null;

export interface Assignment {
  employeeId: string;
  status: AssignmentStatus;
  confirmation: ConfirmationState;
  checkIn: CheckInState;
  note: string;
  /**
   * What the worker was giving up at the moment they declined.
   *
   * `confirmation` collapses to `declined` either way, so without this the
   * record cannot tell "I was asked and said no" from "I had agreed and then
   * dropped out" once the decline has happened. Those are different acts: one
   * costs the staffing team nothing, the other costs them coverage and carries
   * a strike, and only the second should stop the worker picking the role back
   * up off the open list.
   *
   * Undefined on a record declined before this field existed. Read as
   * `confirmed` in that case — the conservative reading, since it keeps the
   * old behaviour rather than returning a pile of historic declines to
   * everybody's open jobs at once.
   */
  declinedFrom?: Exclude<ConfirmationState, 'declined'>;

  /*
     `Sheet25`'s "Job Cancellations" log, absorbed rather than rebuilt.

     The workbook keeps a separate tab recording who pulled off which job, how
     they told us and why — "Conversation", "TOIL request", "Messaged Martin",
     `"personal issue"`. Every one of those rows is about a decline that this
     record already holds; only the circumstances were missing. So they hang off
     the decline instead of becoming a second log to keep in step with the
     first. Present only on a declined record, like `declinedFrom`.
  */
  declineReason?: string;
  declineChannel?: 'conversation' | 'message' | 'request' | 'document' | 'comment';
  declinedAt?: string;

  /**
   * The `Split` this assignment fills — and through it, the lines that sold it.
   *
   * Absent on every record made before deployments shipped, and on anything the
   * staffing tool wrote without a split in hand. `splitForAttendance` resolves
   * those by date, role and window instead, so the variance report is not empty
   * for the entire back catalogue.
   */
  splitId?: string;
}

export interface Split {
  id: string;
  role: string;
  required: number;
  /**
   * Into the event's `locations` — where this group actually stands.
   *
   * Without it, two car parks half a mile apart merged into one split reading
   * "Car Park Steward x 24" and the worker assigned to it was never told which
   * one to go to.
   */
  locationId?: string | null;
  /**
   * This group's own window, when it differs from the day's.
   *
   * A day used to run the event's start-to-end for everybody, so a 17:00-02:00
   * night steward and an 08:00-16:00 day steward were rostered against the same
   * block. Reading has both, on the same day, in the same car park.
   */
  start?: string;
  end?: string;
  /**
   * The quote lines that SOLD this group of positions.
   *
   * The first half of the chain from a sold hour to a paid one. Without it a
   * timesheet can say who worked and when, but never which line on the quote
   * it was worked against — so "we sold 48 hours of Alley Farm nights and paid
   * for 51" is a question the system cannot answer at any price.
   *
   * Usually one. Several when the same role, place and window was sold on more
   * than one line, which is why worked hours are apportioned rather than
   * attributed whole.
   */
  lineIds?: string[];
  /** null renders "Not set", never the meaningless "00:00". */
  pickupTime: string | null;
  office: string;
  uniform: string;
  travel: string;
  tags: string[];
  assignments: Assignment[];
}

export interface Shift {
  id: string;
  label: string;
  day: number;
  start: string;
  end: string;
  splits: Split[];
}

export interface EventLocation {
  id: string;
  name: string;
  note: string;
}

export interface EpEvent {
  id: string;
  name: string;
  clientId: string;
  office: string;
  start: string;
  end: string;
  allDay: boolean;
  requiresAccreditation: boolean;
  accreditationExportReady: boolean;
  accreditationBlockedReason: string;
  locations: EventLocation[];
  additionalInfo: string;
  shifts: Shift[];
  /**
   * The `TeamMember` leading this event on the ground.
   *
   * The People Planner carries this as blue text in the person's cell, which
   * means it is invisible to every filter, sort and count the workbook can do.
   * A field instead, so "who is leading Wilderness" is answerable.
   */
  leadId: string | null;
}

/* ------------------------------------------------------------ check-ins --- */

export interface CheckIn {
  id: string;
  employeeId: string;
  eventId: string;
  shiftId: string;
  role: string;
  scheduledIn: string;
  scheduledOut: string;
  actualIn: string | null;
  actualOut: string | null;
  flag: string | null;
}

export type AttendanceOutcome = 'worked' | 'late' | 'overtime' | 'no-show' | 'cancelled';

export interface AttendanceRow {
  id: string;
  employeeId: string;
  eventId: string;
  role: string;
  date: string;
  scheduled: string;
  actual: string;
  hours: number;
  outcome: AttendanceOutcome;
  approvedBy: string;
  /** The split this was worked against, where the staffing tool knew it. */
  splitId?: string;
}

/* -------------------------------------------------------- notifications --- */

export type NotificationType = 'staffing' | 'checkin' | 'confirmation' | 'staff' | 'approval';

export interface AppNotification {
  id: string;
  type: NotificationType;
  severity: Tone;
  unread: boolean;
  title: string;
  body: string;
  at: string;
  /** Route inside the app, e.g. `/events/ev-2`. */
  link: string;
}

/* ------------------------------------------------------ reference data --- */

export interface Manager {
  id: string;
  name: string;
  role: string;
  initials: string;
  hue: number;
  owns: string;
}

export interface ChargeTier {
  minQty: number;
  charge: number;
}

/**
 * One of the three published rate cards.
 *
 * A card is a POSITION ON THE PUBLISHED RATE, not a second table of prices.
 * `factor` is applied to whatever the table of charges says on the day the
 * line is priced, so a card cannot silently fall behind an April rate rise
 * the way a copied price list would — and there is still only one place to
 * change what a Response Steward costs.
 *
 * What a card cannot express is a price negotiated for one line with one
 * account. That is what the client price list is for, and it beats the card.
 */
export interface RateCard {
  id: string;
  label: string;
  blurb: string;
  /** Multiplier on the published charge-out. Standard is 1. */
  factor: number;
}

/** A price agreed with one client for one charge line. Beats their card. */
export interface ClientPrice {
  clientId: string;
  chargeId: string;
  /** Absolute charge-out, in pounds. Never a cost price. */
  charge: number;
  note: string;
  at: string;
  by: string;
}

export interface ChargeVersionRecord {
  effectiveFrom: string;
  cost: number;
  charge: number;
  tiers: ChargeTier[];
}

export type ChargeKind = 'staff' | 'kit' | 'service';
export type ChargeUnit = 'hour' | 'day' | 'each';

export interface Charge {
  id: string;
  kind: ChargeKind;
  code: string;
  name: string;
  unit: ChargeUnit;
  role?: string;
  cost: number;
  charge: number;
  effectiveFrom: string;
  tiers: ChargeTier[];
  history: ChargeVersionRecord[];
  hireHopCode?: string;
  /**
   * No longer offered on new quote lines.
   *
   * Never deleted: every line ever quoted from this charge points at it, and
   * `LineItem.snap` freezes its rate onto historic work. Retiring removes it
   * from what can be SOLD and from nothing else.
   */
  retired?: boolean;
}

export interface ChargeVersion extends ChargeVersionRecord {
  current: boolean;
}

/** A rate resolved as at a point in time — what a WOF line item snapshots. */
export interface ResolvedRate {
  chargeId: string;
  kind: ChargeKind;
  name: string;
  unit: ChargeUnit;
  code: string;
  cost: number;
  /** What this client is charged. Already through card and price list. */
  charge: number;
  tiers: ChargeTier[];
  rateVersion: string;
  isCurrent: boolean;

  /* --- where that number came from ---------------------------------------
     Optional because every line snapshotted before client pricing shipped
     has none of it. Read a missing `basis` as `standard`, which is what
     those lines were: the published rate, for everybody. */

  /** The rate card in force when this was priced. */
  cardId?: string;
  basis?: 'standard' | 'card' | 'client';
  /** The published charge-out for this version, before card or price list. */
  listCharge?: number;
}

export interface EventScheduleEntry {
  id: string;
  name: string;
  clientId: string;
  venue: string;
  type: string;
  recurrence: string;
  start: string;
  end: string;
  leadDays: number;
  triggerRule: string;
  ownerId: string;
  /** `null` is a real state: the calendar renders it as "No WOF". */
  wofId: string | null;
}

export interface DocumentType {
  id: string;
  label: string;
  owner: string;
  leadDays: number;
  blocking: boolean;
}

export interface JobType {
  id: string;
  label: string;
  depositPct: number;
  termsDays: number;
  docs: string[];
}
