/* ============================================================================
   EPROSTA — UK WAGE FRAMEWORKS
   ----------------------------------------------------------------------------
   Four pay floors a job can be staffed under. A client may hold more than one
   — a council pays the real Living Wage on its parks and the London Living
   Wage on the events it runs in Southwark — so the framework belongs to the
   JOB (the WOF), chosen from the ones set up on the client's Rates tab.

     NLW  National Living Wage — the statutory minimum for workers 21 and over.
          Set by government, from 1 April each year. Every job is at least this.
     RLW  real Living Wage — the Living Wage Foundation's voluntary rate,
          worked out from the cost of living. Accredited employers and their
          contractors commit to it.
     LLW  London Living Wage — the Foundation's London rate, for work in
          Greater London.

   A framework does two things, and the second is the reason it exists:

     1. It is a PAY FLOOR. Every hour on the job is paid at least the
        framework's rate on the day it was worked (`floorOn`), whatever the
        worker's band or custom rate says — see `payrates.rateOn`.
     2. It PRICES the staff lines. Lifting pay lifts EP's cost, so a staff
        line on an RLW job costs more and is charged more — see `rates.rateFor`.

   Rates are DATED, like everything else that moves money. The Foundation
   announces each autumn and accredited employers must pay the new rate by the
   following 1 May; that deadline is the `from` used here, with the
   announcement kept for the screen. Add the next row each year — nothing
   else needs to change.

   Sources: gov.uk (NLW £12.71 from 1 April 2026); Living Wage Foundation,
   announced 15 October 2026 (RLW £14.10, LLW £15.45, to be paid by
   1 May 2027); EP's 2027 labour rate card for the NLW 2027 figure (£13.21)
   and the Ireland Living Wage (€14.20, €14.95 in 2027).

   ILW  Ireland Living Wage — added 12 Nov 2026. It is in EUROS, staff only:
        the floor, the role pay rates and the staff charge-out on an Ireland
        job are euro figures (`currencyOf`). Nothing converts them.

   WHAT A ROLE IS PAID is no longer just the floor. The 2027 labour rate card
   (`data/labour.ts`) gives every role a category and a pay rate under each
   framework; the floor here is the least anyone is paid, the card is what
   the role is paid and charged.
   ========================================================================== */

export type WageFrameworkId = 'nlw' | 'rlw' | 'llw' | 'ilw';
export type Currency = 'GBP' | 'EUR';

export interface WageRate {
  /** YYYY-MM-DD — hours worked on or after this day are paid at least `rate`. */
  from: string;
  rate: number;
  /** When it was announced, if it is announced ahead of `from`. */
  announced?: string;
}

export interface WageFramework {
  id: WageFrameworkId;
  label: string;
  short: string;
  blurb: string;
  /** Statutory — cannot be switched off for a client. */
  statutory?: boolean;
  /** Missing = pounds. Ireland is paid in euros. */
  currency?: Currency;
  rates: WageRate[];
}

export const FRAMEWORKS: WageFramework[] = [
  {
    id: 'nlw',
    label: 'National Living Wage',
    short: 'NLW',
    blurb: 'The legal minimum for workers 21 and over. Every job is paid at least this.',
    statutory: true,
    rates: [
      { from: '2024-04-01', rate: 11.44 },
      { from: '2025-04-01', rate: 12.21 },
      { from: '2026-04-01', rate: 12.71 },
      { from: '2027-04-01', rate: 13.21 },
    ],
  },
  {
    id: 'rlw',
    label: 'Real Living Wage',
    short: 'RLW',
    blurb: 'The Living Wage Foundation rate for work outside London.',
    rates: [
      { from: '2025-05-01', rate: 12.6, announced: '2024-10-24' },
      { from: '2026-05-01', rate: 13.45, announced: '2025-10-22' },
      { from: '2027-05-01', rate: 14.1, announced: '2026-10-15' },
    ],
  },
  {
    id: 'llw',
    label: 'London Living Wage',
    short: 'LLW',
    blurb: 'The Living Wage Foundation rate for work in Greater London.',
    rates: [
      { from: '2025-05-01', rate: 13.85, announced: '2024-10-24' },
      { from: '2026-05-01', rate: 14.8, announced: '2025-10-22' },
      { from: '2027-05-01', rate: 15.45, announced: '2026-10-15' },
    ],
  },
  {
    id: 'ilw',
    label: 'Ireland Living Wage',
    short: 'ILW',
    blurb: 'The living wage for work in Ireland. Paid in euros.',
    currency: 'EUR',
    /* The sheet gives the two figures (2026 and 2027) and no dates. The 2027
       rate is taken from 1 January 2027 until someone says otherwise. */
    rates: [
      { from: '2026-01-01', rate: 14.2 },
      { from: '2027-01-01', rate: 14.95 },
    ],
  },
];

export const DEFAULT_FRAMEWORK: WageFrameworkId = 'nlw';

export const isFramework = (id: unknown): id is WageFrameworkId =>
  typeof id === 'string' && FRAMEWORKS.some((f) => f.id === id);

export const framework = (id: string | null | undefined): WageFramework =>
  FRAMEWORKS.find((f) => f.id === id) || FRAMEWORKS[0];

/** Local YYYY-MM-DD for any date-ish input. */
function day(v: string | Date | null | undefined): string {
  if (!v) return day(new Date());
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(v);
  if (Number.isNaN(+d)) return String(v).slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The rate row in force on a day, or the earliest row for a day before them all. */
export function rateRowOn(id: string | null | undefined, when?: string | Date | null): WageRate {
  const f = framework(id);
  const d = day(when);
  const live = f.rates.filter((r) => r.from <= d);
  return live[live.length - 1] || f.rates[0];
}

/** The pay floor per hour on a day. */
export const floorOn = (id: string | null | undefined, when?: string | Date | null): number =>
  rateRowOn(id, when).rate;

/** An announced rate not yet in force — "£14.10 from 1 May 2027". */
export function nextRate(id: string | null | undefined, when?: string | Date | null): WageRate | null {
  const d = day(when);
  return framework(id).rates.find((r) => r.from > d) || null;
}

/**
 * How far above the statutory floor this framework sits on a day. This is the
 * extra pay per hour a staff line carries on a framework job, and so the extra
 * COST per hour that `rates.rateFor` adds before holding the margin.
 */
export const premiumOn = (id: string | null | undefined, when?: string | Date | null): number =>
  // A euro floor less a sterling one is not a number of anything.
  currencyOf(id) !== 'GBP'
    ? 0
    : Math.max(0, Math.round((floorOn(id, when) - floorOn('nlw', when)) * 100) / 100);

/** The currency a framework's wages are paid in. */
export function currencyOf(id: string | null | undefined): Currency {
  return framework(id).currency || 'GBP';
}

const SYMBOL: Record<Currency, string> = { GBP: '£', EUR: '€' };

/** "£14.10" / "€14.95" — an hourly figure in the framework's own currency. */
export const fmt = (id: string | null | undefined, n: number | null | undefined): string =>
  n == null || Number.isNaN(n)
    ? '—'
    : `${n < 0 ? '−' : ''}${SYMBOL[currencyOf(id)]}${Math.abs(n).toFixed(2)}`;
