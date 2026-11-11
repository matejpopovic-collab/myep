/* ============================================================================
   EPROSTA — the day grid
   ----------------------------------------------------------------------------
   The frame both quote grids are drawn in: the operator's `DeploymentTable` on
   the WOF and the client's `ClientDeploymentTable` in the portal. Roles down
   the side, one column per day of the job, the sold totals on the right.

   It exists because of the month-long job. The grid was laid out for a
   festival - eight days, sixteen with a long build - and let the browser size
   the columns, so a 31-day span simply grew wider than the card: Shifts, Hours
   and Value, the place subtotals and the edit buttons all ended up past the
   right-hand edge, behind a scrollbar at the bottom of a table two screens
   tall. And the header was a bare day-of-month, which reads fine for 16-23 and
   as nonsense for "30 1 2 3 ... 30".

   Three things, in the order they kick in as a job gets longer:

   1. The day columns are FLUID. They share whatever the card has left after
      the role column and the totals, between `--dg-day-min` and `--dg-day-max`
      (see `.daygrid` in app.css). A weekend job keeps its roomy columns; a
      month closes up to fit the same card without a scrollbar.
   2. The header says WHICH day. A month band above the dates, the weekday on
      every column, and a rule down the grid at each Monday - thirty-one
      identical columns need somewhere for the eye to land.
   3. Past what fits - six weeks, or a month on a small laptop - the days
      SCROLL BETWEEN the role column and the totals, which both stay put. The
      one thing a long job must never do is separate a row's name from its
      money.

   Kept to layout. What goes in a cell, and whether it can be typed into, is
   the business of the table that uses this.
   ========================================================================== */

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { TONE_HEX } from '@/lib/status';
import * as W from '@/lib/wof';

export interface GridDay {
  /** 1-based day number into the job's span - what patterns store. */
  no: number;
  /** `null` only for a job whose dates do not parse. */
  date: Date | null;
  kind: W.DayKind;
  /** A Monday that is not the first column: where the week rule is drawn. */
  weekStart: boolean;
  weekend: boolean;
  /**
   * The first day of a phase, other than the first column: where the build
   * hands over to the event, or the event to the breakdown.
   */
  phaseStart: boolean;
}

/** Every day of the job, with what the grid needs to know to draw its column. */
export function gridDays(w: W.Wof): GridDay[] {
  const wins = W.spanWindowsOf(w.start, w.end);
  return Array.from({ length: W.eventDays(w) }, (_, i) => {
    const date = wins[i]?.start || null;
    const dow = date ? date.getDay() : -1;
    const kind = W.dayKind(w, i + 1);
    return {
      no: i + 1,
      date,
      kind,
      weekStart: i > 0 && dow === 1,
      weekend: dow === 0 || dow === 6,
      phaseStart: i > 0 && kind !== W.dayKind(w, i),
    };
  });
}

/**
 * The vertical rule, if any, down the left of a day's column.
 *
 * Three strengths, because there are three sizes of division and they are not
 * equally important: the phase boundary is the one a reader is actually
 * looking for - where the build stops and the job goes live - so it gets the
 * dark rule and beats a week that starts on the same day. Mondays get the
 * light one. Ordinary days get none, or thirty-one ruled columns would read as
 * a fence rather than a grid.
 *
 * The phase TINTS cannot carry this on their own. All three sit at about a
 * tenth of an alpha, so they differ in hue and barely in weight, and a build
 * day beside an event day is two pale washes meeting with nothing between
 * them.
 */
export function dayRule(day: GridDay): string {
  return day.phaseStart ? ' dg-phase' : day.weekStart ? ' dg-wk' : '';
}

/**
 * The column tint for a day of the job, by phase: the accent for event days,
 * amber for the build and grey for the breakdown, the same three colours the
 * day pickers use, so a day reads the same on every screen.
 *
 * The grid has its own tokens for them rather than the status tones (which is
 * what these were). See `--dg-build` in app.css for why.
 */
export function phaseBg(kind: W.DayKind): string {
  return kind === 'event' ? 'var(--dg-event)' : kind === 'build' ? 'var(--dg-build)' : 'var(--dg-break)';
}

/** "Wed 12 Aug" - a day named the way it is said, for titles and labels. */
export function dayName(day: GridDay): string {
  return day.date
    ? day.date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
    : `Day ${day.no}`;
}

/**
 * Class and offset for a cell in the totals block on the right.
 *
 * `tail` is the pixel width of each of those columns, left to right; `i` is
 * which one this cell is. Each is stuck to the right edge at the combined
 * width of the columns after it, so the block holds together as the days
 * scroll underneath.
 */
export function tailCell(tail: number[], i: number): { className: string; style: CSSProperties } {
  return {
    className: i === 0 ? 'dg-tail dg-tail-edge' : 'dg-tail',
    style: { right: tail.slice(i + 1).reduce((n, x) => n + x, 0) },
  };
}

/**
 * The scrolling frame. Sets the two numbers the stylesheet sizes the columns
 * from, and marks which edges have more grid beyond them so the pinned columns
 * can cast a shadow only when there is something under them.
 */
export function DayGridFrame({
  days,
  tail,
  children,
}: {
  days: number;
  tail: number[];
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => {
      const max = el.scrollWidth - el.clientWidth;
      el.toggleAttribute('data-more-l', el.scrollLeft > 1);
      el.toggleAttribute('data-more-r', el.scrollLeft < max - 1);
    };
    sync();
    el.addEventListener('scroll', sync, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', sync);
      ro?.disconnect();
    };
  }, [days]);

  return (
    <div
      ref={ref}
      className="daygrid"
      style={
        {
          '--dg-days': Math.max(days, 1),
          '--dg-tail': `${tail.reduce((n, x) => n + x, 0)}px`,
        } as CSSProperties
      }
    >
      {children}
    </div>
  );
}

/** Role column (takes what is left), one fluid column per day, then the totals. */
export function DayGridCols({ days, tail }: { days: GridDay[]; tail: number[] }) {
  return (
    <colgroup>
      <col />
      {days.map((d) => (
        <col key={d.no} className="dg-day" />
      ))}
      {tail.map((width, i) => (
        <col key={i} style={{ width }} />
      ))}
    </colgroup>
  );
}

const HEAD = 'text-[9.5px] uppercase tracking-[0.11em] text-ink-3 font-semibold';

/**
 * Two header rows: the months the job runs through, then a weekday and a date
 * for every day.
 *
 * The month label is pinned inside its own band, so on a grid that scrolls it
 * rides along the left edge until its month runs out - the column under your
 * eye is always labelled, however far in you are.
 */
export function DayGridHead({
  days,
  tail,
  tailLabels,
  titleFor,
}: {
  days: GridDay[];
  tail: number[];
  /** One per `tail` column. `null` for a column with no heading (the buttons). */
  tailLabels: (string | null)[];
  titleFor: (day: GridDay) => string;
}) {
  const months: { key: string; date: Date | null; span: number }[] = [];
  days.forEach((d) => {
    const key = d.date ? `${d.date.getFullYear()}-${d.date.getMonth()}` : 'none';
    const last = months[months.length - 1];
    if (last && last.key === key) last.span += 1;
    else months.push({ key, date: d.date, span: 1 });
  });

  return (
    <thead>
      <tr>
        <th rowSpan={2} className={`dg-role text-left px-3 py-2 align-bottom ${HEAD}`}>
          Role
        </th>
        {months.map((m, i) => (
          <th
            key={m.key}
            colSpan={m.span}
            className={`text-left pt-2 pb-1 whitespace-nowrap overflow-clip ${HEAD} ${i ? 'dg-wk' : ''}`}
          >
            {m.date ? (
              // A month with a day or two in it has room for three letters,
              // and only if they are not spaced out.
              <span className={m.span >= 6 ? 'dg-pin-month' : 'dg-pin-month tracking-normal'}>
                {m.date.toLocaleDateString('en-GB', m.span >= 6 ? { month: 'long', year: 'numeric' } : { month: 'short' })}
              </span>
            ) : null}
          </th>
        ))}
        {tailLabels.map((label, i) => {
          const pin = tailCell(tail, i);
          return (
            <th
              key={i}
              rowSpan={2}
              className={`${pin.className} text-right px-3 py-2 align-bottom ${HEAD}`}
              style={pin.style}
            >
              {label}
            </th>
          );
        })}
      </tr>
      <tr>
        {days.map((d) => (
          <th
            key={d.no}
            className={`px-0 pt-1 pb-1.5 text-center${dayRule(d)}`}
            style={{ background: phaseBg(d.kind) }}
            title={titleFor(d)}
          >
            <div
              className="text-[8.5px] uppercase tracking-[0.04em] leading-none mb-1"
              style={{ color: d.weekend ? 'var(--ink-2)' : 'var(--ink-3)', fontWeight: d.weekend ? 700 : 500 }}
            >
              {d.date ? d.date.toLocaleDateString('en-GB', { weekday: 'short' }).slice(0, 2) : ''}
            </div>
            <div
              className="text-[10.5px] tabular-nums font-semibold leading-none"
              style={{
                color: d.kind === 'event' ? 'var(--ink-2)' : d.kind === 'build' ? TONE_HEX.atRisk : TONE_HEX.neutral,
              }}
            >
              {d.date ? d.date.getDate() : d.no}
            </div>
          </th>
        ))}
      </tr>
    </thead>
  );
}
