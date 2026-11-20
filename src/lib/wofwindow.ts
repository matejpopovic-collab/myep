/* ============================================================================
   EPROSTA — THE WOF WINDOW
   ----------------------------------------------------------------------------
   When a scheduled event has to have its WOF by.

   Until 20 Nov 2026 every register entry carried its own lead time ("raise the
   WOF 60 days before the event") plus a free-text trigger rule. In practice the
   manager who schedules an event is the one who opens its WOF, and the rule the
   business actually runs is simpler: once you have scheduled it, you have
   30 days to open the WOF. So:

     · An entry scheduled in this app records `createdAt`, and its WOF is due
       WOF_WINDOW_DAYS after that — or on the event day, if the event is sooner.
       Nobody types a lead time any more.
     · Seeded entries predate the rule and have no `createdAt`; they keep the
       lead time they were imported with, so their history does not move.

   Pure on purpose — no store, no WOF lookups — so the register, the calendar
   and the alert sweep all read the same date from one place.
   ========================================================================== */

import { NOW } from '@/data/db';
import { addDays, dayDiff } from './format';
import type { EventScheduleEntry } from '@/data/types';

/** Days a manager has, from scheduling an event, to open its WOF. */
export const WOF_WINDOW_DAYS = 30;

/** Heads-up before the window closes. */
export const WOF_WARN_DAYS = 7;

type Dated = Pick<EventScheduleEntry, 'start' | 'leadDays'> & { createdAt?: string | null };

/** The date the WOF is due by, as `YYYY-MM-DD…`. */
export function wofDueBy(s: Dated): string {
  if (s.createdAt) {
    const window = addDays(s.createdAt, WOF_WINDOW_DAYS);
    return new Date(window) < new Date(s.start) ? window : s.start;
  }
  return addDays(s.start, -(s.leadDays ?? WOF_WINDOW_DAYS));
}

/** Whole days until the WOF is due — negative once it is late. */
export const daysToDue = (s: Dated, now: Date = NOW): number => dayDiff(now, wofDueBy(s));

/** Whether this entry runs on the 30-day rule rather than a legacy lead time. */
export const onWindowRule = (s: Dated): boolean => !!s.createdAt;

/** One line for a tooltip or a dialog: why the date is what it is. */
export function dueReason(s: Dated): string {
  if (!s.createdAt) return `Imported with a ${s.leadDays}-day lead time before the event.`;
  const window = addDays(s.createdAt, WOF_WINDOW_DAYS);
  return new Date(window) < new Date(s.start)
    ? `${WOF_WINDOW_DAYS} days from when it was scheduled.`
    : `The event is less than ${WOF_WINDOW_DAYS} days after it was scheduled, so the WOF is due by the event itself.`;
}
