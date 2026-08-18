/* ============================================================================
   EPROSTA — TIERS
   ----------------------------------------------------------------------------
   The same database, seen from three sides:

     admin   EP Team staff. Everything. This is the console that already existed.
     client  The organisation that booked the job. Their events, their coverage,
             the hours delivered against them. Nothing about other clients, no
             pay rates, no margin.
     staff   The person who works the shift. Jobs they can apply for, the shifts
             they hold, what they earned, what paperwork is outstanding.

   Two rules make the tiers honest rather than decorative:

     1. Scope is applied HERE, once, in `clientEvents()` / `myAttendance()` /
        `openRoles()` and friends — not re-derived on each page. A page that
        forgets to filter cannot leak, because it is never handed the full set.

     2. `canAccess()` is enforced in the route guard. Typing an admin URL while
        acting as a client bounces you to the client home rather than rendering
        the page, so the switcher is not a cosmetic filter over a shared screen.

   The switcher itself is a PROTOTYPE DEVICE, not a product feature. Real tiers
   come from the account you signed in with. It sits next to the notification
   bell so it is findable during a demo without pretending to be part of the
   product's own navigation.
   ========================================================================== */

import {
  ATTENDANCE, EVENTS, NOW,
  client as clientById, employee as employeeById, event as eventById, tag as tagById,
} from '@/data/db';
import type { Assignment, EpEvent, Shift, Split, Tone } from '@/data/types';
import { splitCoverage, eventCoverage, type Coverage } from './coverage';
import * as EV from './events';
import { timing, type Timing } from './format';
import * as WOF from './wof';
import * as ROLES from './roles';

const KEY_TIER = 'epteam.tier';
const KEY_APPS = 'epteam.applications';
const KEY_CLIENT = 'epteam.actingClient';

/* ==========================================================================
   1. WHO IS ACTING
   --------------------------------------------------------------------------
   The worker identity is fixed: Omolobake has the richest record in the data —
   assigned across three Wilderness shifts with settled hours — and letting the
   demo pick any of thirty workers would make the switcher a second navigation
   system without showing anything new.

   The CLIENT identity is selectable, because it has to be. An operator raises a
   work order against whichever client rang up; if the portal were pinned to one
   organisation, that job would be invisible from the client side and the round
   trip could not be demonstrated at all. So the switcher offers every client
   with live work, and the choice is remembered.
   ========================================================================== */

const DEFAULT_CLIENT_ID = 'c-19'; // Festival Republic Ltd — the richest account
const ACTING_EMPLOYEE_ID = 'e-9'; // Omolobake Ashimolowo

export type TierId = 'admin' | 'client' | 'staff';

export interface Tier {
  id: TierId;
  label: string;
  role: string;
  blurb: string;
  home: string;
  icon: string;
}

export const TIERS: Record<TierId, Tier> = {
  admin: {
    id: 'admin',
    label: 'EP Team',
    role: 'Internal console',
    blurb: 'Everything: the WOF pipeline, staffing, reports and reference data.',
    home: '/wofs',
    icon: 'layers',
  },
  client: {
    id: 'client',
    label: 'Client',
    role: 'Booking organisation',
    blurb: 'Sign quotes, send documents, approve changes, pay. Nothing about other clients.',
    home: '/client/jobs',
    icon: 'building',
  },
  staff: {
    id: 'staff',
    label: 'Staff',
    role: 'Worker',
    blurb: 'Apply for shifts, hold a rota, see hours and paperwork.',
    home: '/my/jobs',
    icon: 'staff',
  },
};

export const ORDER: TierId[] = ['admin', 'client', 'staff'];

/* --- tiny store so React re-renders when the tier or an application changes */

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

export function current(): TierId {
  let t: string | null = null;
  try {
    t = localStorage.getItem(KEY_TIER);
  } catch {
    /* private mode */
  }
  return TIERS[t as TierId] ? (t as TierId) : 'admin';
}

export function setTier(tier: TierId): void {
  if (!TIERS[tier]) return;
  try {
    localStorage.setItem(KEY_TIER, tier);
  } catch {
    /* private mode */
  }
  emit();
}

export const tier = (): Tier => TIERS[current()];
export const actingEmployee = () => employeeById(ACTING_EMPLOYEE_ID)!;

/* ------------------------------------------------------- acting client --- */

export function actingClientId(): string {
  let id: string | null = null;
  try {
    id = localStorage.getItem(KEY_CLIENT);
  } catch {
    /* private mode */
  }
  return id && clientById(id) ? id : DEFAULT_CLIENT_ID;
}

export const actingClient = () => clientById(actingClientId())!;

export function setActingClient(id: string): void {
  if (!clientById(id)) return;
  try {
    localStorage.setItem(KEY_CLIENT, id);
  } catch {
    /* private mode */
  }
  emit();
}

/** Clients the switcher offers: anyone with a live work order, plus the default. */
export function selectableClients() {
  const ids = new Set([...WOF.clientsWithWork(), DEFAULT_CLIENT_ID]);
  return [...ids]
    .map((id) => clientById(id))
    .filter((c): c is NonNullable<typeof c> => !!c)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The client's own identity for anything they do. Every client-side mutation
 * carries this, so the WOF history names the person rather than crediting EP
 * Team with signing the client's own quote.
 */
export function clientActor(): WOF.Actor {
  const c = actingClient();
  return { by: 'client', name: c.contact ? `${c.contact} (${c.name})` : c.name };
}

export interface ActingIdentity {
  name: string;
  sub: string;
  initials: string;
  hue: number;
  detail: string;
}

/**
 * The identity shown in the sidebar footer.
 *
 * Admin used to be the hardcoded string "Jake Wright". It is now whichever team
 * member is acting, because the console no longer shows every operator the same
 * thing — the footer has to name the person whose permissions are in force, or
 * a screen missing from the rail looks like a bug rather than a role.
 */
export function acting(): ActingIdentity {
  const t = current();
  if (t === 'client') {
    const c = actingClient();
    // The named contact on the client record, not a hardcoded person — the
    // acting client is selectable, so the identity has to follow it.
    const name = c.contact || 'Client contact';
    const initials = name
      .split(' ')
      .map((p) => p[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();
    // Deterministic hue from the client id, so each account keeps its colour.
    const hue = (parseInt(c.id.replace(/\D/g, ''), 10) * 47) % 360;
    return {
      name, sub: c.name, initials, hue,
      detail: `${c.contactRole || 'Authorised contact'} · ${c.name}`,
    };
  }
  if (t === 'staff') {
    const e = actingEmployee();
    return {
      name: e.name, sub: `${e.department} · ${e.office}`, initials: e.initials, hue: e.hue,
      detail: `${e.employmentType} · joined ${e.startedAt}`,
    };
  }
  const m = ROLES.acting();
  return {
    name: m.name,
    sub: ROLES.role(m.roleId)?.label || m.jobTitle,
    initials: m.initials,
    hue: m.hue,
    detail: `${m.jobTitle} · EP Team internal`,
  };
}

/* ==========================================================================
   2. NAVIGATION PER TIER
   ========================================================================== */

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  badgeKey?: BadgeKey;
  /**
   * The capability this item requires. Admin only — the client and staff rails
   * are already the whole of what those tiers may see, so a second permission
   * layer on top of them would be a control with nothing to control.
   *
   * An item without a `cap` is visible to every EP Team role. There is exactly
   * one, and it is deliberate: see the Notifications entry below.
   */
  cap?: ROLES.Capability;
  /**
   * Force this item to stay live even when its group is `disabled`. Lets a
   * single entry be unlocked out of an otherwise parked section.
   */
  active?: boolean;
}
export interface NavGroup {
  group: string;
  items: NavItem[];
  /**
   * A grouped-but-inactive section: its heading and items still render so the
   * shape of the console is visible, but every item is shown greyed out and is
   * not clickable. Used to park whole areas that are not yet in play.
   */
  disabled?: boolean;
}

export type BadgeKey =
  | 'wofAttention' | 'noWof' | 'checkins' | 'docsOutstanding' | 'notifications'
  | 'clientTodo' | 'clientGaps' | 'openRoles' | 'myUpcoming' | 'myDocsDue';

export const NAV: Record<TierId, NavGroup[]> = {
  admin: [
    {
      group: 'Work orders',
      items: [
        { href: '/wofs', label: 'WOF pipeline', icon: 'fileText', badgeKey: 'wofAttention', cap: 'wof.view' },
        { href: '/calendar', label: 'Event calendar', icon: 'calendar', badgeKey: 'noWof', cap: 'calendar.view' },
      ],
    },
    {
      group: 'Delivery',
      disabled: true,
      items: [
        { href: '/events', label: 'Staffing', icon: 'events', cap: 'staffing.view', active: true },
        { href: '/check-in-approvals', label: 'Check-In Approvals', icon: 'checkin', badgeKey: 'checkins', cap: 'checkin.approve' },
        { href: '/attendance', label: 'Attendance', icon: 'attendance', cap: 'attendance.view' },
      ],
    },
    {
      group: 'Reports',
      disabled: true,
      items: [
        { href: '/reports/cashflow', label: 'Cash flow', icon: 'trendUp', cap: 'report.cashflow' },
        { href: '/reports/costing', label: 'Job costing', icon: 'layers', cap: 'report.costing' },
        { href: '/reports/payroll', label: 'Payroll output', icon: 'users', cap: 'report.payroll' },
        { href: '/reports/documents', label: 'Document checklist', icon: 'checkin', badgeKey: 'docsOutstanding', cap: 'docs.view' },
      ],
    },
    {
      group: 'Reference data',
      disabled: true,
      items: [
        { href: '/charges', label: 'Table of charges', icon: 'settings', cap: 'charges.view' },
        { href: '/clients', label: 'Clients', icon: 'clients', cap: 'clients.view' },
        { href: '/schedules', label: 'Event schedules', icon: 'calendar', cap: 'schedules.view' },
        { href: '/staff', label: 'Staff register', icon: 'staff', cap: 'staff.view' },
      ],
    },
    {
      group: 'Admin',
      disabled: true,
      items: [
        // No `cap`: everyone who can sign in to the console can read their own
        // notification feed. Gating it would mean a role could be told to do
        // something and have no way of being told.
        { href: '/notifications', label: 'Notifications', icon: 'bell', badgeKey: 'notifications' },
        { href: '/settings/team', label: 'Team & roles', icon: 'users', cap: 'team.view' },
      ],
    },
  ],
  client: [
    {
      group: 'My jobs',
      items: [{ href: '/client/jobs', label: 'Quotes & jobs', icon: 'fileText', badgeKey: 'clientTodo' }],
    },
    {
      group: 'My bookings',
      items: [{ href: '/client/events', label: 'My events', icon: 'events', badgeKey: 'clientGaps' }],
    },
    {
      group: 'Delivery record',
      items: [{ href: '/client/hours', label: 'Hours delivered', icon: 'attendance' }],
    },
  ],
  staff: [
    {
      group: 'Find work',
      items: [{ href: '/my/jobs', label: 'Open jobs', icon: 'search', badgeKey: 'openRoles' }],
    },
    {
      group: 'My work',
      items: [
        { href: '/my/shifts', label: 'My shifts', icon: 'calendar', badgeKey: 'myUpcoming' },
        { href: '/my/pay', label: 'Hours & pay', icon: 'trendUp' },
        { href: '/my/documents', label: 'My documents', icon: 'fileText', badgeKey: 'myDocsDue' },
      ],
    },
  ],
};

/**
 * The rail as this person actually sees it. Items their role cannot open are
 * removed, and a group left with nothing in it is removed too — a heading with
 * no items under it reads as a loading failure.
 */
export function nav(): NavGroup[] {
  const t = current();
  if (t !== 'admin') return NAV[t];
  return NAV.admin
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.cap || ROLES.can(i.cap)) }))
    .filter((g) => g.items.length > 0);
}

/**
 * Where this person lands. The WOF pipeline is the operator's home, but the
 * payroll clerk cannot open it — sending them to a redirect loop on sign-in
 * would be a worse bug than the one roles were introduced to fix. So home is
 * the first thing their own rail offers.
 */
export function home(): string {
  const t = tier();
  if (t.id !== 'admin') return t.home;
  if (ROLES.can('wof.view')) return t.home;
  return nav()[0]?.items[0]?.href || '/notifications';
}

/**
 * Every route this tier is allowed to render.
 *
 * Admin is an allow-all rather than a list, because the operator console
 * legitimately reaches pages that are not in its rail — event detail, WOF
 * detail, job types. Enumerating those would mean every new admin screen has to
 * remember to register itself, and the failure mode is a blank redirect nobody
 * can explain. The client and staff tiers are the opposite: an explicit list,
 * because there the default must be "no".
 */
export function routes(t: TierId = current()): string[] | null {
  if (t === 'admin') return null; // null == everything the ROLE allows, below
  return NAV[t].flatMap((g) => g.items.map((i) => i.href));
}

/* --------------------------------------------------------- role scoping ---
   Admin stays an allow-all across TIERS, and the role narrows it here. The two
   layers answer different questions and are checked in that order: a client
   never reaches this table at all, and an operator reaches every route in it.

   Longest prefix wins, so `/reports/payroll` is gated on the payroll report
   rather than picking up whatever `/reports` might one day mean. The detail
   routes are listed alongside their index — `/wofs/:id` is the page where a
   work order is actually cancelled, and leaving it off would make the pipeline
   permission a filter on a list rather than a boundary.
   ------------------------------------------------------------------------ */

const ROUTE_CAPS: [string, ROLES.Capability][] = [
  ['/wofs', 'wof.view'],
  ['/calendar', 'calendar.view'],
  ['/events', 'staffing.view'],
  ['/check-in-approvals', 'checkin.approve'],
  ['/attendance', 'attendance.view'],
  ['/reports/cashflow', 'report.cashflow'],
  ['/reports/costing', 'report.costing'],
  ['/reports/payroll', 'report.payroll'],
  ['/reports/documents', 'docs.view'],
  ['/charges', 'charges.view'],
  ['/clients', 'clients.view'],
  ['/schedules', 'schedules.view'],
  ['/staff', 'staff.view'],
  ['/job-types', 'charges.view'],
  ['/settings/team', 'team.view'],
];

/** The capability a path needs, or null when any EP Team role may open it. */
export function routeCap(pathname: string): ROLES.Capability | null {
  let best: ROLES.Capability | null = null;
  let bestLen = -1;
  for (const [prefix, cap] of ROUTE_CAPS) {
    if ((pathname === prefix || pathname.startsWith(prefix + '/')) && prefix.length > bestLen) {
      best = cap;
      bestLen = prefix.length;
    }
  }
  return best;
}

/**
 * Routes every tier may open, whatever the navigation says.
 *
 * The client and staff tiers are an explicit allow-list built from `NAV`, which
 * is right for product surface — a worker has no business on the pipeline — but
 * wrong for the account itself. Everyone signed in has a name, an email and a
 * theme, and the account menu offers the page to all three tiers. Without this
 * a client clicking their own settings would be bounced home, which reads as a
 * broken link rather than a permission.
 *
 * Deliberately not in `NAV`: this is reachable from the account menu, not from
 * the sidebar, and adding it to the rail would put "Account settings" in the
 * middle of a worker's list of shifts.
 */
const ALWAYS: string[] = ['/settings/account'];

export function canAccess(pathname: string): boolean {
  if (!pathname) return true;
  if (ALWAYS.some((r) => pathname === r || pathname.startsWith(r + '/'))) return true;
  const allowed = routes();
  if (allowed === null) {
    const cap = routeCap(pathname);
    return !cap || ROLES.can(cap);
  }
  return allowed.some((r) => pathname === r || pathname.startsWith(r + '/'));
}

/* ==========================================================================
   3. CLIENT SCOPE
   --------------------------------------------------------------------------
   A client sees an event only if the work order behind it belongs to them and
   has actually been ordered. A quote they have not signed is not a booking, and
   showing it as one is how a client ends up planning around staff nobody has
   committed.
   ========================================================================== */

export interface ClientJobRow {
  wof: WOF.Wof;
  status: WOF.ClientStatus;
  tasks: WOF.ClientTask[];
  event: EpEvent | null;
  coverage: Coverage | null;
  timing: Timing;
}

/**
 * Every job for the acting client, from the moment it is raised.
 *
 * This is the answer to "I raised a WOF and the client cannot see it": the
 * client's list is driven by work orders, not by operational events, because an
 * event does not exist until the order is confirmed — which is three stages
 * after the client first needs to do something.
 */
export function clientJobs(): ClientJobRow[] {
  return WOF.byClient(actingClientId()).map((w) => {
    const ev = w.eventId ? eventById(w.eventId) || null : null;
    return {
      wof: w,
      status: WOF.clientStatus(w),
      tasks: WOF.clientTasks(w),
      event: ev,
      coverage: ev ? eventCoverage(ev) : null,
      timing: timing(w.start, w.end),
    };
  });
}

/** One job, guarded — a client can never open another client's work order. */
export function clientJob(wofId: string): ClientJobRow | null {
  const w = WOF.byId(wofId);
  if (!w || w.clientId !== actingClientId()) return null;
  return clientJobs().find((r) => r.wof.id === wofId) || null;
}

/** Everything outstanding across every job, for the rail badge and the list. */
export const clientTodoCount = (): number =>
  clientJobs().reduce((n, r) => n + r.tasks.length, 0);

export interface ClientEventRow {
  event: EpEvent;
  wof: WOF.Wof | null;
  coverage: Coverage;
  confirmed: boolean;
  timing: Timing;
}

export function clientEvents(): ClientEventRow[] {
  const c = actingClient();
  return EVENTS.filter((ev) => ev.clientId === c.id)
    .map((ev) => {
      const w = WOF.byEvent(ev.id) || null;
      return {
        event: ev,
        wof: w,
        coverage: eventCoverage(ev),
        confirmed: !!w && WOF.atLeast(w, 'order'),
        timing: timing(ev.start, ev.end),
      };
    })
    // Anything still at quote stage is not yet a booking. It is not hidden
    // silently — it simply is not on the client's "my events" list, which is a
    // list of things that are happening.
    .filter((r) => r.confirmed)
    .sort((a, b) => +new Date(a.event.start) - +new Date(b.event.start));
}

/** Settled attendance rows for this client's events only. */
export function clientAttendance() {
  const ids = new Set(clientEvents().map((r) => r.event.id));
  return ATTENDANCE.filter((a) => ids.has(a.eventId));
}

/* ==========================================================================
   4. STAFF SCOPE
   ========================================================================== */

export interface MyAssignment {
  event: EpEvent;
  shift: Shift;
  split: Split;
  assignment: Assignment;
}

/** Every split this worker is assigned to, flattened with its context. */
export function myAssignments(): MyAssignment[] {
  const me = actingEmployee();
  const out: MyAssignment[] = [];
  EVENTS.forEach((ev) =>
    ev.shifts.forEach((sh) =>
      sh.splits.forEach((sp) => {
        const a = sp.assignments.find((x) => x.employeeId === me.id);
        if (a) out.push({ event: ev, shift: sh, split: sp, assignment: a });
      }),
    ),
  );
  return out.sort((x, y) => +new Date(x.shift.start) - +new Date(y.shift.start));
}

/**
 * The acting worker's answer to an invitation, routed through the events store
 * so it is journalled rather than poked into the shared object and lost on the
 * next reload. See `events.respond`.
 */
export function respondToInvite(
  splitId: string,
  answer: 'confirmed' | 'declined',
): MyAssignment | null {
  const row = myAssignments().find((a) => a.split.id === splitId);
  if (!row) return null;
  const a = EV.respond(row.event.id, splitId, actingEmployee().id, answer);
  if (!a) return null;
  // Re-read rather than returning the stale row: `respond` commits a clone into
  // the journal, and the caller wants the record the rest of the app is now
  // reading.
  return myAssignments().find((x) => x.split.id === splitId) || null;
}

/** Settled hours for this worker only. */
export function myAttendance() {
  const me = actingEmployee();
  return ATTENDANCE.filter((a) => a.employeeId === me.id);
}

export interface Eligibility {
  ok: boolean;
  missing: string[];
  warn: string[];
}

export interface OpenRole {
  id: string;
  event: EpEvent;
  wof: WOF.Wof | null;
  shift: Shift;
  split: Split;
  coverage: Coverage;
  eligibility: Eligibility;
  application: Application | null;
}

/**
 * Open roles a worker could apply for.
 *
 * Three gates, in this order, because they answer three different questions:
 *   is the job real?    -> visibleToWorkers
 *   is there a gap?     -> splitCoverage().gap
 *   am I already on it? -> existing assignment or application
 * Eligibility is reported rather than used to hide the row, so a worker can see
 * the shift they *would* get if they renewed a licence.
 */
/**
 * Is this worker still held by this assignment, for the purpose of keeping the
 * role off their open list?
 *
 * Anything not declined: yes, obviously — they are on it.
 *
 * A decline depends on what they were giving up. Saying no to an invitation
 * they had never accepted costs the staffing team nothing, so the role goes
 * straight back on their open list; the decline dialog has always promised
 * exactly that, and until now it was not true for the person reading it.
 * Dropping out of a shift they had CONFIRMED is a different act — it costs
 * coverage and carries a strike — so that one stays off their list until
 * staffing invites them back, rather than letting somebody drop out, take the
 * strike, and re-apply for the same slot a minute later.
 *
 * A record declined before `declinedFrom` existed reads as the confirmed case.
 * See the note on `Assignment.declinedFrom`.
 */
const stillHeld = (a: Assignment): boolean =>
  a.confirmation !== 'declined' || (a.declinedFrom ?? 'confirmed') === 'confirmed';

export function openRoles(): OpenRole[] {
  const me = actingEmployee();
  const mine = new Set(
    myAssignments().filter((a) => stillHeld(a.assignment)).map((a) => a.split.id),
  );
  const rows: OpenRole[] = [];

  EVENTS.forEach((ev) => {
    const w = WOF.byEvent(ev.id) || null;
    const vis = WOF.visibleToWorkers(w);
    if (!vis.visible) return;
    if (new Date(ev.end) < NOW) return;

    ev.shifts.forEach((sh) => {
      if (new Date(sh.start) < NOW) return;
      sh.splits.forEach((sp) => {
        if (mine.has(sp.id)) return;
        const cov = splitCoverage(sp);
        if (cov.gap <= 0) return;
        rows.push({
          id: `${ev.id}:${sh.id}:${sp.id}`,
          event: ev, wof: w, shift: sh, split: sp, coverage: cov,
          eligibility: eligibility(me, sp, sh),
          application: applicationFor(sp.id),
        });
      });
    });
  });

  return rows.sort((a, b) => +new Date(a.shift.start) - +new Date(b.shift.start));
}

/**
 * Can this worker take this role? Returns every reason, not just the first, so
 * the page can say "renew your SIA licence and you qualify" rather than a bare
 * "not eligible".
 */
export function eligibility(
  emp: ReturnType<typeof actingEmployee>,
  split: Split,
  shift: Shift,
): Eligibility {
  const missing: string[] = [];
  const warn: string[] = [];

  (split.tags || []).forEach((t) => {
    if (!emp.tags.includes(t)) {
      const label = tagById(t)?.label || t;
      missing.push(`${label} is required for this role`);
    }
  });

  if (emp.status === 'flagged') {
    missing.push(`Account flagged — ${emp.strikes} active strike${emp.strikes === 1 ? '' : 's'}`);
  } else if (emp.strikes) {
    warn.push(`${emp.strikes} active strike${emp.strikes === 1 ? '' : 's'} on record`);
  }

  if (emp.rtw === 'pending') missing.push('Right to work not yet verified');
  if (emp.rtw === 'expiring' && emp.rtwExpiry && emp.rtwExpiry < String(shift.start).slice(0, 10)) {
    missing.push(`Right to work expires ${emp.rtwExpiry}, before this shift`);
  } else if (emp.rtw === 'expiring') {
    warn.push(`Right to work expires ${emp.rtwExpiry}`);
  }

  if (!emp.available) warn.push('You are currently marked unavailable');

  // A clash is a hard stop: nobody can be in two places at once, and the
  // original system let this happen silently.
  const clash = myAssignments().find(
    (a) => new Date(a.shift.start) < new Date(shift.end) && new Date(shift.start) < new Date(a.shift.end),
  );
  if (clash) missing.push(`Clashes with ${clash.shift.label} on ${clash.event.name}`);

  return { ok: !missing.length, missing, warn };
}

/* ==========================================================================
   5. APPLICATIONS
   --------------------------------------------------------------------------
   The one piece of genuinely new state. Kept in localStorage next to the WOF
   store so a demo survives a reload, and shaped like a row a real backend would
   hold: who, which split, when, what happened to it.
   ========================================================================== */

export interface Application {
  id: string;
  employeeId: string;
  eventId: string;
  shiftId: string;
  splitId: string;
  role: string;
  start: string;
  end: string;
  note: string;
  appliedAt: string;
  status: 'applied';
}

export function applications(): Application[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY_APPS) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveApplications(list: Application[]): void {
  try {
    localStorage.setItem(KEY_APPS, JSON.stringify(list));
  } catch {
    /* private mode */
  }
  emit();
}

export const myApplications = (): Application[] =>
  applications().filter((a) => a.employeeId === ACTING_EMPLOYEE_ID);

export const applicationFor = (splitId: string): Application | null =>
  myApplications().find((a) => a.splitId === splitId) || null;

export function apply(row: OpenRole, note?: string): Application | null {
  const list = applications();
  if (list.some((a) => a.employeeId === ACTING_EMPLOYEE_ID && a.splitId === row.split.id)) return null;
  const rec: Application = {
    id: 'app-' + Date.now().toString(36),
    employeeId: ACTING_EMPLOYEE_ID,
    eventId: row.event.id,
    shiftId: row.shift.id,
    splitId: row.split.id,
    role: row.split.role,
    start: row.shift.start,
    end: row.shift.end,
    note: note || '',
    appliedAt: new Date().toISOString(),
    status: 'applied',
  };
  list.push(rec);
  saveApplications(list);
  return rec;
}

export function withdraw(splitId: string): void {
  saveApplications(
    applications().filter((a) => !(a.employeeId === ACTING_EMPLOYEE_ID && a.splitId === splitId)),
  );
}

/* ==========================================================================
   6. WORKER COMPLIANCE
   --------------------------------------------------------------------------
   Derived, not stored. The staff register already knows employment type,
   right-to-work state and qualifications; a document list is just that same
   information written as things the worker has to DO. Deriving it means the two
   can never disagree, which is the failure mode the briefing describes for
   documents held in a second system.
   ========================================================================== */

const DAY = 86400000;

export type StaffDocStatus = 'approved' | 'expiring' | 'expired' | 'pending';

export interface StaffDoc {
  id: string;
  label: string;
  why: string;
  status: StaffDocStatus;
  expires: string | null;
  note?: string;
  owner: string;
  blocking: boolean;
  daysLeft?: number | null;
}

export interface StaffDocsState {
  docs: StaffDoc[];
  total: number;
  approved: number;
  outstanding: number;
  blocking: number;
  tone: Tone;
}

export function staffDocs(emp?: ReturnType<typeof actingEmployee>): StaffDocsState {
  const e = emp || actingEmployee();
  const iso = (d: number | string | Date) => new Date(d).toISOString().slice(0, 10);
  const inDays = (n: number) => iso(NOW.getTime() + n * DAY);

  // Deterministic per worker so the prototype reads the same on every load.
  const seed = parseInt(e.id.split('-')[1], 10) || 1;
  const spread = (n: number) => (seed * 37) % n;

  const docs: StaffDoc[] = [
    {
      id: 'rtw', label: 'Right to work',
      why: 'Legally required before any shift is worked.',
      status: e.rtw === 'verified' ? 'approved' : e.rtw === 'pending' ? 'pending' : 'expiring',
      expires: e.rtwExpiry, note: e.rtwNote, owner: 'You', blocking: true,
    },
    {
      id: 'photo-id', label: 'Photo ID',
      why: 'Checked against you on site at first sign-in.',
      status: 'approved', expires: null, owner: 'You', blocking: true,
    },
    {
      id: 'bank',
      label: e.employmentType === 'PAYE' ? 'Bank details & starter checklist' : 'Bank details & UTR',
      why:
        e.employmentType === 'PAYE'
          ? 'Without these payroll cannot pay you and defaults to emergency tax.'
          : 'Self-employed workers are paid against a UTR, not a payroll record.',
      status: 'approved', expires: null, owner: 'You', blocking: false,
    },
    {
      id: 'uniform', label: 'Uniform & conduct agreement',
      why: 'Signed once. Covers the dress code each client sets.',
      status: 'approved', expires: null, owner: 'You', blocking: false,
    },
  ];

  if (e.tags.includes('sia')) {
    docs.push({
      id: 'sia', label: 'SIA licence',
      why: 'Security roles cannot be filled without a valid licence on the day.',
      status: spread(3) === 0 ? 'expiring' : 'approved',
      expires: inDays(spread(3) === 0 ? 24 : 300), owner: 'You', blocking: true,
    });
  }
  if (e.tags.includes('first-aid')) {
    docs.push({
      id: 'first-aid', label: 'First aid at work certificate',
      why: 'Three-year certificate. Medical cover plans name the holders.',
      status: 'approved', expires: inDays(120 + spread(200)), owner: 'You', blocking: false,
    });
  }
  if (e.tags.includes('driver')) {
    docs.push({
      id: 'licence', label: 'Driving licence & DVLA check code',
      why: 'Required for any role that involves moving vehicles on site.',
      status: spread(4) === 1 ? 'expiring' : 'approved',
      expires: inDays(spread(4) === 1 ? 17 : 210), owner: 'You', blocking: false,
    });
  }
  if (e.tags.includes('supervisor')) {
    docs.push({
      id: 'supervisor', label: 'Supervisor induction',
      why: 'Refreshed annually before you can be booked as a supervisor.',
      status: 'approved', expires: inDays(60 + spread(90)), owner: 'EP Compliance', blocking: false,
    });
  }

  // Expiry beats stored status: a certificate that has run out is outstanding
  // whatever the record says.
  docs.forEach((d) => {
    if (!d.expires) {
      d.daysLeft = null;
      return;
    }
    d.daysLeft = Math.round((+new Date(d.expires) - +NOW) / DAY);
    if (d.daysLeft < 0) d.status = 'expired';
    else if (d.daysLeft <= 30 && d.status === 'approved') d.status = 'expiring';
  });

  const outstanding = docs.filter((d) => d.status !== 'approved');
  return {
    docs,
    total: docs.length,
    approved: docs.filter((d) => d.status === 'approved').length,
    outstanding: outstanding.length,
    blocking: outstanding.filter((d) => d.blocking).length,
    tone: outstanding.some((d) => d.blocking) ? 'critical' : outstanding.length ? 'atRisk' : 'healthy',
  };
}

export const DOC_TONE: Record<StaffDocStatus, Tone> = {
  approved: 'healthy',
  expiring: 'atRisk',
  expired: 'critical',
  pending: 'info',
};

export const DOC_LABEL: Record<StaffDocStatus, string> = {
  approved: 'Valid',
  expiring: 'Expiring soon',
  expired: 'Expired',
  pending: 'Being checked',
};

/* ==========================================================================
   7. BADGES — per tier, so a rail never counts something you cannot open
   ========================================================================== */

export function badges(): Partial<Record<BadgeKey, number>> | null {
  const t = current();
  if (t === 'client') {
    return {
      clientTodo: clientTodoCount(),
      clientGaps: clientEvents().filter((r) => r.coverage.gap > 0).length,
    };
  }
  if (t === 'staff') {
    return {
      openRoles: openRoles().filter((r) => r.eligibility.ok && !r.application).length,
      myUpcoming: myAssignments().filter((a) => new Date(a.shift.start) >= NOW).length,
      myDocsDue: staffDocs().outstanding,
    };
  }
  return null; // admin badges are computed in the shell
}
