/* ============================================================================
   WOF — WAGE FRAMEWORK
   ----------------------------------------------------------------------------
   Which pay floor this job is staffed under: the National Living Wage, the
   real Living Wage, the London Living Wage or the Ireland Living Wage (euros). The choices are the ones set up
   on the client's Rates tab — one client can run a Living Wage park and an NLW
   car park in the same month, so it is chosen per job.

   It decides two things at once, and the card says both before it moves:
   what each staff hour is CHARGED (the staff lines re-price), and what each
   staff hour is PAID (the floor every timesheet on the job is held to).

   Fixed once the client signs — the price of every staff hour rests on it.
   ========================================================================== */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Segmented } from '@/components/primitives';
import { Icon } from '@/components/Icon';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { countLabel, fmtDateFull, money, round2 } from '@/lib/format';
import { NOW } from '@/data/db';
import * as W from '@/lib/wof';
import * as WAGES from '@/lib/wages';
import * as ROLES from '@/lib/roles';
import { TONE_BG, TONE_HEX, TONE_LINE } from '@/lib/status';

/** "£13.45/hr — £14.10 from 1 May 2027" */
export function floorLine(id: WAGES.WageFrameworkId, when: Date | string = NOW): string {
  const now = WAGES.floorOn(id, when);
  const next = WAGES.nextRate(id, when);
  return `${WAGES.fmt(id, now)}/hr${next ? ` — ${WAGES.fmt(id, next.rate)} from ${fmtDateFull(next.from)}` : ''}`;
}

/**
 * The pricing basis, as a banner above the quote. It was a quiet line of
 * metadata until Nov 2026, but the ops manager staffs the job off it — the pay
 * floor and any rise before the job ends have to be readable at a glance, so
 * they are figures, not a sentence. Where the rates come from (and that each
 * line keeps the rate it was priced on) stays in the tooltip.
 */
export function WageFrameworkRow({ w }: { w: W.Wof }) {
  const toast = useToast();
  const [moving, setMoving] = useState<WAGES.WageFrameworkId | null>(null);
  const cur = W.wageFramework(w);
  const fw = WAGES.framework(cur);
  const options = W.wageFrameworkOptions(w);
  const denial = ROLES.denial('wof.quote');
  const block = denial || W.wageFrameworkBlock(w);
  const euros = WAGES.currencyOf(cur) === 'EUR';
  const about =
    `Roles, pay rates and charges come from the ${fw.short} column of the 2027 labour rate card. ` +
    'Every line keeps the rate that applied on the day it was priced — editing the table of charges changes future quotes only.';

  const floor = WAGES.floorOn(cur, w.start);
  const next = WAGES.nextRate(cur, w.start);
  // A rise that lands before the job is over changes what the later shifts
  // must be paid — that is the one the ops manager has to act on.
  const riseInJob = !!next && next.from <= String(w.end ?? w.start).slice(0, 10);
  const riseTone = riseInJob ? 'atRisk' : 'neutral';

  return (
    <section
      className="card mb-4 mt-1 overflow-hidden"
      style={{ borderLeft: `4px solid ${TONE_HEX.info}` }}
      aria-label="Wage framework"
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3.5">
        {/* Which framework */}
        <div className="flex items-center gap-3 min-w-0 flex-1" style={{ minWidth: 240 }}>
          <span
            className="inline-flex items-center justify-center shrink-0 rounded-lg"
            style={{ width: 40, height: 40, background: TONE_BG.info, color: TONE_HEX.info }}
          >
            <Icon name="users" decorative />
          </span>
          <div className="min-w-0">
            <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3">
              Wage framework
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[16px] font-bold text-ink leading-tight">{fw.label}</span>
              <span
                className="text-[11px] font-bold rounded-[4px] px-1.5 py-0.5"
                style={{ background: TONE_BG.info, color: TONE_HEX.info, border: `1px solid ${TONE_LINE.info}` }}
              >
                {fw.short}
              </span>
              <span
                className="tip tip-wrap inline-flex text-ink-3 cursor-help"
                data-tip={about}
                tabIndex={0}
                aria-label={about}
              >
                <Icon name="info" decorative className="icon-sm" />
              </span>
            </div>
            <div className="text-[12px] text-ink-3 mt-0.5">
              2027 labour rate card{euros ? ' · paid and charged in euros' : ''}
            </div>
          </div>
        </div>

        {/* What staff must be paid */}
        <div className="flex items-stretch gap-6">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3">Pay floor</div>
            <div className="text-[20px] font-bold text-ink tabular-nums leading-tight mt-0.5">
              {WAGES.fmt(cur, floor)}
              <span className="text-[12.5px] font-medium text-ink-3">/hr</span>
            </div>
            <div className="text-[12px] text-ink-3">minimum for every staff hour</div>
          </div>
          {next ? (
            <div className="pl-6" style={{ borderLeft: '1px solid var(--surface-line)' }}>
              <div
                className="text-[11px] font-bold uppercase tracking-wider"
                style={{ color: riseInJob ? TONE_HEX[riseTone] : undefined }}
              >
                <span className={riseInJob ? '' : 'text-ink-3'}>
                  {riseInJob ? 'Rises during this job' : 'Next rise'}
                </span>
              </div>
              <div className="text-[20px] font-bold tabular-nums leading-tight mt-0.5" style={{ color: TONE_HEX[riseTone] }}>
                {WAGES.fmt(cur, next.rate)}
                <span className="text-[12.5px] font-medium text-ink-3">/hr</span>
              </div>
              <div className="text-[12px] text-ink-3">from {fmtDateFull(next.from)}</div>
            </div>
          ) : null}
        </div>

        {/* Change it */}
        <div className="shrink-0 ml-auto text-right">
          {options.length > 1 ? (
            <div title={block || undefined}>
              <fieldset disabled={!!block} style={{ border: 0, padding: 0, margin: 0, opacity: block ? 0.6 : 1 }}>
                <Segmented<WAGES.WageFrameworkId>
                  ariaLabel="Wage framework for this job"
                  value={cur}
                  onChange={(v) => (v === cur ? undefined : setMoving(v))}
                  options={options.map((id) => [id, WAGES.framework(id).short])}
                />
              </fieldset>
              {block && !denial ? (
                <p className="text-[11.5px] text-ink-3 mt-1.5 max-w-[260px] ml-auto leading-snug">{block}</p>
              ) : null}
            </div>
          ) : (
            <Link
              to={`/clients/${w.clientId}?tab=rates`}
              className="btn btn-secondary btn-sm no-underline"
            >
              Add a wage framework
            </Link>
          )}
        </div>
      </div>

      {moving ? (
        <MoveFramework
          w={w}
          to={moving}
          onClose={() => setMoving(null)}
          onDone={(msg) => {
            setMoving(null);
            toast(msg, { tone: 'healthy' });
          }}
        />
      ) : null}
    </section>
  );
}

function MoveFramework({
  w,
  to,
  onClose,
  onDone,
}: {
  w: W.Wof;
  to: WAGES.WageFrameworkId;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const from = W.wageFramework(w);
  const plan = W.wageFrameworkPreview(w, to);
  const before = round2(plan.reduce((s, p) => s + p.before, 0));
  const after = round2(plan.reduce((s, p) => s + p.after, 0));
  const delta = round2(after - before);
  const sent = W.quoteSent(w);
  const target = WAGES.framework(to);

  return (
    <Modal
      title={`Staff this job under the ${target.label}?`}
      width={540}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              const r = W.setWageFramework(w, to);
              if (!r.ok) return onDone(r.reason || 'That did not work.');
              onDone(
                `${w.ref} is now on the ${target.label}${
                  r.moved ? ` — ${countLabel(r.moved, 'staff line')} re-priced, ${delta >= 0 ? '+' : '−'}${money(Math.abs(delta))}` : ''
                }.`,
              );
            }}
          >
            Move to {target.short}
          </button>
        </>
      }
    >
      <p className="text-[13.5px] text-ink-2 leading-relaxed mb-3">
        {target.blurb} Every staff hour on this job will be paid at least{' '}
        <strong className="text-ink">{floorLine(to, w.start)}</strong>, instead of{' '}
        {floorLine(from, w.start)}.
      </p>

      {plan.length ? (
        <>
          <div className="well p-3 mb-3" style={{ maxHeight: 240, overflowY: 'auto' }}>
            {plan.map((p) => (
              <div key={p.line.id} className="flex items-baseline justify-between gap-3 py-0.5">
                <span className="text-[12.5px] text-ink-2 truncate">{p.line.description}</span>
                <span className="text-[12.5px] tabular-nums text-ink-2 whitespace-nowrap">
                  {money(p.before)} → <strong className="text-ink">{money(p.after)}</strong>
                </span>
              </div>
            ))}
          </div>
          <div className="well p-3 mb-3">
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-ink-2">Staff on this quote</span>
              <span className="text-[15px] font-bold text-ink tabular-nums">
                {money(before)} → {money(after)}
              </span>
            </div>
            <p className="text-[12px] text-ink-3 mt-1">
              {delta >= 0 ? '+' : '−'}
              {money(Math.abs(delta))} · kit and services do not move
            </p>
          </div>
        </>
      ) : (
        <p className="text-[12.5px] text-ink-3 mb-3">
          No staff are quoted yet, so no price moves. Staff added from now on are priced for the {target.label}.
        </p>
      )}

      <p className="text-[12px] text-ink-3 leading-relaxed">
        Prices agreed with this client under the {target.short} are used where there are any; otherwise each
        role moves to its {target.short} pay rate and charge on the 2027 labour rate card.
        {sent ? ' The client has been sent this quote, so it will show as amended until you re-send it.' : ''}
      </p>
    </Modal>
  );
}
