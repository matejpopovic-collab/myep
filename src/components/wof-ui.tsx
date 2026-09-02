/* ============================================================================
   EPROSTA — shared WOF presentation
   ----------------------------------------------------------------------------
   Rendering that more than one screen needs. Keeping it here means a WOF looks
   and reads the same on the pipeline, the calendar, the reports and its own
   detail page — the briefing's whole complaint about EPROSTA today is that the
   same job looks different in three systems.
   ========================================================================== */

import { Link } from 'react-router-dom';
import { Icon } from './Icon';
import { Pill } from './primitives';
import { TONE_BG, TONE_HEX, TONE_LINE } from '@/lib/status';
import { money } from '@/lib/format';
import { NOW, client as clientById, manager as managerById } from '@/data/db';
import * as CHARGES_LIB from '@/lib/charges';
import * as HOP from '@/lib/hop';
import * as RATES from '@/lib/rates';
import * as ROLES from '@/lib/roles';
import type { ChargeKind, Tone } from '@/data/types';
import * as W from '@/lib/wof';

export const STAGE_TONE: Record<string, Tone> = {
  wof: 'neutral', quote: 'info', signoff: 'atRisk', order: 'healthy',
  documents: 'info', picking: 'info', job: 'atRisk', invoice: 'info',
  complete: 'healthy', lost: 'neutral', cancelled: 'neutral',
};

export function StagePill({ wof }: { wof: W.Wof }) {
  const st = W.stage(wof.stage);
  const label = st
    ? `${st.n}. ${st.label}`
    : W.TERMINAL[wof.stage as W.TerminalId]?.label || wof.stage;
  return (
    <Pill
      status={wof.stage}
      label={label}
      tone={STAGE_TONE[wof.stage] || 'neutral'}
      hint={st ? st.blurb : 'This WOF has left the lifecycle.'}
    />
  );
}

/**
 * The eight-stage rail. The single most important piece of the new UI: it is
 * the picture of the business the briefing describes, and it tells an operator
 * at a glance where a job is and what is holding it up.
 */
export function StageRail({ wof, compact = false }: { wof: W.Wof; compact?: boolean }) {
  const cur = W.stageIndex(wof.stage);
  const done = W.isTerminal(wof.stage);
  const g = W.gate(wof);

  return (
    <ol className="flex items-stretch gap-1 overflow-x-auto" aria-label="WOF lifecycle stage">
      {W.STAGES.map((s, i) => {
        const past = done || i < cur;
        const now = !done && i === cur;
        const bg = past ? TONE_BG.healthy : now ? TONE_BG.info : TONE_BG.neutral;
        const fg = past ? TONE_HEX.healthy : now ? TONE_HEX.info : TONE_HEX.neutral;
        const bd = now ? 'var(--accent)' : 'transparent';
        const blocked = now && g.block.length > 0;
        const warned = now && !g.block.length && g.warn.length > 0;
        return (
          <li key={s.id} className="flex-1" style={{ minWidth: compact ? 78 : 104 }}>
            <div
              className={`rounded-lg px-2.5 py-2 h-full ${now ? 'shadow-card' : ''}`}
              style={{
                background: bg,
                border: `1px solid ${blocked ? TONE_HEX.critical : warned ? TONE_HEX.atRisk : bd}`,
              }}
              title={s.requirement}
            >
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="text-[10px] font-bold tabular-nums" style={{ color: fg }}>
                  {s.n}
                </span>
                {past && (
                  <span style={{ color: TONE_HEX.healthy }}>
                    <Icon name="check" decorative className="icon-sm" />
                  </span>
                )}
                {blocked && (
                  <span style={{ color: TONE_HEX.critical }}>
                    <Icon name="alert" decorative className="icon-sm" />
                  </span>
                )}
                {warned && (
                  <span style={{ color: TONE_HEX.atRisk }}>
                    <Icon name="alert" decorative className="icon-sm" />
                  </span>
                )}
              </div>
              <div
                className="text-[11.5px] font-semibold leading-tight"
                style={{ color: now || past ? 'var(--ink)' : fg }}
              >
                {compact ? s.short : s.label}
              </div>
              {now && !compact ? (
                <div className="text-[10.5px] text-ink-3 mt-0.5">Current stage</div>
              ) : null}
            </div>
          </li>
        );
      })}
      {done ? (
        <li className="flex-1" style={{ minWidth: 90 }}>
          <div className="rounded-lg px-2.5 py-2 h-full" style={{ background: TONE_BG.healthy }}>
            <div className="text-[11.5px] font-semibold text-ink leading-tight">
              {W.TERMINAL[wof.stage as W.TerminalId]?.label || wof.stage}
            </div>
          </div>
        </li>
      ) : null}
    </ol>
  );
}

/** Warnings/blocks for the current gate, rendered as a banner. */
export function GateBanner({ wof }: { wof: W.Wof }) {
  const g = W.gate(wof);
  if (!g.block.length && !g.warn.length) return null;
  const tone: Tone = g.block.length ? 'critical' : 'atRisk';
  const items = g.block.map((m) => ({ m, hard: true })).concat(g.warn.map((m) => ({ m, hard: false })));
  const targetLabel = W.stage(g.target as string)?.label || g.target;

  return (
    <div className="card p-3.5 mb-4" style={{ borderColor: TONE_LINE[tone], background: TONE_BG[tone] }}>
      <div className="flex items-start gap-2.5">
        <span style={{ color: TONE_HEX[tone], marginTop: 1 }}>
          <Icon name="alert" decorative />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-ink mb-1">
            {g.block.length
              ? `Cannot move to ${targetLabel} yet`
              : `Can move to ${targetLabel}, with ${items.length} thing${items.length > 1 ? 's' : ''} to note`}
          </div>
          <ul className="text-[13px] text-ink-2 leading-relaxed space-y-0.5">
            {items.map((it, i) => (
              <li key={i}>· {it.m}</li>
            ))}
          </ul>
          {!g.block.length ? (
            <div className="text-[11.5px] text-ink-3 mt-1.5">
              Policy is to warn rather than block. Continuing is recorded against the WOF with your
              name on it.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Compact document roll-up, used on the pipeline, calendar and detail. */
export function DocChip({ wof }: { wof: W.Wof }) {
  const ds = W.docState(wof);
  if (!ds.total) return <span className="text-[12.5px] text-ink-3">No checklist</span>;
  // Say which kind of work is left, because "outstanding" sent operators to
  // chase clients for documents that were already sitting in our own queue.
  const label = ds.outstanding
    ? `${ds.outstanding} not received`
    : ds.awaitingReview
      ? `${ds.awaitingReview} to check`
      : ds.approved === ds.total
        ? 'All approved'
        : `${ds.approved}/${ds.total} approved`;
  return (
    <Pill
      status="docs"
      label={label}
      tone={ds.tone}
      hint={
        ds.blocking
          ? `${ds.blocking} of them mandatory`
          : ds.outstanding && ds.awaitingReview
            ? `${ds.awaitingReview} more already with us to check`
            : `${ds.approved} of ${ds.total} approved`
      }
    />
  );
}

/** Money delta with sign colour — used for margin. */
export function MarginPill({ wof }: { wof: W.Wof }) {
  const m = W.margin(wof);
  const p = W.marginPct(wof);
  const tone: Tone = p >= 30 ? 'healthy' : p >= 15 ? 'atRisk' : 'critical';
  return (
    <span className="tabular-nums font-semibold" style={{ color: TONE_HEX[tone] }}>
      {money(m, { pence: false })}{' '}
      <span className="text-[11.5px] font-medium opacity-80">({p}%)</span>
    </span>
  );
}

/* ------------------------------------------------------------------ people */

export function ManagerChip({ id, size = 22 }: { id: string | null | undefined; size?: number }) {
  const m = managerById(id);
  if (!m) return <span className="text-ink-3 text-[12.5px]">Unassigned</span>;
  return (
    <span
      className="inline-flex items-center gap-1.5 tip max-w-full min-w-0 align-bottom"
      tabIndex={0}
      data-tip={`${m.role} — ${m.owns}`}
    >
      <span
        className="avatar flex-none"
        aria-hidden="true"
        style={
          {
            '--av-hue': `${m.hue}deg`,
            width: size,
            height: size,
            fontSize: Math.round(size * 0.4),
          } as React.CSSProperties
        }
      >
        {m.initials}
      </span>
      <span className="text-[12.5px] text-ink-2 min-w-0 truncate">{m.name}</span>
    </span>
  );
}

/**
 * The client's name, linked to their record for anyone who may open it.
 *
 * A role without `clients.view` still needs to read the name — it is on the
 * calendar and on the kit list, and a job with no client on it is harder to
 * place than one with no link. So the name stays and the link goes: a link the
 * route guard would bounce is a broken link, and users read broken links as a
 * broken app rather than as a permission they do not have.
 */
export function ClientLink({ id }: { id: string | null | undefined }) {
  const c = clientById(id);
  if (!c) return <>—</>;
  if (!ROLES.can('clients.view')) return <span className="text-[13px] text-ink-2">{c.name}</span>;
  return (
    <Link to={`/clients?id=${c.id}`} className="text-[13px] text-ink-2 no-underline hover:text-ink hover:underline">
      {c.name}
    </Link>
  );
}

export function WofLink({ wof, showTitle = true }: { wof: W.Wof | null | undefined; showTitle?: boolean }) {
  if (!wof) return <span className="text-ink-3">—</span>;
  return (
    <Link to={`/wofs/${wof.id}`} className="no-underline">
      <span className="font-mono text-[12px] text-accent">{wof.ref}</span>
      {showTitle ? <span className="block text-[13px] text-ink">{wof.title}</span> : null}
    </Link>
  );
}

/* ---------------------------------------------------------------- controls */

/**
 * Rate-card picker used by the quote builder and the variation dialog.
 *
 * `clientId` is what the account PAYS, and the price shown is theirs — their
 * agreed price, or their card, or the published rate, in that order. Without
 * it the picker would offer a price the line it creates does not use, which is
 * a menu with the wrong prices on it. Optional only because a caller with no
 * account in hand is a real case; when it is absent the published rate is
 * shown, which is then also the rate that would be charged.
 */
export function ChargePicker({
  value,
  onChange,
  kindFilter,
  clientId,
  id,
}: {
  value: string;
  onChange: (chargeId: string) => void;
  kindFilter?: ChargeKind;
  clientId?: string | null;
  id?: string;
}) {
  const groups = (
    [
      { kind: 'staff' as ChargeKind, label: 'Staff (charged per person per hour)' },
      { kind: 'kit' as ChargeKind, label: 'Kit (charged per item per day)' },
      { kind: 'service' as ChargeKind, label: 'Services' },
    ] as const
  ).filter((g) => !kindFilter || kindFilter === g.kind);

  return (
    <select id={id} className="field" value={value} onChange={(e) => onChange(e.target.value)}>
      {groups.map((g) => (
        <optgroup key={g.kind} label={g.label}>
          {/* `quotable()`, not `CHARGES` — a retired line is still on every job
              that used it and still resolves everywhere it is read, but it is
              not offered on anything new. That is the whole difference between
              retiring and deleting.

              Replacement charges are excluded for a different reason. They are
              real rate-card rows and they price a real event, but the event is
              "it did not come back", raised as a variation by the warehouse
              check-in. Offered here they read as ordinary kit and get sold as
              it — a hire line that draws no stock, can never be short, and can
              never itself be recharged, because a replacement has no
              replacement. `kitCharges()` already keeps them off the register;
              this is the same set, kept off the quote. */}
          {CHARGES_LIB.quotable()
            .filter((c) => c.kind === g.kind && !HOP.isReplacementCharge(c.id))
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} — {money(RATES.rateFor(c.id, clientId, NOW)?.charge ?? c.charge)}/{c.unit}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}
