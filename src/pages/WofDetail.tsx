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
     Picking    — kit to the warehouse via Hire Hop, staff via the staffing tool
     Timesheets — hours worked, which is both payroll input and actual cost
     Invoice    — billed net of deposit
     History    — the audit trail
   ========================================================================== */

import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import {
  Avatar, CoverageBar, EmptyState, Kpi, PageHeader, Pill, Provenance, Section,
} from '@/components/primitives';
import { DataTable, type Column } from '@/components/DataTable';
import { ConfirmDestructive, MenuButton, type MenuEntry } from '@/components/Modal';
import { GateBanner, ManagerChip, MarginPill, STAGE_TONE, StageRail } from '@/components/wof-ui';
import { useToast } from '@/components/Toast';
import { TONE_BG, TONE_HEX, TONE_LINE } from '@/lib/status';
import { coverageTone, eventCoverage } from '@/lib/coverage';
import { countLabel, fmtDate, fmtDateFull, fmtRange, fmtTime, money, round2, timing } from '@/lib/format';
import {
  NOW, charge as chargeById, client as clientById, employee as employeeById,
  event as eventById, jobType, manager as managerById, schedule as scheduleById,
} from '@/data/db';
import type { Tone } from '@/data/types';
import * as W from '@/lib/wof';
import * as ROLES from '@/lib/roles';
import { useWofVersion } from '@/lib/useStore';
import {
  AddLineDialog, AdvanceDialog, DeleteWofDialog, DepositDialog, EventInfoDialog,
  RevertStageDialog, SignDialog, StaffingEventDialog,
} from './wof/dialogs';

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
  | { kind: 'eventInfo' }
  | { kind: 'sign' }
  | { kind: 'deposit' }
  | { kind: 'removeLine'; line: W.LineItem }
  | { kind: 'staffingEvent' }
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
      label: w.picking ? 'Re-send kit list to Hire Hop' : 'Send kit list to Hire Hop',
      icon: 'externalLink',
      hint: w.picking
        ? `Keeps reference ${w.picking.hireHopRef} and raises its version`
        : 'Assigns a Hire Hop reference and sends the kit list',
      onSelect: () => {
        const first = !w.picking;
        const n = W.kitChangesSincePush(w).length;
        const p = W.pushToHireHop(w);
        toast(
          first
            ? `Kit list sent to Hire Hop as ${p.hireHopRef}.`
            : `${p.hireHopRef} updated to v${p.version}${n ? ` — ${countLabel(n, 'change')} sent.` : ' — unchanged.'}`,
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
      {dialog?.kind === 'eventInfo' ? <EventInfoDialog w={w} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'sign' ? <SignDialog w={w} onClose={() => setDialog(null)} /> : null}
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
      {dialog?.kind === 'removeLine' ? (
        <ConfirmDestructive
          title="Remove line"
          confirmLabel="Remove"
          onClose={() => setDialog(null)}
          onConfirm={() => {
            W.removeLine(w, dialog.line.id);
            toast('Line removed.');
          }}
          message={`Remove “${dialog.line.description}” worth ${money(W.lineValue(dialog.line))} from this WOF?`}
        />
      ) : null}
    </>
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
            ? `${countLabel(w.kitPrep.manifest.length, 'kit line')} prepared on confirmation, not yet sent to Hire Hop.`
            : 'Kit list not yet sent to the warehouse.';
        const pending = W.kitChangesSincePush(w).length;
        return `Hire Hop ${w.picking.hireHopRef}${(w.picking.version ?? 1) > 1 ? ` v${w.picking.version}` : ''} — ${w.picking.status}, last synced ${fmtDate(w.picking.lastSyncAt)}.${pending ? ` ${countLabel(pending, 'change')} not yet re-sent.` : ''}`;
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

function QuoteTab({ w, onDialog }: { w: W.Wof; onDialog: (d: Dialog) => void }) {
  const quote = W.quoteLines(w);
  const vars = W.variationLines(w);
  const stale = w.lines.filter(W.lineIsStale);
  const locked = !!w.signoff;
  const dep = W.deposit(w);

  return (
    <>
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
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onDialog({ kind: 'addLine', source: 'quote' })}
            >
              <Icon name="plus" decorative className="icon-sm" /> Add line
            </button>
          )
        }
      />
      <LineTable
        w={w}
        lines={quote}
        emptyMsg="No lines priced yet. Add items from the table of charges to build the quote."
        onDialog={onDialog}
      />

      <Section
        title={`Variations${vars.length ? ` (${vars.length})` : ''}`}
        right={
          locked ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onDialog({ kind: 'addLine', source: 'variation' })}
            >
              <Icon name="plus" decorative className="icon-sm" /> Add variation
            </button>
          ) : undefined
        }
      />
      {vars.length ? (
        <LineTable w={w} lines={vars} emptyMsg="" onDialog={onDialog} />
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

function LineTable({
  w,
  lines,
  emptyMsg,
  onDialog,
}: {
  w: W.Wof;
  lines: W.LineItem[];
  emptyMsg: string;
  onDialog: (d: Dialog) => void;
}) {
  const toast = useToast();

  if (!lines.length) {
    return (
      <div className="card p-4">
        <p className="text-[13px] text-ink-3">{emptyMsg}</p>
      </div>
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
          </div>
          {l.note ? <div className="text-[11.5px] text-ink-2 mt-0.5 italic">{l.note}</div> : null}
          {/* A variation is extra money on a signed job, so where the client
              has got to with it belongs on the operator's line too. */}
          {l.source === 'variation' ? (
            <div className="mt-1">
              {l.clientApproval === 'accepted' ? (
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
      key: 'qty', label: 'Qty', align: 'right', nowrap: true,
      cell: (l) => <span className="tabular-nums">{l.qty.toLocaleString()}</span>,
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
                W.repriceLine(w, l.id);
                toast('Line re-priced. The change is in the history.', { tone: 'info' });
              },
            },
            { label: 'View rate history', icon: 'fileText', onSelect: () => toast('Open Table of charges to see the rate history.') },
            '-',
            { label: 'Remove line', icon: 'trash', danger: true, onSelect: () => onDialog({ kind: 'removeLine', line: l }) },
          ]}
        />
      ),
    },
  ];

  return (
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

  const push = () => {
    const first = !w.picking;
    const n = changes.length;
    const p = W.pushToHireHop(w);
    toast(
      first
        ? `Kit list sent to Hire Hop as ${p.hireHopRef}. The warehouse picks against this list.`
        : n
          ? `${p.hireHopRef} updated to v${p.version} — ${n} change${n > 1 ? 's' : ''} sent. Same reference, so the warehouse knows it supersedes the last one.`
          : `${p.hireHopRef} re-sent unchanged (v${p.version}).`,
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
            Hire Hop code {chargeById(l.chargeId)?.hireHopCode || '—'}
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
                Prepared when the client confirmed; pushed to Hire Hop over its API so Pete's team pick
                against one list.
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
                      <span className="font-mono text-[12.5px]">{w.picking.hireHopRef}</span>
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
                <Row label="Status" value={w.picking.status} />
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
                {changes.length ? 'Re-send amended kit list' : 'Re-send kit list to Hire Hop'}
              </button>
              <p className="text-[11.5px] text-ink-3 mt-2 leading-relaxed">
                Re-sending keeps {w.picking.hireHopRef} and raises its version, so the warehouse has one
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

                  <button type="button" className="btn btn-primary btn-sm w-full mt-3" onClick={push}>
                    Send kit list to Hire Hop
                  </button>
                  <p className="text-[11.5px] text-ink-3 mt-2 leading-relaxed">
                    {kit.length} lines, {kit.reduce((s, l) => s + l.qty, 0).toLocaleString()} items.
                    Sending assigns the Hire Hop reference — once, and it is never reissued.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-[13px] text-ink-2 leading-relaxed mb-3">
                    Nothing sent yet. {kit.length} kit lines totalling{' '}
                    {kit.reduce((s, l) => s + l.qty, 0).toLocaleString()} items are ready to go.
                  </p>
                  <button type="button" className="btn btn-primary btn-sm w-full" onClick={push}>
                    Send kit list to Hire Hop
                  </button>
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

function HistoryTab({ w }: { w: W.Wof }) {
  const h = (w.history || []).slice().reverse();
  if (!h.length) {
    return <EmptyState title="No history" body="Nothing has happened to this WOF yet." />;
  }

  return (
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
  );
}
