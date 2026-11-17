/* ============================================================================
   ATTENDANCE — was 🔴 BROKEN (a top-level nav item that 404'd)
   ----------------------------------------------------------------------------
   The critique called this the most damaging bug in the set: a primary nav item
   leading to "Page not found" destroys trust in every other link. So the route
   is built rather than hidden.

   This is the settled history that Check-In Approvals feeds into — approved
   timesheets, hours, and the no-show / late record that drives staff strikes.

   A manager with `attendance.edit` can correct the hours on an approved row
   (worked 9, not 8). The change goes through CHECKINS.amend, which keeps who,
   when, before/after and why — shown under "Approved by" and in the dialog.
   ========================================================================== */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { Avatar, EmptyState, PageHeader, Pill, StatStripe } from '@/components/primitives';
import { useToast } from '@/components/Toast';
import { Modal } from '@/components/Modal';
import * as CHECKINS from '@/lib/checkins';
import * as ROLES from '@/lib/roles';
import * as W from '@/lib/wof';
import { useCheckInsVersion, useRolesVersion, useWofVersion } from '@/lib/useStore';
import { TONE_HEX } from '@/lib/status';
import { countLabel, fmtDate, fmtDateTime } from '@/lib/format';
import { ATTENDANCE, employee as employeeById, event as eventById } from '@/data/db';
import type { AttendanceRow, Tone } from '@/data/types';

const PER_PAGE = 20;

const OUTCOMES: [string, string][] = [
  ['all', 'Any outcome'],
  ['worked', 'Worked'],
  ['late', 'Late'],
  ['overtime', 'Overtime'],
  ['no-show', 'No show'],
  ['cancelled', 'Cancelled'],
];

type SortKey = 'date' | 'hours';

/**
 * One line on the page. Timesheets live in two places, the same two
 * `W.timesheets()` joins for payroll and costing:
 *
 *   · ATTENDANCE — clocked shifts approved through Check-In Approvals, for jobs
 *     run through the staffing tool. These carry clock times and can be amended.
 *   · `wof.timesheets` — hours recorded on a delivered job that never had a
 *     staffing event. No clock times; read-only here.
 *
 * Reading only ATTENDANCE is what made every delivered job vanish from this
 * page while payroll was still paying for it.
 */
interface SheetRow {
  key: string;
  wof: W.Wof | null;
  eventId: string | null;
  employeeId: string;
  date: string;
  role: string;
  scheduled: string;
  actual: string;
  hours: number;
  outcome: AttendanceRow['outcome'];
  approvedBy: string;
  /** The clocked record behind the row, when there is one — the editable kind. */
  att: AttendanceRow | null;
}

function collectRows(): SheetRow[] {
  const rows: SheetRow[] = [];
  W.all().forEach((w) => {
    (w.timesheets || []).forEach((t, i) =>
      rows.push({
        key: `${w.id}-ts${i}`,
        wof: w,
        eventId: null,
        employeeId: t.employeeId,
        date: t.date,
        role: t.role,
        scheduled: t.scheduled || '—',
        actual: '—',
        hours: t.hours || 0,
        outcome: t.outcome || 'worked',
        approvedBy: t.approvedBy || 'Jake Wright',
        att: null,
      }),
    );
  });
  ATTENDANCE.forEach((a) =>
    rows.push({
      key: a.id,
      wof: W.byEvent(a.eventId) || null,
      eventId: a.eventId,
      employeeId: a.employeeId,
      date: a.date,
      role: a.role,
      scheduled: a.scheduled,
      actual: a.actual,
      hours: a.hours,
      outcome: a.outcome,
      approvedBy: a.approvedBy,
      att: a,
    }),
  );
  return rows;
}

const DELIVERED_STAGES = new Set(['invoice', 'paid', 'complete', 'closed']);
const stageLabel = (w: W.Wof): string => W.STAGES.find((s) => s.id === w.stage)?.label ?? w.stage;

/** Why a row cannot be amended, or null if it can. */
function amendBlock(r: SheetRow): string | null {
  const gate = ROLES.denial('attendance.edit');
  if (gate) return gate;
  if (r.wof?.invoice) {
    return `Invoiced as ${r.wof.invoice.number} — these hours are locked. Correct them with a variation or credit on the job.`;
  }
  if (!r.att) return 'Hours recorded on the work order, not clocked in — amend them on the job.';
  return null;
}

const JOB_STATES: [string, string][] = [
  ['all', 'Any job'],
  ['live', 'In delivery'],
  ['delivered', 'Delivered'],
];

export default function AttendancePage() {
  const toast = useToast();
  useCheckInsVersion();
  useRolesVersion();
  useWofVersion();
  const [editing, setEditing] = useState<AttendanceRow | null>(null);
  const [jobState, setJobState] = useState('all');
  const [q, setQ] = useState('');
  const [outcome, setOutcome] = useState('all');
  const [wofId, setWofId] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'date', dir: -1 });
  const [page, setPage] = useState(1);

  const all = collectRows();
  const rows = all.filter((a) => {
    if (outcome !== 'all' && a.outcome !== outcome) return false;
    if (wofId !== 'all' && a.wof?.id !== wofId) return false;
    if (jobState !== 'all') {
      const delivered = !!a.wof && DELIVERED_STAGES.has(a.wof.stage);
      if ((jobState === 'delivered') !== delivered) return false;
    }
    if (from && a.date < from) return false;
    if (to && a.date > to) return false;
    if (q) {
      const emp = employeeById(a.employeeId);
      const w = a.wof;
      const hay = `${emp?.name ?? ''} ${a.role} ${w?.ref ?? ''} ${w?.title ?? ''}`;
      if (!hay.toLowerCase().includes(q.toLowerCase())) return false;
    }
    return true;
  }).sort((a, b) => {
    const va = a[sort.key];
    const vb = b[sort.key];
    const r = typeof va === 'string' ? va.localeCompare(String(vb)) : (va as number) - (vb as number);
    return r * sort.dir;
  });

  // Only the work orders that actually have timesheets — a filter offering
  // jobs that can never match is a filter that looks broken.
  const wofOptions = [...new Map(all.filter((r) => r.wof).map((r) => [r.wof!.id, r.wof!])).values()]
    .sort((a, b) => a.ref.localeCompare(b.ref));

  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  const current = Math.min(page, pages);
  const pageRows = rows.slice((current - 1) * PER_PAGE, current * PER_PAGE);

  const hours = rows.reduce((s, r) => s + r.hours, 0);
  const noShows = rows.filter((r) => r.outcome === 'no-show').length;
  const late = rows.filter((r) => r.outcome === 'late').length;
  const reliability = rows.length ? Math.round(((rows.length - noShows - late) / rows.length) * 100) : 100;

  const toggleSort = (k: SortKey) =>
    setSort((s) => (s.key === k ? { key: k, dir: (-s.dir as 1 | -1) } : { key: k, dir: 1 }));

  const clear = () => {
    setQ('');
    setOutcome('all');
    setWofId('all');
    setJobState('all');
    setFrom('');
    setTo('');
    setPage(1);
  };

  const th = (key: SortKey, label: string) => {
    const on = sort.key === key;
    return (
      <th
        className="is-sortable"
        aria-sort={on ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
        tabIndex={0}
        role="button"
        onClick={() => toggleSort(key)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleSort(key);
          }
        }}
      >
        <span className="inline-flex items-center gap-1">
          {label}
          {on ? <Icon name={sort.dir === 1 ? 'chevronUp' : 'chevronDown'} decorative className="icon-sm" /> : null}
        </span>
      </th>
    );
  };

  return (
    <>
      <PageHeader
        title="Timesheets"
        subtitle="Approved timesheets and the worked record behind them. This is what billing and staff strikes are calculated from."
        actions={
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() =>
              toast(`Exporting ${countLabel(rows.length, 'record')} · ${hours.toFixed(1)} billable hours.`, {
                tone: 'healthy',
              })
            }
          >
            <Icon name="download" decorative /> Export for billing
          </button>
        }
      />

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 mb-4">
        <Stat label="Shifts recorded" value={rows.length} tone="info" />
        <Stat label="Hours worked" value={hours.toFixed(1)} tone="healthy" />
        <Stat label="Late arrivals" value={late} tone={late ? 'atRisk' : 'neutral'} />
        <Stat label="No shows" value={noShows} tone={noShows ? 'critical' : 'neutral'} />
      </div>

      <div className="card p-3.5 mb-4">
        <div className="flex flex-wrap items-end gap-2.5">
          <div className="relative flex-1 min-w-[200px] max-w-xs">
            <label className="block text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1.5" htmlFor="q">
              Search
            </label>
            <span className="absolute left-3 bottom-2 text-ink-3 pointer-events-none">
              <Icon name="search" decorative className="icon-sm" />
            </span>
            <input
              className="field pl-8"
              id="q"
              type="search"
              placeholder="Worker, role or WOF…"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1.5" htmlFor="outcome">
              Outcome
            </label>
            <select
              className="field w-auto"
              id="outcome"
              value={outcome}
              onChange={(e) => {
                setOutcome(e.target.value);
                setPage(1);
              }}
            >
              {OUTCOMES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1.5" htmlFor="jobState">
              Job
            </label>
            <select
              className="field w-auto"
              id="jobState"
              value={jobState}
              onChange={(e) => {
                setJobState(e.target.value);
                setPage(1);
              }}
            >
              {JOB_STATES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1.5" htmlFor="wofId">
              Work order
            </label>
            <select
              className="field w-auto"
              id="wofId"
              value={wofId}
              onChange={(e) => {
                setWofId(e.target.value);
                setPage(1);
              }}
            >
              <option value="all">All work orders</option>
              {wofOptions.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.ref} · {w.title}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1.5" htmlFor="from">
              From
            </label>
            <input className="field w-auto" id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1.5" htmlFor="to">
              To
            </label>
            <input className="field w-auto" id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>

          <div className="flex-1" />
          <div className="pb-0.5">
            <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1.5">Reliability</div>
            <div
              className="text-[20px] font-bold leading-none tabular-nums"
              style={{ color: TONE_HEX[reliability >= 90 ? 'healthy' : reliability >= 75 ? 'atRisk' : 'critical'] }}
            >
              {reliability}%
            </div>
          </div>
        </div>
      </div>

      <section className="card">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-surface-line-soft">
          <span className="text-[13px] text-ink-2">
            <strong className="text-ink">{rows.length.toLocaleString()}</strong> of{' '}
            {all.length.toLocaleString()} records
          </span>
          <Link className="btn btn-ghost btn-sm" to="/check-in-approvals">
            <Icon name="checkin" decorative className="icon-sm" /> Pending approvals
          </Link>
        </div>

        {rows.length ? (
          <>
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    {th('date', 'Date')}
                    <th>Worker</th>
                    <th>Work order</th>
                    <th>Role</th>
                    <th>Scheduled</th>
                    <th>Actual</th>
                    {th('hours', 'Hours')}
                    <th>Outcome</th>
                    <th>Approved by</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r) => (
                    <Row key={r.key} r={r} onEdit={() => r.att && setEditing(r.att)} />
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-surface-line-soft">
              <span className="text-[12.5px] text-ink-3">
                Showing {(current - 1) * PER_PAGE + 1}–{Math.min(current * PER_PAGE, rows.length)} of{' '}
                {rows.length.toLocaleString()}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="btn-icon"
                  disabled={current === 1}
                  aria-label="Previous page"
                  onClick={() => setPage(current - 1)}
                >
                  <Icon name="chevronLeft" decorative />
                </button>
                <span className="text-[12.5px] text-ink-2 px-2 tabular-nums">
                  Page {current} of {pages}
                </span>
                <button
                  type="button"
                  className="btn-icon"
                  disabled={current === pages}
                  aria-label="Next page"
                  onClick={() => setPage(current + 1)}
                >
                  <Icon name="chevronRight" decorative />
                </button>
              </div>
            </div>
          </>
        ) : (
          <EmptyState
            iconName="attendance"
            title="No attendance records match"
            body="Records appear here once a check-in has been approved. Try widening the date range or clearing the filters."
            action={
              <button type="button" className="btn btn-secondary" onClick={clear}>
                Clear filters
              </button>
            }
          />
        )}
      </section>

      {editing ? (
        <AmendHoursDialog
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={(am) => {
            setEditing(null);
            const d = Math.round((am.to.hours - am.from.hours) * 100) / 100;
            toast(`Timesheet amended: ${am.from.hours}h → ${am.to.hours}h (${d > 0 ? '+' : ''}${d}h). Payroll and billing now use the new hours.`, {
              tone: 'healthy',
            });
          }}
        />
      ) : null}
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone: Tone }) {
  return (
    <div className="card p-3.5 relative overflow-hidden">
      <StatStripe tone={tone} />
      <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1.5">{label}</div>
      <div className="text-[24px] font-bold leading-none tabular-nums" style={{ color: tone === 'neutral' ? 'var(--hue-navy-fg)' : TONE_HEX[tone] }}>
        {value}
      </div>
    </div>
  );
}

function Row({ r: a, onEdit }: { r: SheetRow; onEdit: () => void }) {
  const emp = employeeById(a.employeeId);
  const ev = a.eventId ? eventById(a.eventId) : undefined;
  const w = a.wof;
  const last = a.att ? CHECKINS.lastAmendment(a.att.id) : null;
  const blocked = amendBlock(a);
  return (
    <tr>
      <td className="text-ink-2 text-[13px] whitespace-nowrap">{fmtDate(a.date)}</td>
      <td>
        {emp ? (
          <Link to={`/staff/${emp.id}`} className="flex items-center gap-2.5 no-underline group">
            <Avatar hue={emp.hue} initials={emp.initials} size={26} />
            <span className="text-[13.5px] text-ink group-hover:text-accent">{emp.name}</span>
          </Link>
        ) : (
          <span className="text-ink-3">—</span>
        )}
      </td>
      <td>
        {w ? (
          <Link to={`/wofs/${w.id}`} className="block no-underline group">
            <span className="block text-[13px] text-ink-2 group-hover:text-accent group-hover:underline">{w.title}</span>
            <span className="block text-[11.5px] text-ink-3 tabular-nums">
              {w.ref} · {stageLabel(w)}
            </span>
          </Link>
        ) : ev ? (
          <Link to={`/events/${ev.id}`} className="block no-underline group">
            <span className="block text-[13px] text-ink-2 group-hover:text-accent group-hover:underline">{ev.name}</span>
            <span className="block text-[11.5px] text-status-at-risk">No work order</span>
          </Link>
        ) : (
          <span className="text-ink-3">—</span>
        )}
      </td>
      <td className="text-ink-2 text-[13px]">{a.role}</td>
      <td className="text-ink-2 text-[13px] tabular-nums">{a.scheduled}</td>
      {a.att ? (
        <td className={`text-[13px] tabular-nums ${a.outcome === 'worked' ? 'text-ink-2' : 'text-status-at-risk'}`}>
          {a.actual}
        </td>
      ) : (
        <td className="text-[12.5px] text-ink-3">
          <span className="tip" tabIndex={0} data-tip="Hours were recorded on the work order after the job, not clocked in on site.">
            Not clocked
          </span>
        </td>
      )}
      <td className="text-[13px] tabular-nums text-ink-2 whitespace-nowrap">
        {a.hours ? `${a.hours}h` : '—'}
        {last ? (
          <span
            className="tip ml-1.5 text-[11px] text-ink-3 line-through"
            tabIndex={0}
            data-tip={`Approved as ${CHECKINS.asApproved(a.att!).hours}h`}
          >
            {CHECKINS.asApproved(a.att!).hours}h
          </span>
        ) : null}
      </td>
      <td>
        <Pill status={a.outcome} />
      </td>
      <td className="text-[12.5px]">
        <div className="text-ink-3">{a.approvedBy}</div>
        {last ? (
          <div
            className="tip text-[11.5px] text-status-info mt-0.5 whitespace-nowrap"
            tabIndex={0}
            data-tip={`${fmtDateTime(last.at)} · ${last.from.hours}h → ${last.to.hours}h · “${last.reason}”`}
          >
            Amended by {last.name}
          </div>
        ) : null}
      </td>
      <td className="text-right">
        <button
          type="button"
          className="btn-icon"
          aria-label={`Amend hours for ${emp?.name ?? 'this worker'} on ${fmtDate(a.date)}`}
          disabled={!!blocked}
          title={blocked || 'Amend hours'}
          onClick={onEdit}
        >
          <Icon name="edit" decorative className="icon-sm" />
        </button>
      </td>
    </tr>
  );
}

function AmendHoursDialog({
  row,
  onClose,
  onSaved,
}: {
  row: AttendanceRow;
  onClose: () => void;
  onSaved: (am: CHECKINS.Amendment) => void;
}) {
  const emp = employeeById(row.employeeId);
  const ev = eventById(row.eventId);
  const [s0, f0] = CHECKINS.splitRange(row.actual);
  const [sch0, schF] = CHECKINS.splitRange(row.scheduled);
  const [start, setStart] = useState(s0 || sch0 || '');
  const [finish, setFinish] = useState(f0 || schF || '');
  // null = follow the times; a number = the manager typed the hours themselves.
  const [hoursTyped, setHoursTyped] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const span = CHECKINS.hoursFromTimes(start, finish);
  const hours = hoursTyped === null ? span : parseFloat(hoursTyped);
  const diff = Number.isFinite(hours) ? Math.round((hours - row.hours) * 100) / 100 : 0;
  const history = CHECKINS.amendmentsFor(row.id);

  const save = () => {
    const r = CHECKINS.amend(
      row.id,
      { start, finish, hours: hoursTyped === null ? undefined : hours, reason },
      ROLES.actingActor(),
    );
    if (!r.ok || !r.amendment) setError(r.error || 'Could not save.');
    else onSaved(r.amendment);
  };

  return (
    <Modal
      title="Amend timesheet hours"
      onClose={onClose}
      width={560}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={save}>
            Save amendment
          </button>
        </>
      }
    >
      <div className="text-[13px] text-ink-2 mb-4 leading-relaxed">
        <strong className="text-ink">{emp?.name ?? 'Unknown worker'}</strong> · {row.role}
        <br />
        {W.byEvent(row.eventId)?.ref ? `${W.byEvent(row.eventId)!.ref} · ` : ''}
        {W.byEvent(row.eventId)?.title ?? ev?.name ?? '—'} · {fmtDate(row.date)} · scheduled {row.scheduled}
      </div>

      <div className="grid grid-cols-3 gap-3">
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Start</span>
          <input className="field" type="time" value={start} onChange={(e) => { setStart(e.target.value); setError(null); }} />
        </label>
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Finish</span>
          <input className="field" type="time" value={finish} onChange={(e) => { setFinish(e.target.value); setError(null); }} />
        </label>
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Hours to pay</span>
          <input
            className="field tabular-nums"
            type="number"
            step="0.25"
            min="0"
            max="24"
            value={hoursTyped === null ? String(span) : hoursTyped}
            onChange={(e) => { setHoursTyped(e.target.value); setError(null); }}
          />
        </label>
      </div>
      <p className="text-[11.5px] text-ink-3 mt-1.5 leading-relaxed">
        Hours follow the start and finish unless you type them — e.g. to take off an unpaid break.
        {hoursTyped !== null ? (
          <>
            {' '}
            <button type="button" className="text-accent underline" onClick={() => setHoursTyped(null)}>
              Use {span}h from the times
            </button>
          </>
        ) : null}
      </p>

      <label className="block mt-4">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
          Reason <span className="text-status-critical">*</span>
        </span>
        <textarea
          className="field"
          rows={2}
          placeholder="e.g. Stayed on to clear the car park — confirmed by site lead"
          value={reason}
          onChange={(e) => { setReason(e.target.value); setError(null); }}
        />
      </label>

      <div className="well p-3 mt-4 flex items-center justify-between gap-3">
        <span className="text-[12.5px] text-ink-2">
          Now {row.actual} · {row.hours}h
        </span>
        <span className="text-[14px] font-semibold tabular-nums text-ink">
          {Number.isFinite(hours) ? `${hours}h` : '—'}
          {diff ? (
            <span className="ml-1.5 text-[12.5px]" style={{ color: TONE_HEX[diff > 0 ? 'atRisk' : 'info'] }}>
              ({diff > 0 ? '+' : ''}
              {diff}h)
            </span>
          ) : null}
        </span>
      </div>
      <p className="text-[11.5px] text-ink-3 mt-1.5 leading-relaxed">
        Recorded against your name ({ROLES.acting().name}). Payroll, billing and the client's hours all read the new figure.
      </p>

      {error ? (
        <p role="alert" className="text-[12.5px] text-status-critical mt-3">
          {error}
        </p>
      ) : null}

      {history.length ? (
        <>
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2 mt-5">Change history</div>
          <ol className="space-y-2">
            {[...history].reverse().map((h) => (
              <li key={h.id} className="text-[12.5px] text-ink-2 leading-relaxed">
                <span className="text-ink font-medium">{h.name}</span>{' '}
                <span className="text-ink-3">· {fmtDateTime(h.at)}</span>
                <br />
                <span className="tabular-nums">
                  {h.from.actual} · {h.from.hours}h → {h.to.actual} · {h.to.hours}h
                </span>
                <span className="text-ink-3"> — “{h.reason}”</span>
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </Modal>
  );
}
