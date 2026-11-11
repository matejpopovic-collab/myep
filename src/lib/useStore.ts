/* ============================================================================
   EPROSTA — store hooks
   ----------------------------------------------------------------------------
   The domain modules are deliberately framework-free: `wof.ts`, `portal.ts` and
   `flags.ts` are plain modules with a version counter and a subscriber set.
   These hooks are the only place React learns about them.

   `useSyncExternalStore` rather than context because the state is genuinely
   module-global — every screen reads the same WOF array, and a mutation on the
   detail page has to move the badge in the sidebar. Threading that through
   providers would create two copies of a thing the whole product exists to keep
   singular.
   ========================================================================== */

import { useSyncExternalStore } from 'react';
import * as WOF from './wof';
import * as PORTAL from './portal';
import * as FLAGS from './flags';
import * as PAYRATES from './payrates';
import * as CLIENTS from './clients';
import * as SCHEDULES from './schedules';
import * as JOBTYPES from './jobtypes';
import * as DOCTYPES from './doctypes';
import * as STANDARD_DOCS from './standarddocs';
import * as ROLES from './roles';
import * as HOP from './hop';
import * as EVENTS from './events';
import * as NOTIFICATIONS from './notifications';
import * as CHECKINS from './checkins';
import * as PREFS from './prefs';
import * as AVAIL from './availability';
import * as RATES from './rates';
import * as CLIENTFILES from './clientfiles';
import * as CHARGES from './charges';
import * as PORTAL_USERS from './portalusers';
import * as CLIENT_HISTORY from './clienthistory';
import * as JOB_FILES from './jobfiles';
import * as STAFF_PHOTOS from './staffphotos';

/** Re-renders when any WOF mutates. Returns the live array. */
export function useWofs(): WOF.Wof[] {
  useSyncExternalStore(WOF.subscribe, WOF.getVersion, WOF.getVersion);
  return WOF.all();
}

/** Re-renders on WOF mutation without pulling the whole list. */
export function useWofVersion(): number {
  return useSyncExternalStore(WOF.subscribe, WOF.getVersion, WOF.getVersion);
}

/** The acting tier. Changing it re-renders the shell and every guarded route. */
export function useTier(): PORTAL.TierId {
  useSyncExternalStore(PORTAL.subscribe, PORTAL.getVersion, PORTAL.getVersion);
  return PORTAL.current();
}

/** Re-renders when an application is made or withdrawn. */
export function usePortalVersion(): number {
  return useSyncExternalStore(PORTAL.subscribe, PORTAL.getVersion, PORTAL.getVersion);
}

/** Re-renders when a worker is flagged or cleared. */
export function useFlagVersion(): number {
  return useSyncExternalStore(FLAGS.subscribe, FLAGS.getVersion, FLAGS.getVersion);
}

/** Re-renders when a worker's custom pay rate is set or removed. */
export function usePayRatesVersion(): number {
  return useSyncExternalStore(PAYRATES.subscribe, PAYRATES.getVersion, PAYRATES.getVersion);
}

/** Re-renders when a worker's photo is added, changed or removed. */
export function useStaffPhotosVersion(): number {
  return useSyncExternalStore(STAFF_PHOTOS.subscribe, STAFF_PHOTOS.getVersion, STAFF_PHOTOS.getVersion);
}

/** Re-renders when a client is created, edited or removed. */
export function useClientsVersion(): number {
  return useSyncExternalStore(CLIENTS.subscribe, CLIENTS.getVersion, CLIENTS.getVersion);
}

/** Re-renders when a price is agreed with a client, or dropped. */
export function useRatesVersion(): number {
  return useSyncExternalStore(RATES.subscribe, RATES.getVersion, RATES.getVersion);
}

/** Re-renders when a file is attached to a job document, or one is decided on. */
export function useJobFilesVersion(): number {
  return useSyncExternalStore(JOB_FILES.subscribe, JOB_FILES.getVersion, JOB_FILES.getVersion);
}

/** Re-renders when anything is added to a client's change history. */
export function useClientHistoryVersion(): number {
  return useSyncExternalStore(CLIENT_HISTORY.subscribe, CLIENT_HISTORY.getVersion, CLIENT_HISTORY.getVersion);
}

/** Re-renders when a client portal user is invited, changed or removed. */
export function usePortalUsersVersion(): number {
  return useSyncExternalStore(PORTAL_USERS.subscribe, PORTAL_USERS.getVersion, PORTAL_USERS.getVersion);
}

/** Re-renders when a document is filed against a client, amended or removed. */
export function useClientDocsVersion(): number {
  return useSyncExternalStore(CLIENTFILES.subscribe, CLIENTFILES.getVersion, CLIENTFILES.getVersion);
}

/**
 * Re-renders when a schedule entry is created, edited or removed.
 *
 * The calendar needs this as much as the register does: an entry added here is
 * a calendar row whether or not a WOF exists, so a page that subscribes only to
 * WOF mutations would keep drawing the old month.
 */
export function useSchedulesVersion(): number {
  return useSyncExternalStore(SCHEDULES.subscribe, SCHEDULES.getVersion, SCHEDULES.getVersion);
}

/**
 * Re-renders when a job type is created, edited or deleted — the checklist
 * configuration list, and the job-type pickers that read `JOB_TYPES`.
 */
/** Re-renders when a standard library file is added, edited or withdrawn. */
export function useStandardDocsVersion(): number {
  return useSyncExternalStore(STANDARD_DOCS.subscribe, STANDARD_DOCS.getVersion, STANDARD_DOCS.getVersion);
}

/** Re-renders when an EP document type is added or removed. */
export function useDocTypesVersion(): number {
  return useSyncExternalStore(DOCTYPES.subscribe, DOCTYPES.getVersion, DOCTYPES.getVersion);
}

export function useJobTypesVersion(): number {
  return useSyncExternalStore(JOBTYPES.subscribe, JOBTYPES.getVersion, JOBTYPES.getVersion);
}

/**
 * Re-renders when a role's permissions change, someone is invited or assigned,
 * or the acting member is switched.
 *
 * The shell subscribes to this as well as to the tier, because a permission is
 * the one kind of state that has to move the navigation itself: revoke
 * `report.payroll` and the item must leave the rail on the same render, not on
 * the next route change, or the operator clicks a link that now bounces them.
 */
/**
 * Re-renders when a charge line is created, corrected or retired.
 *
 * Wider than the charge table itself: every quote picker offers `quotable()`,
 * so a line retired on one screen has to stop being offered on the other in
 * the same render, not after a refresh.
 */
export function useChargesVersion(): number {
  return useSyncExternalStore(CHARGES.subscribe, CHARGES.getVersion, CHARGES.getVersion);
}

/** Re-renders when a stock count changes. */
export function useStockVersion(): number {
  return useSyncExternalStore(HOP.subscribe, HOP.getVersion, HOP.getVersion);
}

export function useRolesVersion(): number {
  return useSyncExternalStore(ROLES.subscribe, ROLES.getVersion, ROLES.getVersion);
}

/** The acting member's permission predicate, re-evaluated on every change. */
export function useCan(): (cap: ROLES.Capability) => boolean {
  useRolesVersion();
  return ROLES.can;
}

/**
 * Re-renders when an event, shift, role group or assignment changes.
 *
 * The widest-reaching of these hooks, because coverage is derived: assigning
 * one worker moves a role group's ratio, the shift's ratio, the event card, the
 * week header, the summary strip at the top of the events list and the staffing
 * badge in the sidebar. They all read the same derived numbers, so they all
 * have to re-render off the same version.
 */
export function useEventsVersion(): number {
  return useSyncExternalStore(EVENTS.subscribe, EVENTS.getVersion, EVENTS.getVersion);
}

/**
 * Re-renders when anyone's day state changes.
 *
 * Wider-reaching than it looks. A single approved leave day moves a cell on the
 * planner, the headcount in that day's column header, the conflict badge in the
 * sidebar, that person's leave balance, and whether they appear in the pool the
 * assignment dialog offers. They all read the same derived answer, so they all
 * have to re-render off the same version.
 */
export function useAvailabilityVersion(): number {
  return useSyncExternalStore(AVAIL.subscribe, AVAIL.getVersion, AVAIL.getVersion);
}

/**
 * Re-renders when a check-in is approved, rejected or reopened.
 *
 * Needed in three places that look unrelated: the approvals queue, the badge on
 * the event's Check-ins tab, and the payroll report — because approving a
 * timesheet is what puts an hour into payroll's total.
 */
export function useCheckInsVersion(): number {
  return useSyncExternalStore(CHECKINS.subscribe, CHECKINS.getVersion, CHECKINS.getVersion);
}

/** Re-renders when a notification is raised, read, or dismissed. */
export function useNotificationsVersion(): number {
  return useSyncExternalStore(
    NOTIFICATIONS.subscribe,
    NOTIFICATIONS.getVersion,
    NOTIFICATIONS.getVersion,
  );
}

/** Re-renders when a personal preference changes. */
export function usePrefsVersion(): number {
  return useSyncExternalStore(PREFS.subscribe, PREFS.getVersion, PREFS.getVersion);
}

