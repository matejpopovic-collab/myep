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
import { MenuButton, type MenuEntry } from './Modal';
import { Pill } from './primitives';
import { useToast } from './Toast';
import { TONE_BG, TONE_HEX, TONE_LINE } from '@/lib/status';
import { money, type Timing } from '@/lib/format';
import { NOW, client as clientById, manager as managerById } from '@/data/db';
import * as C from '@/lib/classification';
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
        /* What the current tile says under its name.
           "Current stage" is true and useless on a job that is stuck: a signed
           quote sitting on Client sign-off because the yard is two buggies
           short reads, at a glance, as a client who has not signed. So the
           tile says what the stage is actually waiting for — the signature
           when it is the signature, and plainly held when the job has done its
           part and something downstream is refusing. */
        const sub = !now
          ? null
          : s.id === 'signoff' && wof.signoff
            ? blocked
              ? 'Signed — held here'
              : 'Signed'
            : blocked
              ? 'Held here'
              : 'Current stage';
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
              {sub && !compact ? <div className="text-[10.5px] text-ink-3 mt-0.5">{sub}</div> : null}
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
/**
 * The Master Calendar's classification, on a WOF row.
 *
 * Nothing at all before the job has been quoted — see `wofScale`. In a table
 * that absence has to hold its cell open, so it reads as an em dash; anywhere
 * the pill sits in a row of other pills, `dash={false}` drops it entirely
 * rather than leaving a stray dash among them. A short
 * label ("Tier 1") rather than the full band name, because this sits in a
 * table column beside eight others and "Tier 1 – Major" wraps; the full name
 * and the figures behind it are in the tooltip.
 */
export function TierPill({
  wof,
  full = false,
  dash = true,
}: { wof: W.Wof; full?: boolean; dash?: boolean }) {
  const v = C.wofScale(wof);
  if (!v) return dash ? <span className="text-[12.5px] text-ink-3">—</span> : null;
  const long = C.SCALE_LABEL[v.scale];
  return (
    <Pill
      label={full ? long : long.split(' – ')[0]}
      tone={C.scaleTone(v.scale)}
      hint={`${long} · ${v.hint}`}
      variant="quiet"
    />
  );
}

/* ------------------------------------------------------------ tier menu -- */

/**
 * The band list every tier control offers, in one place.
 *
 * The tier can be corrected on a work order (before the order, where the
 * reading comes off the quote) and on an event (after it, where it comes off
 * the staffing plan). Those write to two different stores and fall back to two
 * different computed figures, but they must offer the SAME six bands in the
 * same order with the same wording — a key that reads differently depending on
 * which screen you opened is not a key. So the menu is built here and the
 * differences are passed in.
 *
 * `computed` leads, and it names the band it would fall back to: clearing an
 * override has to be a choice with a visible result rather than an empty
 * option. It is disabled when nothing is overridden, because there is nothing
 * to clear and offering it would imply there were.
 */
export function tierMenuItems({
  manual,
  computed,
  computedHint,
  denial,
  onPick,
}: {
  /** The band currently set by hand, or null when running on the computed one. */
  manual: C.EventScale | null;
  /** What the figures say, shown whether or not it is in force. */
  computed: C.EventScale;
  /** Where those figures came from, for the hint. */
  computedHint: string;
  /** Why this person may not change it, or null. */
  denial: string | null;
  onPick: (next: C.EventScale | null) => void;
}): MenuEntry[] {
  const band = (sc: C.EventScale): MenuEntry => ({
    label: C.SCALE_LABEL[sc],
    hint: denial || C.SCALE_DESCRIPTION[sc],
    badge: sc === manual ? 'Set' : undefined,
    disabled: !!denial,
    onSelect: () => onPick(sc),
  });

  return [
    {
      label: `Computed — ${C.SCALE_LABEL[computed]}`,
      icon: 'refresh',
      hint: denial || (manual ? `Clears the hand-set tier. ${computedHint}.` : `In force. ${computedHint}.`),
      badge: manual ? undefined : 'In force',
      disabled: !!denial || !manual,
      onSelect: () => onPick(null),
    },
    '-',
    // Biggest first, the same order as the pipeline filter and the legend.
    ...[...C.AUTO_SCALES].reverse().map((sc) => band(sc)),
    '-',
    ...C.MANUAL_ONLY_SCALES.map((sc) => band(sc)),
  ];
}

/** The pill-as-trigger every tier control uses, so the two look identical. */
export function TierTrigger({
  scale,
  label,
  items,
}: { scale: C.EventScale; label: string; items: MenuEntry[] }) {
  return (
    <MenuButton
      label={label}
      align="left"
      className="bg-transparent border-0 p-0 cursor-pointer inline-flex items-center gap-1 align-middle"
      items={items}
    >
      <Pill label={C.SCALE_LABEL[scale]} tone={C.scaleTone(scale)} hint={false} variant="quiet" />
      <Icon name="chevronDown" decorative className="icon-sm text-ink-3" />
    </MenuButton>
  );
}

/**
 * The tier on a work order, correctable until the job is ordered.
 *
 * After the order the EVENT holds the classification — `W.setScaleOverride`
 * refuses to write a second copy — so this degrades to a read-only pill that
 * says where the control now lives rather than offering one that would fail.
 *
 * A job with no priced lines and no hand-set tier has no tier at all, and the
 * control still renders: "not yet quoted" is the state a planner is most likely
 * to want to correct, since a day-to-day activity may never be priced.
 */
export function WofTierControl({ wof }: { wof: W.Wof }) {
  const toast = useToast();
  const view = C.wofScale(wof);
  const manual = C.wofManualScale(wof);
  const locked = !!wof.eventId;
  const auto = C.assessWofScale(wof);
  const why = ROLES.denial('wof.edit');

  if (locked) {
    return view ? <TierPill wof={wof} /> : null;
  }

  const computed = auto?.auto ?? 'minimal';
  const computedHint = auto
    ? `Peak ${auto.peakStaff} staff on any one day, from the quote`
    : 'Nothing priced yet, so there is nothing to read a band from';

  const items = tierMenuItems({
    manual,
    computed,
    computedHint,
    denial: why,
    onPick: (next) => {
      if (!W.setScaleOverride(wof, next)) return;
      toast(
        next
          ? `Tier set by hand to ${C.SCALE_LABEL[next]}.`
          : auto
            ? `Tier back to the computed figure — ${C.SCALE_LABEL[computed]}.`
            : 'Tier cleared. Nothing is priced yet, so the job has no tier.',
        { tone: 'healthy' },
      );
    },
  });

  // Nothing priced and nothing set by hand: there is no band to show, but the
  // control still has to be reachable, so the trigger is the em dash itself.
  if (!view) {
    return (
      <MenuButton
        label="No tier yet. Set how this job is classified."
        align="left"
        className="bg-transparent border-0 p-0 cursor-pointer inline-flex items-center gap-1 align-middle"
        items={items}
      >
        <span className="text-[12.5px] text-ink-3">No tier</span>
        <Icon name="chevronDown" decorative className="icon-sm text-ink-3" />
      </MenuButton>
    );
  }

  return (
    <TierTrigger
      scale={view.scale}
      label={`Tier: ${C.SCALE_LABEL[view.scale]}. Change how this job is classified.`}
      items={items}
    />
  );
}

/**
 * When the job runs, as a pill.
 *
 * Timing is usually a classification — "Next week", "Ended 4 days ago" — and
 * belongs in the quiet variant beside the tier, so the only filled pill on a
 * card is the one asking to be dealt with. But timing turns into a state at
 * the sharp end: "Live now" and "Starts today" are the reason someone opened
 * the board. So the variant follows the tone rather than the field: neutral
 * and info go quiet, atRisk and critical stay filled.
 */
export function TimingPill({
  t,
  status,
  hint = false,
}: { t: Timing; status?: string; hint?: string | false }) {
  const quiet = t.tone === 'neutral' || t.tone === 'info';
  return (
    <Pill
      status={status}
      label={t.label}
      tone={t.tone}
      hint={hint}
      variant={quiet ? 'quiet' : 'solid'}
    />
  );
}

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
