/* ============================================================================
   CHECK-IN APPROVALS — was 🔴 BROKEN
   ----------------------------------------------------------------------------
   In the live app this page rendered `chevron_left`, `chevron_right`,
   `refresh`, `lightbulb` and `check_circle` as literal text because the
   Material Symbols font never loaded, and the layout had collapsed entirely: no
   card, no container, the date navigator centre-top and the refresh button
   orphaned on the left.

   Two root causes, both fixed:
     1. Icon font  -> every icon in this rebuild is inline SVG (components/Icon).
                      Nothing to fetch, so no ligature can ever flash as text.
     2. No layout  -> the page uses the same card container as every other
                      screen, and the empty state has real structure.
   ========================================================================== */

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { Avatar, EmptyState, PageHeader, Pill } from '@/components/primitives';
import { ConfirmDestructive, MenuButton, Modal } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { TONE_BG, TONE_HEX } from '@/lib/status';
import { countLabel, fmtDate, fmtDateFull, fmtTime } from '@/lib/format';
import { CHECK_INS, NOW, employee as employeeById, event as eventById } from '@/data/db';
import type { CheckIn, Tone } from '@/data/types';

type Filter = 'all' | 'flagged' | 'clean';

function mondayOf(v: Date): Date {
  const x = new Date(v);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

/* A half-recorded shift shouldn't render as a run of dashes ("06:58——").
   Show the time that exists and name the one that doesn't. */
function actualRange(c: CheckIn): string {
  const i = c.actualIn ? fmtTime(c.actualIn) : null;
  const o = c.actualOut ? fmtTime(c.actualOut) : null;
  if (i && o) return `${i}–${o}`;
  if (i) return `${i} · no clock-out`;
  if (o) return `no clock-in · ${o}`;
  return 'Nothing recorded';
}

const hoursOf = (c: CheckIn): number | null =>
  c.actualIn && c.actualOut ? (+new Date(c.actualOut) - +new Date(c.actualIn)) / 3600000 : null;

export default function CheckInApprovalsPage() {
  const toast = useToast();
  const navigate = useNavigate();

  const [weekStart, setWeekStart] = useState(() => mondayOf(NOW));
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Approving rows removes them from the queue, so the operator can reach the
  // (previously undesigned) empty state.
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null);
  const [adjusting, setAdjusting] = useState<CheckIn | null>(null);
  const [rejecting, setRejecting] = useState<CheckIn | null>(null);

  const weekEnd = (() => {
    const x = new Date(weekStart);
    x.setDate(x.getDate() + 6);
    x.setHours(23, 59, 59);
    return x;
  })();

  const pending = CHECK_INS.filter((c) => !approved.has(c.id));
  const rows = pending
    .filter((c) => {
      const t = new Date(c.scheduledIn);
      return t >= weekStart && t <= weekEnd;
    })
    .filter((c) => filter === 'all' || (filter === 'flagged' ? !!c.flag : !c.flag));

  const flagged = pending.filter((c) => c.flag).length;
  const clean = pending.length - flagged;
  const sel = selected.size;
  const hoursPending = pending.reduce((s, c) => s + (hoursOf(c) ?? 0), 0);

  const shiftWeek = (days: number) => {
    setWeekStart((w) => {
      const x = new Date(w);
      x.setDate(x.getDate() + days);
      return x;
    });
    setSelected(new Set());
  };

  const doApprove = (ids: string[]) => {
    setApproved((s) => {
      const next = new Set(s);
      ids.forEach((id) => next.add(id));
      return next;
    });
    setSelected(new Set());
    toast(`${countLabel(ids.length, 'timesheet')} approved and released for billing.`, { tone: 'healthy' });
  };

  const approve = (ids: string[]) => {
    const withFlags = ids.filter((id) => CHECK_INS.find((c) => c.id === id)?.flag);
    if (withFlags.length) setConfirmIds(ids);
    else doApprove(ids);
  };

  return (
    <>
      <PageHeader
        title="Check-In Approvals"
        subtitle="Approve worker timesheets to release them for billing. Flagged rows need a decision before they can be approved."
        actions={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={refreshing}
              onClick={() => {
                setRefreshing(true);
                window.setTimeout(() => {
                  setRefreshing(false);
                  toast('Check-in queue refreshed.', { tone: 'healthy' });
                }, 400);
              }}
            >
              <Icon name="refresh" decorative /> Refresh
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!clean}
              onClick={() => doApprove(pending.filter((c) => !c.flag).map((c) => c.id))}
            >
              <Icon name="check" decorative /> Approve {clean} clean
            </button>
          </>
        }
      />

      {pending.length ? (
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 mb-4">
          <Stat label="Waiting" value={pending.length} tone="info" />
          <Stat label="Flagged" value={flagged} tone="critical" />
          <Stat label="Clean" value={clean} tone="healthy" />
          <Stat label="Hours pending" value={hoursPending.toFixed(1)} tone="neutral" />
        </div>
      ) : null}

      {/* Date navigator: labelled controls in a proper container, rather than
          floating centre-top with an orphaned refresh button. */}
      <div className="card p-3 mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <button type="button" className="btn-icon" aria-label="Previous week" onClick={() => shiftWeek(-7)}>
            <Icon name="chevronLeft" decorative />
          </button>
          <span className="text-[13.5px] font-semibold text-ink px-2 tabular-nums min-w-[190px] text-center">
            {fmtDate(weekStart)} – {fmtDateFull(weekEnd)}
          </span>
          <button type="button" className="btn-icon" aria-label="Next week" onClick={() => shiftWeek(7)}>
            <Icon name="chevronRight" decorative />
          </button>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setWeekStart(mondayOf(NOW));
            setSelected(new Set());
          }}
        >
          This week
        </button>

        <div className="h-5 w-px bg-surface-line mx-1" />

        <div className="flex items-center gap-1.5">
          {(['all', 'flagged', 'clean'] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              className="chip"
              aria-pressed={filter === f}
              onClick={() => {
                setFilter(f);
                setSelected(new Set());
              }}
            >
              {f === 'all' ? 'All' : f === 'flagged' ? 'Flagged only' : 'Clean only'}
            </button>
          ))}
        </div>

        <div className="flex-1" />
        <span className="text-[12.5px] text-ink-3">Updates automatically as workers clock out</span>
      </div>

      {sel ? (
        <div className="card p-3 mb-4 flex items-center gap-2">
          <span className="text-[13px] text-ink-2 flex-1">{countLabel(sel, 'timesheet')} selected</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => approve([...selected])}>
            Approve {sel}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => toast(`Opening the timesheet editor for ${countLabel(sel, 'row')}.`)}
          >
            Adjust times
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      ) : null}

      <section className="card">
        {rows.length ? (
          <>
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 38 }}>
                      <input
                        type="checkbox"
                        aria-label="Select all timesheets in view"
                        checked={sel === rows.length && rows.length > 0}
                        onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
                      />
                    </th>
                    <th>Worker</th>
                    <th>Event</th>
                    <th>Role</th>
                    <th>Scheduled</th>
                    <th>Actual</th>
                    <th>Hours</th>
                    <th>Review</th>
                    <th style={{ width: 130 }}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <Row
                      key={c.id}
                      c={c}
                      selected={selected.has(c.id)}
                      onSelect={(on) =>
                        setSelected((s) => {
                          const next = new Set(s);
                          if (on) next.add(c.id);
                          else next.delete(c.id);
                          return next;
                        })
                      }
                      onApprove={() => approve([c.id])}
                      onAdjust={() => setAdjusting(c)}
                      onReject={() => setRejecting(c)}
                      onViewWorker={() => navigate(`/staff?id=${c.employeeId}`)}
                      onNote={() => toast('Note added to the timesheet.')}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-3 border-t border-surface-line-soft text-[12.5px] text-ink-3">
              {countLabel(rows.length, 'timesheet')} in this week
            </div>
          </>
        ) : (
          <EmptyState
            iconName="checkCircle"
            title="All caught up"
            body={
              filter !== 'all'
                ? `No ${filter} timesheets in this week. Switch the filter to see the rest.`
                : `Every check-in for ${fmtDate(weekStart)} – ${fmtDateFull(weekEnd)} has been approved and released for billing. New rows appear here automatically as workers clock out.`
            }
            action={
              <div className="flex gap-2">
                <Link className="btn btn-primary" to="/attendance">
                  View attendance log
                </Link>
                <button type="button" className="btn btn-secondary" onClick={() => shiftWeek(7)}>
                  Check next week
                </button>
              </div>
            }
          />
        )}
      </section>

      {confirmIds ? (
        <ApproveFlaggedDialog
          ids={confirmIds}
          onClose={() => setConfirmIds(null)}
          onConfirm={() => {
            const ids = confirmIds;
            setConfirmIds(null);
            doApprove(ids);
          }}
        />
      ) : null}

      {adjusting ? (
        <AdjustDialog
          c={adjusting}
          onClose={() => setAdjusting(null)}
          onSave={() => {
            const c = adjusting;
            setAdjusting(null);
            setApproved((s) => new Set(s).add(c.id));
            toast(`${employeeById(c.employeeId)?.name}'s timesheet adjusted and approved.`, { tone: 'healthy' });
          }}
        />
      ) : null}

      {rejecting ? (
        <ConfirmDestructive
          title={`Reject ${employeeById(rejecting.employeeId)?.name}'s check-in?`}
          confirmLabel="Reject check-in"
          message={`The timesheet will be marked unpaid and ${employeeById(rejecting.employeeId)?.name} will be notified. A supervisor can reinstate it later.`}
          onClose={() => setRejecting(null)}
          onConfirm={() => {
            const c = rejecting;
            setRejecting(null);
            setApproved((s) => new Set(s).add(c.id));
            toast('Check-in rejected.', { tone: 'critical' });
          }}
        />
      ) : null}
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone: Tone }) {
  return (
    <div className="card p-3.5">
      <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1.5">{label}</div>
      <div className="text-[24px] font-bold leading-none tabular-nums" style={{ color: TONE_HEX[tone] }}>
        {value}
      </div>
    </div>
  );
}

function Row({
  c, selected, onSelect, onApprove, onAdjust, onReject, onViewWorker, onNote,
}: {
  c: CheckIn;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onApprove: () => void;
  onAdjust: () => void;
  onReject: () => void;
  onViewWorker: () => void;
  onNote: () => void;
}) {
  const emp = employeeById(c.employeeId);
  const ev = eventById(c.eventId);
  const hrs = hoursOf(c);
  const flagTone: Tone = c.flag?.includes('No show') ? 'critical' : 'atRisk';

  return (
    <tr className={selected ? 'is-selected' : undefined}>
      <td>
        <input
          type="checkbox"
          checked={selected}
          aria-label={`Select ${emp?.name}'s timesheet`}
          onChange={(e) => onSelect(e.target.checked)}
        />
      </td>
      <td>
        {emp ? (
          <Link to={`/staff?id=${emp.id}`} className="flex items-center gap-2.5 no-underline group">
            <Avatar hue={emp.hue} initials={emp.initials} size={28} />
            <span className="text-[13.5px] text-ink group-hover:text-accent">{emp.name}</span>
          </Link>
        ) : null}
      </td>
      <td>
        {ev ? (
          <Link to={`/events/${ev.id}`} className="text-[13px] text-ink-2 no-underline hover:text-accent hover:underline">
            {ev.name}
          </Link>
        ) : null}
      </td>
      <td className="text-ink-2 text-[13px]">{c.role}</td>
      <td className="text-ink-2 text-[13px] tabular-nums">
        {fmtTime(c.scheduledIn)}–{fmtTime(c.scheduledOut)}
      </td>
      <td className={`text-[13px] tabular-nums whitespace-nowrap ${c.flag ? 'text-status-at-risk' : 'text-ink-2'}`}>
        {actualRange(c)}
      </td>
      <td className="text-[13px] tabular-nums text-ink-2">{hrs ? `${hrs.toFixed(1)}h` : '—'}</td>
      <td>
        {c.flag ? (
          <span
            className="pill"
            style={{ background: TONE_BG[flagTone], color: TONE_HEX[flagTone] }}
          >
            <span className="pill-dot" style={{ background: 'currentColor' }} />
            {c.flag}
          </span>
        ) : (
          <Pill status="worked" label="No issues" hint={false} />
        )}
      </td>
      <td>
        <div className="flex gap-1.5">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onApprove}>
            Approve
          </button>
          <MenuButton
            label={`More actions for ${emp?.name}'s timesheet`}
            items={[
              { label: 'Adjust times', icon: 'clock', onSelect: onAdjust },
              { label: 'Add a note', icon: 'fileText', onSelect: onNote },
              { label: 'View worker', icon: 'staff', onSelect: onViewWorker },
              '-',
              { label: 'Reject check-in', icon: 'ban', danger: true, onSelect: onReject },
            ]}
          />
        </div>
      </td>
    </tr>
  );
}

function ApproveFlaggedDialog({
  ids,
  onClose,
  onConfirm,
}: {
  ids: string[];
  onClose: () => void;
  onConfirm: () => void;
}) {
  const flagged = ids
    .map((id) => CHECK_INS.find((c) => c.id === id)!)
    .filter((c) => c.flag);

  return (
    <Modal
      title={`Approve ${countLabel(ids.length, 'timesheet')}?`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            Approve anyway
          </button>
        </>
      }
    >
      <p className="text-[13.5px] text-ink-2 leading-relaxed">
        <strong>{flagged.length}</strong> of these {flagged.length === 1 ? 'has a flag' : 'have flags'} that
        would normally need review:
      </p>
      <ul className="mt-3 grid gap-1.5">
        {flagged.map((c) => (
          <li key={c.id} className="flex items-center gap-2 text-[13px] text-ink-2">
            <span style={{ color: TONE_HEX.atRisk }}>
              <Icon name="alert" decorative className="icon-sm" />
            </span>
            {employeeById(c.employeeId)?.name} — {c.flag}
          </li>
        ))}
      </ul>
      <p className="text-[13px] text-ink-3 mt-3">Approving accepts the recorded hours as billable.</p>
    </Modal>
  );
}

function AdjustDialog({ c, onClose, onSave }: { c: CheckIn; onClose: () => void; onSave: () => void }) {
  const emp = employeeById(c.employeeId);
  return (
    <Modal
      title={`Adjust times · ${emp?.name}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={onSave}>
            Save and approve
          </button>
        </>
      }
    >
      <p className="text-[13.5px] text-ink-2 mb-4">
        Scheduled {fmtTime(c.scheduledIn)}–{fmtTime(c.scheduledOut)} on {fmtDate(c.scheduledIn)}.{' '}
        {c.flag ? <span style={{ color: TONE_HEX.atRisk }}>{c.flag}.</span> : null}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Clock in</span>
          <input className="field" type="time" defaultValue={c.actualIn ? fmtTime(c.actualIn) ?? '' : ''} />
        </label>
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Clock out</span>
          <input className="field" type="time" defaultValue={c.actualOut ? fmtTime(c.actualOut) ?? '' : ''} />
        </label>
      </div>
      <label className="block mt-3.5">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Reason for adjustment</span>
        <input className="field" placeholder="e.g. radio handover ran late" />
      </label>
    </Modal>
  );
}
