/* ============================================================================
   WOF DETAIL — the central document of the business
   ----------------------------------------------------------------------------
   One record, seven tabs, one stage rail across the top. Every stage of the
   briefing's §2.2 lifecycle is driveable from here, and every action writes to
   the history so there is an audit trail of who moved what and past which
   warning.

   The tabs deliberately mirror the lifecycle rather than the database:
     Overview   — where is this job and what is holding it up
     Quote      — pricing from the table of charges, plus variations
     Documents  — the configurable checklist for this job type
     Picking    — kit to the warehouse via EP HOP, staff via the staffing tool
     Timesheets — hours worked, which is both payroll input and actual cost
     Invoice    — billed net of deposit
     History    — the audit trail
   ========================================================================== */

import { Fragment, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import {
  Avatar, CoverageBar, EmptyState, Kpi, PageHeader, Pill, Provenance, Section,
} from '@/components/primitives';
import { DataTable, type Column } from '@/components/DataTable';
import { ConfirmDestructive, MenuButton, Modal, type MenuEntry } from '@/components/Modal';
import { GateBanner, ManagerChip, MarginPill, STAGE_TONE, StageRail } from '@/components/wof-ui';
import { useToast } from '@/components/Toast';
import { TONE_BG, TONE_HEX, TONE_LINE } from '@/lib/status';
import { coverageTone, eventCoverage } from '@/lib/coverage';
import { addDays, countLabel, fmtDate, fmtDateFull, fmtRange, fmtTime, money, round2, timing } from '@/lib/format';
import {
  NOW, charge as chargeById, client as clientById, employee as employeeById,
  event as eventById, jobType, manager as managerById, schedule as scheduleById,
} from '@/data/db';
import type { Tone } from '@/data/types';
import * as W from '@/lib/wof';
import * as DOC from '@/lib/quotedoc';
import * as ROLES from '@/lib/roles';
import * as HOP from '@/lib/hop';
import { useRolesVersion, useWofVersion } from '@/lib/useStore';
import {
  AddLineDialog, AdvanceDialog, DeleteWofDialog, DepositDialog, EventInfoDialog,
  QuoteApprovalDialog, RevertStageDialog, SignDialog, StaffingEventDialog,
} from './wof/dialogs';
import {
  CloneDeploymentsDialog, CopyDeploymentDialog, DeploymentDialog,
} from './wof/DeploymentDialog';

type TabId = 'overview' | 'quote' | 'documents' | 'picking' | 'timesheets' | 'invoice' | 'history';

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'quote', label: 'Quote & variations' },
  { id: 'documents', label: 'Documents' },
  { id: 'picking', label: 'Picking & packing' },
  { id: 'timesheets', label: 'Timesheets' },
  { id: 'invoice', label: 'Invoice' },
  { id: 'history', label: 'History' },
];

type Dialog =
  | { kind: 'advance' }
  | { kind: 'revert' }
  | { kind: 'addLine'; source: 'quote' | 'variation' }
  | { kind: 'addDeployment' }
  | { kind: 'copyDeployment'; deploymentKey: string }
  | { kind: 'cloneDeployments' }
  | { kind: 'eventInfo' }
  | { kind: 'sign' }
  | { kind: 'deposit' }
  | { kind: 'removeLine'; line: W.LineItem }
  | { kind: 'hireWindow'; line: W.LineItem }
  | { kind: 'staffingEvent' }
  | { kind: 'quoteApproval'; mode: 'request' | 'approve' | 'refuse'; override?: boolean }
  | { kind: 'delete' }
  | null;

/**
 * Which permission the NEXT stage needs. Named stages only — everything else on
 * the pipeline is ordinary delivery work and takes `wof.edit`, so adding a
 * stage cannot accidentally create an ungated commercial decision.
 */
function stageCap(next: string): ROLES.Capability {
  if (next === 'cancelled' || next === 'lost') return 'wof.cancel';
  if (next === 'quote' || next === 'signoff') return 'wof.quote';
  if (next === 'order') return 'wof.confirm';
  return 'wof.edit';
}

/* Shared little row used by several cards. */
function Row({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 border-b border-surface-line-soft last:border-0">
      <span className="text-[12.5px] text-ink-3 flex-none">{label}</span>
      {/* min-w-0 lets the value shrink instead of forcing the row (and the whole
          page) wider; break-words wraps long unbroken values like emails. */}
      <span className="text-[13px] text-ink-2 text-right min-w-0 break-words">{value}</span>
    </div>
  );
}

function TotalRow({
  label,
  value,
  tone,
  bold,
}: {
  label: string;
  value: number;
  tone?: Tone | null;
  bold?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-8">
      <span className={`text-[12.5px] ${bold ? 'text-ink font-semibold' : 'text-ink-3'}`}>{label}</span>
      <span
        className={`tabular-nums ${bold ? 'text-[15px] font-bold' : 'text-[13px]'}`}
        style={{ color: tone ? TONE_HEX[tone] : 'var(--ink)' }}
      >
        {money(value, { pence: false })}
      </span>
    </div>
  );
}

const marginTone = (p: number): Tone => (p >= 30 ? 'healthy' : p >= 15 ? 'atRisk' : 'critical');

export default function WofDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  useWofVersion();
  // The approval card asks who is signed in and what their role may do, so a
  // persona switch has to redraw this page as well as the sidebar.
  useRolesVersion();

  const w = W.byId(id) || W.all()[0];
  const [tab, setTab] = useState<TabId>(() => {
    const h = window.location.hash.replace('#', '');
    return (TABS.some((t) => t.id === h) ? h : 'overview') as TabId;
  });
  const [dialog, setDialog] = useState<Dialog>(null);

  if (!w) {
    return (
      <EmptyState
        iconName="fileText"
        title="Work order not found"
        body="That reference does not exist, or the demo data has been reset."
        action={
          <Link className="btn btn-primary" to="/wofs">
            Back to the pipeline
          </Link>
        }
      />
    );
  }

  const client = clientById(w.clientId)!;
  const g = W.gate(w);
  const next = W.nextStage(w);
  const t = timing(w.start, w.end);
  const ds = W.docState(w);
  const dep = W.deposit(w);
  const revert = W.revertPreview(w);
  const revertTo = revert ? (W.stage(revert.to)?.label ?? revert.to) : null;
  const del = W.deletable(w);

  const moreItems: MenuEntry[] = [
    {
      label: 'Record deposit received', icon: 'checkCircle',
      disabled: dep.due <= 0 || dep.received > 0,
      hint: dep.due <= 0 ? 'No deposit due on this job' : dep.received > 0 ? 'Already received' : '',
      onSelect: () => setDialog({ kind: 'deposit' }),
    },
    {
      label: 'Record client signature', icon: 'edit',
      disabled: !!w.signoff,
      hint: w.signoff ? `Signed by ${w.signoff.signedBy}` : '',
      onSelect: () => setDialog({ kind: 'sign' }),
    },
    {
      label: w.picking ? 'Re-send kit list to EP HOP' : 'Send kit list to EP HOP',
      icon: 'externalLink',
      /* Same rule as the Picking tab: no kit quoted, nothing to send. */
      disabled: !w.picking && W.kitLines(w).length === 0,
      hint: w.picking
        ? `Keeps reference ${w.picking.epHopRef} and raises its version`
        : W.kitLines(w).length === 0
          ? 'No kit quoted on this job yet'
          : 'Assigns an EP HOP reference and puts the job in the warehouse queue',
      onSelect: () => {
        const first = !w.picking;
        const n = W.kitChangesSincePush(w).length;
        const p = W.sendToHop(w);
        toast(
          first
            ? `Kit list sent to EP HOP as ${p.epHopRef}.`
            : `${p.epHopRef} updated to v${p.version}${n ? ` — ${countLabel(n, 'change')} sent.` : ' — unchanged.'}`,
          { tone: 'healthy' },
        );
      },
    },
    {
      /* Only offered once the job is committed work, and only while the link is
         missing. Before Order there is nothing to staff; after it, an unlinked
         event is a job the client cannot see. */
      label: 'Create staffing event',
      icon: 'events',
      disabled: !W.atLeast(w, 'order') || !!w.eventId,
      hint: w.eventId
        ? 'Already linked to a staffing event'
        : !W.atLeast(w, 'order')
          ? 'Confirm the order first — nothing is committed to staff yet'
          : `${client?.name || 'The client'} cannot see this job until it has one`,
      onSelect: () => setDialog({ kind: 'staffingEvent' }),
    },
    '-',
    {
      label: revertTo ? `Step back to ${revertTo}` : 'Step back a stage',
      icon: 'chevronLeft',
      disabled: !revertTo,
      hint: revertTo
        ? 'Correct a stage that was moved by mistake. Requires a reason.'
        : 'This WOF is at the first stage — there is nowhere to step back to.',
      onSelect: () => setDialog({ kind: 'revert' }),
    },
    {
      /* Deleting is gated on `wof.cancel` — the same permission as taking a job
         out of the pipeline, because it is the same decision taken further. It
         sits below the separator with Step back, away from the delivery actions
         above it, and it is the only red thing in the menu. */
      label: 'Delete this job',
      icon: 'trash',
      danger: true,
      disabled: !del.ok || !!ROLES.denial('wof.cancel'),
      hint: ROLES.denial('wof.cancel') || (del.ok
        ? 'Removes the job and everything it owns. No undo.'
        : del.reason),
      onSelect: () => setDialog({ kind: 'delete' }),
    },
  ];

  const badge = (tabId: TabId) => {
    if (tabId === 'documents' && ds.outstanding) {
      return (
        <span
          className="pill ml-1"
          style={{ background: TONE_BG[ds.tone], color: TONE_HEX[ds.tone], padding: '0 6px', fontSize: 10.5 }}
        >
          {ds.outstanding}
        </span>
      );
    }
    if (tabId === 'quote' && W.variationLines(w).length) {
      return (
        <span
          className="pill ml-1"
          style={{ background: TONE_BG.atRisk, color: TONE_HEX.atRisk, padding: '0 6px', fontSize: 10.5 }}
        >
          +{W.variationLines(w).length}
        </span>
      );
    }
    return null;
  };

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'WOF pipeline', to: '/wofs' }, { label: w.ref }]}
        title={w.title}
        subtitle={
          <>
            <span className="font-mono text-[12.5px] text-accent">{w.ref}</span> · {client?.name} ·{' '}
            {w.venue || 'Venue not set'} · {fmtRange(w.start, w.end)}
          </>
        }
        actions={
          <>
            {w.eventId ? (
              <Link className="btn btn-secondary" to={`/events/${w.eventId}`}>
                <Icon name="events" decorative /> Open staffing
              </Link>
            ) : null}
            <MenuButton className="btn btn-secondary" label="More actions for this work order" items={moreItems} />
            {next ? (
              (() => {
                /* Advancing a WOF is not one permission — the stages it passes
                   through are different people's jobs. Pricing and issuing the
                   quote is the client manager's; turning a signed quote into
                   committed work is a commercial decision; cancelling a job with
                   staff on it is neither. So the gate is chosen by the stage
                   being entered, and the existing data gate (`g.block`) still
                   wins when it applies — a missing deposit is a better reason to
                   refuse than a missing permission. */
                const cap = stageCap(next);
                const why = ROLES.denial(cap);
                return (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={g.block.length > 0 || !!why}
                    title={g.block.length ? g.block[0] : why || undefined}
                    onClick={() => setDialog({ kind: 'advance' })}
                  >
                    <Icon name="chevronRight" decorative /> Move to{' '}
                    {W.stage(next)?.label || W.TERMINAL[next as W.TerminalId]?.label || next}
                  </button>
                );
              })()
            ) : null}
          </>
        }
      />

      <div className="card p-4 mb-4">
        <StageRail wof={w} />
      </div>

      <GateBanner wof={w} />

      <div className="flex flex-wrap gap-3 mb-5">
        <Kpi
          label="Contract value"
          value={money(W.contractValue(w), { pence: false })}
          sub={
            W.variationValue(w)
              ? `Quote ${money(W.quoteValue(w), { pence: false })} + ${money(W.variationValue(w), { pence: false })} in variations`
              : 'No variations raised'
          }
          tone="info"
        />
        <Kpi
          label="Cost to deliver"
          value={money(W.actualCost(w), { pence: false })}
          sub={
            W.timesheets(w).length
              ? `Staff at actual hours (${W.timesheets(w).length} timesheets), kit at cost price`
              : !W.hasStaffWork(w)
                ? 'Kit and services at cost price — no staff on this job'
                : 'Planned — no timesheets approved yet'
          }
          tone="neutral"
        />
        <Kpi
          label="Margin"
          value={money(W.margin(w), { pence: false })}
          sub={`${W.marginPct(w)}% of contract value`}
          tone={marginTone(W.marginPct(w))}
          to="/reports/costing"
          hint="Opens job costing across all jobs"
        />
        <Kpi label="Timing" value={t.label} sub={fmtRange(w.start, w.end)} tone={t.tone} />
      </div>

      <div className="sticky-sub mb-5">
        <div className="tabs" role="tablist">
          {TABS.map((x) => (
            <button
              key={x.id}
              type="button"
              className="tab"
              role="tab"
              aria-selected={tab === x.id}
              onClick={() => {
                setTab(x.id);
                window.history.replaceState({}, '', `#${x.id}`);
              }}
            >
              {x.label}
              {badge(x.id)}
            </button>
          ))}
        </div>
      </div>

      <div role="tabpanel">
        {tab === 'overview' ? <OverviewTab w={w} onDialog={setDialog} /> : null}
        {tab === 'quote' ? <QuoteTab w={w} onDialog={setDialog} /> : null}
        {tab === 'documents' ? <DocumentsTab w={w} /> : null}
        {tab === 'picking' ? <PickingTab w={w} /> : null}
        {tab === 'timesheets' ? <TimesheetsTab w={w} /> : null}
        {tab === 'invoice' ? <InvoiceTab w={w} /> : null}
        {tab === 'history' ? <HistoryTab w={w} /> : null}
      </div>

      {dialog?.kind === 'advance' ? <AdvanceDialog w={w} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'revert' ? <RevertStageDialog w={w} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'addLine' ? (
        <AddLineDialog w={w} kind={dialog.source} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'addDeployment' ? (
        <DeploymentDialog w={w} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'cloneDeployments' ? (
        <CloneDeploymentsDialog w={w} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'copyDeployment' ? (
        <CopyDeploymentDialog
          w={w}
          deploymentKey={dialog.deploymentKey}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'eventInfo' ? <EventInfoDialog w={w} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'sign' ? <SignDialog w={w} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'quoteApproval' ? (
        <QuoteApprovalDialog
          w={w}
          mode={dialog.mode}
          override={dialog.override}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'deposit' ? <DepositDialog w={w} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'staffingEvent' ? (
        <StaffingEventDialog w={w} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'delete' ? (
        /* Navigating away is the dialog's caller's job, not the dialog's: the
           list page deletes a row and stays put, this page is looking at a
           record that no longer exists and has to leave. */
        <DeleteWofDialog w={w} onClose={() => setDialog(null)} onDeleted={() => navigate('/wofs')} />
      ) : null}
      {dialog?.kind === 'hireWindow' ? (
        <HireWindowDialog w={w} line={dialog.line} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'removeLine' ? (
        <ConfirmDestructive
          title="Remove line"
          confirmLabel="Remove"
          onClose={() => setDialog(null)}
          onConfirm={() => {
            W.removeLine(w, dialog.line.id, ROLES.actingActor());
            toast('Line removed.');
          }}
          message={`Remove “${dialog.line.description}” worth ${money(W.lineValue(dialog.line))} from this WOF?`}
        />
      ) : null}
    </>
  );
}

/* ========================================================================== */
/* HIRE WINDOW                                                                */
/* ========================================================================== */

/**
 * Which days of the job a kit line is actually out.
 *
 * Days rather than dates, because that is what the line stores and what
 * `remapDay` understands — and because an operator reading a build-and-
 * breakdown schedule is already thinking in "day 3", not in the 16th. The
 * calendar date is shown beside each one so nobody has to count.
 *
 * Clearing is a first-class action, not an edge case: "the whole job" is the
 * default and the commonest answer, and making somebody re-derive the last day
 * number to get back to it would be a trap.
 */
export function HireWindowDialog({
  w, line, onClose,
}: { w: W.Wof; line: W.LineItem; onClose: () => void }) {
  const toast = useToast();
  const current = W.hireWindow(w, line);
  const [from, setFrom] = useState(current.from);
  const [to, setTo] = useState(current.to);

  const days = current.days;
  const span = Array.from({ length: days }, (_, i) => i + 1);
  const dateOf = (n: number) => fmtDate(addDays(w.start, n - 1));
  const chosen = Math.max(0, Math.min(to, days) - Math.max(from, 1) + 1);
  const whole = from === 1 && to === days;

  const apply = (window: { from: number; to: number } | null) => {
    W.setHire(w, line.id, window, ROLES.actingActor());
    toast(
      window && !(window.from === 1 && window.to === days)
        ? `${line.description} is on hire for ${countLabel(chosen, 'day')} — days ${window.from}–${window.to}.`
        : `${line.description} is on hire for the whole job.`,
      { tone: 'info' },
    );
    onClose();
  };

  return (
    <Modal
      title="Hire window"
      width={560}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={whole}
            title={whole ? 'Already the whole job' : undefined}
            onClick={() => apply(null)}
          >
            The whole job
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => apply({ from, to })}>
            Save
          </button>
        </>
      }
    >
      <p className="text-[13px] text-ink-2 leading-relaxed mb-3">
        <strong className="text-ink">{line.description}</strong> — which days of this {days}-day job the
        item is actually out. Charged per day, so this sets the number of days on the line as well as
        what the warehouse holds.
      </p>

      <div className="grid grid-cols-2 gap-3 mb-3">
        {([['From', from, setFrom], ['To', to, setTo]] as const).map(([label, value, set]) => (
          <label key={label} className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">{label}</span>
            <select
              className="field"
              value={value}
              onChange={(e) => {
                const n = Number(e.target.value);
                set(n);
                // Never let the window invert: an operator dragging the start
                // past the end means to move the window, not to empty it.
                if (label === 'From' && n > to) setTo(n);
                if (label === 'To' && n < from) setFrom(n);
              }}
            >
              {span.map((n) => (
                <option key={n} value={n}>
                  Day {n} — {dateOf(n)} ({W.dayKind(w, n)})
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <div
        className="rounded-lg p-3"
        style={{ background: TONE_BG.info, border: `1px solid ${TONE_LINE.info}` }}
      >
        <div className="text-[12.5px] text-ink">
          {countLabel(chosen, 'day')} on hire
          {whole ? ' — the whole job, which is the same as clearing the window' : ''}.
        </div>
        <div className="text-[11.5px] text-ink-3 mt-0.5 leading-relaxed">
          {line.qty.toLocaleString()} × {chosen} day{chosen === 1 ? '' : 's'} at{' '}
          {money(W.lineRate(line))} = {money(line.qty * chosen * W.lineRate(line), { pence: false })}.
        </div>
      </div>
    </Modal>
  );
}

/* ========================================================================== */
/* OVERVIEW                                                                   */
/* ========================================================================== */

function OverviewTab({ w, onDialog }: { w: W.Wof; onDialog: (d: Dialog) => void }) {
  const toast = useToast();
  const client = clientById(w.clientId)!;
  const dep = W.deposit(w);
  const ev = w.eventId ? eventById(w.eventId) : null;
  const cov = ev ? eventCoverage(ev) : null;
  const sch = w.scheduleId ? scheduleById(w.scheduleId) : null;
  const jt = jobType(w.jobTypeId);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2 space-y-4">
        {w.notes ? (
          <div className="card p-4">
            <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2">Notes</div>
            <p className="text-[13.5px] text-ink-2 leading-relaxed">{w.notes}</p>
          </div>
        ) : null}

        <div className="card p-4">
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-3">
            Where this job stands
          </div>
          <StageChecklist w={w} />
        </div>

        {!W.hasStaffWork(w) ? (
          <div className="card p-4">
            <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2">Staffing</div>
            <p className="text-[13px] text-ink-2 leading-relaxed">
              <strong className="text-ink">No staff on this job.</strong> Nothing on the quote needs people,
              so no shifts were created and there is no rota to fill.
            </p>
          </div>
        ) : ev && cov ? (
          <div className="card p-4">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1">Staffing</div>
                <p className="text-[12.5px] text-ink-3 leading-snug max-w-md">
                  Shifts were seeded into the staff allocation tool when this WOF became an order.
                </p>
              </div>
              <Link className="btn btn-secondary btn-sm" to={`/events/${ev.id}`}>
                Open staffing
              </Link>
            </div>
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="text-[24px] font-bold text-ink tabular-nums">
                {cov.filled}
                <span className="text-ink-3 text-[17px]">/{cov.required}</span>
              </span>
              <span className="text-[13px] text-ink-2">
                {cov.gap ? `${cov.gap} roles unfilled` : 'Fully covered'}
              </span>
            </div>
            <CoverageBar cov={cov} tone={coverageTone(cov, w.start, w.end)} height={8} />
          </div>
        ) : (
          <div className="card p-4">
            <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2">Staffing</div>
            <p className="text-[13px] text-ink-2 leading-relaxed">
              No shifts exist yet. A WOF seeds the event calendar and creates shifts in the staff allocation
              tool at the <strong className="text-ink">Order</strong> stage — that is, once the client has
              signed.
            </p>
          </div>
        )}
      </div>

      <div className="space-y-4">
        <div className="card p-4">
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-3">Client</div>
          <div className="text-[14px] font-semibold text-ink mb-0.5">{client.name}</div>
          <div className="text-[12.5px] text-ink-3 mb-3">
            {client.contact || 'No named contact'}
            {client.contactRole ? ` · ${client.contactRole}` : ''}
          </div>
          <Row label="Payment terms" value={`${client.termsDays} days`} />
          <Row label="Deposit policy" value={`${dep.pct}%`} />
          <Row label="Agreement" value={client.agreement || '—'} />
          <Row
            label="Billing email"
            value={client.billingEmail || <span className="text-ink-3">Not set</span>}
          />
          <Link className="btn btn-secondary btn-sm w-full mt-3" to={`/clients?id=${client.id}`}>
            Open client record
          </Link>
        </div>

        <div className="card p-4">
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-3">Money</div>
          <Row label="Quote" value={money(W.quoteValue(w), { pence: false })} />
          {W.variationValue(w) ? (
            <Row
              label="Variations"
              value={<span className="text-status-at-risk">+{money(W.variationValue(w), { pence: false })}</span>}
            />
          ) : null}
          <Row
            label="Contract value"
            value={<strong className="text-ink">{money(W.contractValue(w), { pence: false })}</strong>}
          />
          {dep.due > 0 ? (
            <Row
              label={`Deposit (${dep.pct}%)`}
              value={
                dep.received ? (
                  <span className="text-status-healthy">{money(dep.received, { pence: false })} received</span>
                ) : (
                  <span className="text-status-at-risk">{money(dep.due, { pence: false })} outstanding</span>
                )
              }
            />
          ) : null}
          <Row label="Balance" value={money(W.contractValue(w) - dep.due, { pence: false })} />
          <Row label="Cost to deliver" value={money(W.actualCost(w), { pence: false })} />
          <Row label="Margin" value={<MarginPill wof={w} />} />
          <Link className="btn btn-secondary btn-sm w-full mt-3" to="/reports/cashflow">
            Cash flow forecast
          </Link>
        </div>

        <div className="card p-4">
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3">Event info</div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => onDialog({ kind: 'eventInfo' })}>
              Edit
            </button>
          </div>
          <Row
            label="Job code"
            value={<span className="font-mono text-[12.5px] text-ink">{w.jobCode || w.ref}</span>}
          />
          <Row label="Manager" value={<ManagerChip id={w.ownerId} />} />
          <Row label="Department" value={w.departmentId || '—'} />
          {W.phaseSummary(w) ? <Row label="Event days" value={W.phaseSummary(w)!} /> : null}
          <Row label="Job type" value={jt ? jt.label : w.jobTypeId} />
          <Row label="Office" value={w.office} />
          <Row label="Venue" value={w.venue || '—'} />
          <Row
            label="Post code"
            value={
              w.postcode ? (
                <span className="font-mono text-[12.5px]">{w.postcode}</span>
              ) : (
                <span className="text-ink-3">Not set</span>
              )
            }
          />
          <Row
            label="Staff meeting point"
            value={w.staffMeetingPoint || <span className="text-ink-3">Not set</span>}
          />
          <Row label="Raised" value={fmtDateFull(w.raisedAt)} />
          {sch ? (
            <Row
              label="Schedule entry"
              value={
                <Link className="text-accent no-underline hover:underline" to={`/schedules?id=${sch.id}`}>
                  {sch.name}
                </Link>
              }
            />
          ) : null}
        </div>

        <VisibilityCard w={w} onChanged={toast} />
      </div>
    </div>
  );
}

/**
 * Worker visibility, stated as a sentence rather than a toggle.
 *
 * The live system pairs a "Hide from Staff Calendar" label with a control
 * reading "Visible" — a double negative an operator has to decode. Here the
 * card says what is actually true right now and why, because whether workers
 * can see a job is the thing that decides whether it gets staffed.
 */
function VisibilityCard({
  w,
  onChanged,
}: {
  w: W.Wof;
  onChanged: (m: string, o?: { tone?: Tone }) => void;
}) {
  const v = W.visibleToWorkers(w);
  const tone: Tone = v.visible ? 'healthy' : 'atRisk';

  return (
    <div className="card p-4">
      <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-3">Visible to workers</div>
      <div className="flex items-start gap-2.5 mb-3">
        <span style={{ color: TONE_HEX[tone], marginTop: 1 }}>
          <Icon name={v.visible ? 'checkCircle' : 'ban'} decorative />
        </span>
        <div className="flex-1">
          <div className="text-[13.5px] font-semibold text-ink">{v.visible ? 'Yes' : 'No'}</div>
          <div className="text-[12.5px] text-ink-2 leading-snug">{v.reason}</div>
        </div>
      </div>
      <label className="flex items-center gap-2.5 py-1.5 border-t border-surface-line-soft pt-3">
        <input
          type="checkbox"
          checked={w.staffCalendarVisible !== false}
          onChange={(e) => {
            w.staffCalendarVisible = e.target.checked;
            W.save();
            onChanged(
              e.target.checked
                ? 'Shifts will show on the staff calendar once this is an order.'
                : 'Hidden from the staff calendar. Staff by direct assignment only.',
              { tone: 'info' },
            );
          }}
        />
        <span className="text-[13px] text-ink-2">Show on the staff calendar</span>
      </label>
      <label className="flex items-center gap-2.5 py-1.5">
        <input
          type="checkbox"
          checked={w.active !== false}
          onChange={(e) => {
            w.active = e.target.checked;
            W.save();
            onChanged(
              e.target.checked ? 'Job marked active.' : 'Job marked inactive — hidden from workers.',
              { tone: e.target.checked ? 'healthy' : 'atRisk' },
            );
          }}
        />
        <span className="text-[13px] text-ink-2">Job is active</span>
      </label>
      {!W.atLeast(w, 'order') ? (
        <p className="text-[11.5px] text-ink-3 mt-2 leading-relaxed">
          Neither setting makes shifts visible before the job becomes an order. An unsigned job is never
          offered to workers.
        </p>
      ) : null}
    </div>
  );
}

/** Per-stage "is this done, and if not what is missing" list. */
function StageChecklist({ w }: { w: W.Wof }) {
  const cur = W.stageIndex(w.stage);
  const done = W.isTerminal(w.stage);
  const dep = W.deposit(w);
  const ds = W.docState(w);

  const detail = (sid: string): string => {
    switch (sid) {
      case 'wof':
        return `Raised ${fmtDate(w.raisedAt)} by ${managerById(w.raisedBy)?.name || '—'}.`;
      case 'quote':
        return w.quotedAt
          ? `Quote of ${money(W.quoteValue(w), { pence: false })} across ${W.quoteLines(w).length} lines, sent ${fmtDate(w.quotedAt)}.`
          : `${W.quoteLines(w).length} lines priced. Not yet sent.`;
      case 'signoff':
        return w.signoff
          ? `Signed by ${w.signoff.signedBy} on ${fmtDate(w.signoff.signedAt)} via ${w.signoff.method} (${w.signoff.ref}).`
          : "Awaiting the client's digital signature.";
      case 'order':
        return w.orderedAt
          ? `Confirmed ${fmtDate(w.orderedAt)}. ${
              dep.due > 0
                ? dep.received
                  ? `Deposit ${money(dep.received, { pence: false })} received.`
                  : `Deposit ${money(dep.due, { pence: false })} outstanding.`
                : "No deposit required under this client's terms."
            }`
          : 'Not yet confirmed as an order.';
      case 'documents':
        return ds.total
          ? `${ds.approved} of ${ds.total} approved${ds.outstanding ? `, ${ds.outstanding} not received${ds.blocking ? ` (${ds.blocking} mandatory)` : ''}` : ''}${ds.awaitingReview ? `, ${ds.awaitingReview} with us to check` : ''}.`
          : 'No checklist configured for this job type.';
      case 'picking':
        if (!w.picking)
          return w.kitPrep
            ? `${countLabel(w.kitPrep.manifest.length, 'kit line')} prepared on confirmation, not yet sent to EP HOP.`
            : 'Kit list not yet sent to the warehouse.';
        const pending = W.kitChangesSincePush(w).length;
        {
          // The live prep, not `picking.status` — that string was written when
          // the record was created and nothing could ever change it, so a job
          // nobody had touched still read "Picking in progress".
          const pr = HOP.prep(w.id);
          const where = pr
            ? `${HOP.PREP_META[pr.state].label.toLowerCase()}${HOP.isShort(pr) ? ', short on at least one line' : ''}`
            : 'with the warehouse';
          return `EP HOP ${w.picking.epHopRef}${(w.picking.version ?? 1) > 1 ? ` v${w.picking.version}` : ''} — ${where}, last synced ${fmtDate(w.picking.lastSyncAt)}.${pending ? ` ${countLabel(pending, 'change')} not yet re-sent.` : ''}`;
        }
      case 'job': {
        const ts = W.timesheets(w);
        return ts.length
          ? `${ts.length} timesheets approved, ${ts.reduce((s, x) => s + x.hours, 0).toFixed(1)} hours.`
          : 'No timesheets approved yet.';
      }
      case 'invoice':
        return w.invoice
          ? `${w.invoice.number} raised ${fmtDate(w.invoice.issuedAt)}, due ${fmtDate(w.invoice.dueAt)}${w.invoice.paidAt ? `, paid ${fmtDate(w.invoice.paidAt)}` : ''}.`
          : 'Not yet invoiced.';
      default:
        return '';
    }
  };

  return (
    <ol className="space-y-2">
      {W.STAGES.map((s, i) => {
        const past = done || i < cur;
        const now = !done && i === cur;
        return (
          <li key={s.id} className="flex items-start gap-2.5">
            <span
              className="mt-0.5 flex-none"
              style={{ color: past ? TONE_HEX.healthy : now ? TONE_HEX.info : 'var(--ink-3)' }}
            >
              <Icon name={past ? 'checkCircle' : now ? 'clock' : 'info'} decorative />
            </span>
            <div className="flex-1 min-w-0">
              <div className={`text-[13px] ${past || now ? 'text-ink font-medium' : 'text-ink-3'}`}>{s.label}</div>
              <div className="text-[12px] text-ink-3 leading-snug">{detail(s.id) || s.blurb}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ========================================================================== */
/* QUOTE                                                                      */
/* ========================================================================== */

/**
 * Where a high-value quote has got to with its approval.
 *
 * Above the "who can see this" card rather than inside it, because until this
 * is settled the question of what the client can see has one answer — nothing
 * — and burying that inside the send box is how a quote sits unnoticed for a
 * week waiting on a manager nobody told.
 */
function ApprovalCard({ w, onDialog }: { w: W.Wof; onDialog: (d: Dialog) => void }) {
  const state = W.quoteApprovalState(w);
  if (state === 'not-required') return null;

  const value = W.quoteValue(w);
  const actor = ROLES.actingActor();
  const approval = w.quoteApproval;
  const req = w.quoteApprovalRequest;
  const refusal = w.quoteApprovalRefusal;
  const client = clientById(w.clientId)?.name || 'the client';

  // Two different questions, deliberately kept apart: whether this person's
  // ROLE can approve, and whether this person can approve THIS quote. Someone
  // who priced it holds the capability and still cannot use it here.
  const held = ROLES.can('wof.approve');
  const block = W.approveQuoteBlock(w, actor);
  const canDecide = held && !block;
  // Asked twice: if setting the four-eyes rule aside clears the block, this is
  // a person whose only problem is that they touched the quote — and with no
  // eligible approver on the team that is a job with no move available. They
  // get the same two buttons, labelled as what they are, and the decision is
  // stamped as an override. A blocker the override cannot clear (under the
  // threshold, already approved, job closed) still shows no buttons, because
  // no amount of authority makes those into decisions.
  const overrideable = held && !!block && !W.approveQuoteBlock(w, actor, { override: true });
  const others = ROLES.approvers().filter(
    (m) => m.id !== actor.by && !W.quotePricedBy(w).includes(m.id),
  );
  const names = others.map((m) => m.name).join(' or ');

  const tone: Tone = state === 'approved' ? 'healthy' : state === 'refused' ? 'critical' : 'atRisk';
  const icon =
    state === 'approved' ? 'checkCircle' : state === 'requested' ? 'clock' : state === 'refused' ? 'ban' : 'alert';

  const title =
    state === 'approved'
      ? `Approved by ${approval!.byName} — ${money(approval!.value, { pence: false })}`
      : state === 'requested'
        ? `Sent for approval by ${req!.byName}`
        : state === 'lapsed'
          ? 'Approval lapsed — the quote has gone up since'
          : state === 'refused'
            ? `Sent back by ${refusal!.byName}`
            : "Needs a senior manager's approval";

  return (
    <div className="card p-3.5 mb-4" style={{ background: TONE_BG[tone], borderColor: TONE_LINE[tone] }}>
      <div className="flex items-start gap-3">
        <span style={{ color: TONE_HEX[tone], marginTop: 1 }}>
          <Icon name={icon} decorative />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-ink mb-1">{title}</div>
          <div className="text-[12.5px] text-ink-2 leading-relaxed">
            {state === 'approved' ? (
              <>
                Approved {fmtDate(approval!.at)}
                {approval!.note ? ` — “${approval!.note}”` : ''}. Take the quote above{' '}
                {money(approval!.value, { pence: false })} and it comes back for approval.
                {approval!.override
                  ? ' Approved by somebody who priced it — the four-eyes rule was overridden, and that is on the record.'
                  : ''}
              </>
            ) : state === 'requested' ? (
              <>
                {money(req!.value, { pence: false })}, sent up {fmtDate(req!.at)}
                {req!.note ? ` — “${req!.note}”` : ''}.{' '}
                {canDecide
                  ? 'You can approve it or send it back.'
                  : overrideable
                    ? // The buttons are right there, so "waiting on somebody else"
                      // would be the card arguing with itself. It still names who
                      // could decide it cleanly, because that is the better move
                      // when that person is available.
                      names
                      ? `${names} can sign it off cleanly, or you can decide it yourself.`
                      : 'Nobody else is left to approve it, so it is yours to decide.'
                    : names
                      ? `Waiting on ${names}. ${client} cannot see the job until it is approved.`
                      : `${client} cannot see the job until it is approved.`}
              </>
            ) : state === 'lapsed' ? (
              <>
                {approval!.byName} approved {money(approval!.value, { pence: false })} on{' '}
                {fmtDate(approval!.at)}. It now comes to {money(value, { pence: false })}, so the figure has
                to be approved again before it goes out.
              </>
            ) : state === 'refused' ? (
              <>
                “{refusal!.reason}” — {refusal!.byName}, {fmtDate(refusal!.at)}. Put it right and send it up
                again.
              </>
            ) : (
              <>
                {money(value, { pence: false })} is over the{' '}
                {money(W.QUOTE_APPROVAL_THRESHOLD, { pence: false })} approval threshold. A senior manager
                who did not price it has to approve the figure — {client} cannot see the job until they do.
              </>
            )}
          </div>
          {held && block && state !== 'approved' ? (
            <div className="text-[11.5px] text-ink-3 mt-1.5">
              {block}
              {overrideable
                ? ' Approving it yourself is allowed and recorded as an override, so the job is never stuck.'
                : ''}
            </div>
          ) : null}
        </div>

        <div className="shrink-0 flex items-center gap-2">
          {canDecide || overrideable ? (
            <>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => onDialog({ kind: 'quoteApproval', mode: 'refuse', override: overrideable })}
              >
                Send back
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => onDialog({ kind: 'quoteApproval', mode: 'approve', override: overrideable })}
              >
                <Icon name="checkCircle" decorative className="icon-sm" />{' '}
                {overrideable ? 'Approve anyway' : `Approve ${money(value, { pence: false })}`}
              </button>
            </>
          ) : state !== 'approved' && state !== 'requested' ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              {...ROLES.gate('wof.quote')}
              onClick={() => onDialog({ kind: 'quoteApproval', mode: 'request' })}
            >
              <Icon name="mail" decorative className="icon-sm" />{' '}
              {state === 'required' ? 'Send for approval' : 'Send for approval again'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The client has come back on the quote they were sent.
 *
 * Their words, verbatim, above everything else on the tab — a paraphrase in a
 * history entry is what turns "we said 80, not 100" into an argument nobody
 * can settle. It clears itself when EP Team issues them something newer.
 */
function ObjectionCard({ w }: { w: W.Wof }) {
  const raised = W.openObjection(w);
  if (!raised) return null;
  const { version, objection } = raised;

  return (
    <div className="card p-3.5 mb-4" style={{ background: TONE_BG.atRisk, borderColor: TONE_LINE.atRisk }}>
      <div className="flex items-start gap-3">
        <span style={{ color: TONE_HEX.atRisk, marginTop: 1 }}>
          <Icon name="alert" decorative />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-ink mb-1">
            {clientById(w.clientId)?.name || 'The client'} has queried {version.label}
          </div>
          <div className="text-[13px] text-ink-2 leading-relaxed mb-1.5">“{objection.note}”</div>
          <div className="text-[11.5px] text-ink-3">
            {objection.byName} · {fmtDateFull(objection.at)} · on the quote at{' '}
            {money(version.value, { pence: false })}
          </div>
          <div className="text-[12.5px] text-ink-2 leading-relaxed mt-2">
            Amend the lines and send it again. The query closes itself when they have a newer version —
            it does not need answering here.
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Whether the variations on this job are with the client, and the button that
 * puts them there.
 *
 * The same distinction the quote makes, one stage later: pricing is not
 * publishing. An extra steward typed at 4pm while somebody is still working
 * out whether it is chargeable is a working note, and it should not appear in
 * the client's portal as a change awaiting their approval.
 */
function VariationSendCard({ w }: { w: W.Wof }) {
  const toast = useToast();
  const vars = W.variationLines(w);
  if (!vars.length) return null;

  const unsent = W.unsentVariations(w);
  const withClient = W.clientVariations(w);
  const issued = W.latestIssued(w, 'variation');
  const block = W.variationSendBlock(w);

  const send = () => {
    const count = unsent.length;
    if (!W.sendVariations(w, ROLES.actingActor())) {
      toast(W.variationSendBlock(w) || 'The variations could not be sent.', { tone: 'critical' });
      return;
    }
    toast(
      `${countLabel(count, 'variation')} sent to ${clientById(w.clientId)?.name || 'the client'}. They can now accept or query ${count === 1 ? 'it' : 'them'}.`,
      { tone: 'healthy' },
    );
  };

  return (
    <div
      className="card p-3.5 mb-3"
      style={
        unsent.length
          ? { background: TONE_BG.atRisk, borderColor: TONE_LINE.atRisk }
          : { background: TONE_BG.healthy, borderColor: TONE_LINE.healthy }
      }
    >
      <div className="flex items-start gap-3">
        <span
          style={{ color: unsent.length ? TONE_HEX.atRisk : TONE_HEX.healthy, marginTop: 1 }}
        >
          <Icon name={unsent.length ? 'edit' : 'checkCircle'} decorative />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-ink mb-1">
            {unsent.length
              ? `${countLabel(unsent.length, 'variation')} not sent — only EP Team can see ${unsent.length === 1 ? 'it' : 'them'}`
              : `All variations are with the client${issued?.issuedAt ? ` — sent ${fmtDate(issued.issuedAt)}` : ''}`}
          </div>
          <div className="text-[12.5px] text-ink-2 leading-relaxed">
            {unsent.length ? (
              <>
                {unsent.map((l) => l.description).join(', ')} —{' '}
                {money(unsent.reduce((s, l) => s + W.lineValue(l), 0), { pence: false })}. Add as many as
                you need; nothing reaches {clientById(w.clientId)?.name || 'the client'} until you send.
                {withClient.length
                  ? ` ${countLabel(withClient.length, 'variation')} already with them.`
                  : ''}
              </>
            ) : (
              <>
                {clientById(w.clientId)?.name || 'The client'} can accept or query each line. Anything you
                add from here is held until you send again.
              </>
            )}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          {issued ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => DOC.openQuoteDocument(w, issued, { audience: 'ep' })}
            >
              <Icon name="download" decorative className="icon-sm" /> {issued.label}
            </button>
          ) : null}
          {unsent.length ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!!block || !!ROLES.denial('wof.quote')}
              title={block || ROLES.denial('wof.quote') || undefined}
              onClick={send}
            >
              <Icon name="mail" decorative className="icon-sm" /> Send to client
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function QuoteTab({ w, onDialog }: { w: W.Wof; onDialog: (d: Dialog) => void }) {
  const toast = useToast();
  // Patterned lines are shown by `DeploymentTable`, grouped as the client's own
  // sheet groups them. Everything else lands here in one list: kit, services
  // and anything quoted before deployments shipped. Kit is bought across the
  // whole event even when it was ordered for a particular car park, so it is
  // listed once here with the place as a caption, rather than banded inside
  // that car park's block where the same radios read as four separate orders.
  const quote = W.quoteLines(w).filter(W.isFlatLine);
  const vars = W.variationLines(w).filter(W.isFlatLine);
  const deployed = W.deployments(w).length;
  const stale = w.lines.filter(W.lineIsStale);
  const locked = !!w.signoff;
  const dep = W.deposit(w);

  const sent = W.quoteSent(w);
  const sendBlock = W.quoteSendBlock(w);
  const drift = W.quoteDrift(w);

  const send = () => {
    const resend = sent;
    if (!W.sendQuote(w)) {
      toast(W.quoteSendBlock(w) || 'The quote could not be sent.', { tone: 'critical' });
      return;
    }
    toast(
      resend
        ? `Re-sent to the client — they now see ${money(W.quoteValue(w), { pence: false })}.`
        : `Sent to the client. ${clientById(w.clientId)?.name || 'They'} can now see this job.`,
      { tone: 'healthy' },
    );
  };

  const withdraw = () => {
    if (!W.unsendQuote(w)) return;
    toast('Quote withdrawn. This job is no longer visible to the client.', { tone: 'info' });
  };

  return (
    <>
      {/* WHO CAN SEE THIS ------------------------------------------------
          Answered before the lines, because it changes what the lines mean:
          an unsent quote is a working document and a sent one is an offer
          somebody may be about to sign. */}
      <ObjectionCard w={w} />

      {!locked ? <ApprovalCard w={w} onDialog={onDialog} /> : null}

      {!locked ? (
        <div
          className="card p-3.5 mb-4"
          style={
            drift
              ? { background: TONE_BG.atRisk, borderColor: TONE_LINE.atRisk }
              : sent
                ? { background: TONE_BG.healthy, borderColor: TONE_LINE.healthy }
                : undefined
          }
        >
          <div className="flex items-start gap-3">
            <span style={{ color: drift ? TONE_HEX.atRisk : sent ? TONE_HEX.healthy : 'var(--ink-3)', marginTop: 1 }}>
              <Icon name={sent ? (drift ? 'alert' : 'checkCircle') : 'edit'} decorative />
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold text-ink mb-1">
                {drift
                  ? 'Amended since you sent it'
                  : sent
                    ? `Sent to the client ${fmtDate(w.quotedAt!)}`
                    : 'Not sent — only EP Team can see this'}
              </div>
              <div className="text-[12.5px] text-ink-2 leading-relaxed">
                {drift ? (
                  <>
                    The client is looking at {money(drift.sentValue, { pence: false })}. This quote now comes
                    to {money(drift.nowValue, { pence: false })} —{' '}
                    {[
                      drift.added.length
                        ? `${countLabel(drift.added.length, 'line')} added (${drift.added
                            .map((l) => l.description)
                            .join(', ')})`
                        : '',
                      drift.removed ? `${countLabel(drift.removed, 'line')} removed` : '',
                      drift.repriced ? 'a line repriced' : '',
                    ]
                      .filter(Boolean)
                      .join(', ')}
                    . Re-send so they are signing what you are quoting.
                  </>
                ) : sent ? (
                  <>
                    {clientById(w.clientId)?.name || 'The client'} can see this job and sign it for{' '}
                    {money(w.quotedValue ?? W.quoteValue(w), { pence: false })}. Any change you make here is
                    flagged until you re-send.
                  </>
                ) : (
                  <>
                    Price it over as many sittings as you need — nothing reaches{' '}
                    {clientById(w.clientId)?.name || 'the client'} until you send it, and the job does not
                    appear in their portal at all.
                  </>
                )}
              </div>
            </div>
            <div className="shrink-0 flex items-center gap-2">
              {sent ? (
                <button type="button" className="btn btn-secondary btn-sm" onClick={withdraw}>
                  Withdraw
                </button>
              ) : null}
              <button
                type="button"
                className={`btn btn-sm ${sent && !drift ? 'btn-secondary' : 'btn-primary'}`}
                disabled={!!sendBlock}
                title={sendBlock || undefined}
                onClick={send}
              >
                <Icon name="mail" decorative className="icon-sm" />{' '}
                {sent ? 'Re-send' : 'Send to client'}
              </button>
            </div>
          </div>
          {sendBlock ? <div className="text-[11.5px] text-ink-3 mt-2 pl-8">{sendBlock}</div> : null}
        </div>
      ) : null}

      {locked ? (
        <div className="card p-3.5 mb-4" style={{ background: TONE_BG.info, borderColor: TONE_LINE.info }}>
          <div className="flex items-start gap-2.5">
            <span style={{ color: TONE_HEX.info, marginTop: 1 }}>
              <Icon name="info" decorative />
            </span>
            <p className="text-[13px] text-ink-2 leading-relaxed flex-1">
              The client signed this quote on {fmtDate(w.signoff!.signedAt)}, so the original lines are
              locked. Anything added now is recorded as a <strong className="text-ink">variation</strong> —
              including kit and services added while the event is running — and is invoiced on top.
            </p>
          </div>
        </div>
      ) : null}

      {stale.length ? (
        <div className="card p-3.5 mb-4" style={{ background: TONE_BG.atRisk, borderColor: TONE_LINE.atRisk }}>
          <div className="flex items-start gap-2.5">
            <span style={{ color: TONE_HEX.atRisk, marginTop: 1 }}>
              <Icon name="alert" decorative />
            </span>
            <div className="flex-1">
              <p className="text-[13px] text-ink-2 leading-relaxed">
                {stale.length} line{stale.length > 1 ? 's were' : ' was'} priced on a rate that has since been
                superseded in the table of charges. They are deliberately{' '}
                <strong className="text-ink">held at the rate agreed with the client</strong> — a rate change
                never rewrites an existing job. Re-price a line only if you have agreed it, and it will be
                recorded in the history.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      <Section
        title="Quote"
        right={
          locked ? undefined : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => onDialog({ kind: 'addLine', source: 'quote' })}
              >
                <Icon name="plus" decorative className="icon-sm" /> Add line
              </button>
              {/* Staff are sold by the deployment, not the line: a place, the
                  windows worked there, and a headcount per day. Primary of the
                  two because on a festival it is most of the quote. */}
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => onDialog({ kind: 'addDeployment' })}
              >
                <Icon name="users" decorative className="icon-sm" /> Add deployment
              </button>
              {/* Offered only where there is something to copy. A button that
                  opens a dialog saying "nothing to copy" is a button that
                  wasted the click. */}
              {W.cloneSources(w).length ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => onDialog({ kind: 'cloneDeployments' })}
                  title="Copy the areas, places, patterns and headcounts from an earlier job for this client"
                >
                  <Icon name="copy" decorative className="icon-sm" /> Start from last year
                </button>
              ) : null}
            </div>
          )
        }
      />
      <DeploymentTable w={w} source="quote" onDialog={onDialog} />
      <LineTable
        w={w}
        lines={quote}
        locked={locked}
        caption={deployed ? 'Across the whole event' : undefined}
        emptyMsg={
          deployed
            ? 'No other lines. Kit, services and anything a deployment cannot describe lands here.'
            : 'No lines priced yet. Add a deployment for staff, or a line from the table of charges.'
        }
        onDialog={onDialog}
      />

      <Section
        title={`Variations${vars.length ? ` (${vars.length})` : ''}`}
        right={
          locked ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => onDialog({ kind: 'addLine', source: 'variation' })}
              >
                <Icon name="plus" decorative className="icon-sm" /> Add variation
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => onDialog({ kind: 'addDeployment' })}
              >
                <Icon name="users" decorative className="icon-sm" /> Add deployment
              </button>
            </div>
          ) : undefined
        }
      />
      {vars.length || W.deployments(w, 'variation').length ? (
        <>
          <VariationSendCard w={w} />
          <DeploymentTable w={w} source="variation" onDialog={onDialog} />
          {vars.length ? (
            <LineTable
              w={w}
              lines={vars}
              locked={false}
              caption={W.deployments(w, 'variation').length ? 'Across the whole event' : undefined}
              emptyMsg=""
              onDialog={onDialog}
            />
          ) : null}
        </>
      ) : (
        <div className="card p-4">
          <p className="text-[13px] text-ink-3 leading-relaxed">
            No variations. Anything added after sign-off — extra kit, extra staff, a late request from the
            client on site — lands here and is invoiced with the job.
          </p>
        </div>
      )}

      <div className="card p-4 mt-4">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="space-y-1.5 min-w-[220px]">
            <TotalRow label="Quote" value={W.quoteValue(w)} />
            {vars.length ? <TotalRow label="Variations" value={W.variationValue(w)} tone="atRisk" /> : null}
            <div className="h-px bg-surface-line my-1" />
            <TotalRow label="Contract value" value={W.contractValue(w)} bold />
            {dep.due > 0 ? <TotalRow label={`Less deposit (${dep.pct}%)`} value={-dep.due} /> : null}
            {dep.due > 0 ? (
              <TotalRow label="Balance on invoice" value={W.contractValue(w) - dep.due} bold />
            ) : null}
          </div>
          <div className="space-y-1.5 min-w-[220px]">
            <TotalRow label="Cost of sale" value={W.actualCost(w)} tone="neutral" />
            <TotalRow label="Margin" value={W.margin(w)} tone={marginTone(W.marginPct(w))} bold />
            <div className="text-[11.5px] text-ink-3">{W.marginPct(w)}% of contract value</div>
          </div>
          {!w.signoff && quote.length ? (
            <button type="button" className="btn btn-primary" onClick={() => onDialog({ kind: 'sign' })}>
              <Icon name="edit" decorative /> Record client signature
            </button>
          ) : null}
        </div>
      </div>

      <Provenance>
        Every line stores the rate that applied on the day it was priced. Editing the table of charges changes
        future quotes only — see Reference data → Table of charges for the version history behind each rate.
      </Provenance>
    </>
  );
}


/* ---------------------------------------------------------- deployments ---
   The quote's staff lines, grouped the way the client's own spreadsheet is:
   area, then place, then window. Days across, counts in the cells, and the
   sold totals on the right.

   Deliberately a different table from `LineTable`. A deployment is a
   two-dimensional fact - roles against windows, over days - and flattening it
   back into one row per line is what made the spreadsheet unreadable in the
   first place.                                                          --- */

export function DeploymentTable({
  w,
  source,
  onDialog,
}: {
  w: W.Wof;
  source: W.LineSource;
  onDialog: (d: Dialog) => void;
}) {
  // Kit is listed below, across the whole event, so a place that has kit and
  // nobody rostered to it has nothing to draw here. Filtered rather than
  // rendered empty: a band with a heading, no rows and a subtotal of nothing
  // is a place the reader goes looking for people at.
  const groups = W.deployments(w, source).filter((g) => g.columns.length);
  const locked = !!w.signoff && source === 'quote';
  if (!groups.length) return null;

  const dayNos = Array.from({ length: W.eventDays(w) }, (_, i) => i + 1);
  const spanWins = W.spanWindowsOf(w.start, w.end);
  const byArea: { area: string; groups: W.DeploymentView[] }[] = [];
  groups.forEach((g) => {
    const bucket = byArea.find((b) => b.area === g.area);
    if (bucket) bucket.groups.push(g);
    else byArea.push({ area: g.area, groups: [g] });
  });

  return (
    <div className="card mb-4 overflow-x-auto">
      <table className="w-full text-[12.5px]" style={{ borderCollapse: 'collapse', minWidth: 720 }}>
        <thead>
          <tr>
            <th className="text-left px-3 py-2 text-[9.5px] uppercase tracking-[0.11em] text-ink-3 font-semibold">
              Role
            </th>
            {dayNos.map((d) => {
              const kind = W.dayKind(w, d);
              const date = spanWins[d - 1]?.start;
              return (
                <th
                  key={d}
                  className="px-1 py-2 text-center text-[10px] tabular-nums font-semibold"
                  style={{
                    minWidth: 30,
                    color: kind === 'event' ? 'var(--ink-2)' : 'var(--ink-3)',
                    background: kind === 'event' ? 'var(--accent-soft)' : undefined,
                  }}
                  title={
                    date
                      ? `${date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} - ${kind}`
                      : `Day ${d}`
                  }
                >
                  {date ? date.getDate() : d}
                </th>
              );
            })}
            {['Shifts', 'Hours', 'Value'].map((x) => (
              <th
                key={x}
                className="text-right px-3 py-2 text-[9.5px] uppercase tracking-[0.11em] text-ink-3 font-semibold"
              >
                {x}
              </th>
            ))}
            <th style={{ width: 34 }} />
          </tr>
        </thead>
        <tbody>
          {byArea.map((bucket) => (
            <Fragment key={bucket.area}>
              <tr>
                <td
                  colSpan={dayNos.length + 5}
                  className="px-3 py-1.5 text-[9.5px] uppercase tracking-[0.14em] font-semibold"
                  style={{ background: 'var(--surface-high)', color: 'var(--ink-2)' }}
                >
                  {bucket.area}
                </td>
              </tr>
              {bucket.groups.map((g) => (
                <Fragment key={g.key}>
                  {g.columns.map((col) => (
                    <Fragment key={col.pattern.id}>
                      <tr>
                        <td
                          colSpan={dayNos.length + 5}
                          className="px-3 py-1 text-[11.5px] text-ink-2"
                          style={{ borderTop: '1px solid var(--surface-line-soft)' }}
                        >
                          <span className="font-medium">{g.placeName}</span>
                          <span className="text-ink-3 tabular-nums">
                            {' '}
                            · {col.window ? `${col.window.start}-${col.window.end}` : 'no window'}
                            {col.window ? ` · ${W.patternHours(col.window)}h` : ''}
                          </span>
                          {col.window && col.window.end <= col.window.start ? (
                            <Pill label="Nights" tone="info" hint="This window closes the following morning" />
                          ) : null}
                          {!locked ? (
                            <span className="ml-2 inline-flex align-middle gap-[2px]">
                              {dayNos.map((d) => {
                                const on = col.pattern.days.includes(d);
                                const kind = W.dayKind(w, d);
                                return (
                                  <button
                                    key={d}
                                    type="button"
                                    aria-pressed={on}
                                    aria-label={`Day ${d} for ${g.placeName}, ${col.window?.name || 'window'}`}
                                    title={`Day ${d} - ${kind}. Click to ${on ? 'remove' : 'add'}.`}
                                    onClick={() =>
                                      W.setPatternDays(
                                        w,
                                        col.pattern.id,
                                        on
                                          ? col.pattern.days.filter((x) => x !== d)
                                          : [...col.pattern.days, d],
                                        ROLES.actingActor(),
                                      )
                                    }
                                    style={{
                                      width: 9,
                                      height: 12,
                                      padding: 0,
                                      borderRadius: 2,
                                      border: '1px solid',
                                      borderColor: on ? 'transparent' : 'var(--surface-line)',
                                      background: on
                                        ? kind === 'build'
                                          ? TONE_HEX.atRisk
                                          : kind === 'break'
                                            ? 'var(--ink-3)'
                                            : 'var(--accent)'
                                        : 'var(--well)',
                                    }}
                                  />
                                );
                              })}
                            </span>
                          ) : null}
                        </td>
                      </tr>
                      {col.lines.map((l) => (
                        <tr key={l.id} style={{ borderTop: '1px solid var(--surface-line-soft)' }}>
                          <td className="pl-6 pr-3 py-1.5 text-ink whitespace-nowrap">{l.description}</td>
                          {dayNos.map((d) => (
                            <HeadcountCell key={d} w={w} line={l} day={d} editable={!locked} />
                          ))}
                          <td className="px-3 py-1.5 text-right tabular-nums text-ink-2">
                            {W.lineShifts(w, l)}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-ink-2">
                            {W.lineHours(w, l)}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-ink font-semibold">
                            {money(W.lineValue(l), { pence: false })}
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            {!locked ? (
                              <button
                                type="button"
                                className="icon-btn"
                                aria-label={`Remove ${l.description}`}
                                onClick={() => onDialog({ kind: 'removeLine', line: l })}
                              >
                                <Icon name="trash" decorative className="icon-sm" />
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                  <tr style={{ borderTop: '1px solid var(--surface-line)' }}>
                    <td
                      colSpan={dayNos.length + 1}
                      className="px-3 py-1.5 text-right text-[9.5px] uppercase tracking-[0.11em] text-ink-3 font-semibold"
                    >
                      {g.placeName}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums font-semibold text-ink">{g.shifts}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums font-semibold text-ink">{g.hours}</td>
                    <td
                      className="px-3 py-1.5 text-right tabular-nums font-semibold text-ink"
                      title={
                        g.itemValue
                          ? `Staff at ${g.placeName}. The kit ordered for it is listed once below, across the whole event.`
                          : undefined
                      }
                    >
                      {money(g.staffValue, { pence: false })}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      {!locked ? (
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={`Copy ${g.placeName} to other places`}
                          title="Copy this deployment to other places"
                          onClick={() => onDialog({ kind: 'copyDeployment', deploymentKey: g.key })}
                        >
                          <Icon name="copy" decorative className="icon-sm" />
                        </button>
                      ) : null}
                    </td>
                  </tr>
                </Fragment>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
      <div
        className="px-3 py-2 flex items-center gap-4 flex-wrap"
        style={{ borderTop: '1px solid var(--surface-line)' }}
      >
        <p className="text-[11.5px] text-ink-3">
          {countLabel(groups.reduce((n, g) => n + g.lines.length, 0), 'deployed line')} ·{' '}
          {countLabel(groups.reduce((n, g) => n + g.shifts, 0), 'shift')} ·{' '}
          {countLabel(groups.reduce((n, g) => n + g.hours, 0), 'hour')} sold
        </p>
        <p className="text-[11.5px] text-ink-3">
          Shaded columns are event days. A dot is a day this line does not work.
        </p>
      </div>
    </div>
  );
}


/**
 * One editable headcount in the quote grid.
 *
 * Committed on blur or Enter, never on keystroke: each commit writes a history
 * entry and a quote version, and versioning every digit of "12" would bury the
 * one that mattered. Escape puts the old number back.
 */
function HeadcountCell({
  w,
  line,
  day,
  editable,
}: {
  w: W.Wof;
  line: W.LineItem;
  day: number;
  editable: boolean;
}) {
  const pat = W.linePattern(w, line);
  const covered = !!pat && pat.days.includes(day);
  const n = covered ? W.headcountOn(w, line, day) : 0;
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const shaded = W.dayKind(w, day) === 'event';

  if (!covered || !editable) {
    return (
      <td
        className="px-1 py-1.5 text-center tabular-nums"
        style={{
          color: n ? 'var(--ink)' : 'var(--ink-3)',
          fontWeight: n ? 600 : 400,
          background: shaded ? 'var(--accent-soft)' : undefined,
        }}
      >
        {covered && n ? n : '·'}
      </td>
    );
  }

  // Escape blurs the field, and a blur commits — so cancelling has to be
  // recorded somewhere `commit` can still see it. `setDraft(null)` cannot be:
  // the blur handler runs from inside the keydown, with the closure of the
  // render that is still on screen, and reads the draft it was about to throw
  // away. A ref is the same tick. Without this, Escape SAVED.
  const commit = () => {
    const typed = cancelled.current ? null : draft;
    cancelled.current = false;
    setDraft(null);
    if (typed !== null && typed !== String(n)) {
      W.setHeadcount(w, line.id, day, Number(typed) || 0, ROLES.actingActor());
    }
  };

  return (
    <td className="px-1 py-1 text-center" style={{ background: shaded ? 'var(--accent-soft)' : undefined }}>
      <input
        type="text"
        inputMode="numeric"
        aria-label={`${line.description}, day ${day}`}
        className="tabular-nums text-center"
        style={{
          width: 30,
          padding: '2px 0',
          border: '1px solid transparent',
          borderRadius: 5,
          background: 'transparent',
          color: n ? 'var(--ink)' : 'var(--ink-3)',
          fontWeight: n ? 600 : 400,
          fontSize: 12.5,
        }}
        value={draft ?? (n || '')}
        placeholder="·"
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          }
          if (e.key === 'Escape') {
            cancelled.current = true;
            e.currentTarget.blur();
          }
        }}
      />
    </td>
  );
}

/**
 * The quantity on a kit or services line, editable where it is read.
 *
 * The staff grid has had an editable cell since the day it shipped and the
 * things standing next to the people did not: forty barriers became
 * thirty-eight by deleting the line and adding it again, losing the hire
 * window, the sub-hire flag and the place along with it. Same commit rules as
 * `HeadcountCell` - blur or Enter, never a keystroke, Escape puts the old
 * number back - because every commit writes a history entry and a note for the
 * next document, and versioning each digit of "100" would bury the one that
 * mattered.
 *
 * The shelf is checked on the way in, the way the add-line dialog checks it:
 * past Order a quantity the yard cannot cover is REFUSED, before Order it is
 * quoted with the same sentence and a warning. An edit was the third road into
 * that arithmetic and the only one that never met it - a signed job is already
 * past the Order gate, so typing 1,000 cones against 900 on the shelf reached
 * the client's signature with nothing said.
 */
function QtyField({ w, line, editable }: { w: W.Wof; line: W.LineItem; editable: boolean }) {
  const toast = useToast();
  const [draft, setDraft] = useState<string | null>(null);
  // See `HeadcountCell`: Escape blurs, and a blur commits.
  const cancelled = useRef(false);

  if (!editable) return <span className="tabular-nums">{line.qty.toLocaleString()}</span>;

  const commit = () => {
    const typed = cancelled.current ? null : draft;
    cancelled.current = false;
    setDraft(null);
    if (typed === null || typed === '' || Number(typed) === line.qty) return;
    const next = Number(typed);

    // Nought is a line that is not there. Offered as a removal rather than
    // done silently: the line carries a window, a place and possibly a
    // sub-hire arrangement, and none of that comes back.
    if (!(next > 0)) {
      toast('A quantity of nought is a line that is not there — remove it instead.', {
        tone: 'critical',
      });
      return;
    }

    const short = HOP.qtyShortfall(w, line, next);
    const committed = W.atLeast(w, 'order') && !W.isTerminal(w.stage) && w.active;
    if (short && committed) {
      toast(
        `Not enough ${short.name} in stock — ${HOP.describeShortfall(short, { name: false })} ` +
          'This job is already ordered, so this is a promise rather than a price. ' +
          'Reduce it, narrow the hire window, or mark it sub-hire.',
        { tone: 'critical' },
      );
      return;
    }

    if (!W.setQty(w, line.id, next, ROLES.actingActor())) return;
    if (short) {
      toast(
        `Quoted at ${next}, but the yard is short — ${HOP.describeShortfall(short, { name: false })} ` +
          'The shelf is checked again when the job goes to Order.',
        { tone: 'atRisk' },
      );
    }
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label={`Quantity of ${line.description}`}
      className="tabular-nums text-right"
      style={{
        width: 52,
        padding: '2px 4px',
        border: '1px solid var(--surface-line)',
        borderRadius: 5,
        background: 'var(--well)',
        color: 'var(--ink)',
        fontWeight: 600,
        fontSize: 12.5,
      }}
      value={draft ?? String(line.qty)}
      onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === 'Escape') {
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

export function LineTable({
  w,
  lines,
  emptyMsg,
  locked,
  caption,
  onDialog,
}: {
  w: W.Wof;
  lines: W.LineItem[];
  emptyMsg: string;
  /** Signed quote lines are read-only; a variation never is. */
  locked: boolean;
  /**
   * A heading over the table, for when it sits under the deployment grid and
   * the reader needs telling that this half is not per-place.
   */
  caption?: string;
  onDialog: (d: Dialog) => void;
}) {
  const toast = useToast();

  const head = caption ? (
    <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2 mt-4">{caption}</div>
  ) : null;

  if (!lines.length) {
    return (
      <>
        {head}
        <div className="card p-4">
          <p className="text-[13px] text-ink-3">{emptyMsg}</p>
        </div>
      </>
    );
  }

  const columns: Column<W.LineItem>[] = [
    {
      key: 'kind', label: '', nowrap: true,
      cell: (l) => (
        <span className="text-ink-3 tip" tabIndex={0} data-tip={l.kind}>
          <Icon name={l.kind === 'staff' ? 'users' : l.kind === 'kit' ? 'inbox' : 'settings'} decorative />
        </span>
      ),
    },
    {
      key: 'description', label: 'Line',
      cell: (l) => (
        <>
          <div className="text-[13.5px] text-ink">{l.description}</div>
          {/* Ordered because of a particular car park, but bought across the
              whole event - so the place is a caption here, not a band up in
              the grid. See `W.placementLabel`. */}
          {W.placementLabel(w, l) ? (
            <div className="text-[11.5px] text-ink-2">for {W.placementLabel(w, l)}</div>
          ) : null}
          <div className="text-[11.5px] text-ink-3">
            {chargeById(l.chargeId)?.code || ''} · rate card {l.snap ? fmtDate(l.snap.rateVersion) : '—'}
            {W.lineIsStale(l) ? (
              <>
                {' · '}
                <span style={{ color: TONE_HEX.atRisk }}>superseded</span>
              </>
            ) : null}
            {l.duringEvent ? (
              <>
                {' · '}
                <span style={{ color: TONE_HEX.atRisk }}>added during the event</span>
              </>
            ) : null}
            {/* Kit is out for the whole job unless somebody narrowed it, and
                the narrowed case is the one worth saying out loud — it is what
                the stock register is reading. */}
            {l.kind === 'kit' && l.hire ? (
              <>
                {' · '}
                <span className="text-ink-2">
                  on hire days {W.hireWindow(w, l).from}–{W.hireWindow(w, l).to}
                </span>
              </>
            ) : null}
            {l.subHire ? (
              <>
                {' · '}
                <span className="text-ink-2">sub-hire</span>
              </>
            ) : null}
          </div>
          {l.note ? <div className="text-[11.5px] text-ink-2 mt-0.5 italic">{l.note}</div> : null}
          {/* Not enough of it on the shelf. A FLAG, not a block: quoting is
              speculative and a warehouse constraint that stopped an operator
              pricing a job is how people go back to the spreadsheet. The
              refusal comes at Order, in `gate()`. */}
          {(() => {
            const sf = HOP.lineShortfall(w, l);
            return sf ? (
              <div className="mt-1">
                <Pill
                  label={`${sf.short} short`}
                  tone="atRisk"
                  hint={HOP.describeShortfall(sf, { name: false })}
                />
              </div>
            ) : null;
          })()}
          {/* A variation is extra money on a signed job, so where the client
              has got to with it belongs on the operator's line too. */}
          {l.source === 'variation' ? (
            <div className="mt-1">
              {!W.variationSent(w, l) ? (
                <Pill
                  label="Not sent"
                  tone="neutral"
                  hint="Priced but not yet sent — the client cannot see this line"
                />
              ) : l.clientApproval === 'accepted' ? (
                <Pill label="Client approved" tone="healthy" hint="Approved in the client portal" />
              ) : l.clientApproval === 'queried' ? (
                <Pill
                  label="Client queried"
                  tone="atRisk"
                  hint={l.clientNote || 'The client has questioned this line'}
                />
              ) : (
                <Pill label="With the client" tone="info" hint="Sent for approval, no answer yet" />
              )}
              {l.clientNote ? (
                <div className="text-[11.5px] text-ink-2 mt-0.5 italic">“{l.clientNote}”</div>
              ) : null}
            </div>
          ) : null}
        </>
      ),
    },
    {
      // Editable for kit and services, read-only for staff: a staffed line's
      // qty is its shift count, derived from the grid, and typing over it
      // would last until the next re-cut. See `W.setQty`.
      key: 'qty', label: 'Qty', align: 'right', nowrap: true,
      cell: (l) => <QtyField w={w} line={l} editable={!locked && l.kind !== 'staff'} />,
    },
    {
      key: 'units', label: 'Units', align: 'right', nowrap: true,
      cell: (l) => (
        <span className="tabular-nums text-ink-2">
          {l.units} {l.unitLabel}
          {l.units === 1 ? '' : 's'}
        </span>
      ),
    },
    {
      key: 'rate', label: 'Rate', align: 'right', nowrap: true,
      cell: (l) => {
        const base = l.snap?.charge ?? 0;
        const applied = W.lineRate(l);
        return (
          <>
            <span className="tabular-nums">{money(applied)}</span>
            {applied !== base ? (
              <div className="text-[11px] tabular-nums" style={{ color: TONE_HEX.healthy }}>
                tier from {money(base)}
              </div>
            ) : null}
          </>
        );
      },
    },
    {
      key: 'cost', label: 'Cost', align: 'right', nowrap: true,
      cell: (l) => <span className="tabular-nums text-ink-3">{money(W.lineCost(l), { pence: false })}</span>,
    },
    {
      key: 'value', label: 'Value', align: 'right', nowrap: true,
      cell: (l) => (
        <span className="tabular-nums font-semibold text-ink">{money(W.lineValue(l), { pence: false })}</span>
      ),
    },
    {
      key: 'act', label: '', align: 'right', nowrap: true,
      cell: (l) => (
        <MenuButton
          label={`Actions for ${l.description}`}
          items={[
            {
              label: 'Re-price to current rate card', icon: 'refresh',
              disabled: !W.lineIsStale(l),
              hint: W.lineIsStale(l)
                ? 'The rate card has moved since this line was priced'
                : 'This line is already on the current rate',
              onSelect: () => {
                W.repriceLine(w, l.id, ROLES.actingActor());
                toast('Line re-priced. The change is in the history.', { tone: 'info' });
              },
            },
            { label: 'View rate history', icon: 'fileText', onSelect: () => toast('Open Table of charges to see the rate history.') },
            ...(l.kind === 'kit'
              ? [
                  '-' as const,
                  {
                    label: l.hire ? 'Change hire window' : 'Narrow the hire window',
                    icon: 'calendar',
                    hint: l.hire
                      ? `Out on days ${W.hireWindow(w, l).from}–${W.hireWindow(w, l).to} of ${W.hireWindow(w, l).days}`
                      : 'Out for the whole job. Narrow it if the item is only wanted on some days.',
                    onSelect: () => onDialog({ kind: 'hireWindow', line: l }),
                  },
                  {
                    label: l.subHire ? 'Back onto EP stock' : 'Mark as sub-hire',
                    icon: 'externalLink',
                    hint: l.subHire
                      ? 'Draw this from EP’s own stock again'
                      : 'Supplied by a third party — draws no EP stock and can never be short',
                    onSelect: () => {
                      W.setSubHire(w, l.id, !l.subHire, ROLES.actingActor());
                      toast(
                        l.subHire
                          ? `${l.description} is back on EP stock.`
                          : `${l.description} marked sub-hire — it no longer draws on the warehouse.`,
                        { tone: 'info' },
                      );
                    },
                  },
                ]
              : []),
            '-',
            { label: 'Remove line', icon: 'trash', danger: true, onSelect: () => onDialog({ kind: 'removeLine', line: l }) },
          ]}
        />
      ),
    },
  ];

  return (
    <>
      {head}
      <DataTable
        columns={columns}
        rows={lines}
        rowKey={(l) => l.id}
        footer={{
          description: `${lines.length} line${lines.length === 1 ? '' : 's'}`,
          cost: money(lines.reduce((s, l) => s + W.lineCost(l), 0), { pence: false }),
          value: money(lines.reduce((s, l) => s + W.lineValue(l), 0), { pence: false }),
        }}
      />
    </>
  );
}

/* ========================================================================== */
/* DOCUMENTS                                                                  */
/* ========================================================================== */

function DocumentsTab({ w }: { w: W.Wof }) {
  const toast = useToast();
  const ds = W.docState(w);
  const jt = jobType(w.jobTypeId);

  const columns: Column<W.WofDocView>[] = [
    {
      key: 'label', label: 'Document',
      cell: (d) => (
        <>
          <div className="text-[13.5px] text-ink">{d.label}</div>
          {d.blocking ? <div className="text-[11px] text-ink-3">Mandatory for this job type</div> : null}
          {d.note ? <div className="text-[11.5px] text-ink-2 italic mt-0.5">{d.note}</div> : null}
        </>
      ),
    },
    {
      key: 'owner', label: 'Responsible', nowrap: true,
      cell: (d) => <span className="text-[13px] text-ink-2">{d.owner}</span>,
    },
    {
      key: 'due', label: 'Due', nowrap: true,
      cell: (d) => (
        <>
          <div className={`text-[13px] ${d.overdue ? 'text-status-critical font-semibold' : 'text-ink-2'}`}>
            {fmtDate(d.dueDate)}
          </div>
          <div className="text-[11.5px] text-ink-3">{timing(d.dueDate, d.dueDate).label}</div>
        </>
      ),
    },
    {
      key: 'status', label: 'Status', nowrap: true,
      cell: (d) => {
        const meta = W.docStatusMeta(d);
        return (
          <Pill
            status={d.effectiveStatus}
            label={meta.label}
            tone={meta.tone}
            hint={
              d.status === 'submitted'
                ? d.overdue
                  ? 'Received, past its due date, waiting on our check'
                  : 'Received, waiting on our check'
                : d.overdue
                  ? 'Never received — past the date we needed it'
                  : false
            }
          />
        );
      },
    },
    {
      key: 'act', label: '', align: 'right', nowrap: true,
      cell: (d) => (
        <select
          className="field w-auto text-[12.5px]"
          value={d.status}
          aria-label={`Set status for ${d.label}`}
          onChange={(e) => {
            const next = e.target.value as W.DocStatusId;
            W.setDocStatus(w, d.docId, next);
            toast(`Document marked ${W.DOC_STATUS[next].label.toLowerCase()}.`, {
              tone: next === 'approved' ? 'healthy' : 'info',
            });
          }}
        >
          {(['required', 'submitted', 'approved'] as W.DocStatusId[]).map((s) => (
            <option key={s} value={s}>
              {W.DOC_STATUS[s].label}
            </option>
          ))}
        </select>
      ),
    },
  ];

  return (
    <>
      <div className="flex flex-wrap gap-3 mb-4">
        <Kpi
          label="Approved"
          value={`${ds.approved}/${ds.total}`}
          tone={ds.complete ? 'healthy' : 'info'}
          sub={ds.complete ? 'Checklist complete' : `${ds.total - ds.approved} still to approve`}
        />
        <Kpi
          label="Not received"
          value={String(ds.outstanding)}
          tone={ds.outstanding ? 'atRisk' : 'healthy'}
          sub={ds.outstanding ? 'Past their due date — chase the owner' : 'Nothing missing past its date'}
        />
        <Kpi
          label="With us to check"
          value={String(ds.awaitingReview)}
          tone={ds.awaitingReview ? 'info' : 'healthy'}
          sub={ds.awaitingReview ? 'Received, waiting on our approval' : 'Nothing waiting on us'}
        />
        <Kpi
          label="Mandatory missing"
          value={String(ds.blocking)}
          tone={ds.blocking ? 'critical' : 'healthy'}
          sub={ds.blocking ? 'Flagged, but progression is not hard-blocked' : 'None'}
        />
      </div>

      <div className="card p-3.5 mb-4" style={{ background: TONE_BG.info, borderColor: TONE_LINE.info }}>
        <div className="flex items-start gap-2.5">
          <span style={{ color: TONE_HEX.info, marginTop: 1 }}>
            <Icon name="info" decorative />
          </span>
          <p className="text-[13px] text-ink-2 leading-relaxed flex-1">
            This checklist came from the <strong className="text-ink">{jt ? jt.label : w.jobTypeId}</strong>{' '}
            job type, which is editable in Reference data without a developer. Due dates are derived from each
            document's lead time before the event date. Current policy is to{' '}
            <strong className="text-ink">warn rather than block</strong>: a missing mandatory document is
            flagged everywhere, and moving past it records an override against your name. A document that has
            been sent in reads as <em>Submitted</em> whether or not it arrived on time — lateness is shown on
            the due date, not by overwriting where the document is.
          </p>
        </div>
      </div>

      <DataTable columns={columns} rows={ds.docs} rowKey={(d) => d.docId} />

      <Provenance>
        The same rows appear on the cross-job Document checklist report, and the roll-up drives the document
        pill on the WOF pipeline and the event calendar.
      </Provenance>
    </>
  );
}

/* ========================================================================== */
/* PICKING                                                                    */
/* ========================================================================== */

function PickingTab({ w }: { w: W.Wof }) {
  const toast = useToast();
  const kit = w.lines.filter((l) => l.kind === 'kit');
  const services = w.lines.filter((l) => l.kind === 'service');
  const staff = w.lines.filter((l) => l.kind === 'staff');
  const ev = w.eventId ? eventById(w.eventId) : null;
  const cov = ev ? eventCoverage(ev) : null;

  const changes = W.kitChangesSincePush(w);
  const prepDrift = W.kitChangesSincePrep(w);

  /* The reference is issued once and never reissued, so the first send has to
     have something to pick. No kit lines quoted means there is no list — the
     button stays dead rather than burning the reference on an empty job. A
     re-send is different: emptying the kit is itself an amendment the
     warehouse needs to see. */
  const noKit = kit.length === 0;
  const sendBlock = noKit ? 'No kit quoted on this job yet — add kit lines to the quote first.' : '';

  const push = () => {
    const first = !w.picking;
    const n = changes.length;
    const p = W.sendToHop(w);
    toast(
      first
        ? `Kit list sent to EP HOP as ${p.epHopRef}. It is in the warehouse queue now.`
        : n
          ? `${p.epHopRef} updated to v${p.version} — ${n} change${n > 1 ? 's' : ''} sent. Same reference, so the warehouse knows it supersedes the last one.`
          : `${p.epHopRef} re-sent unchanged (v${p.version}).`,
      { tone: 'healthy' },
    );
  };

  const kitColumns: Column<W.LineItem>[] = [
    {
      key: 'desc', label: 'Item',
      cell: (l) => (
        <>
          <div className="text-[13.5px] text-ink">{l.description}</div>
          <div className="text-[11.5px] text-ink-3">
            Warehouse code {chargeById(l.chargeId)?.hireHopCode || '—'}
          </div>
        </>
      ),
    },
    {
      key: 'qty', label: 'Quantity', align: 'right', nowrap: true,
      cell: (l) => (
        <span className="tabular-nums text-[15px] font-semibold text-ink">{l.qty.toLocaleString()}</span>
      ),
    },
    {
      key: 'days', label: 'On hire', align: 'right', nowrap: true,
      cell: (l) => (
        <span className="tabular-nums text-ink-2">
          {l.units} {l.unitLabel}
          {l.units === 1 ? '' : 's'}
        </span>
      ),
    },
    {
      key: 'src', label: 'Source', nowrap: true,
      cell: (l) =>
        l.source === 'variation' ? (
          <Pill
            label={l.duringEvent ? 'Added on site' : 'Variation'}
            tone="atRisk"
            hint={l.note || false}
          />
        ) : (
          <span className="text-[12.5px] text-ink-3">Quote</span>
        ),
    },
    {
      key: 'value', label: 'Charged', align: 'right', nowrap: true,
      cell: (l) => <span className="tabular-nums text-ink-2">{money(W.lineValue(l), { pence: false })}</span>,
    },
  ];

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2 mb-4">
        <div className="card p-4">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1">
                Kit — warehouse
              </div>
              <p className="text-[12.5px] text-ink-3 leading-snug">
                Prepared when the client confirmed; sent to EP HOP so Pete's team pick against one
                list — and so this screen can say where they have got to.
              </p>
            </div>
            <Icon name="inbox" decorative className="icon-lg" />
          </div>
          {w.picking ? (
            <>
              <div className="space-y-1">
                <Row
                  label="Reference"
                  value={
                    <span className="inline-flex items-center gap-1.5">
                      <span className="font-mono text-[12.5px]">{w.picking.epHopRef}</span>
                      {(w.picking.version ?? 1) > 1 ? (
                        <span
                          className="pill"
                          style={{ background: TONE_BG.neutral, color: TONE_HEX.neutral }}
                          title="Amended since the original send. Same reference — this supersedes it."
                        >
                          v{w.picking.version}
                        </span>
                      ) : null}
                    </span>
                  }
                />
                {/* The live prep. `picking.status` was a string written when
                    the record was created and changed by nothing — a job
                    nobody had opened still read "Picking in progress". This
                    reads what the warehouse has actually done. */}
                {(() => {
                  const pr = HOP.prep(w.id);
                  if (!pr) return <Row label="Status" value="With the warehouse" />;
                  const prog = HOP.prepProgress(pr);
                  return (
                    <>
                      <Row
                        label="Warehouse"
                        value={
                          <span className="inline-flex items-center gap-1.5">
                            <Pill
                              label={HOP.PREP_META[pr.state].label}
                              tone={HOP.PREP_META[pr.state].tone}
                              hint={HOP.PREP_META[pr.state].blurb}
                            />
                            {HOP.isShort(pr) ? (
                              <Pill
                                label="Short"
                                tone="atRisk"
                                hint="At least one line could not be picked in full."
                              />
                            ) : null}
                          </span>
                        }
                      />
                      <Row
                        label="Picked"
                        value={`${prog.picked.toLocaleString()} of ${prog.wanted.toLocaleString()} items`}
                      />
                      {pr.heldBy ? (
                        <Row label="With" value={ROLES.member(pr.heldBy)?.name || pr.heldBy} />
                      ) : null}
                    </>
                  );
                })()}
                <Row label="First sent" value={fmtDateFull(w.picking.pushedAt)} />
                <Row label="Last sync" value={fmtDateFull(w.picking.lastSyncAt)} />
              </div>

              {/* Sent once and then amended is worse than never sent: the
                  warehouse is confidently picking a list that is out of date. */}
              {changes.length ? (
                <div
                  className="rounded-lg p-3 mt-3"
                  style={{ background: TONE_BG.atRisk, border: `1px solid ${TONE_LINE.atRisk}` }}
                >
                  <div className="flex items-start gap-2">
                    <span style={{ color: TONE_HEX.atRisk, marginTop: 1 }}>
                      <Icon name="alert" decorative className="icon-sm" />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[12.5px] font-semibold text-ink mb-1">
                        {countLabel(changes.length, 'change')} the warehouse has not seen
                      </div>
                      <ul className="text-[12px] text-ink-2 leading-relaxed space-y-0.5">
                        {changes.map((c, i) => (
                          <li key={i}>
                            ·{' '}
                            {c.kind === 'added'
                              ? `Added ${c.description}`
                              : c.kind === 'removed'
                                ? `Removed ${c.description}`
                                : `${c.description}: ${c.from} → ${c.to}`}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              ) : null}

              <button
                type="button"
                className={`btn btn-sm w-full mt-3 ${changes.length ? 'btn-primary' : 'btn-secondary'}`}
                onClick={push}
              >
                {changes.length ? 'Re-send amended kit list' : 'Re-send kit list to EP HOP'}
              </button>
              <p className="text-[11.5px] text-ink-3 mt-2 leading-relaxed">
                Re-sending keeps {w.picking.epHopRef} and raises its version, so the warehouse has one
                reference for this job rather than two competing lists.
              </p>
            </>
          ) : (
            <>
              {w.kitPrep ? (
                <>
                  <div className="space-y-1">
                    <Row
                      label="Status"
                      value={
                        <span className="inline-flex items-center gap-1.5">
                          <Pill label="Prepared, not sent" tone="info" />
                        </span>
                      }
                    />
                    <Row
                      label={w.kitPrep.source === 'confirmation' ? 'Built on confirmation' : 'Prepared'}
                      value={fmtDateFull(w.kitPrep.preparedAt)}
                    />
                    <Row label="Lines held" value={`${w.kitPrep.manifest.length}`} />
                  </div>

                  {/* Prepared and then changed is not an error — nothing has
                      been sent, so this is still free to fix. It is shown
                      because the office should know the job it confirmed and
                      the job it is about to pick are not the same job. */}
                  {prepDrift.length ? (
                    <div
                      className="rounded-lg p-3 mt-3"
                      style={{ background: TONE_BG.info, border: `1px solid ${TONE_LINE.info}` }}
                    >
                      <div className="text-[12.5px] font-semibold text-ink mb-1">
                        {countLabel(prepDrift.length, 'change')} since the list was prepared
                      </div>
                      <ul className="text-[12px] text-ink-2 leading-relaxed space-y-0.5">
                        {prepDrift.map((c, i) => (
                          <li key={i}>
                            ·{' '}
                            {c.kind === 'added'
                              ? `Added ${c.description}`
                              : c.kind === 'removed'
                                ? `Removed ${c.description}`
                                : `${c.description}: ${c.from} → ${c.to}`}
                          </li>
                        ))}
                      </ul>
                      <p className="text-[11.5px] text-ink-3 mt-1.5 leading-relaxed">
                        Nothing has gone to the warehouse yet, so sending now sends the current list.
                      </p>
                    </div>
                  ) : null}

                  <button
                    type="button"
                    className="btn btn-primary btn-sm w-full mt-3"
                    disabled={noKit}
                    title={sendBlock || undefined}
                    onClick={push}
                  >
                    Send kit list to EP HOP
                  </button>
                  <p className="text-[11.5px] text-ink-3 mt-2 leading-relaxed">
                    {noKit ? (
                      sendBlock
                    ) : (
                      <>
                        {countLabel(kit.length, 'line')},{' '}
                        {kit.reduce((s, l) => s + l.qty, 0).toLocaleString()} items. Sending assigns the
                        EP HOP reference — once, and it is never reissued.
                      </>
                    )}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-[13px] text-ink-2 leading-relaxed mb-3">
                    {noKit ? (
                      <>Nothing to send. No kit has been quoted on this job yet.</>
                    ) : (
                      <>
                        Nothing sent yet. {countLabel(kit.length, 'kit line')} totalling{' '}
                        {kit.reduce((s, l) => s + l.qty, 0).toLocaleString()} items are ready to go.
                      </>
                    )}
                  </p>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm w-full"
                    disabled={noKit}
                    title={sendBlock || undefined}
                    onClick={push}
                  >
                    Send kit list to EP HOP
                  </button>
                  {noKit ? (
                    <p className="text-[11.5px] text-ink-3 mt-2 leading-relaxed">{sendBlock}</p>
                  ) : null}
                </>
              )}
            </>
          )}
        </div>

        <div className="card p-4">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1">
                Staff — allocation tool
              </div>
              <p className="text-[12.5px] text-ink-3 leading-snug">
                {ev
                  ? 'Shifts seeded from this WOF when it became an order.'
                  : 'No shifts until this WOF becomes an order.'}
              </p>
            </div>
            <Icon name="users" decorative className="icon-lg" />
          </div>
          {!W.hasStaffWork(w) ? (
            // Kit-only hire. There is no rota to fill, so there is nothing to
            // report as covered.
            <p className="text-[13px] text-ink-2 leading-relaxed">
              <strong className="text-ink">No staff on this job.</strong> It is kit and services only, so
              there are no shifts to fill and no check-ins to approve.
            </p>
          ) : cov && ev ? (
            <>
              <div className="flex items-baseline justify-between mb-1.5">
                <span className="text-[24px] font-bold text-ink tabular-nums">
                  {cov.filled}
                  <span className="text-ink-3 text-[17px]">/{cov.required}</span>
                </span>
                <span className="text-[13px] text-ink-2">{cov.gap ? `${cov.gap} unfilled` : 'Fully covered'}</span>
              </div>
              <CoverageBar cov={cov} tone={coverageTone(cov, w.start, w.end)} height={8} />
              <Link className="btn btn-secondary btn-sm w-full mt-3" to={`/events/${ev.id}`}>
                Open in the staffing tool
              </Link>
            </>
          ) : (
            <p className="text-[13px] text-ink-2 leading-relaxed">
              {staff.length} staff lines are priced on the quote and will become shifts automatically at the
              Order stage.
            </p>
          )}
        </div>
      </div>

      <Section title="Kit to pick" />
      {kit.length ? (
        <DataTable
          columns={kitColumns}
          rows={kit}
          rowKey={(l) => l.id}
          footer={{
            desc: `${kit.length} lines`,
            qty: kit.reduce((s, l) => s + l.qty, 0).toLocaleString(),
            value: money(kit.reduce((s, l) => s + W.lineValue(l), 0), { pence: false }),
          }}
        />
      ) : (
        <div className="card p-4">
          <p className="text-[13px] text-ink-3">No kit on this job.</p>
        </div>
      )}

      {services.length ? (
        <>
          <Section title="Services" />
          <DataTable
            columns={[
              { key: 'desc', label: 'Service', cell: (l) => <span className="text-[13.5px] text-ink">{l.description}</span> },
              { key: 'qty', label: 'Qty', align: 'right', cell: (l) => <span className="tabular-nums">{l.qty}</span> },
              {
                key: 'value', label: 'Charged', align: 'right', nowrap: true,
                cell: (l) => <span className="tabular-nums text-ink-2">{money(W.lineValue(l), { pence: false })}</span>,
              },
            ]}
            rows={services}
            rowKey={(l) => l.id}
          />
        </>
      ) : null}

      <Provenance>
        Quantities come straight from the priced lines, so what the warehouse picks and what the client is
        charged cannot drift apart. Variations added during the event appear here as soon as they are entered.
      </Provenance>
    </>
  );
}

/* ========================================================================== */
/* TIMESHEETS                                                                 */
/* ========================================================================== */

interface PersonRow {
  employeeId: string;
  name: string;
  employmentType: string;
  payRate: number;
  hours: number;
  gross: number;
  shifts: number;
  roles: Set<string>;
}


/* ------------------------------------------------------------- variance ---
   Sold against worked, which is the question this whole model exists to make
   answerable. Before deployments a timesheet could say who worked and when but
   never which line it was worked against, so "we sold 48 hours of Alley Farm
   nights and paid for 51" could not be asked at any price.                --- */

function VarianceCard({ w }: { w: W.Wof }) {
  const toast = useToast();
  const groups = W.deploymentVariance(w);
  const claims = W.overtimeClaims(w);
  if (!groups.length) return null;

  const sold = groups.reduce((s, g) => s + g.soldHours, 0);
  const worked = groups.reduce((s, g) => s + g.workedHours, 0);
  const delta = Math.round((worked - sold) * 100) / 100;
  const owed = claims.reduce((s, c) => s + c.value, 0);

  return (
    <>
      <Section title="Sold against worked" />
      <div className="card p-4 mb-4">
        <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2 mb-3">
          <Stat label="Sold" value={`${sold}h`} />
          <Stat label="Worked" value={`${worked}h`} />
          <Stat
            label="Difference"
            value={`${delta > 0 ? '+' : ''}${delta}h`}
            tone={delta > 0 ? 'atRisk' : delta < 0 ? 'healthy' : 'neutral'}
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Where', 'Sold', 'Worked', 'Difference'].map((x, i) => (
                  <th
                    key={x}
                    className="px-2 py-1.5 text-[9.5px] uppercase tracking-[0.11em] text-ink-3 font-semibold"
                    style={{ textAlign: i ? 'right' : 'left' }}
                  >
                    {x}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.key} style={{ borderTop: '1px solid var(--surface-line-soft)' }}>
                  <td className="px-2 py-1.5 text-ink">
                    {g.place}
                    <span className="text-ink-3"> · {g.area}</span>
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-ink-2">{g.soldHours}h</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-ink-2">{g.workedHours}h</td>
                  <td
                    className="px-2 py-1.5 text-right tabular-nums font-semibold"
                    style={{
                      color:
                        g.hoursDelta > 0
                          ? TONE_HEX.atRisk
                          : g.hoursDelta < 0
                            ? TONE_HEX.healthy
                            : 'var(--ink-3)',
                    }}
                  >
                    {g.hoursDelta > 0 ? '+' : ''}
                    {g.hoursDelta}h
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {claims.length ? (
        <div className="card p-4 mb-4" style={{ background: TONE_BG.atRisk }}>
          <div className="flex items-start gap-3">
            <span style={{ color: TONE_HEX.atRisk, marginTop: 1 }}>
              <Icon name="alert" decorative />
            </span>
            <div className="flex-1">
              <p className="text-[13.5px] text-ink font-semibold mb-1">
                {money(owed, { pence: false })} worked and never billed
              </p>
              <p className="text-[13px] text-ink-2 leading-relaxed mb-3">
                These hours were paid for and are not on the quote. Raising a variation prices them at the
                rate already agreed and carries the timesheet rows with it, so the invoice can be justified
                rather than argued.
              </p>
              {claims.map((c) => (
                <div
                  key={c.line.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-2"
                  style={{ borderTop: '1px solid var(--surface-line)' }}
                >
                  <div>
                    <div className="text-[13px] text-ink">
                      {c.line.description} · {c.place}
                    </div>
                    <div className="text-[11.5px] text-ink-3">
                      {c.window} · {countLabel(c.extraHours, 'hour')} over ·{' '}
                      {c.workers
                        .slice(0, 2)
                        .map((x) => `${x.name} ${x.hours}h`)
                        .join(', ')}
                      {c.workers.length > 2 ? ` +${c.workers.length - 2} more` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-[14px] font-bold text-ink tabular-nums">
                      {money(c.value, { pence: false })}
                    </span>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        const made = W.raiseOvertimeVariation(w, c, ROLES.actingActor());
                        toast(
                          made
                            ? `Variation raised — ${money(W.lineValue(made), { pence: false })}. It is on the quote tab, ready to send.`
                            : 'That claim could not be raised.',
                          { tone: made ? 'healthy' : 'critical' },
                        );
                      }}
                    >
                      Raise variation
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** One number with its label, for the variance strip. */
function Stat({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  return (
    <div>
      <div className="text-[9.5px] uppercase tracking-[0.11em] text-ink-3 font-semibold">{label}</div>
      <div
        className="text-[19px] font-bold tabular-nums"
        style={{ color: tone && tone !== 'neutral' ? TONE_HEX[tone] : 'var(--ink)' }}
      >
        {value}
      </div>
    </div>
  );
}

function TimesheetsTab({ w }: { w: W.Wof }) {
  const ts = W.timesheets(w);

  if (!ts.length) {
    // Three different empty states, because "no timesheets" has three very
    // different meanings and only one of them is something to act on.
    const staffed = W.hasStaffWork(w);
    const notRunYet = new Date(w.start) > NOW;

    if (!staffed) {
      return (
        <EmptyState
          iconName="inbox"
          title="No staff on this job"
          body="This is a kit and services hire — nobody is rostered, so there are no check-ins to approve and no timesheets to arrive. Cost to deliver stays at the kit cost price."
          action={
            <Link className="btn btn-secondary" to={`/wofs/${w.id}#picking`}>
              See what is on hire
            </Link>
          }
        />
      );
    }

    return (
      <EmptyState
        iconName="clock"
        title={notRunYet ? 'This job has not run yet' : 'No timesheets approved yet'}
        body={
          notRunYet
            ? `It runs on ${fmtDate(w.start)}. Timesheets arrive after that, from check-ins approved in the staff allocation tool — they are the single source for both payroll and the actual staff cost.`
            : 'Timesheets arrive from approved check-ins in the staff allocation tool. They are the single source for both payroll and the actual staff cost on this job.'
        }
        action={
          notRunYet && w.eventId ? (
            <Link className="btn btn-secondary" to={`/events/${w.eventId}`}>
              Open staffing
            </Link>
          ) : w.eventId ? (
            <Link className="btn btn-secondary" to="/check-in-approvals">
              Open check-in approvals
            </Link>
          ) : undefined
        }
      />
    );
  }

  const byEmp = new Map<string, PersonRow>();
  ts.forEach((t) => {
    const e =
      byEmp.get(t.employeeId) ||
      {
        employeeId: t.employeeId, name: t.employeeName, employmentType: t.employmentType,
        payRate: t.payRate, hours: 0, gross: 0, shifts: 0, roles: new Set<string>(),
      };
    e.hours = round2(e.hours + t.hours);
    e.gross = round2(e.gross + t.gross);
    e.shifts++;
    e.roles.add(t.role);
    byEmp.set(t.employeeId, e);
  });

  const people = [...byEmp.values()].sort((a, b) => b.gross - a.gross);
  const totalHours = Math.round(ts.reduce((s, t) => s + t.hours, 0) * 10) / 10;
  const totalGross = W.actualStaffCost(w);
  const planned = W.plannedStaffCost(w);
  const variance = round2(totalGross - planned);

  const columns: Column<PersonRow>[] = [
    {
      key: 'name', label: 'Worker',
      cell: (p) => {
        const emp = employeeById(p.employeeId);
        return (
          <div className="flex items-center gap-2.5">
            {emp ? <Avatar hue={emp.hue} initials={emp.initials} size={28} /> : null}
            <div>
              <div className="text-[13.5px] text-ink">{p.name}</div>
              <div className="text-[11.5px] text-ink-3">{[...p.roles].join(', ')}</div>
            </div>
          </div>
        );
      },
    },
    {
      key: 'type', label: 'Employment', nowrap: true,
      cell: (p) => <span className="text-[12.5px] text-ink-2">{p.employmentType}</span>,
    },
    { key: 'shifts', label: 'Shifts', align: 'right', cell: (p) => <span className="tabular-nums">{p.shifts}</span> },
    {
      key: 'hours', label: 'Hours', align: 'right',
      cell: (p) => <span className="tabular-nums">{p.hours.toFixed(1)}</span>,
    },
    {
      key: 'rate', label: 'Pay rate', align: 'right', nowrap: true,
      cell: (p) => <span className="tabular-nums text-ink-2">{money(p.payRate)}/hr</span>,
    },
    {
      key: 'gross', label: 'Gross', align: 'right', nowrap: true,
      cell: (p) => <span className="tabular-nums font-semibold text-ink">{money(p.gross)}</span>,
    },
  ];

  return (
    <>
      <div className="flex flex-wrap gap-3 mb-4">
        <Kpi
          label="Hours worked"
          value={totalHours.toLocaleString()}
          sub={`${ts.length} approved timesheets across ${people.length} people`}
          tone="info"
        />
        <Kpi
          label="Gross pay"
          value={money(totalGross, { pence: false })}
          sub="Hours × pay rate, including role uplifts"
          tone="neutral"
          to="/reports/payroll"
          hint="Opens the payroll output report"
        />
        <Kpi
          label="Planned staff cost"
          value={money(planned, { pence: false })}
          sub="From the cost prices on the quote"
          tone="neutral"
        />
        <Kpi
          label="Variance"
          value={money(variance, { pence: false })}
          sub={variance > 0 ? 'Over what was planned' : 'Under what was planned'}
          tone={variance > planned * 0.1 ? 'critical' : variance > 0 ? 'atRisk' : 'healthy'}
        />
      </div>

      {/* Money against the plan is above; this is HOURS against what was sold,
          broken down to the place and window they were sold for. The four KPIs
          say the job is over; this says which car park, on which shift. */}
      <VarianceCard w={w} />

      <DataTable
        columns={columns}
        rows={people}
        rowKey={(p) => p.employeeId}
        rowHref={(p) => `/staff?id=${p.employeeId}`}
        footer={{
          name: `${people.length} people`,
          hours: totalHours.toFixed(1),
          gross: money(totalGross, { pence: false }),
        }}
      />

      <Provenance>
        These rows are approved check-ins from the staff allocation tool. The gross figure is what the Payroll
        output report pays and what Job costing books as actual staff cost — one number, two reports.
      </Provenance>
    </>
  );
}

/* ========================================================================== */
/* INVOICE                                                                    */
/* ========================================================================== */

function InvoiceTab({ w }: { w: W.Wof }) {
  const toast = useToast();
  const dep = W.deposit(w);
  const cf = W.cashflow(w);
  const contract = W.contractValue(w);
  const balance = round2(contract - dep.due);
  const client = clientById(w.clientId)!;

  if (!w.invoice) {
    return (
      <>
        <EmptyState
          iconName="download"
          title="Not yet invoiced"
          body={
            <>
              Invoicing follows job completion. When this WOF reaches the Invoice stage an invoice is raised
              for <strong>{money(balance, { pence: false })}</strong> — the contract value of{' '}
              {money(contract, { pence: false })} net of the{' '}
              {dep.due > 0
                ? `${dep.pct}% deposit of ${money(dep.due, { pence: false })}`
                : 'deposit (none on this job)'}{' '}
              — due {client.termsDays} days from issue under this client's terms.
            </>
          }
        />
        <div className="card p-4 mt-4">
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-3">Draft position</div>
          <div className="max-w-sm space-y-1.5">
            <TotalRow label="Quote" value={W.quoteValue(w)} />
            {W.variationValue(w) ? <TotalRow label="Variations" value={W.variationValue(w)} tone="atRisk" /> : null}
            <TotalRow label="Contract value" value={contract} bold />
            {dep.due > 0 ? (
              <TotalRow
                label={`Deposit ${dep.received ? 'received' : 'due'}`}
                value={-dep.due}
                tone={dep.received ? 'healthy' : 'atRisk'}
              />
            ) : null}
            <TotalRow label="To invoice" value={balance} bold />
          </div>
          <Provenance>
            Scoping note from the briefing: integration with an external accounts package (Xero, Sage) is out
            of scope for the first release and is to be specified with the incoming Finance Director.
          </Provenance>
        </div>
      </>
    );
  }

  const overdue = !w.invoice.paidAt && new Date(w.invoice.dueAt) < NOW;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2 card p-5">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1">Invoice</div>
            <div className="text-[20px] font-bold text-ink">{w.invoice.number}</div>
          </div>
          <Pill
            label={w.invoice.paidAt ? 'Paid' : overdue ? 'Overdue' : 'Awaiting payment'}
            tone={w.invoice.paidAt ? 'healthy' : overdue ? 'critical' : 'atRisk'}
            hint={false}
          />
        </div>
        <table className="tbl">
          <tbody>
            <tr>
              <td className="text-ink-2">Contract value</td>
              <td style={{ textAlign: 'right' }} className="tabular-nums">
                {money(contract)}
              </td>
            </tr>
            {dep.due > 0 ? (
              <tr>
                <td className="text-ink-2">
                  Less deposit received {dep.receivedAt ? `(${fmtDate(dep.receivedAt)})` : ''}
                </td>
                <td style={{ textAlign: 'right' }} className="tabular-nums">
                  −{money(dep.due)}
                </td>
              </tr>
            ) : null}
            <tr>
              <td className="text-ink font-semibold">Invoice total</td>
              <td style={{ textAlign: 'right' }} className="tabular-nums font-bold text-[15px]">
                {money(balance)}
              </td>
            </tr>
          </tbody>
        </table>
        <div className="grid grid-cols-2 gap-4 mt-4">
          <div>
            <Row label="Issued" value={fmtDateFull(w.invoice.issuedAt)} />
            <Row
              label="Due"
              value={
                <span className={overdue ? 'text-status-critical font-semibold' : ''}>
                  {fmtDateFull(w.invoice.dueAt)}
                </span>
              }
            />
          </div>
          <div>
            <Row label="Terms" value={`${client.termsDays} days`} />
            <Row
              label="Paid"
              value={w.invoice.paidAt ? fmtDateFull(w.invoice.paidAt) : <span className="text-ink-3">Not yet</span>}
            />
          </div>
        </div>
        {!w.invoice.paidAt ? (
          <button
            type="button"
            className="btn btn-primary mt-4"
            onClick={() => {
              W.markInvoicePaid(w);
              toast('Payment recorded. The cash flow forecast now shows this as received.', { tone: 'healthy' });
            }}
          >
            <Icon name="check" decorative /> Record payment received
          </button>
        ) : null}
      </div>

      <div className="card p-4">
        <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-3">Cash flow position</div>
        {cf.rows.map((r, i) => (
          <div key={i} className="py-2 border-b border-surface-line-soft last:border-0">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[13px] text-ink">{r.label}</span>
              <span className="tabular-nums text-[13px] font-semibold">{money(r.amount, { pence: false })}</span>
            </div>
            <div className="flex items-center justify-between gap-3 mt-1">
              <span className="text-[11.5px] text-ink-3">Due {fmtDate(r.dueAt)}</span>
              <Pill
                label={r.received ? 'Received' : new Date(r.dueAt) < NOW ? 'Overdue' : 'Expected'}
                tone={r.received ? 'healthy' : new Date(r.dueAt) < NOW ? 'critical' : 'info'}
                hint={false}
              />
            </div>
          </div>
        ))}
        <Link className="btn btn-secondary btn-sm w-full mt-3" to="/reports/cashflow">
          Full cash flow forecast
        </Link>
      </div>
    </div>
  );
}

/* ========================================================================== */
/* HISTORY                                                                    */
/* ========================================================================== */

/**
 * The quote's paper trail: every document the client was sent.
 *
 * At the top of the history rather than mixed into it, because these are the
 * entries somebody will come looking for — "send me what we agreed" is a
 * question about documents, and hunting for them among forty stage changes is
 * how people end up emailing the wrong figure.
 *
 * Only sends appear here. Edits made since the last one are shown at the
 * bottom as what they are: work in the office that nobody has published.
 */
function DocumentsCard({ w }: { w: W.Wof }) {
  const toast = useToast();
  const quote = W.quoteVersions(w);
  const vars = W.variationVersions(w);
  const pendingQuote = W.pendingChanges(w, 'quote');
  const pendingVars = W.pendingChanges(w, 'variation');
  if (!quote.length && !vars.length && !pendingQuote.length && !pendingVars.length) return null;

  /* What has changed since the last document, and cannot be opened because it
     is not a document. Named against the version it will supersede, so the
     operator can see at a glance whether the client is reading the same
     numbers they are. */
  const unsent = (changes: W.PendingChange[], last: W.QuoteVersion | null, what: string) =>
    changes.length ? (
      <div className="mt-4 rounded-md border border-dashed border-surface-line p-3">
        <div className="text-[12.5px] font-semibold text-ink">
          {countLabel(changes.length, 'change')} since {last ? last.label : 'the last document'} — not sent
        </div>
        <ul className="mt-1.5 space-y-1">
          {changes.map((c, i) => (
            <li key={i} className="text-[12.5px] text-ink-2 leading-relaxed">
              {c.text}
              <span className="text-ink-3"> · {c.byName}</span>
            </li>
          ))}
        </ul>
        <div className="text-[11.5px] text-ink-3 mt-2">
          The client is still reading {last ? last.label : 'nothing'}. {what}
        </div>
      </div>
    ) : null;

  const open = (v: W.QuoteVersion) => {
    if (!DOC.openQuoteDocument(w, v, { audience: 'ep' })) {
      toast('Your browser blocked the document window. Allow pop-ups for this site and try again.', {
        tone: 'critical',
      });
    }
  };

  const row = (v: W.QuoteVersion) => {
    const tone: Tone = v.signedAt ? 'info' : v.objection ? 'atRisk' : 'healthy';
    const label = v.signedAt ? 'Signed' : v.objection ? 'Queried' : 'Sent';

    return (
      <li key={`${v.kind}-${v.no}`} className="flex items-start gap-3 py-3 border-t border-surface-line">
        <span className="text-[13px] font-bold text-ink tabular-nums w-[52px] shrink-0 pt-0.5">
          {v.label}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-[13px] text-ink font-medium">{money(v.value, { pence: false })}</span>
            <Pill label={label} tone={tone} hint={false} />
            <span className="text-[11.5px] text-ink-3">
              {fmtDateFull(v.at)} · {v.byName}
            </span>
          </div>
          <div className="text-[12.5px] text-ink-2 leading-relaxed mt-0.5">{v.change}</div>
          {v.changes.length > 1 ? (
            <ul className="mt-1 space-y-0.5">
              {v.changes.map((c, i) => (
                <li key={i} className="text-[12px] text-ink-3 leading-relaxed">
                  · {c.text}
                </li>
              ))}
            </ul>
          ) : null}
          {(v.answers || []).map((a, i) => (
            <div key={i} className="text-[12px] text-ink-2 leading-relaxed mt-1">
              {a.byName} {a.approval === 'accepted' ? 'accepted' : 'queried'} {a.description}
              {a.note ? `: “${a.note}”` : ''}
            </div>
          ))}
          {v.objection ? (
            <div className="text-[12px] leading-relaxed mt-1" style={{ color: TONE_HEX.atRisk }}>
              {v.objection.byName} queried this: “{v.objection.note}”
            </div>
          ) : null}
        </div>
        <button type="button" className="btn btn-secondary btn-sm shrink-0" onClick={() => open(v)}>
          <Icon name="download" decorative className="icon-sm" /> Document
        </button>
      </li>
    );
  };

  return (
    <div className="card p-5 mb-4">
      <div className="flex items-baseline justify-between gap-4 mb-1">
        <h3 className="text-[14px] font-semibold text-ink">Quote documents</h3>
        <span className="text-[11.5px] text-ink-3">
          {countLabel(quote.length, 'version')}
          {vars.length ? ` · ${countLabel(vars.length, 'variation schedule')}` : ''}
        </span>
      </div>
      <p className="text-[12.5px] text-ink-3 leading-relaxed mb-2">
        Sending the quote writes a version and keeps the document it produced. Opening one prints
        exactly what it said at the time, not what the job says now. Amendments made since the last
        send are listed below it, and the client cannot see them.
      </p>
      {quote.length ? <ul className="mt-2">{quote.map(row)}</ul> : null}
      {unsent(pendingQuote, W.currentVersion(w, 'quote'), 'Send the quote to put these in front of them.')}
      {vars.length || pendingVars.length ? (
        <>
          <div className="text-[11.5px] uppercase tracking-wide text-ink-3 font-semibold mt-5 mb-1">
            Variation schedule
          </div>
          <ul>{vars.map(row)}</ul>
          {unsent(
            pendingVars,
            W.currentVersion(w, 'variation'),
            'Send the variations to put these in front of them.',
          )}
        </>
      ) : null}
    </div>
  );
}

function HistoryTab({ w }: { w: W.Wof }) {
  const h = (w.history || []).slice().reverse();
  if (!h.length) {
    return <EmptyState title="No history" body="Nothing has happened to this WOF yet." />;
  }

  return (
    <>
    <DocumentsCard w={w} />
    <div className="card p-5">
      <ol className="relative border-l border-surface-line ml-2 space-y-5">
        {h.map((e, i) => {
          const st = W.stage(e.stage) || W.TERMINAL[e.stage as W.TerminalId] || { label: e.stage };
          // `by` is a manager id for operator actions and `client` for anything
          // done in the client portal, where the name comes from `byName`.
          const who = managerById(e.by)?.name || e.byName;
          const fromClient = e.by === 'client';
          return (
            <li key={i} className="pl-5 relative">
              <span
                className="absolute -left-[5px] top-1.5 w-2.5 h-2.5 rounded-full"
                style={{ background: TONE_HEX[STAGE_TONE[e.stage] || 'neutral'] }}
              />
              <div className="flex flex-wrap items-baseline gap-2 mb-0.5">
                <span className="text-[13.5px] font-semibold text-ink">{st.label}</span>
                <span className="text-[11.5px] text-ink-3">
                  {fmtDateFull(e.at)}
                  {fmtTime(e.at) ? ` · ${fmtTime(e.at)}` : ''}
                </span>
                {who ? <span className="text-[11.5px] text-ink-3">· {who}</span> : null}
                {fromClient ? (
                  <span className="pill" style={{ background: TONE_BG.info, color: TONE_HEX.info }}>
                    <Icon name="building" decorative className="icon-sm" />
                    Client portal
                  </span>
                ) : null}
              </div>
              <div className="text-[13px] text-ink-2 leading-relaxed">{e.note}</div>
              {e.overrides ? (
                <div className="mt-1.5 text-[12px] leading-relaxed" style={{ color: TONE_HEX.atRisk }}>
                  Continued past {e.overrides.length} warning{e.overrides.length > 1 ? 's' : ''}:{' '}
                  {e.overrides.join(' ')}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
    </>
  );
}
