/* ============================================================================
   EPROSTA — COVERAGE
   ----------------------------------------------------------------------------
   The number the whole product exists to close. Every screen that shows a
   staffing figure derives it from here, which is why the four irreconcilable
   numbers the live app printed for one Wilderness shift cannot come back.

     required = split.required
     assigned = every assignment on the split
     filled   = assignments whose confirmation is 'confirmed'
     gap      = required − filled, floored at zero
   ========================================================================== */

import { NOW } from '@/data/db';
import type { EpEvent, Shift, Split, Tone } from '@/data/types';
import { dayDiff, timing } from './format';

export interface Coverage {
  required: number;
  assigned: number;
  filled: number;
  awaiting: number;
  gap: number;
}

const EMPTY: Coverage = { required: 0, assigned: 0, filled: 0, awaiting: 0, gap: 0 };

/** Coverage for one split. filled = confirmed assignments. */
export function splitCoverage(sp: Split): Coverage {
  const assigned = sp.assignments.length;
  const filled = sp.assignments.filter((a) => a.confirmation === 'confirmed').length;
  const awaiting = sp.assignments.filter((a) => a.confirmation === 'awaiting').length;
  return {
    required: sp.required,
    assigned,
    filled,
    awaiting,
    gap: Math.max(0, sp.required - filled),
  };
}

const sum = (acc: Coverage, c: Coverage): Coverage => ({
  required: acc.required + c.required,
  assigned: acc.assigned + c.assigned,
  filled: acc.filled + c.filled,
  awaiting: acc.awaiting + c.awaiting,
  gap: acc.gap + c.gap,
});

export const shiftCoverage = (sh: Shift): Coverage =>
  sh.splits.map(splitCoverage).reduce(sum, { ...EMPTY });

export const eventCoverage = (ev: EpEvent): Coverage =>
  ev.shifts.map(shiftCoverage).reduce(sum, { ...EMPTY });

export const pct = (c: Coverage): number =>
  c.required ? Math.round((c.filled / c.required) * 100) : 100;

/**
 * Severity by GAP SIZE × TIME TO EVENT, not by a flat red number.
 * 416 unfilled starting tomorrow and 4 unfilled starting tomorrow are not the
 * same problem — the live app painted both the same red.
 */
export function coverageTone(
  cov: Coverage,
  startV: string | Date,
  endV?: string | Date,
): Tone {
  if (cov.gap === 0) return 'healthy';
  const t = timing(startV, endV);
  if (t.phase === 'past') return 'neutral';

  const coverage = cov.required ? cov.filled / cov.required : 1;
  const daysOut = Math.max(0, dayDiff(NOW, startV));

  // Urgency score: bigger gap and less time => higher.
  const proximity =
    daysOut <= 0 ? 1 : daysOut === 1 ? 0.85 : daysOut <= 3 ? 0.6 : daysOut <= 7 ? 0.35 : 0.15;
  const shortfall = 1 - coverage;
  const scale = Math.min(1, Math.log10(cov.gap + 1) / 2.2); // 416 >> 4
  const score = proximity * (0.55 * shortfall + 0.45 * scale);

  // Magnitude gate. Without it, "0 of 4 starting today" scores the same as
  // "0 of 416 starting today" — exactly the flattening the live app did. A
  // handful of unfilled roles is a to-do; hundreds is an emergency. Small gaps
  // therefore top out at at-risk however close the event is.
  const SMALL_GAP = 8;
  if (score >= 0.42) return cov.gap >= SMALL_GAP ? 'critical' : 'atRisk';
  if (score >= 0.16) return 'atRisk';
  return 'neutral';
}

/** Numeric urgency used for the default sort. */
export function urgencyScore(ev: EpEvent): number {
  const cov = eventCoverage(ev);
  const t = timing(ev.start, ev.end);
  if (t.phase === 'past') return -1;
  const daysOut = Math.max(0, dayDiff(NOW, ev.start));
  const proximity = 1 / (daysOut + 1);
  return cov.gap * proximity * 100 + (t.phase === 'live' ? 500 : 0);
}

/**
 * One role, across every day of an event.
 *
 * The unit a worker is offered and the unit staffing reports on. The split
 * stays the unit of truth underneath — check-in, attendance and payroll are all
 * per-day, and a single short day is a real state that has to stay visible and
 * fixable — so this is a roll-up, never a replacement.
 */
export interface EventRole {
  event: EpEvent;
  role: string;
  /**
   * Every role group this role runs as, in shift order.
   *
   * One entry per group, NOT per day. A role sold against three deployments —
   * two car parks and a night window — is three groups on every day it works,
   * so `parts.length` runs well ahead of the calendar. Both numbers are real
   * and neither substitutes for the other, which is why they are counted
   * separately below.
   */
  parts: { shift: Shift; split: Split }[];
  required: number;
  assigned: number;
  filled: number;
  awaiting: number;
  gap: number;
  /**
   * Calendar days this role works.
   *
   * Distinct shift days, so "applying commits you to N days" and "assign this
   * worker across N days" both say what an operator or a worker would count.
   */
  days: number;
  /**
   * Role groups to fill: `parts.length`.
   *
   * Never fewer than `days`, and the number of rows staffing actually has to
   * work through. This used to be reported as `days`, which read as a
   * seventeen-day job lasting sixty-two.
   */
  groups: number;
  start: string;
  end: string;
}

/**
 * Calendar days an event actually works.
 *
 * Distinct shift days rather than `shifts.length`, because nothing stops an
 * operator adding a second shift to one day, and rather than a start-to-end
 * duration, because "14 Sep 09:00 to 30 Sep 18:00" is sixteen days and nine
 * hours elapsed but seventeen days on a roster. Days worked is the number
 * every other count on the staffing screen is expressed against, so it is the
 * one this returns.
 */
export function eventDayCount(ev: EpEvent): number {
  return new Set(ev.shifts.map((sh) => sh.day)).size;
}

export function eventRoles(ev: EpEvent): EventRole[] {
  const order: string[] = [];
  const byRole = new Map<string, { shift: Shift; split: Split }[]>();

  ev.shifts.forEach((sh) => {
    sh.splits.forEach((sp) => {
      if (!byRole.has(sp.role)) {
        order.push(sp.role);
        byRole.set(sp.role, []);
      }
      byRole.get(sp.role)!.push({ shift: sh, split: sp });
    });
  });

  return order.map((role) => {
    const parts = byRole.get(role)!;
    const cov = parts.map((p) => splitCoverage(p.split)).reduce(sum, { ...EMPTY });
    return {
      event: ev,
      role,
      parts,
      ...cov,
      days: new Set(parts.map((p) => p.shift.day)).size,
      groups: parts.length,
      start: parts[0].shift.start,
      end: parts[parts.length - 1].shift.end,
    };
  });
}
