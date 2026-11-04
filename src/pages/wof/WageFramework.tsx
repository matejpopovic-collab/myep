/* ============================================================================
   WOF — WAGE FRAMEWORK
   ----------------------------------------------------------------------------
   Which pay floor this job is staffed under: the National Living Wage, the
   real Living Wage or the London Living Wage. The choices are the ones set up
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
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { countLabel, fmtDateFull, money, round2 } from '@/lib/format';
import { NOW, client as clientById } from '@/data/db';
import * as W from '@/lib/wof';
import * as WAGES from '@/lib/wages';
import * as ROLES from '@/lib/roles';

/** "£13.45/hr — £14.10 from 1 May 2027" */
export function floorLine(id: WAGES.WageFrameworkId, when: Date | string = NOW): string {
  const now = WAGES.floorOn(id, when);
  const next = WAGES.nextRate(id, when);
  return `${money(now)}/hr${next ? ` — ${money(next.rate)} from ${fmtDateFull(next.from)}` : ''}`;
}

export function WageFrameworkCard({ w }: { w: W.Wof }) {
  const toast = useToast();
  const [moving, setMoving] = useState<WAGES.WageFrameworkId | null>(null);
  const cur = W.wageFramework(w);
  const fw = WAGES.framework(cur);
  const options = W.wageFrameworkOptions(w);
  const client = clientById(w.clientId);
  const denial = ROLES.denial('wof.quote');
  const block = denial || W.wageFrameworkBlock(w);

  return (
    <div className="card p-3.5 mb-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1">Wage framework</div>
          <div className="text-[13.5px] font-semibold text-ink">{fw.label}</div>
          <p className="text-[12.5px] text-ink-2 mt-0.5 leading-relaxed">
            Staff on this job are paid at least {floorLine(cur, w.start)}.{' '}
            {cur === 'nlw'
              ? 'Staff lines are priced from the table of charges as published.'
              : `Staff lines carry the +${money(WAGES.premiumOn(cur, w.start))}/hr over the National Living Wage, with the margin held.`}
          </p>
        </div>
        {options.length > 1 ? (
          <div className="shrink-0" title={block || undefined}>
            <fieldset disabled={!!block} style={{ border: 0, padding: 0, margin: 0, opacity: block ? 0.6 : 1 }}>
              <Segmented<WAGES.WageFrameworkId>
                ariaLabel="Wage framework for this job"
                value={cur}
                onChange={(v) => (v === cur ? undefined : setMoving(v))}
                options={options.map((id) => [id, WAGES.framework(id).short])}
              />
            </fieldset>
          </div>
        ) : null}
      </div>
      {options.length <= 1 ? (
        <p className="text-[11.5px] text-ink-3 mt-2 leading-relaxed">
          {client?.name || 'This client'} is set up for the National Living Wage only.{' '}
          <Link to={`/clients/${w.clientId}?tab=rates`} className="text-accent no-underline hover:underline">
            Set up the real or London Living Wage on their Rates tab
          </Link>{' '}
          to quote this job under one.
        </p>
      ) : block && !denial ? (
        <p className="text-[11.5px] text-ink-3 mt-2">{block}</p>
      ) : null}

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
    </div>
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
        Prices agreed with this client under the {target.short} are used where there are any; otherwise the
        published rate moves by the extra pay per hour, keeping the same margin.
        {sent ? ' The client has been sent this quote, so it will show as amended until you re-send it.' : ''}
      </p>
    </Modal>
  );
}
