/* ============================================================================
   CLIENT PORTAL — HOURS DELIVERED
   ----------------------------------------------------------------------------
   The billing evidence, shown to the person being billed.

   Every invoice dispute in this business is the same argument: the client
   believes fewer people turned up than were charged for. The admin Attendance
   screen already holds the answer — approved clock-in and clock-out times per
   worker per shift. Putting the same rows in front of the client, before the
   invoice rather than after it, is the cheapest possible fix.

   Two deliberate omissions:
     · No pay rate, gross, or employment type. What EP Team pays a worker is not
       what the client is charged, and mixing the two invites an argument about
       the wrong number.
     · No worker outside this client's own events. Scoping happens in
       portal.clientAttendance(), not here.

   A no-show is shown as a no-show. Hiding it would make the hours total
   unreconcilable with the shift list on the previous page, and a client who
   catches that once stops believing the rest.
   ========================================================================== */

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import {
  Avatar, EmptyState, Kpi, PageHeader, Pill, Provenance, Section,
} from '@/components/primitives';
import { DataTable, sortRows, useSort, type Column } from '@/components/DataTable';
import { useToast } from '@/components/Toast';
import { countLabel, fmtDate } from '@/lib/format';
import { employee as employeeById, event as eventById } from '@/data/db';
import type { AttendanceRow } from '@/data/types';
import * as PORTAL from '@/lib/portal';
import { useWofVersion } from '@/lib/useStore';

const OUTCOMES: [string, string][] = [
  ['all', 'Any outcome'],
  ['worked', 'Worked'],
  ['late', 'Late'],
  ['overtime', 'Overtime'],
  ['no-show', 'Did not attend'],
  ['cancelled', 'Cancelled'],
];

export default function ClientAttendancePage() {
  const toast = useToast();
  useWofVersion();
  const [params] = useSearchParams();

  const all = PORTAL.clientAttendance();
  const events = PORTAL.clientEvents().map((r) => r.event);

  const initialEvent =
    params.get('event') && events.some((e) => e.id === params.get('event'))
      ? (params.get('event') as string)
      : 'all';

  const [eventId, setEventId] = useState(initialEvent);
  const [outcome, setOutcome] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { sort, toggle } = useSort({ key: 'date', dir: -1 });

  const rows = all.filter((a) => {
    if (eventId !== 'all' && a.eventId !== eventId) return false;
    if (outcome !== 'all' && a.outcome !== outcome) return false;
    if (from && a.date < from) return false;
    if (to && a.date > to) return false;
    return true;
  });

  const hours = rows.reduce((s, r) => s + r.hours, 0);
  const delivered = rows.filter((r) => r.hours > 0).length;
  const noShows = rows.filter((r) => r.outcome === 'no-show').length;
  const late = rows.filter((r) => r.outcome === 'late').length;
  const overtime = rows.filter((r) => r.outcome === 'overtime').length;
  const reliability = rows.length ? Math.round(((rows.length - noShows - late) / rows.length) * 100) : 100;

  // Group by event so a multi-event range still reads as separate jobs rather
  // than one undifferentiated ledger.
  const byEvent = new Map<string, AttendanceRow[]>();
  rows.forEach((r) => {
    const list = byEvent.get(r.eventId) || [];
    list.push(r);
    byEvent.set(r.eventId, list);
  });

  const columns: Column<AttendanceRow>[] = [
    {
      key: 'date', label: 'Date', sortKey: 'date', nowrap: true,
      cell: (r) => <span className="text-[13px] text-ink-2">{fmtDate(r.date)}</span>,
    },
    {
      key: 'worker', label: 'Worker',
      cell: (r) => {
        const e = employeeById(r.employeeId);
        if (!e) return <span className="text-ink-3">—</span>;
        return (
          <span className="flex items-center gap-2.5">
            <Avatar hue={e.hue} initials={e.initials} size={26} />
            <span className="text-[13.5px] text-ink">{e.name}</span>
          </span>
        );
      },
    },
    {
      key: 'role', label: 'Role', sortKey: 'role',
      cell: (r) => <span className="text-[13px] text-ink-2">{r.role}</span>,
    },
    {
      key: 'scheduled', label: 'Booked', nowrap: true,
      cell: (r) => <span className="text-[13px] text-ink-2 tabular-nums">{r.scheduled}</span>,
    },
    {
      key: 'actual', label: 'Actual', nowrap: true,
      cell: (r) => (
        <span
          className={`text-[13px] tabular-nums ${r.outcome === 'worked' ? 'text-ink-2' : 'text-status-at-risk'}`}
        >
          {r.actual}
        </span>
      ),
    },
    {
      key: 'hours', label: 'Hours', sortKey: 'hours', align: 'right', nowrap: true,
      cell: (r) => (
        <span className="text-[13px] tabular-nums font-semibold text-ink">
          {r.hours ? r.hours.toFixed(1) : '—'}
        </span>
      ),
    },
    { key: 'outcome', label: 'Outcome', cell: (r) => <Pill status={r.outcome} /> },
  ];

  return (
    <>
      <PageHeader
        title="Hours delivered"
        subtitle="Approved clock-in and clock-out times for every shift worked on your events. These are the hours your invoice is built from — you are seeing them at the same time your account manager does, not after the invoice lands."
        crumbs={[{ label: 'My events', to: '/client/events' }, { label: 'Hours delivered' }]}
        actions={
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() =>
              toast(
                `${countLabel(rows.length, 'row')} · ${hours.toFixed(1)} hours. In the live system this downloads a CSV you can reconcile against the invoice.`,
                { tone: 'healthy' },
              )
            }
          >
            <Icon name="download" decorative className="icon-sm" /> Download as CSV
          </button>
        }
      />

      <div className="flex flex-wrap gap-3 mb-4">
        <Kpi
          label="Hours delivered"
          value={hours.toFixed(1)}
          sub={`${countLabel(delivered, 'shift')} actually worked`}
          tone="info"
        />
        <Kpi label="Shifts recorded" value={rows.length} sub="Every scheduled shift, worked or not" tone="neutral" />
        <Kpi
          label="Reliability"
          value={`${reliability}%`}
          sub={`${late} late, ${noShows} did not attend`}
          tone={reliability >= 95 ? 'healthy' : reliability >= 85 ? 'atRisk' : 'critical'}
        />
        <Kpi
          label="Overtime shifts"
          value={overtime}
          sub={overtime ? 'Worked beyond the booked finish time' : 'Nothing ran over'}
          tone={overtime ? 'atRisk' : 'healthy'}
        />
      </div>

      <div className="card p-3.5 mb-4">
        <div className="flex flex-wrap items-end gap-2.5">
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1.5" htmlFor="eventId">
              Event
            </label>
            <select className="field w-auto" id="eventId" value={eventId} onChange={(e) => setEventId(e.target.value)}>
              <option value="all">All my events</option>
              {events.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1.5" htmlFor="outcome">
              Outcome
            </label>
            <select className="field w-auto" id="outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              {OUTCOMES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
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
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setEventId('all');
              setOutcome('all');
              setFrom('');
              setTo('');
            }}
          >
            Clear filters
          </button>
        </div>
      </div>

      {!rows.length ? (
        <div className="card">
          <EmptyState
            iconName="attendance"
            title="No hours recorded for that selection"
            body="Hours appear here once a shift has run and the on-site supervisor has approved the check-in. For an event still to come, the shift list on My events is the place to look."
          />
        </div>
      ) : (
        [...byEvent.entries()].map(([evId, list]) => {
          const ev = eventById(evId);
          const h = list.reduce((s, r) => s + r.hours, 0);
          return (
            <div key={evId}>
              <Section
                title={ev ? ev.name : evId}
                right={
                  <span className="text-[12.5px] text-ink-2 tabular-nums">
                    {countLabel(list.length, 'shift')} · <strong className="text-ink">{h.toFixed(1)} hours</strong>
                  </span>
                }
              />
              <DataTable
                columns={columns}
                rows={sortRows(list, sort.key, sort.dir, (r, k) => (r as unknown as Record<string, string | number>)[k])}
                rowKey={(r) => r.id}
                sort={sort}
                onSort={toggle}
                footer={{
                  date: <span className="text-[12.5px] text-ink-3">{countLabel(list.length, 'shift')}</span>,
                  hours: <span className="tabular-nums font-bold text-ink">{h.toFixed(1)}</span>,
                }}
              />
            </div>
          );
        })
      )}

      <Provenance>
        Each row is a clock-in and clock-out approved by an EP Team supervisor on site. Scheduled times come
        from the booking you signed; actual times come from the check-in device. Pay rates and staff costs
        are not shown here because they are not what you are charged — your rates are the ones on your
        quote.
      </Provenance>
    </>
  );
}
