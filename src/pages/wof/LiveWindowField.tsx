/* ============================================================================
   WHICH DAYS ARE THE EVENT
   ----------------------------------------------------------------------------
   A job's span is not all the same kind of day. A festival sold as 28 Aug ->
   3 Sep is two build days, three event days and two breakdown days, and until
   this field existed the only record of that was the wording of a quote line.

   Renders nothing on a single-day job. There is no build day to distinguish on
   a job that is one day long, and a control that always reads "Day 1 to Day 1"
   is a control an operator learns to skip past — which is how the real ones get
   skipped too.
   ========================================================================== */

import { fmtDate } from '@/lib/format';
import * as W from '@/lib/wof';

export function LiveWindowField({
  start,
  end,
  from,
  to,
  onChange,
}: {
  /** Local `YYYY-MM-DDTHH:mm` — the shape the datetime inputs hold. */
  start: string;
  end: string;
  from: number;
  to: number;
  onChange: (from: number, to: number) => void;
}) {
  const windows = start && end ? W.spanWindowsOf(start, end) : [];
  const days = windows.length;
  if (days < 2) return null;

  // The dates moved under a window that was already set. Clamp for display so
  // the selects cannot show a day the job no longer has; the same clamp runs in
  // `liveWindow` when the value is read back.
  const f = Math.min(Math.max(from, 1), days);
  const t = Math.min(Math.max(to, f), days);

  const label = (i: number) => `Day ${i + 1} · ${fmtDate(windows[i].start)}`;
  const build = f - 1;
  const brk = days - t;

  return (
    <div>
      <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Event days</span>
      <div className="flex items-center gap-2">
        <select
          className="field"
          aria-label="First event day"
          value={f}
          onChange={(e) => {
            const next = Number(e.target.value);
            // Dragging the start past the end takes the end with it rather than
            // refusing the change — an operator moving the front of the window
            // means to move it, and a silently rejected click reads as a bug.
            onChange(next, Math.max(next, t));
          }}
        >
          {windows.map((_, i) => (
            <option key={i} value={i + 1}>
              {label(i)}
            </option>
          ))}
        </select>
        <span className="text-[12.5px] text-ink-3 shrink-0">to</span>
        <select
          className="field"
          aria-label="Last event day"
          value={t}
          onChange={(e) => onChange(f, Number(e.target.value))}
        >
          {windows.map((_, i) => (
            <option key={i} value={i + 1} disabled={i + 1 < f}>
              {label(i)}
            </option>
          ))}
        </select>
      </div>
      <span className="block text-[11px] text-ink-3 mt-1">
        {build || brk
          ? `${build ? `${build} build day${build === 1 ? '' : 's'} before` : 'No build days'}, ` +
            `${brk ? `${brk} break day${brk === 1 ? '' : 's'} after` : 'no break days after'}.`
          : 'The whole job is the event — narrow this if there are build or break days.'}
      </span>
    </div>
  );
}
