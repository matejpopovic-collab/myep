/* ============================================================================
   ATTENDANCE — was 🔴 BROKEN (a top-level nav item that 404'd)
   ----------------------------------------------------------------------------
   The critique called this the most damaging bug in the set: a primary nav item
   leading to "Page not found" destroys trust in every other link. So the route
   is built rather than hidden.

   This is the settled history that Check-In Approvals feeds into — approved
   timesheets, hours, and the no-show / late record that drives staff strikes.
   ========================================================================== */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { Avatar, EmptyState, PageHeader, Pill } from '@/components/primitives';
import { useToast } from '@/components/Toast';
import { TONE_HEX } from '@/lib/status';
import { countLabel, fmtDate } from '@/lib/format';
import { ATTENDANCE, EVENTS, employee as employeeById, event as eventById } from '@/data/db';
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

export default function AttendancePage() {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [outcome, setOutcome] = useState('all');
  const [eventId, setEventId] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'date', dir: -1 });
  const [page, setPage] = useState(1);

  const rows = ATTENDANCE.filter((a) => {
    if (outcome !== 'all' && a.outcome !== outcome) return false;
    if (eventId !== 'all' && a.eventId !== eventId) return false;
    if (from && a.date < from) return false;
    if (to && a.date > to) return false;
    if (q) {
      const emp = employeeById(a.employeeId);
      if (!`${emp?.name ?? ''} ${a.role}`.toLowerCase().includes(q.toLowerCase())) return false;
    }
    return true;
  }).sort((a, b) => {
    const va = a[sort.key];
    const vb = b[sort.key];
    const r = typeof va === 'string' ? va.localeCompare(String(vb)) : (va as number) - (vb as number);
    return r * sort.dir;
  });

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
    setEventId('all');
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
        title="Attendance"
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
              placeholder="Worker or role…"
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
            <label className="block text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1.5" htmlFor="eventId">
              Event
            </label>
            <select
              className="field w-auto"
              id="eventId"
              value={eventId}
              onChange={(e) => {
                setEventId(e.target.value);
                setPage(1);
              }}
            >
              <option value="all">All events</option>
              {EVENTS.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
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
            {ATTENDANCE.length.toLocaleString()} records
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
                    <th>Event</th>
                    <th>Role</th>
                    <th>Scheduled</th>
                    <th>Actual</th>
                    {th('hours', 'Hours')}
                    <th>Outcome</th>
                    <th>Approved by</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((a) => (
                    <Row key={a.id} a={a} />
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

function Row({ a }: { a: AttendanceRow }) {
  const emp = employeeById(a.employeeId);
  const ev = eventById(a.eventId);
  return (
    <tr>
      <td className="text-ink-2 text-[13px] whitespace-nowrap">{fmtDate(a.date)}</td>
      <td>
        {emp ? (
          <Link to={`/staff?id=${emp.id}`} className="flex items-center gap-2.5 no-underline group">
            <Avatar hue={emp.hue} initials={emp.initials} size={26} />
            <span className="text-[13.5px] text-ink group-hover:text-accent">{emp.name}</span>
          </Link>
        ) : (
          <span className="text-ink-3">—</span>
        )}
      </td>
      <td>
        {ev ? (
          <Link to={`/events/${ev.id}`} className="text-[13px] text-ink-2 no-underline hover:text-accent hover:underline">
            {ev.name}
          </Link>
        ) : (
          <span className="text-ink-3">—</span>
        )}
      </td>
      <td className="text-ink-2 text-[13px]">{a.role}</td>
      <td className="text-ink-2 text-[13px] tabular-nums">{a.scheduled}</td>
      <td className={`text-[13px] tabular-nums ${a.outcome === 'worked' ? 'text-ink-2' : 'text-status-at-risk'}`}>
        {a.actual}
      </td>
      <td className="text-[13px] tabular-nums text-ink-2">{a.hours ? `${a.hours}h` : '—'}</td>
      <td>
        <Pill status={a.outcome} />
      </td>
      <td className="text-ink-3 text-[12.5px]">{a.approvedBy}</td>
    </tr>
  );
}
