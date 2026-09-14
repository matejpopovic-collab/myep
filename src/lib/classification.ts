/* ============================================================================
   EPROSTA — EVENT SCALE
   ----------------------------------------------------------------------------
   Ported from the Master Calendar's "Classification Key": a job's scale is
   read off its peak single-day headcount and peak single-day kit volume, not
   summed across the run — a 17-day job running 10 people a day is not "Major"
   for lasting a long time, and a stadium job with real headcount for one day
   should not be outranked by a long, light one.

   Named `EventScale`, not `Tier` — `TierId` already means something else in
   this codebase (`portal.ts`: admin/client/staff access levels). Same
   collision the sheet itself doesn't have to worry about; we do.

   Auto-classification only ever produces the five numeric bands. 'day-to-day'
   is not derived from anything — the sheet's key names it and ties it to no
   threshold at all, so it is set by hand only, the same way `override` is:
   see `eventScale`.

   THE BANDS ARE THE SHEET'S, AND ONLY THE SHEET'S
   -----------------------------------------------
   There used to be a seventh, 'lorry-only', for a kit delivery with no crew.
   It is not in the Classification Key, no event ever carried it, and a band
   this module invents is a band the operator's own key cannot explain. If EP
   decides a kit-only run needs its own tier, it goes in the key first and
   here second — not the other way round.
   ========================================================================== */

import type { EpEvent } from '@/data/types';
import { event as eventById } from '@/data/db';
import { AUTO_SCALES, SCALE_LABEL, type AutoScale, type EventScale } from './scale';
import { hireWindow } from './wof';
import type { LineItem, Wof } from './wof';
import * as W from './wof';

export type { EventScale, AutoScale } from './scale';
export {
  AUTO_SCALES, MANUAL_ONLY_SCALES, SCALE_DESCRIPTION, SCALE_LABEL, SCALE_TONE,
  scaleRank, scaleTone,
} from './scale';

/* ==========================================================================
   1. KIT WEIGHT — vehicle-equivalents per unit of a kit line
   ========================================================================== */

/**
 * How much of a "vehicle of equipment" one unit of a kit charge represents.
 *
 * The sheet never totals kit either — it has ~150 separate equipment columns
 * and a Classification Key that talks about vans and artics, with nothing
 * joining the two. This table is the missing join, and it is a judgement
 * call this app cannot make on its own: EP's own kit register (`data/db.ts`,
 * `kind: 'kit'`) is eleven charges, none of them an actual vehicle — no van,
 * no HGV, no telehandler exists as a chargeable line today. The weights below
 * are a reasonable starting guess (a cabin or welfare unit travels on its own
 * trailer; twenty barriers or fifty Heras panels are roughly one vehicle's
 * worth of load; a handful of radios changes nothing) and are meant to be
 * corrected by whoever actually loads the trucks, not treated as final.
 */
export const KIT_WEIGHT: Record<string, number> = {
  'ch-kit-cabin': 1, // a control point/cabin is its own low-loader or flatbed load
  'ch-kit-welfare': 1, // a welfare unit is a trailer in its own right
  'ch-kit-lighting': 0.5, // a tower light tows as a small trailer
  'ch-kit-buggy': 0.5,
  'ch-kit-barrier': 0.05, // ~20 barriers per vehicle-equivalent load
  'ch-kit-heras': 0.02, // ~50 panels per vehicle-equivalent load
  'ch-kit-signage': 0.02,
  'ch-kit-cone': 0.01,
  'ch-kit-radio': 0, // fits in a car; doesn't move the classification
  'ch-kit-charger': 0,
  'ch-kit-hivis': 0,
};

/** A conservative guess for any kit charge not named above — see `KIT_WEIGHT`. */
export const DEFAULT_KIT_WEIGHT = 0.02;

export function kitWeight(chargeId: string): number {
  return chargeId in KIT_WEIGHT ? KIT_WEIGHT[chargeId] : DEFAULT_KIT_WEIGHT;
}

/* ==========================================================================
   2. THE BANDS
   ========================================================================== */

/**
 * Staff and kit are each read off the sheet's own Classification Key
 * independently, and the HIGHER of the two bands wins — the key's "OR" for
 * Tier 2/1 ("5 vehicles OR 1 artic") generalises to every band rather than
 * being special-cased at the top.
 *
 * Boundaries are inclusive at the low edge, matching the sheet's own
 * overlapping ranges (21–40 / 41–75): exactly 20 staff stays Light, 21 tips
 * to Medium. The gap the sheet leaves between "<0.5" and "1" vehicle is
 * closed at 0.5, rounding up rather than down — equipment that's more than a
 * token drop is treated as a real vehicle of kit.
 */
export function scaleForCounts(staff: number, kitVolume: number): AutoScale {
  const staffIndex =
    staff > 75 ? 4 : staff > 40 ? 3 : staff > 20 ? 2 : staff >= 5 ? 1 : 0;
  const kitIndex =
    kitVolume >= 10 ? 4 : kitVolume >= 5 ? 3 : kitVolume >= 2 ? 2 : kitVolume >= 0.5 ? 1 : 0;
  return AUTO_SCALES[Math.max(staffIndex, kitIndex)] as AutoScale;
}

/* ==========================================================================
   3. PEAK STAFF AND KIT, PER EVENT
   ========================================================================== */

export interface ScaleAssessment {
  auto: AutoScale;
  /** Highest same-day headcount required, across every day the event runs. */
  peakStaff: number;
  /** Highest same-day kit volume (vehicle-equivalents), across the job's span. */
  peakKitVolume: number;
  /** The shift day `peakStaff` was read from, or null when the event has none. */
  staffPeakDay: number | null;
  /** The span day `peakKitVolume` was read from, or null when there's no kit. */
  kitPeakDay: number | null;
}

const EMPTY_ASSESSMENT: ScaleAssessment = {
  auto: 'minimal',
  peakStaff: 0,
  peakKitVolume: 0,
  staffPeakDay: null,
  kitPeakDay: null,
};

function peakStaffByDay(ev: EpEvent): { peak: number; day: number | null } {
  const byDay = new Map<number, number>();
  ev.shifts.forEach((sh) => {
    const required = sh.splits.reduce((sum, sp) => sum + sp.required, 0);
    byDay.set(sh.day, (byDay.get(sh.day) || 0) + required);
  });
  let peak = 0;
  let day: number | null = null;
  byDay.forEach((total, d) => {
    if (total > peak) {
      peak = total;
      day = d;
    }
  });
  return { peak, day };
}

function isKitLine(l: LineItem): boolean {
  return l.kind === 'kit';
}

function peakKitByDay(w: Wof): { peak: number; day: number | null } {
  const byDay = new Map<number, number>();
  w.lines.filter(isKitLine).forEach((l) => {
    const { from, to } = hireWindow(w, l);
    const weight = l.qty * kitWeight(l.chargeId);
    if (weight <= 0) return;
    for (let d = from; d <= to; d += 1) byDay.set(d, (byDay.get(d) || 0) + weight);
  });
  let peak = 0;
  let day: number | null = null;
  byDay.forEach((total, d) => {
    if (total > peak) {
      peak = total;
      day = d;
    }
  });
  return { peak, day };
}

/**
 * The auto-classification an event would carry today, with the two figures
 * it was read from. Ignores any manual `scaleOverride` — see `eventScale`
 * for the value to actually show.
 *
 * An event with no shifts yet (raised but not yet built out) reads as
 * Minimal on zero staff and zero kit, same as the sheet would show a job with
 * nothing entered against it — not an error state, just an honest floor.
 */
export function assessScale(ev: EpEvent): ScaleAssessment {
  const { peak: peakStaff, day: staffPeakDay } = peakStaffByDay(ev);
  const w = W.byEvent(ev.id);
  const { peak: peakKitVolume, day: kitPeakDay } = w
    ? peakKitByDay(w)
    : { peak: 0, day: null };
  if (peakStaff === 0 && peakKitVolume === 0) return { ...EMPTY_ASSESSMENT };
  return {
    auto: scaleForCounts(peakStaff, peakKitVolume),
    peakStaff,
    peakKitVolume,
    staffPeakDay,
    kitPeakDay,
  };
}

/**
 * The scale to actually show: a manual override wins outright, including the
 * two bands `assessScale` can never produce on its own (Day-to-Day, Lorry
 * Only) — those exist ONLY as an override. See `setScaleOverride` in
 * `events.ts`, which is the sole writer of `EpEvent.scaleOverride`.
 */
export function eventScale(ev: EpEvent): EventScale {
  // `scaleOverride` is a loose `string` on the record and is read back out of
  // a browser store that outlives any release, so a value this module no
  // longer recognises — the retired 'lorry-only', a typo, a band from a future
  // build — has to fall back to the computed figure rather than key a label
  // lookup that returns undefined and paints a pill with no text in it.
  return manualScale(ev) ?? assessScale(ev).auto;
}

/**
 * The hand-set band on this event, or null when it is running on the computed
 * figure.
 *
 * One reader for the override, because "is this set by hand" is asked in three
 * places and each of them was asking it of the raw field. An unrecognised
 * value is not a manual band — it is a band that no longer exists — and a
 * screen that answers yes to it says "Set manually" over a figure that was in
 * fact computed.
 */
export function manualScale(ev: EpEvent): EventScale | null {
  const override = ev.scaleOverride;
  return override && override in SCALE_LABEL ? (override as EventScale) : null;
}



/* ==========================================================================
   4. THE SAME READING, FROM THE QUOTE
   --------------------------------------------------------------------------
   `assessScale` needs an `EpEvent`, and an event does not exist until the job
   is ordered (`seedEvent` fires on the transition into `order`, and refuses
   outright when the quote has no staff lines). The pipeline screen is used
   long before that — the tier is most useful when someone is still deciding
   how big a job is, not once it is already being crewed.

   The quote already holds the same two facts the classification needs:
   deployments give headcount per day (`LineItem.perDay`, aligned to its
   pattern's `days`), and kit lines already carry their own hire window. So
   the WOF can be assessed directly, before any event exists, using the exact
   same bands.
   ========================================================================== */

/**
 * Peak same-day headcount read off the quote's deployments.
 *
 * Patterned lines land on the days their pattern names. A staff line with no
 * pattern is a line quoted before deployments shipped: it has a headcount and
 * no day to put it on, so all such lines are pooled into one notional day and
 * compared against the patterned peak, rather than being dropped (which would
 * read a legacy job as Minimal) or spread across the span (which would
 * invent days the quote never claimed).
 */
function peakQuoteStaffByDay(w: Wof): { peak: number; day: number | null } {
  const byDay = new Map<number, number>();
  let unplaced = 0;
  (w.lines || [])
    .filter((l) => l.kind === 'staff')
    .forEach((l) => {
      const pat = W.linePattern(w, l);
      if (!pat || !l.perDay) {
        unplaced += l.qty;
        return;
      }
      pat.days.forEach((d, i) => {
        const n = l.perDay![i] || 0;
        if (n > 0) byDay.set(d, (byDay.get(d) || 0) + n);
      });
    });
  let peak = 0;
  let day: number | null = null;
  byDay.forEach((total, d) => {
    if (total > peak) {
      peak = total;
      day = d;
    }
  });
  if (unplaced > peak) return { peak: unplaced, day: null };
  return { peak, day };
}

/**
 * What the quote on this WOF classifies as, or null when there is nothing to
 * read it from.
 *
 * Null rather than Minimal on purpose: a WOF raised this morning with no
 * lines on it is unclassified, not small, and a screen that says "Tier 5 –
 * Minimal" against an enquiry nobody has priced is stating a fact it does not
 * have.
 */
export function assessWofScale(w: Wof): ScaleAssessment | null {
  const { peak: peakStaff, day: staffPeakDay } = peakQuoteStaffByDay(w);
  const { peak: peakKitVolume, day: kitPeakDay } = peakKitByDay(w);
  if (peakStaff === 0 && peakKitVolume === 0) return null;
  return {
    auto: scaleForCounts(peakStaff, peakKitVolume),
    peakStaff,
    peakKitVolume,
    staffPeakDay,
    kitPeakDay,
  };
}

export interface WofScaleView {
  scale: EventScale;
  /** Null when the scale is a manual override — there are no figures behind it. */
  assessment: ScaleAssessment | null;
  /** Which record the figures were read from. */
  source: 'event' | 'quote';
  /** Ready-made tooltip line, matching the one on the event screen. */
  hint: string;
}

/**
 * The hand-set tier on a job that has no event yet, or null.
 *
 * The pre-order twin of `manualScale`, and it stops mattering the moment
 * `seedEvent` runs — which carries the value onto the event, after which the
 * EVENT is the one record that answers this. Same tolerance for a value this
 * build no longer knows: a retired band is not an override, it is a band that
 * no longer exists.
 */
export function wofManualScale(w: Wof): EventScale | null {
  if (w.eventId && eventById(w.eventId)) return null;
  const override = w.scaleOverride;
  return override && override in SCALE_LABEL ? (override as EventScale) : null;
}

/**
 * The tier to show for a WOF anywhere outside the event screen, or null when
 * the job has not been quoted yet.
 *
 * Once an event exists the event is the truth — its shifts are what will
 * actually be crewed, and a second figure read off the quote would disagree
 * with the badge on `EventDetail` the moment a variation lands. Before then,
 * the quote is all there is — unless somebody has said otherwise, which is the
 * only way Tier 6 can be reached before an order and the reason this check
 * comes first.
 */
export function wofScale(w: Wof): WofScaleView | null {
  const ev = w.eventId ? eventById(w.eventId) : null;
  if (ev) {
    const scale = eventScale(ev);
    if (manualScale(ev)) {
      return { scale, assessment: null, source: 'event', hint: 'Set manually' };
    }
    const a = assessScale(ev);
    return { scale, assessment: a, source: 'event', hint: peakHint(a, 'the staffing plan') };
  }
  const manual = wofManualScale(w);
  if (manual) return { scale: manual, assessment: null, source: 'quote', hint: 'Set manually' };
  const a = assessWofScale(w);
  if (!a) return null;
  return { scale: a.auto, assessment: a, source: 'quote', hint: peakHint(a, 'the quote') };
}

function peakHint(a: ScaleAssessment, from: string): string {
  const kit = a.peakKitVolume
    ? `, ${a.peakKitVolume.toFixed(2)} vehicle-equivalents of kit`
    : '';
  return `Peak ${a.peakStaff} staff${kit} on any one day, from ${from}`;
}
