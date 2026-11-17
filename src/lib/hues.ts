/* ==========================================================================
   Brand hues — CATEGORY colour, from the EP Team design system (Figma
   "Color Principles"). The tokens live in app.css as --hue-<name>-<role>.

   Use these to tell KINDS of thing apart: which rate card, which wage
   framework, staff vs kit vs service, which part of the pipeline. Never for
   status (that is TONE_* in status.ts) and never for buttons (that is accent).

   Every role is contrast-checked in app.css:
     fg    text and icons   — >= 6:1 on white and on its own bg/chip
     bg    tinted panel     chip  stronger tint behind fg text
     solid selected border  — >= 3:1 on white
     bar   decorative stripe — never the only signal; a label goes with it

   The domains follow the design system's own definitions: Management Blue
   for planning and sales, Equipment Yellow for kit and the warehouse, Agency
   Red for staffing, Technology Green for positive outcomes.
   ========================================================================== */

import type { ChargeKind } from '@/data/types';

export type Hue = 'navy' | 'blue' | 'green' | 'red' | 'yellow';

export interface HueVars { fg: string; bg: string; chip: string; solid: string; bar: string }

export const hue = (h: Hue): HueVars => ({
  fg: `var(--hue-${h}-fg)`,
  bg: `var(--hue-${h}-bg)`,
  chip: `var(--hue-${h}-chip)`,
  solid: `var(--hue-${h}-solid)`,
  bar: `var(--hue-${h}-bar)`,
});

/** Rate cards: published = blue, the discount = green, the surcharge = red. */
export const CARD_HUE: Record<string, Hue> = { standard: 'blue', preferred: 'green', premium: 'red' };

/** Wage frameworks — one hue each so the four rows are told apart at a glance. */
export const FRAMEWORK_HUE: Record<string, Hue> = { nlw: 'navy', rlw: 'green', llw: 'blue', ilw: 'yellow' };

/** What a charge line sells. */
export const KIND_HUE: Record<ChargeKind, Hue> = { staff: 'red', kit: 'yellow', service: 'blue' };
export const KIND_LABEL: Record<ChargeKind, string> = { staff: 'Staff', kit: 'Kit', service: 'Service' };

/** WOF lifecycle, grouped by who owns the stage: sales (blue), office (navy),
    warehouse (yellow), staffing on site (red), money in (green). */
export const STAGE_HUE: Record<string, Hue> = {
  wof: 'blue', quote: 'blue', signoff: 'blue',
  order: 'navy', documents: 'navy',
  picking: 'yellow',
  job: 'red',
  invoice: 'green', complete: 'green',
};
