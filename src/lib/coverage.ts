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
