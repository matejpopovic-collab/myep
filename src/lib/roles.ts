/* ============================================================================
   EPROSTA — INTERNAL ROLES AND PERMISSIONS
   ----------------------------------------------------------------------------
   `portal.ts` answers "which of the three products am I looking at" — EP Team,
   client, worker. This module answers the question underneath it: inside the EP
   Team console, WHICH members of staff can do WHAT.

   Those are genuinely different questions and conflating them is how you end up
   with a fourth tier called "super admin" that has to duplicate the whole admin
   navigation. A tier is a product. A role is a permission set within one.

   WHY THIS EXISTS AT ALL
   ----------------------
   The console currently hands every operator the same console: the payroll run,
   every worker's pay rate, the cash-flow report, the table of charges and the
   ability to cancel a work order. That is one shared login's worth of trust
   spread across a company that has a recruiter, a payroll clerk, a client
   manager and a finance director in it. The recruiter does not need to see what
   anybody earns, and the payroll clerk should not be able to cancel a job.

   THE THREE RULES
   ---------------
     1. CAPABILITIES, NOT PAGES. A role holds capabilities (`payroll.run`,
        `wof.cancel`). Pages and buttons ask `can()`. Adding a screen therefore
        cannot silently widen anyone's access — the screen has to name the
        capability it needs, and a capability nobody granted is denied.

     2. ONE ANSWER, ONE PLACE. `can()` is the only permission predicate in the
        app. The sidebar, the route guard and the buttons all call it, so a page
        that appears in the rail is always a page you can open, and a button you
        can see is always a button that works. Hiding a route but leaving its
        action live is the failure mode this design exists to prevent.

     3. YOU CANNOT LOCK THE COMPANY OUT. Super Admin's permissions are not
        editable, the last Super Admin cannot be demoted or removed, and nobody
        can change their own role. Those are enforced in `assignRole()` /
        `setRoleCaps()` and return a REASON, not a silent `false`, so the UI can
        say why the option is greyed out.

   WHY PERMISSION EDITS ARE STORED AS A FULL SET
   ---------------------------------------------
   `clients.ts` journals deltas so seed improvements still land. Permissions go
   the other way: an edited role stores the exact list the administrator ticked.
   A delta would mean a capability introduced in a later release is granted to
   every role that happens not to exclude it — access widening on its own, which
   is the one thing a permission system must never do. New capabilities default
   to OFF for edited roles, and Super Admin (which is always everything) is the
   route back.
   ========================================================================== */

import { MANAGERS } from '@/data/db';
import { shiftDeep } from '@/data/clock';

const KEY = 'eprosta.roles.v1';
const KEY_ACTING = 'eprosta.actingMember';

/* ==========================================================================
   1. CAPABILITIES
   --------------------------------------------------------------------------
   Grouped the way the sidebar is grouped, because the permission matrix is
   read by the same person who reads the rail and asking them to hold two
   different mental models of the same product is how permissions get ticked
   at random.

   `view` and the action that follows it are kept separate wherever the
   difference is a real job boundary — seeing the payroll report is the finance
   director's business, running it is the payroll clerk's.
   ========================================================================== */

export type Capability =
  /* work orders */
  | 'wof.view' | 'wof.edit' | 'wof.quote' | 'wof.approve' | 'wof.confirm' | 'wof.cancel' | 'calendar.view'
  /* delivery */
  | 'staffing.view' | 'staffing.assign' | 'checkin.approve' | 'attendance.view' | 'attendance.edit'
  /* warehouse */
  | 'kit.view' | 'kit.prepare' | 'kit.stock'
  /* money */
  | 'report.cashflow' | 'report.costing' | 'report.payroll' | 'payroll.run' | 'pay.view'
  /* reference data */
  | 'charges.view' | 'charges.edit' | 'clients.view' | 'clients.edit' | 'clients.rates'
  | 'schedules.view' | 'staff.view' | 'staff.edit' | 'docs.view'
  /* administration */
  | 'notifications.view' | 'team.view' | 'team.manage';

export interface CapabilityMeta {
  id: Capability;
  label: string;
  /** What granting it actually lets the person do. Shown in the matrix. */
  blurb: string;
  /** Marked in the UI: these are the ones worth thinking twice about. */
  sensitive?: boolean;
}

export interface CapabilityGroup {
  group: string;
  caps: CapabilityMeta[];
}

export const CAP_GROUPS: CapabilityGroup[] = [
  {
    group: 'Work orders',
    caps: [
      { id: 'wof.view', label: 'View work orders', blurb: 'Open the WOF pipeline and any work order in it.' },
      { id: 'wof.edit', label: 'Edit work orders', blurb: 'Change lines, quantities, dates and requirements.' },
      { id: 'wof.quote', label: 'Price and send quotes', blurb: 'Set the price and issue a quote to the client.', sensitive: true },
      { id: 'wof.approve', label: 'Approve high-value quotes', blurb: 'Sign off a quote over the approval threshold so it can be sent. Never on your own pricing.', sensitive: true },
      { id: 'wof.confirm', label: 'Confirm orders', blurb: 'Turn a signed quote into committed work.', sensitive: true },
      { id: 'wof.cancel', label: 'Cancel work orders', blurb: 'Cancel a job, including one with staff already assigned.', sensitive: true },
      { id: 'calendar.view', label: 'View event calendar', blurb: 'The master calendar of everything booked.' },
    ],
  },
  {
    group: 'Delivery',
    caps: [
      { id: 'staffing.view', label: 'View staffing', blurb: 'See who is assigned to which shift and where the gaps are.' },
      { id: 'staffing.assign', label: 'Assign and remove staff', blurb: 'Put people on shifts and take them off again.' },
      { id: 'checkin.approve', label: 'Approve check-ins', blurb: 'Sign off arrival and departure times. Feeds pay.', sensitive: true },
      { id: 'attendance.view', label: 'View attendance', blurb: 'The delivered-hours record for every job.' },
      { id: 'attendance.edit', label: 'Amend attendance', blurb: 'Correct hours after the fact. Feeds pay and invoicing.', sensitive: true },
    ],
  },
  {
    group: 'Warehouse',
    caps: [
      { id: 'kit.view', label: 'View the kit queue', blurb: 'See which jobs need kit and what each one needs.' },
      { id: 'kit.prepare', label: 'Pick and pack', blurb: 'Work a job through the warehouse and mark it ready. Writes to the job timeline.' },
      { id: 'kit.stock', label: 'Set stock counts', blurb: 'Change what EP owns, what is out of service and how long an item takes to turn around. These are the numbers a job is refused on.', sensitive: true },
    ],
  },
  {
    group: 'Money',
    caps: [
      { id: 'report.cashflow', label: 'Cash flow report', blurb: 'Deposits, invoices and what is owed.', sensitive: true },
      { id: 'report.costing', label: 'Job costing report', blurb: 'Cost, charge and margin per job.', sensitive: true },
      { id: 'report.payroll', label: 'Payroll report', blurb: 'View the payroll output for a period.', sensitive: true },
      { id: 'payroll.run', label: 'Run and export payroll', blurb: 'Lock a period and produce the payment file.', sensitive: true },
      { id: 'pay.view', label: 'View individual pay', blurb: "See what any one worker is paid, on their record and everywhere else.", sensitive: true },
    ],
  },
  {
    group: 'Reference data',
    caps: [
      { id: 'clients.view', label: 'View clients', blurb: 'The client register and account details.' },
      { id: 'clients.edit', label: 'Edit clients', blurb: 'Create, amend and deactivate client accounts.' },
      { id: 'charges.view', label: 'View table of charges', blurb: 'Cost and charge rates for every role and item.', sensitive: true },
      { id: 'charges.edit', label: 'Edit table of charges', blurb: 'Change the published rate every client is priced from. Finance.', sensitive: true },
      /* Deliberately NOT `charges.edit`. Agreeing a rate with one account is
         what the person who negotiated it does; changing the published table
         is what Finance does. Folding the first into the second means either
         account managers cannot honour a deal they signed, or they can move
         every client's price to do it. */
      { id: 'clients.rates', label: 'Agree client rates', blurb: "Set the rate card and the agreed prices for ONE client. Never touches the published table or any other account's price.", sensitive: true },
      { id: 'schedules.view', label: 'View event schedules', blurb: 'Recurring schedule templates.' },
      { id: 'staff.view', label: 'View staff register', blurb: 'The worker register, ratings and availability.' },
      { id: 'staff.edit', label: 'Edit staff register', blurb: 'Add workers, amend records, flag and deactivate.' },
      { id: 'docs.view', label: 'Compliance documents', blurb: 'Right-to-work, SIA and training paperwork.', sensitive: true },
    ],
  },
  {
    group: 'Administration',
    caps: [
      { id: 'notifications.view', label: 'Notifications', blurb: 'The internal notification feed.' },
      { id: 'team.view', label: 'View team & roles', blurb: 'See who has access and what each role can do.' },
      { id: 'team.manage', label: 'Manage team & roles', blurb: 'Invite people, assign roles and edit permissions.', sensitive: true },
    ],
  },
];

export const ALL_CAPS: Capability[] = CAP_GROUPS.flatMap((g) => g.caps.map((c) => c.id));

const CAP_META = new Map<Capability, CapabilityMeta>(
  CAP_GROUPS.flatMap((g) => g.caps.map((c) => [c.id, c] as const)),
);

export const capMeta = (id: Capability): CapabilityMeta | undefined => CAP_META.get(id);

/* ==========================================================================
   2. ROLES
   --------------------------------------------------------------------------
   Named after the job, not after a permission level, because "Level 2" tells
   the person assigning it nothing and they will guess. The defaults below are
   drawn from what each of these people already owns in the briefing — Jenny
   owns the payroll workflow, Pete owns staffing, the Finance Director owns
   invoicing and payroll sign-off.
   ========================================================================== */

export type BuiltInRoleId =
  | 'owner' | 'senior-manager' | 'ops' | 'client-manager' | 'recruitment'
  | 'scheduling' | 'warehouse' | 'payroll' | 'finance' | 'readonly';

/**
 * A built-in id, kept as a union for autocomplete, or any string — because a
 * role created on this page (`createRole`) gets an id nothing here could have
 * predicted. Everything downstream already treated `RoleId` as an opaque
 * lookup key into `ROLES`, so widening it costs nothing.
 */
export type RoleId = BuiltInRoleId | (string & {});

export interface Role {
  id: RoleId;
  label: string;
  blurb: string;
  icon: string;
  /** Created on this page rather than shipped. Editable and deletable, unlike a seeded role. */
  custom?: boolean;
  /** Super Admin. Always every capability, never editable, never empty. */
  locked?: boolean;
  caps: Capability[];
}

/*
   The second signature on a big quote, and the reason this role exists. It is
   deliberately NOT a second Super Admin: no payroll, no pay rates, no power to
   rewrite the permission table. What it adds over Operations is one thing —
   `wof.approve` — plus the money reports needed to judge whether a five-figure
   quote is right.
*/
const SENIOR_MANAGER_CAPS: Capability[] = [
  'wof.view', 'wof.edit', 'wof.quote', 'wof.approve', 'wof.confirm', 'wof.cancel', 'calendar.view',
  'staffing.view', 'staffing.assign', 'attendance.view',
  'report.cashflow', 'report.costing',
  'clients.view', 'clients.edit', 'clients.rates', 'charges.view', 'schedules.view', 'staff.view', 'docs.view',
  'notifications.view', 'team.view',
];

const OPS_CAPS: Capability[] = [
  'wof.view', 'wof.edit', 'wof.quote', 'wof.confirm', 'wof.cancel', 'calendar.view',
  'staffing.view', 'staffing.assign', 'checkin.approve', 'attendance.view', 'attendance.edit',
  'report.cashflow', 'report.costing',
  'clients.view', 'clients.edit', 'charges.view', 'schedules.view', 'staff.view', 'docs.view',
  'notifications.view', 'team.view',
];

const CLIENT_MANAGER_CAPS: Capability[] = [
  'wof.view', 'wof.edit', 'wof.quote', 'wof.confirm', 'calendar.view',
  'staffing.view', 'attendance.view',
  'report.costing',
  'clients.view', 'clients.edit', 'clients.rates', 'charges.view', 'schedules.view',
  'notifications.view',
];

const RECRUITMENT_CAPS: Capability[] = [
  'calendar.view', 'staffing.view',
  'staff.view', 'staff.edit', 'docs.view',
  'notifications.view',
];

const SCHEDULING_CAPS: Capability[] = [
  'wof.view', 'calendar.view',
  'staffing.view', 'staffing.assign', 'checkin.approve', 'attendance.view',
  'staff.view', 'schedules.view',
  'notifications.view',
];

/*
   The warehouse. Narrow on purpose, and narrower than it first looks.

   `wof.view` was here, on the argument that a picker needs the venue, the dates
   and the meeting point, and a picking list with no job behind it sends
   somebody to the wrong site. That argument was for the FACTS, and it granted
   the SCREEN. The work order is where a job is priced, approved, sent to the
   client, confirmed and invoiced; opening it puts contract value, margin, the
   quote builder and the client sign-off in front of a picker, and the read-only
   tabs are one permission edit away from being live buttons. So the capability
   is withheld and the facts are served where the work is: the kit list carries
   the dates, the venue and the load-out, and the calendar carries when.

   `charges.view` is deliberately NOT here, and that was a real decision. The
   stock register joins to the charge table through `hireHopCode`, so the
   obvious move is to grant it. But `charges.view` is sensitive because it
   exposes cost and charge for every role and item, and a picker has no
   business with EP's margin. The register renders name and warehouse code
   only, both of which `lib/hop.ts` reads directly — module reads are not
   permission-gated, `can()` guards what a person is shown and allowed to do.
   So the join costs nothing and the capability stays withheld.

   No `staffing.*` either. The briefing gives Pete both staffing and the
   warehouse, but a Warehouse Manager who can also reassign shifts is not the
   boundary this role exists to draw; staffing stays with Jake.
*/
const WAREHOUSE_CAPS: Capability[] = [
  'calendar.view',
  'kit.view', 'kit.prepare', 'kit.stock',
  'notifications.view',
];

const PAYROLL_CAPS: Capability[] = [
  'attendance.view', 'attendance.edit', 'checkin.approve',
  'report.payroll', 'payroll.run', 'pay.view',
  'staff.view', 'docs.view',
  'notifications.view',
];

const FINANCE_CAPS: Capability[] = [
  'wof.view', 'calendar.view', 'attendance.view',
  'report.cashflow', 'report.costing', 'report.payroll', 'pay.view',
  'clients.view', 'clients.rates', 'charges.view', 'charges.edit',
  'notifications.view',
];

const READONLY_CAPS: Capability[] = [
  'wof.view', 'calendar.view', 'staffing.view', 'attendance.view',
  'clients.view', 'schedules.view', 'staff.view',
  'notifications.view',
];

/** The shipped defaults. `ROLES` below is this, with saved edits applied. */
const ROLE_SEED: Role[] = [
  {
    id: 'owner', label: 'Super Admin', icon: 'star', locked: true,
    blurb: 'Everything, including this page. There must always be at least one.',
    caps: [...ALL_CAPS],
  },
  {
    id: 'senior-manager', label: 'Senior Manager', icon: 'checkCircle',
    blurb: 'Runs jobs like Operations, and is the second signature on a quote over the approval threshold.',
    caps: SENIOR_MANAGER_CAPS,
  },
  {
    id: 'ops', label: 'Operations', icon: 'layers',
    blurb: 'Runs the job end to end: work orders, staffing, delivery. No payroll, no pay rates.',
    caps: OPS_CAPS,
  },
  {
    id: 'client-manager', label: 'Client Manager', icon: 'building',
    blurb: 'Owns the client relationship — quotes, orders, accounts and the margin on their jobs.',
    caps: CLIENT_MANAGER_CAPS,
  },
  {
    id: 'recruitment', label: 'Recruitment', icon: 'userPlus',
    blurb: 'Brings workers on and keeps their paperwork current. Cannot see pay or client money.',
    caps: RECRUITMENT_CAPS,
  },
  {
    id: 'scheduling', label: 'Scheduling', icon: 'calendar',
    blurb: 'Fills the shifts and approves the check-ins. Sees hours, not rates.',
    caps: SCHEDULING_CAPS,
  },
  {
    id: 'warehouse', label: 'Warehouse Manager', icon: 'inbox',
    blurb: 'Receives the kit list, picks and packs it, and owns what EP owns. No work orders, no money, no rota.',
    caps: WAREHOUSE_CAPS,
  },
  {
    id: 'payroll', label: 'Payroll', icon: 'trendUp',
    blurb: 'Turns approved hours into payments. Sees what people are paid; cannot change the job.',
    caps: PAYROLL_CAPS,
  },
  {
    id: 'finance', label: 'Finance', icon: 'fileText',
    blurb: 'Cash flow, costing, charge rates and payroll sign-off. Read-only on delivery.',
    caps: FINANCE_CAPS,
  },
  {
    id: 'readonly', label: 'Read only', icon: 'search',
    blurb: 'Can look at the operational picture and change nothing. For auditors and new starters.',
    caps: READONLY_CAPS,
  },
];

export const ROLE_ORDER: RoleId[] = ROLE_SEED.map((r) => r.id);

/** Live role table. Mutated in place by `setRoleCaps` so readers stay singular. */
export const ROLES: Record<RoleId, Role> = Object.fromEntries(
  ROLE_SEED.map((r) => [r.id, { ...r, caps: [...r.caps] }]),
) as Record<RoleId, Role>;

export const role = (id: RoleId | null | undefined): Role | undefined =>
  id ? ROLES[id] : undefined;

export const roleList = (): Role[] => ROLE_ORDER.map((id) => ROLES[id]);

/* ==========================================================================
   3. MEMBERS
   --------------------------------------------------------------------------
   Seeded from the people the briefing already names, because inventing a
   second list of EP Team staff would immediately disagree with the one on the
   work orders. Two accounts are added that the briefing implies but does not
   staff — a client manager and a recruiter — and the recruiter is left in the
   INVITED state so the invite lifecycle is visible without having to send one.

   `jobTitle` and `roleId` are deliberately separate fields. "OPS Manager" is
   what is on Colin's contract; "Operations" is what the software will let him
   touch. Collapsing them means every job title change becomes a permission
   change nobody reviewed.
   ========================================================================== */

export type MemberStatus = 'active' | 'invited' | 'suspended';

export interface Member {
  id: string;
  name: string;
  email: string;
  jobTitle: string;
  roleId: RoleId;
  initials: string;
  hue: number;
  status: MemberStatus;
  /** ISO date. Null for seeded accounts that predate invitations. */
  invitedAt: string | null;
  lastActive: string | null;
}

const SEED_ROLE: Record<string, RoleId> = {
  'm-colin': 'owner',
  'm-gracie': 'ops',
  'm-pete': 'warehouse',
  'm-jenny': 'payroll',
  'm-jake': 'scheduling',
  'm-fd': 'finance',
};

const SEED_LAST_ACTIVE: Record<string, string> = {
  'm-colin': '2026-07-31',
  'm-gracie': '2026-07-31',
  'm-pete': '2026-07-30',
  'm-jenny': '2026-07-29',
  'm-jake': '2026-07-31',
  'm-fd': '2026-07-24',
};

const emailFor = (name: string): string =>
  `${name.toLowerCase().replace(/[^a-z ]/g, '').split(' ').join('.')}@epteam.co.uk`;

const MEMBER_SEED: Member[] = [
  ...MANAGERS.map<Member>((m) => ({
    id: m.id,
    name: m.name,
    email: emailFor(m.name),
    jobTitle: m.role,
    roleId: SEED_ROLE[m.id] || 'readonly',
    initials: m.initials,
    hue: m.hue,
    status: 'active',
    invitedAt: null,
    lastActive: SEED_LAST_ACTIVE[m.id] || null,
  })),
  {
    id: 'm-nadia', name: 'Nadia Okafor', email: 'nadia.okafor@epteam.co.uk',
    jobTitle: 'Account Manager', roleId: 'client-manager',
    initials: 'NO', hue: 190, status: 'active', invitedAt: null, lastActive: '2026-07-30',
  },
  {
    id: 'm-dawn', name: 'Dawn Cartwright', email: 'dawn.cartwright@epteam.co.uk',
    jobTitle: 'Senior Operations Manager', roleId: 'senior-manager',
    initials: 'DC', hue: 176, status: 'active', invitedAt: null, lastActive: '2026-07-31',
  },
  {
    id: 'm-ruth', name: 'Ruth Adeyemi', email: 'ruth.adeyemi@epteam.co.uk',
    jobTitle: 'Recruitment Officer', roleId: 'recruitment',
    initials: 'RA', hue: 96, status: 'invited', invitedAt: '2026-07-29', lastActive: null,
  },
];

/** Live member list. Mutated in place, same contract as `CLIENTS`. */
export const MEMBERS: Member[] = shiftDeep(MEMBER_SEED.map((m) => ({ ...m })));

export const member = (id: string | null | undefined): Member | undefined =>
  MEMBERS.find((m) => m.id === id);

export const members = (): Member[] =>
  MEMBERS.slice().sort((a, b) => {
    const byRole = ROLE_ORDER.indexOf(a.roleId) - ROLE_ORDER.indexOf(b.roleId);
    return byRole || a.name.localeCompare(b.name);
  });

export const membersWithRole = (id: RoleId): Member[] => MEMBERS.filter((m) => m.roleId === id);

/** Accounts that can actually sign in. An invite is not yet access. */
const activeWithRole = (id: RoleId): Member[] =>
  MEMBERS.filter((m) => m.roleId === id && m.status === 'active');

export const superAdmins = (): Member[] => activeWithRole('owner');

/**
 * Everyone who could approve a high-value quote — read off the capability
 * rather than off the role, so granting `wof.approve` to Finance tomorrow puts
 * the Finance Director in this list without a second edit here.
 *
 * Whether any given one of them may approve THIS quote is a separate question,
 * and `wof.approveQuoteBlock` owns it: nobody approves their own pricing.
 */
export const approvers = (): Member[] =>
  MEMBERS.filter((m) => m.status === 'active' && !!ROLES[m.roleId]?.caps.includes('wof.approve'));

/* ==========================================================================
   4. STORE
   ========================================================================== */

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
  /** Full capability set per edited role. See the header for why not a delta. */
  caps: Partial<Record<RoleId, Capability[]>>;
  roleOf: Record<string, RoleId>;
  statusOf: Record<string, MemberStatus>;
  added: Member[];
  removed: string[];
  /**
   * Name, email and job title, per member.
   *
   * Separate from `roleOf` on purpose. Editing your own display name and
   * changing what you are allowed to do are different acts with different
   * permissions behind them — one is yours, the other is the Super Admin's.
   * Folding them into one map would make the journal unable to say which
   * happened.
   */
  profileOf: Record<string, ProfileFields>;
  /**
   * Roles created on this page, in full — unlike `caps`, which only ever
   * holds an edit to a *seeded* role. A custom role has no seed to diff
   * against, so its whole definition has to live in the journal, and
   * `setRoleCaps` updates the entry here in place rather than touching `caps`.
   */
  customRoles: Role[];
  /** Ids of custom roles deleted in this browser. */
  removedRoles: RoleId[];
}

/** The fields a person may edit about themselves. Role is conspicuously absent. */
export interface ProfileFields {
  name: string;
  email: string;
  jobTitle: string;
}

const empty = (): Journal => ({
  v: 1, caps: {}, roleOf: {}, statusOf: {}, added: [], removed: [], profileOf: {},
  customRoles: [], removedRoles: [],
});

function read(): Journal {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!raw || raw.v !== 1) return empty();
    return {
      v: 1,
      caps: raw.caps && typeof raw.caps === 'object' ? raw.caps : {},
      roleOf: raw.roleOf && typeof raw.roleOf === 'object' ? raw.roleOf : {},
      statusOf: raw.statusOf && typeof raw.statusOf === 'object' ? raw.statusOf : {},
      added: Array.isArray(raw.added) ? raw.added : [],
      removed: Array.isArray(raw.removed) ? raw.removed : [],
      // Absent in journals written before profile editing existed. Defaulted
      // rather than version-bumped: an old journal is still entirely valid,
      // it just has nothing to say about profiles.
      profileOf: raw.profileOf && typeof raw.profileOf === 'object' ? raw.profileOf : {},
      // Same treatment: absent in journals written before custom roles existed.
      customRoles: Array.isArray(raw.customRoles) ? raw.customRoles : [],
      removedRoles: Array.isArray(raw.removedRoles) ? raw.removedRoles : [],
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

/* ==========================================================================
   5. WHO IS ACTING
   --------------------------------------------------------------------------
   Same prototype device as the client selector in `portal.ts`, and for the same
   reason: a permission system you cannot see from the other side is a claim
   rather than a feature. Signing in as the payroll clerk is how you find out
   that hiding the cash-flow route left its export button live.

   Defaults to the Super Admin, so a fresh browser opens on the full console.
   ========================================================================== */

const DEFAULT_MEMBER_ID = 'm-colin';

export function actingId(): string {
  let id: string | null = null;
  try {
    id = localStorage.getItem(KEY_ACTING);
  } catch {
    /* private mode */
  }
  const m = id ? member(id) : undefined;
  return m && m.status === 'active' ? m.id : DEFAULT_MEMBER_ID;
}

export const acting = (): Member => member(actingId()) || MEMBERS[0];

export function setActing(id: string): void {
  const m = member(id);
  if (!m || m.status !== 'active') return;
  try {
    localStorage.setItem(KEY_ACTING, id);
  } catch {
    /* private mode */
  }
  emit();
}

/** Members the switcher offers. An invited or suspended account cannot act. */
export const selectableMembers = (): Member[] => members().filter((m) => m.status === 'active');

export const actingRole = (): Role => ROLES[acting().roleId] || ROLES.readonly;

/**
 * The acting member in the shape `lib/wof` records history in.
 *
 * Lives here rather than in `wof.ts` because `wof.ts` deliberately knows
 * nothing about who is signed in — it takes an actor and writes it down. This
 * is the one line that joins the two, and it is on this side of the join so
 * the domain stays testable without a session.
 */
export const actingActor = (): { by: string; name: string } => {
  const m = acting();
  return { by: m.id, name: m.name };
};

/* ==========================================================================
   6. THE PREDICATE
   --------------------------------------------------------------------------
   The only permission question in the app. Note what it does NOT do: it does
   not check the tier. A client is kept out of `/reports/payroll` by
   `portal.canAccess`, which owns that question; if this function also tried to
   answer it there would be two places to change and one of them would be
   forgotten.
   ========================================================================== */

export function can(cap: Capability): boolean {
  return actingRole().caps.includes(cap);
}

/** `can` for every one of them. Use for "…and can also do X" gates. */
export const canAll = (...caps: Capability[]): boolean => caps.every(can);
export const canAny = (...caps: Capability[]): boolean => caps.some(can);

/** Capability the acting member is missing, for the "why is this greyed out" text. */
export function denial(cap: Capability): string | null {
  if (can(cap)) return null;
  const meta = capMeta(cap);
  return `Your role (${actingRole().label}) does not include “${meta?.label || cap}”. A Super Admin can grant it in Account settings.`;
}

/**
 * Spread onto a button to gate it: `<button {...gate('payroll.run')} …>`.
 *
 * Disabled AND titled, always together. A control that is greyed out with no
 * explanation is indistinguishable from one that is broken, and the person
 * looking at it cannot see the permission table that would tell them why.
 */
export function gate(cap: Capability): { disabled: boolean; title: string | undefined } {
  const why = denial(cap);
  return { disabled: !!why, title: why || undefined };
}

/* ==========================================================================
   7. MUTATIONS
   --------------------------------------------------------------------------
   Every one of these returns a REASON on refusal. A disabled control with no
   explanation is the thing operators file support tickets about.
   ========================================================================== */

export interface Result {
  ok: boolean;
  reason?: string;
}

/** Guard shared by every write on this page. */
function requireManage(): Result | null {
  if (!can('team.manage')) {
    return { ok: false, reason: 'Only a role with “Manage team & roles” can change access.' };
  }
  return null;
}

/* ------------------------------------------------------- role permissions */

export function setRoleCaps(id: RoleId, caps: Capability[]): Result {
  const blocked = requireManage();
  if (blocked) return blocked;

  const r = ROLES[id];
  if (!r) return { ok: false, reason: 'Unknown role.' };
  if (r.locked) {
    return { ok: false, reason: 'Super Admin always has every permission. That is what makes it the way back in.' };
  }

  // Managing the team without being able to see it is not a state anyone means
  // to create, and it renders the page it grants access to unreadable.
  const clean = ALL_CAPS.filter((c) => caps.includes(c));
  if (clean.includes('team.manage') && !clean.includes('team.view')) clean.push('team.view');

  r.caps = clean;

  // A custom role has no seed to diff against — its whole definition lives in
  // `journal.customRoles`, so an edit updates that entry rather than `caps`,
  // which is reserved for edits to a *seeded* role.
  const customEntry = journal.customRoles.find((c) => c.id === id);
  if (customEntry) customEntry.caps = clean;
  else journal.caps[id] = clean;

  write();
  return { ok: true };
}

export function resetRoleCaps(id: RoleId): Result {
  const blocked = requireManage();
  if (blocked) return blocked;

  const seed = ROLE_SEED.find((r) => r.id === id);
  if (!seed || ROLES[id].locked) return { ok: false, reason: 'That role has no editable defaults.' };

  ROLES[id].caps = [...seed.caps];
  delete journal.caps[id];
  write();
  return { ok: true };
}

/** Has this role been changed from what shipped? Drives the "Edited" pill. */
export const isRoleEdited = (id: RoleId): boolean => !!journal.caps[id];

export const defaultCaps = (id: RoleId): Capability[] =>
  ROLE_SEED.find((r) => r.id === id)?.caps ?? [];

/* --------------------------------------------------------- custom roles --- */

/**
 * A role invented here rather than shipped. It always starts as a copy of an
 * existing role's permissions — "start from nothing and tick 26 boxes" is how
 * a real recruiter ends up with a role that cannot see the staff register —
 * and the administrator adjusts the copy in the permissions dialog straight
 * after creating it.
 */
export interface CreateRoleInput {
  label: string;
  /** Falls back to a note naming the source role when left blank. */
  blurb: string;
  copyFrom: RoleId;
}

export interface CreateRoleResult extends Result {
  role?: Role;
}

const slugify = (label: string): string =>
  label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'role';

function nextRoleId(label: string): RoleId {
  const base = `custom-${slugify(label)}`;
  if (!ROLES[base]) return base;
  let n = 2;
  while (ROLES[`${base}-${n}`]) n++;
  return `${base}-${n}`;
}

export function createRole(input: CreateRoleInput): CreateRoleResult {
  const blocked = requireManage();
  if (blocked) return blocked;

  const label = input.label.trim();
  if (!label) return { ok: false, reason: 'Name the role.' };
  if (roleList().some((r) => r.label.toLowerCase() === label.toLowerCase())) {
    return { ok: false, reason: 'A role already has that name.' };
  }

  const source = ROLES[input.copyFrom];
  if (!source) return { ok: false, reason: 'Pick a role to start from.' };

  const id = nextRoleId(label);
  const created: Role = {
    id,
    label,
    blurb: input.blurb.trim() || `Copied from ${source.label}. Nobody has adjusted it yet.`,
    // A fixed icon rather than the source's own — two cards sharing an icon
    // read as the same role at a glance, and this is deliberately not that.
    icon: 'flag',
    custom: true,
    caps: [...source.caps],
  };

  ROLES[id] = created;
  ROLE_ORDER.push(id);
  journal.customRoles.push({ ...created, caps: [...created.caps] });
  write();
  return { ok: true, role: created };
}

/** Why a custom role cannot be deleted, or null when it can. */
export function deleteRoleBlocker(id: RoleId): string | null {
  if (!can('team.manage')) return 'Only a role with “Manage team & roles” can delete a role.';

  const r = ROLES[id];
  if (!r) return 'No such role.';
  if (!r.custom) return 'Only a role created here can be deleted — the shipped roles are fixed.';

  const holders = membersWithRole(id);
  if (holders.length) {
    return `${holders.length} ${holders.length === 1 ? 'person holds' : 'people hold'} this role — move ${holders.length === 1 ? 'them' : 'them all'} to another role first.`;
  }
  return null;
}

export function deleteRole(id: RoleId): Result {
  const why = deleteRoleBlocker(id);
  if (why) return { ok: false, reason: why };

  delete ROLES[id];
  const i = ROLE_ORDER.indexOf(id);
  if (i >= 0) ROLE_ORDER.splice(i, 1);

  journal.customRoles = journal.customRoles.filter((r) => r.id !== id);
  delete journal.caps[id];
  if (!journal.removedRoles.includes(id)) journal.removedRoles.push(id);

  write();
  return { ok: true };
}

/* ------------------------------------------------------------- assignment */

/**
 * Why a member's role cannot be changed, or null when it can. Split out from
 * `assignRole` so the menu can grey the option and say why in the same pass.
 */
export function assignBlocker(memberId: string, next?: RoleId): string | null {
  if (!can('team.manage')) return 'Only a Super Admin can change roles.';

  const m = member(memberId);
  if (!m) return 'No such member.';

  if (m.id === actingId()) {
    return 'You cannot change your own role. Ask another Super Admin — this is what stops one mis-click removing the last way in.';
  }
  if (m.roleId === 'owner' && next !== 'owner' && superAdmins().length <= 1) {
    return 'This is the only Super Admin. Promote someone else first.';
  }
  return null;
}

export function assignRole(memberId: string, next: RoleId): Result {
  const why = assignBlocker(memberId, next);
  if (why) return { ok: false, reason: why };

  const m = member(memberId)!;
  if (!ROLES[next]) return { ok: false, reason: 'Unknown role.' };

  m.roleId = next;

  const added = journal.added.find((a) => a.id === memberId);
  if (added) added.roleId = next;
  else journal.roleOf[memberId] = next;

  write();
  return { ok: true };
}

/* ----------------------------------------------------------------- invite */

export interface InviteInput {
  name: string;
  email: string;
  jobTitle: string;
  roleId: RoleId;
}

export interface InviteResult extends Result {
  member?: Member;
  errors?: { name?: string; email?: string };
}

export function validateEmail(email: string, exceptId?: string): string | null {
  const e = email.trim().toLowerCase();
  if (!e) return 'Required';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return 'That is not an email address';
  if (MEMBERS.some((m) => m.id !== exceptId && m.email.toLowerCase() === e))
    return 'Someone already has access with that address';
  return null;
}

function nextMemberId(): string {
  let n = MEMBERS.length + 1;
  while (MEMBERS.some((m) => m.id === `m-new-${n}`)) n++;
  return `m-new-${n}`;
}

const initialsOf = (name: string): string =>
  name.trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase() || '?';

/**
 * The initials a name WOULD get, without saving anything.
 *
 * The account settings form previews the avatar as you type, and a preview that
 * derived initials by its own rule would eventually disagree with the one
 * `updateProfile` uses — which is the sort of bug nobody reports and everybody
 * notices. Returns an empty string for an empty name so the caller can fall
 * back to the current avatar rather than showing a placeholder "?".
 */
export const initialsPreview = (name: string): string =>
  name.trim() ? initialsOf(name) : '';

export function inviteMember(input: InviteInput, today: string): InviteResult {
  const blocked = requireManage();
  if (blocked) return blocked;

  const errors = {
    name: input.name.trim() ? undefined : 'Required',
    email: validateEmail(input.email) ?? undefined,
  };
  if (errors.name || errors.email) return { ok: false, errors };
  if (!ROLES[input.roleId]) return { ok: false, reason: 'Pick a role.' };

  const m: Member = {
    id: nextMemberId(),
    name: input.name.trim(),
    email: input.email.trim().toLowerCase(),
    jobTitle: input.jobTitle.trim() || ROLES[input.roleId].label,
    roleId: input.roleId,
    initials: initialsOf(input.name),
    // Deterministic from the name so the same person keeps the same colour.
    hue: ([...input.name.trim()].reduce((a, c) => a + c.charCodeAt(0), 0) * 13) % 360,
    status: 'invited',
    invitedAt: today,
    lastActive: null,
  };

  MEMBERS.push(m);
  journal.added.push(m);
  write();
  return { ok: true, member: m };
}

/* -------------------------------------------------------------- profile -- */

export interface ProfileResult extends Result {
  errors?: { name?: string; email?: string };
}

/**
 * Who may edit whose profile?
 *
 * Your own, always — needing a permission to correct the spelling of your own
 * name is the kind of rule that gets worked around by asking an administrator,
 * which is worse for everybody. Anyone else's needs `team.manage`, because
 * changing the name and address on someone else's account is impersonation
 * with extra steps.
 */
export function profileBlocker(memberId: string): string | null {
  if (memberId === actingId()) return null;
  if (!member(memberId)) return 'No such member.';
  if (!can('team.manage')) return "Only a Super Admin can edit someone else's details.";
  return null;
}

/**
 * Change a member's name, email or job title.
 *
 * The email is the account identifier, so it is uniqueness-checked against
 * everyone else — the same check `inviteMember` runs, reused rather than
 * reimplemented so the two can never disagree about what a duplicate is.
 *
 * Initials follow the name. They are shown on every avatar in the app, and a
 * "Colin Harding" whose avatar still reads GT is a bug report waiting to be
 * filed. The hue does not follow: it is somebody's colour, people learn it,
 * and a rename should not reshuffle the calendar.
 */
export function updateProfile(memberId: string, input: ProfileFields): ProfileResult {
  const why = profileBlocker(memberId);
  if (why) return { ok: false, reason: why };

  const m = member(memberId);
  if (!m) return { ok: false, reason: 'No such member.' };

  const errors = {
    name: input.name.trim() ? undefined : 'Required',
    email: validateEmail(input.email, memberId) ?? undefined,
  };
  if (errors.name || errors.email) return { ok: false, errors };

  const next: ProfileFields = {
    name: input.name.trim(),
    email: input.email.trim().toLowerCase(),
    // Falls back to the role label rather than staying blank, matching invite.
    jobTitle: input.jobTitle.trim() || (ROLES[m.roleId]?.label ?? ''),
  };

  m.name = next.name;
  m.email = next.email;
  m.jobTitle = next.jobTitle;
  m.initials = initialsOf(next.name);

  // A member invited in this browser lives in `added`, so the edit belongs
  // there — writing it to `profileOf` as well would leave two records of one
  // person that could drift apart on the next replay.
  const added = journal.added.find((a) => a.id === memberId);
  if (added) {
    added.name = next.name;
    added.email = next.email;
    added.jobTitle = next.jobTitle;
    added.initials = m.initials;
  } else {
    journal.profileOf[memberId] = next;
  }

  write();
  return { ok: true };
}

/* ------------------------------------------------------- status & removal */

export function setStatus(memberId: string, status: MemberStatus): Result {
  const blocked = requireManage();
  if (blocked) return blocked;

  const m = member(memberId);
  if (!m) return { ok: false, reason: 'No such member.' };
  if (m.id === actingId()) return { ok: false, reason: 'You cannot suspend your own account.' };
  if (m.roleId === 'owner' && status !== 'active' && superAdmins().length <= 1) {
    return { ok: false, reason: 'This is the only active Super Admin. Promote someone else first.' };
  }

  m.status = status;
  const added = journal.added.find((a) => a.id === memberId);
  if (added) added.status = status;
  else journal.statusOf[memberId] = status;

  write();
  return { ok: true };
}

export function removeBlocker(memberId: string): string | null {
  if (!can('team.manage')) return 'Only a Super Admin can remove access.';
  const m = member(memberId);
  if (!m) return 'No such member.';
  if (m.id === actingId()) return 'You cannot remove your own access.';
  if (m.roleId === 'owner' && m.status === 'active' && superAdmins().length <= 1) {
    return 'This is the only Super Admin. Promote someone else first.';
  }
  return null;
}

export function removeMember(memberId: string): Result {
  const why = removeBlocker(memberId);
  if (why) return { ok: false, reason: why };

  const i = MEMBERS.findIndex((m) => m.id === memberId);
  if (i < 0) return { ok: false, reason: 'No such member.' };
  MEMBERS.splice(i, 1);

  journal.added = journal.added.filter((a) => a.id !== memberId);
  delete journal.roleOf[memberId];
  delete journal.statusOf[memberId];
  if (!journal.removed.includes(memberId)) journal.removed.push(memberId);

  write();
  return { ok: true };
}

/** Discard every local change and go back to the shipped roles and team. */
export function resetAll(): void {
  journal = empty();
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  ROLE_SEED.forEach((r) => {
    ROLES[r.id].caps = [...r.caps];
  });
  // Drop every role created in this browser and go back to just the shipped set.
  Object.keys(ROLES).forEach((id) => {
    if (!ROLE_SEED.some((r) => r.id === id)) delete ROLES[id];
  });
  ROLE_ORDER.length = 0;
  ROLE_SEED.forEach((r) => ROLE_ORDER.push(r.id));
  MEMBERS.length = 0;
  MEMBER_SEED.forEach((m) => MEMBERS.push({ ...m }));
  emit();
}

/* ==========================================================================
   8. APPLY
   --------------------------------------------------------------------------
   Replay the journal over the seed. Runs once, at import, before the first
   screen renders — the same contract `clients.ts` has, and for the same reason:
   a permission granted last week must be in force before anything asks `can()`.
   ========================================================================== */

(function applyJournal() {
  // Custom roles are recreated before anything else touches them — a
  // capability edit or a member assignment further down may name one.
  journal.customRoles.forEach((created) => {
    const caps = ALL_CAPS.filter((c) => created.caps.includes(c));
    if (!ROLES[created.id]) ROLE_ORDER.push(created.id);
    ROLES[created.id] = { ...created, custom: true, caps };
  });

  (Object.keys(journal.caps) as RoleId[]).forEach((id) => {
    const saved = journal.caps[id];
    if (!ROLES[id] || ROLES[id].locked || !Array.isArray(saved)) return;
    // Filter through ALL_CAPS so a capability removed from the product does not
    // survive in storage as a string nothing understands.
    ROLES[id].caps = ALL_CAPS.filter((c) => saved.includes(c));
  });

  journal.added.forEach((a) => {
    if (!MEMBERS.some((m) => m.id === a.id)) MEMBERS.push({ ...a });
  });

  Object.entries(journal.roleOf).forEach(([id, r]) => {
    const m = member(id);
    if (m && ROLES[r]) m.roleId = r;
  });

  Object.entries(journal.statusOf).forEach(([id, s]) => {
    const m = member(id);
    if (m) m.status = s;
  });

  // After `added`, so a member invited and then renamed in the same session
  // replays in the order it happened.
  Object.entries(journal.profileOf).forEach(([id, p]) => {
    const m = member(id);
    if (!m || !p) return;
    if (p.name) {
      m.name = p.name;
      m.initials = initialsOf(p.name);
    }
    if (p.email) m.email = p.email;
    if (p.jobTitle) m.jobTitle = p.jobTitle;
  });

  journal.removed.forEach((id) => {
    const i = MEMBERS.findIndex((m) => m.id === id);
    if (i >= 0) MEMBERS.splice(i, 1);
  });

  // Deleted custom roles go last, after every reference to them has already
  // replayed — `deleteRole` itself refuses while anyone still holds the role,
  // so this is tidy-up, not a rescue.
  journal.removedRoles.forEach((id) => {
    delete ROLES[id];
    const i = ROLE_ORDER.indexOf(id);
    if (i >= 0) ROLE_ORDER.splice(i, 1);
  });

  // Belt and braces for the one case the guard above cannot see: a role
  // deleted, then the journal replayed against a product build where the
  // capability list changed underneath it. Nobody should be left pointing at
  // a role that no longer exists.
  MEMBERS.forEach((m) => {
    if (!ROLES[m.roleId]) m.roleId = 'readonly';
  });

  // A journal that leaves nobody in charge is a corrupt journal, not a valid
  // state. Restoring the seeded Super Admin is the only safe repair.
  if (!superAdmins().length) {
    const colin = member(DEFAULT_MEMBER_ID);
    if (colin) {
      colin.roleId = 'owner';
      colin.status = 'active';
    } else {
      MEMBERS.unshift({ ...MEMBER_SEED[0], roleId: 'owner', status: 'active' });
    }
  }
})();
