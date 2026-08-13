/* ============================================================================
   RATING + FLAG PRESENTATION
   ----------------------------------------------------------------------------
   The published criteria and the per-worker working. Both exist because a score
   nobody can defend is a score operators work around: an operator who can see
   the arithmetic can explain the queue order to the person standing in it.
   ========================================================================== */

import { Icon } from './Icon';
import { Pill } from './primitives';
import { TONE_HEX } from '@/lib/status';
import { fmtDate } from '@/lib/format';
import type { Employee, Tone } from '@/data/types';
import * as RATING from '@/lib/rating';
import * as FLAGS from '@/lib/flags';

export function BandPill({ emp }: { emp: Employee }) {
  const s = RATING.score(emp);
  return (
    <Pill
      status={`band-${s.band.id}`}
      label={s.band.label}
      tone={s.band.tone}
      hint={`${s.value.toFixed(1)} from ${s.rated} rated shift${s.rated === 1 ? '' : 's'}. ${s.band.perk}`}
    />
  );
}

/**
 * The marker that goes in the table. Icon plus the reason on hover and in the
 * accessible name — never colour alone, per the rest of the build.
 */
export function FlagMarker({ emp, showLabel = true }: { emp: Employee; showLabel?: boolean }) {
  if (!emp.flag) return null;
  const r = FLAGS.reason(emp.flag.reasonId);
  const tip = `${r.label}${emp.flag.note ? ` — ${emp.flag.note}` : ''} · Flagged by ${emp.flag.by}, ${fmtDate(emp.flag.at)}`;
  return (
    <span
      className="inline-flex items-center gap-1 tip"
      tabIndex={0}
      data-tip={tip}
      role="img"
      aria-label={`Flagged: ${tip}`}
      style={{ color: TONE_HEX.critical }}
    >
      <Icon name="flag" decorative className="icon-sm" />
      {showLabel ? <span className="text-[11.5px] font-semibold">{r.label}</span> : null}
    </span>
  );
}

/** The published criteria. Shown wherever somebody asks "how is this set?" */
export function RatingCriteria() {
  const pointTone = (k: string): Tone =>
    k === 'no-show' ? 'critical' : k === 'late' ? 'atRisk' : k === 'cancelled' ? 'neutral' : 'healthy';

  return (
    <>
      <p className="text-[13.5px] text-ink-2 leading-relaxed mb-4">
        A rating is earned from shifts actually worked — there is no supervisor score to chase and nothing
        is entered by hand. Every worker has one, and it moves on its own as they work.
      </p>

      <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2">
        What each shift is worth
      </div>
      <div className="grid gap-1.5 mb-5">
        {Object.entries(RATING.POINTS).map(([k, p]) => (
          <div
            key={k}
            className="flex items-start gap-3 px-3 py-2 rounded-lg bg-surface-raised border border-surface-line-soft"
          >
            <span className="w-12 shrink-0 text-[13px] font-bold tabular-nums" style={{ color: TONE_HEX[pointTone(k)] }}>
              {p.value === null ? '—' : p.value.toFixed(2)}
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] text-ink">{p.label}</span>
              <span className="block text-[12px] text-ink-3 leading-snug">{p.blurb}</span>
            </span>
          </div>
        ))}
      </div>

      <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2">Two rules on top</div>
      <ul className="text-[13px] text-ink-2 leading-relaxed space-y-1.5 mb-5">
        <li>
          · <strong className="text-ink">Recent shifts count more.</strong> A shift's weight halves every six
          months, so an old mistake fades and a worker who has cleaned up their record climbs back.
        </li>
        <li>
          · <strong className="text-ink">Small samples are not flattered.</strong> Scores are pulled toward
          4.0 until roughly six shifts of evidence exist, so one perfect shift is not a 5.0 and a new worker
          cannot leapfrog a veteran on a fluke.
        </li>
      </ul>

      <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2">What it earns them</div>
      <div className="grid gap-1.5">
        {RATING.BANDS.map((b) => (
          <div
            key={b.id}
            className="flex items-start gap-3 px-3 py-2 rounded-lg bg-surface-raised border border-surface-line-soft"
          >
            <span className="shrink-0">
              <Pill status={`band-${b.id}`} label={b.label} tone={b.tone} hint={false} />
            </span>
            <span className="min-w-0">
              <span className="block text-[12.5px] text-ink-2">{b.perk}</span>
              <span className="block text-[11.5px] text-ink-3">
                {b.min > 0 ? `${b.min.toFixed(1)} or above` : 'Below 3.5'}
                {b.minRated > 1 ? `, from at least ${b.minRated} rated shifts` : ''}
              </span>
            </span>
          </div>
        ))}
      </div>

      <p className="text-[12px] text-ink-3 mt-4 leading-relaxed">
        Band decides who is offered a shift first. Nothing here changes pay — the rate is the one on the
        staff register, and a rating never moves it.
      </p>
    </>
  );
}

/** Per-worker working, so a score can be defended to the person holding it. */
export function RatingBreakdown({ emp }: { emp: Employee }) {
  const s = RATING.score(emp);
  const rows = RATING.history(emp);

  const bar = (label: string, n: number, tone: Tone) => {
    const p = s.rated + s.excluded ? Math.round((n / (s.rated + s.excluded)) * 100) : 0;
    return (
      <div className="flex items-center gap-2.5" key={label}>
        <span className="w-28 shrink-0 text-[12.5px] text-ink-2">{label}</span>
        <span className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'var(--surface-high)' }}>
          <span className="block h-full" style={{ width: `${p}%`, background: TONE_HEX[tone] }} />
        </span>
        <span className="w-12 shrink-0 text-right text-[12.5px] tabular-nums text-ink">{n}</span>
      </div>
    );
  };

  return (
    <>
      <div className="flex items-center gap-4 pb-4 mb-4 border-b border-surface-line-soft">
        <div>
          <div className="text-[30px] font-bold leading-none tabular-nums" style={{ color: TONE_HEX[s.band.tone] }}>
            {s.value.toFixed(1)}
          </div>
          <div className="text-[11.5px] text-ink-3 mt-1">out of 5</div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1.5">
            <BandPill emp={emp} />
          </div>
          <p className="text-[12.5px] text-ink-2 leading-snug">{s.band.perk}</p>
        </div>
      </div>

      <div className="grid gap-2 mb-4">
        {bar('Worked clean', s.counts.worked, 'healthy')}
        {bar('Stayed late', s.counts.overtime, 'info')}
        {bar('Late in', s.counts.late, 'atRisk')}
        {bar('Did not attend', s.counts['no-show'], 'critical')}
        {s.excluded ? bar('Client cancelled', s.excluded, 'neutral') : null}
      </div>

      <p className="text-[12.5px] text-ink-2 leading-relaxed mb-4">
        {s.rated ? (
          <>
            {s.rated} rated shift{s.rated === 1 ? '' : 's'}
            {s.excluded ? `, with ${s.excluded} client cancellation${s.excluded === 1 ? '' : 's'} excluded` : ''}.{' '}
            {s.recent
              ? `In the last year: ${s.recent} shift${s.recent === 1 ? '' : 's'}, ${s.recentLate || 'no'} late, ${s.recentNoShow || 'no'} missed. `
              : ''}
            {s.streak >= 3 ? `Currently ${s.streak} clean shifts in a row.` : ''}
          </>
        ) : (
          'No shifts on record yet, so this score is the neutral starting point.'
        )}
      </p>

      <div className="well p-3 mb-4">
        {s.next ? (
          <>
            <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1">
              To reach {s.next.label}
            </div>
            <p className="text-[12.5px] text-ink-2 leading-relaxed">
              {s.next.needs.join(', and ')} — then {s.next.perk.toLowerCase()}
            </p>
          </>
        ) : (
          <>
            <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1">Top band</div>
            <p className="text-[12.5px] text-ink-2">
              Nothing above this. Holding the record holds the position.
            </p>
          </>
        )}
      </div>

      <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2">
        Shifts behind the score · most recent first
      </div>
      <div className="grid gap-1">
        {rows.slice(0, 12).map((r, i) => (
          <div
            key={`${r.date}-${i}`}
            className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg bg-surface-raised border border-surface-line-soft"
          >
            <span className="text-[12.5px] text-ink-3 tabular-nums w-24 shrink-0">{fmtDate(r.date)}</span>
            <span className="flex-1 min-w-0 text-[12.5px] text-ink truncate">{r.role}</span>
            <span
              className="text-[11.5px] text-ink-3 tabular-nums w-16 text-right shrink-0"
              title="How much this shift still counts"
            >
              ×{r.weight.toFixed(2)}
            </span>
            <Pill status={r.outcome} />
          </div>
        ))}
      </div>
      {rows.length > 12 ? (
        <p className="text-[12px] text-ink-3 mt-2">
          and {rows.length - 12} older shift{rows.length - 12 === 1 ? '' : 's'}, counting for less.
        </p>
      ) : null}
    </>
  );
}
