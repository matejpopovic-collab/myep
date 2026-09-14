/* ============================================================================
   EPROSTA — THE BAND VOCABULARY
   ----------------------------------------------------------------------------
   The six tiers of the Master Calendar's Classification Key, their labels,
   their wording and their order. Nothing else: no thresholds, no kit weights,
   no reading of an event or a quote — all of that is `classification.ts`,
   which re-exports everything here so existing callers are unaffected.

   Split out for one reason. `classification.ts` imports `wof.ts`, so `wof.ts`
   cannot import it back to name a tier in a history entry. This module imports
   nothing but a type, which makes it safe for either side to read.

   THE KEY HAS SIX TIERS
   ---------------------
   Tiers 1–5 are computed from peak-day staff and kit. Tier 6 is not computed
   from anything — the key names it and gives it no figure — so it reaches a
   record only by hand. A seventh band invented here would be a band the
   operator's own key cannot explain: if EP needs one, it goes in the key first.
   ========================================================================== */

import type { Tone } from '@/data/types';

export type EventScale =
  | 'major'
  | 'significant'
  | 'medium'
  | 'light'
  | 'minimal'
  | 'day-to-day';

/** The five bands `assessScale` can return. Ordered low to high. */
export const AUTO_SCALES = ['minimal', 'light', 'medium', 'significant', 'major'] as const;
export type AutoScale = (typeof AUTO_SCALES)[number];

export const MANUAL_ONLY_SCALES = ['day-to-day'] as const;

export const SCALE_LABEL: Record<EventScale, string> = {
  major: 'Tier 1 – Major',
  significant: 'Tier 2 – Significant',
  medium: 'Tier 3 – Medium',
  light: 'Tier 4 – Light',
  minimal: 'Tier 5 – Minimal',
  'day-to-day': 'Tier 6 – Day to Day',
};

/**
 * One line per band, in the sheet's own wording, for a tooltip/legend.
 *
 * Tier 6 included, because the pipeline filter offers it and an option with
 * nothing explaining it is guessed at. Its line is not a threshold and does
 * not pretend to be one: the key gives it no staff or kit figure, so neither
 * does this.
 */
export const SCALE_DESCRIPTION: Record<EventScale, string> = {
  major: '>75 staff, multiple artics’ worth of infrastructure',
  significant: '41–75 staff, 5 vehicles or 1 artic of equipment',
  medium: '21–40 staff, 2–4 vehicles of equipment',
  light: '5–20 staff, 1 vehicle of equipment',
  minimal: '<5 staff, <0.5 vehicles of equipment delivery',
  'day-to-day': 'Day to day activity. Set by hand — the key gives it no staff or kit figure.',
};

/** A rough severity mapping, for a status pill — bigger jobs read as more attention-worthy, not "bad". */
export const SCALE_TONE: Record<EventScale, Tone> = {
  major: 'critical',
  significant: 'atRisk',
  medium: 'info',
  light: 'neutral',
  minimal: 'neutral',
  'day-to-day': 'neutral',
};

export function scaleTone(scale: EventScale): Tone {
  return SCALE_TONE[scale];
}

/** Low to high, for sorting a list by size. Unquoted sorts below Minimal. */
export function scaleRank(scale: EventScale | null): number {
  if (!scale) return -1;
  const i = (AUTO_SCALES as readonly string[]).indexOf(scale);
  // Day to Day is not on the numeric ladder at all; it sits below it, and
  // above an unquoted job, which has no band to sort by.
  return i >= 0 ? i : -0.5;
}
