/* ============================================================================
   PAYROLL OUTPUT
   ----------------------------------------------------------------------------
   Briefing §2.3: "Per-job timesheet data showing who worked, hours, and
   applicable pay rate. Feeds payroll processing for Jenny Watt and Gracie."

   Two groupings because the two of them need different cuts of the same rows:
     By person — what Jenny pays out this period
     By job    — what Gracie reconciles against each admin sheet

   PAYE and self-employed are separated, because they leave the business by
   different routes and the totals must not be added together by accident.

   The gross figure here is byte-for-byte the actual staff cost on Job Costing.
   ========================================================================== */

import { useState } from 'react';
import { Icon } from '@/components/Icon';
import {
  Avatar, EmptyState, Kpi, PageHeader, Pill, Provenance, SearchField, Segmented,
} from '@/components/primitives';
import { DataTable, sortRows, useSort, type Column, type SortState } from '@/components/DataTable';
import { ClientLink } from '@/components/wof-ui';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { TONE_HEX } from '@/lib/status';
import { fmtDate, money, round2 } from '@/lib/format';
import { employee as employeeById } from '@/data/db';
import type { Tone } from '@/data/types';
import * as W from '@/lib/wof';
import * as ROLES from '@/lib/roles';
import { useWofVersion } from '@/lib/useStore';

interface Period {
  id: string;
  label: string;
  from: string;
  to: string;
}

const PERIODS: Period[] = [
  { id: 'p-jul-4', label: 'Week ending Sun 2 Aug', from: '2026-07-27', to: '2026-08-02' },
  { id: 'p-jul-3', label: 'Week ending Sun 26 Jul', from: '2026-07-20', to: '2026-07-26' },
  { id: 'p-jul', label: 'July 2026 (month)', from: '2026-07-01', to: '2026-07-31' },
  { id: 'p-jun', label: 'June 2026 (month)', from: '2026-06-01', to: '2026-06-30' },
  { id: 'p-all', label: 'Everything to date', from: '2020-01-01', to: '2030-12-31' },
];

type Group = 'person' | 'job' | 'line';
type Line = W.Timesheet & { wof: W.Wof };

const read = (k: string, fallback: string) => {
  try {
    return localStorage.getItem(k) || fallback;
  } catch {
    return fallback;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
};

export default function ReportPayroll() {
  const toast = useToast();
  useWofVersion();

  const [periodId, setPeriodId] = useState(() => read('eprosta.pr.period', 'p-jul'));
  const [group, setGroup] = useState<Group>(() => read('eprosta.pr.group', 'person') as Group);
  const [type, setType] = useState('all');
  const [query, setQuery] = useState('');
  const [signingOff, setSigningOff] = useState(false);
  const { sort, toggle } = useSort({ key: 'gross', dir: -1 });

  const period = PERIODS.find((p) => p.id === periodId) || PERIODS[0];

  const from = new Date(period.from + 'T00:00:00');
  const to = new Date(period.to + 'T23:59:59');
  const q = query.trim().toLowerCase();

  const rows: Line[] = W.allTimesheets().filter((t) => {
    const d = new Date(t.date);
    if (d < from || d > to) return false;
    if (type !== 'all' && t.employmentType !== type) return false;
    if (q && !`${t.employeeName} ${t.role} ${t.wof.title}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const gross = round2(rows.reduce((s, t) => s + t.gross, 0));
  const hours = round2(rows.reduce((s, t) => s + t.hours, 0));
  const paye = rows.filter((t) => t.employmentType === 'PAYE');
  const se = rows.filter((t) => t.employmentType !== 'PAYE');
  const people = new Set(rows.map((t) => t.employeeId)).size;

  const exportCsv = () => {
    const csv = ['Date,NI,Worker,EmploymentType,Role,Reference,Job,Hours,Rate,Gross,Outcome']
      .concat(
        rows.map((t) => {
          const emp = employeeById(t.employeeId);
          return [
            t.date, emp ? emp.niNumber.replace(/ /g, '') : '', `"${t.employeeName}"`, t.employmentType,
            `"${t.role}"`, t.wof.ref, `"${t.wof.title}"`, t.hours.toFixed(2), t.payRate.toFixed(2),
            t.gross.toFixed(2), t.outcome,
          ].join(',');
        }),
      )
      .join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `payroll-${period.id}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`Exported ${rows.length} timesheet lines for ${period.label}.`, { tone: 'healthy' });
  };

  return (
    <>
      <PageHeader
        title="Payroll output"
        subtitle="Approved timesheets by person and by job, with the pay rate that applied. This is the file that goes to payroll — and the same hours that job costing books as actual staff cost."
        actions={
          <>
            {/* Reading the payroll report and producing the payment file are
                different jobs — Finance signs it off, Payroll runs it — so the
                route is gated on `report.payroll` and these two on
                `payroll.run`. */}
            <button
              type="button"
              className="btn btn-secondary"
              {...ROLES.gate('payroll.run')}
              onClick={exportCsv}
            >
              <Icon name="download" decorative /> Export for payroll
            </button>
            <button
              type="button"
              className="btn btn-primary"
              {...ROLES.gate('payroll.run')}
              onClick={() => setSigningOff(true)}
            >
              <Icon name="check" decorative /> Mark period checked
            </button>
          </>
        }
      />

      <div className="flex flex-wrap gap-3 mb-5">
        <Kpi
          label="Gross pay"
          value={money(gross, { compact: true })}
          sub={`${people} people, ${rows.length} timesheets`}
          tone="info"
        />
        <Kpi
          label="Hours"
          value={hours.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          sub={`Average ${people ? (hours / people).toFixed(1) : '0'} hours per person`}
          tone="neutral"
        />
        <Kpi
          label="PAYE"
          value={money(paye.reduce((s, t) => s + t.gross, 0), { compact: true })}
          sub={`${new Set(paye.map((t) => t.employeeId)).size} people on payroll`}
          tone="neutral"
        />
        <Kpi
          label="Self-employed"
          value={money(se.reduce((s, t) => s + t.gross, 0), { compact: true })}
          sub={`${new Set(se.map((t) => t.employeeId)).size} people invoicing`}
          tone="neutral"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2.5 mb-5">
        <label className="sr-only" htmlFor="period">
          Pay period
        </label>
        <select
          className="field w-auto"
          id="period"
          value={periodId}
          onChange={(e) => {
            setPeriodId(e.target.value);
            write('eprosta.pr.period', e.target.value);
          }}
        >
          {PERIODS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>

        <Segmented<Group>
          ariaLabel="Group by"
          value={group}
          onChange={(g) => {
            setGroup(g);
            write('eprosta.pr.group', g);
          }}
          options={[
            ['person', 'By person'],
            ['job', 'By job'],
            ['line', 'Every line'],
          ]}
        />

        <label className="sr-only" htmlFor="type">
          Employment type
        </label>
        <select className="field w-auto" id="type" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="all">PAYE and self-employed</option>
          <option value="PAYE">PAYE only</option>
          <option value="Self-employed">Self-employed only</option>
        </select>

        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Filter by name, role or job…"
          ariaLabel="Filter payroll rows"
          className="w-56"
        />
      </div>

      {!rows.length ? (
        <div className="card">
          <EmptyState
            iconName="users"
            title="No timesheets in this period"
            body="Nothing has been approved for the selected dates. Approved check-ins arrive here automatically."
          />
        </div>
      ) : group === 'person' ? (
        <ByPerson rows={rows} sort={sort} onSort={toggle} />
      ) : group === 'job' ? (
        <ByJob rows={rows} sort={sort} onSort={toggle} />
      ) : (
        <ByLine rows={rows} sort={sort} onSort={toggle} />
      )}

      {rows.length ? (
        <Provenance>
          Rows are approved check-ins from the staff allocation tool, joined to the pay rate and employment
          type on the staff register. Uplifts for supervisor and SIA roles are already in the rate shown.
          Nothing here is re-keyed from an admin sheet.
        </Provenance>
      ) : null}

      {signingOff ? (
        <Modal
          title="Mark payroll period as checked"
          onClose={() => setSigningOff(false)}
          footer={
            <>
              <button type="button" className="btn btn-secondary" data-close onClick={() => setSigningOff(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setSigningOff(false);
                  toast(`${period.label} marked as checked and ready for payroll.`, { tone: 'healthy' });
                }}
              >
                Mark checked
              </button>
            </>
          }
        >
          <p className="text-[13.5px] text-ink-2 leading-relaxed mb-4">
            {period.label} — {rows.length} timesheets, {hours.toFixed(1)} hours, {money(gross)} gross.
          </p>
          <p className="text-[12.5px] text-ink-3 leading-relaxed">
            In production this locks the period so late timesheet edits cannot change a run that has
            already gone out, and routes to the Finance Director for sign-off. The FD's exact approval step
            is one of the things the briefing flags as still to be scoped.
          </p>
        </Modal>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------- by person -- */

interface PersonRow {
  employeeId: string;
  name: string;
  employmentType: string;
  payRate: number;
  hours: number;
  gross: number;
  shifts: number;
  jobs: Set<string>;
  roles: Set<string>;
}

function ByPerson({ rows, sort, onSort }: { rows: Line[]; sort: SortState; onSort: (k: string) => void }) {
  const map = new Map<string, PersonRow>();
  rows.forEach((t) => {
    const e =
      map.get(t.employeeId) ||
      {
        employeeId: t.employeeId, name: t.employeeName, employmentType: t.employmentType,
        payRate: t.payRate, hours: 0, gross: 0, shifts: 0, jobs: new Set<string>(), roles: new Set<string>(),
      };
    e.hours = round2(e.hours + t.hours);
    e.gross = round2(e.gross + t.gross);
    e.shifts++;
    e.jobs.add(t.wofId);
    e.roles.add(t.role);
    map.set(t.employeeId, e);
  });

  const people = sortRows(
    [...map.values()],
    sort.key,
    sort.dir,
    (p, k) => ({ name: p.name, hours: p.hours, gross: p.gross, shifts: p.shifts, rate: p.payRate })[k],
  );

  const columns: Column<PersonRow>[] = [
    {
      key: 'name', label: 'Worker', sortKey: 'name',
      cell: (p) => {
        const emp = employeeById(p.employeeId);
        return (
          <div className="flex items-center gap-2.5">
            {emp ? <Avatar hue={emp.hue} initials={emp.initials} size={28} /> : null}
            <div>
              <div className="text-[13.5px] text-ink">{p.name}</div>
              <div className="text-[11.5px] text-ink-3">
                {[...p.roles].slice(0, 2).join(', ')}
                {p.roles.size > 2 ? ` +${p.roles.size - 2}` : ''}
              </div>
            </div>
          </div>
        );
      },
    },
    {
      key: 'ni', label: 'NI number', nowrap: true,
      cell: (p) => (
        <span className="text-[12px] text-ink-3 font-mono">{employeeById(p.employeeId)?.niNumber ?? '—'}</span>
      ),
    },
    {
      key: 'type', label: 'Type', nowrap: true,
      cell: (p) => (
        <Pill label={p.employmentType} tone={p.employmentType === 'PAYE' ? 'info' : 'neutral'} hint={false} />
      ),
    },
    { key: 'jobs', label: 'Jobs', align: 'right', cell: (p) => <span className="tabular-nums text-ink-2">{p.jobs.size}</span> },
    {
      key: 'shifts', label: 'Shifts', sortKey: 'shifts', align: 'right',
      cell: (p) => <span className="tabular-nums text-ink-2">{p.shifts}</span>,
    },
    {
      key: 'hours', label: 'Hours', sortKey: 'hours', align: 'right',
      cell: (p) => <span className="tabular-nums text-ink">{p.hours.toFixed(1)}</span>,
    },
    {
      // Withheld rather than removed. A column that vanishes reads as a bug;
      // "Hidden" tells the reader the number exists and is not theirs, which is
      // the honest answer and the one that stops them going to ask for it.
      key: 'rate', label: 'Rate', sortKey: 'rate', align: 'right', nowrap: true,
      cell: (p) =>
        ROLES.can('pay.view') ? (
          <span className="tabular-nums text-ink-2">{money(p.payRate)}/hr</span>
        ) : (
          <span className="text-ink-3 tip" tabIndex={0} data-tip={ROLES.denial('pay.view') || ''}>
            Hidden
          </span>
        ),
    },
    {
      key: 'gross', label: 'Gross', sortKey: 'gross', align: 'right', nowrap: true,
      cell: (p) => <span className="tabular-nums font-semibold text-ink">{money(p.gross)}</span>,
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={people}
      rowKey={(p) => p.employeeId}
      sort={sort}
      onSort={onSort}
      rowHref={(p) => `/staff?id=${p.employeeId}`}
      footer={{
        name: `${people.length} people`,
        hours: people.reduce((s, p) => s + p.hours, 0).toFixed(1),
        gross: money(people.reduce((s, p) => s + p.gross, 0), { pence: false }),
      }}
    />
  );
}

/* ---------------------------------------------------------------- by job -- */

interface JobRow {
  wof: W.Wof;
  hours: number;
  gross: number;
  shifts: number;
  people: Set<string>;
}

function ByJob({ rows, sort, onSort }: { rows: Line[]; sort: SortState; onSort: (k: string) => void }) {
  const map = new Map<string, JobRow>();
  rows.forEach((t) => {
    const e = map.get(t.wofId) || { wof: t.wof, hours: 0, gross: 0, shifts: 0, people: new Set<string>() };
    e.hours = round2(e.hours + t.hours);
    e.gross = round2(e.gross + t.gross);
    e.shifts++;
    e.people.add(t.employeeId);
    map.set(t.wofId, e);
  });

  const jobs = sortRows(
    [...map.values()],
    sort.key,
    sort.dir,
    (j, k) => ({ name: j.wof.title, hours: j.hours, gross: j.gross, shifts: j.shifts })[k],
  );

  const columns: Column<JobRow>[] = [
    {
      key: 'name', label: 'Job', sortKey: 'name',
      cell: (j) => (
        <>
          <div className="text-[13.5px] text-ink font-medium">{j.wof.title}</div>
          <div className="text-[11.5px] text-ink-3 font-mono">
            {j.wof.ref} · {fmtDate(j.wof.start)}
          </div>
        </>
      ),
    },
    { key: 'client', label: 'Client', cell: (j) => <ClientLink id={j.wof.clientId} /> },
    { key: 'people', label: 'People', align: 'right', cell: (j) => <span className="tabular-nums text-ink-2">{j.people.size}</span> },
    {
      key: 'shifts', label: 'Shifts', sortKey: 'shifts', align: 'right',
      cell: (j) => <span className="tabular-nums text-ink-2">{j.shifts}</span>,
    },
    {
      key: 'hours', label: 'Hours', sortKey: 'hours', align: 'right',
      cell: (j) => <span className="tabular-nums text-ink">{j.hours.toFixed(1)}</span>,
    },
    {
      key: 'planned', label: 'vs planned staff cost', align: 'right', nowrap: true,
      cell: (j) => {
        const planned = W.plannedStaffCost(j.wof);
        const v = round2(W.actualStaffCost(j.wof) - planned);
        const t: Tone = v > planned * 0.1 ? 'critical' : v > 0 ? 'atRisk' : 'healthy';
        return (
          <>
            <span className="tabular-nums" style={{ color: TONE_HEX[t] }}>
              {v > 0 ? '+' : ''}
              {money(v, { pence: false })}
            </span>
            <div className="text-[11px] text-ink-3">planned {money(planned, { pence: false })}</div>
          </>
        );
      },
    },
    {
      key: 'gross', label: 'Gross', sortKey: 'gross', align: 'right', nowrap: true,
      cell: (j) => <span className="tabular-nums font-semibold text-ink">{money(j.gross, { pence: false })}</span>,
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={jobs}
      rowKey={(j) => j.wof.id}
      sort={sort}
      onSort={onSort}
      rowHref={(j) => `/wofs/${j.wof.id}#timesheets`}
      footer={{
        name: `${jobs.length} job${jobs.length === 1 ? '' : 's'}`,
        hours: jobs.reduce((s, j) => s + j.hours, 0).toFixed(1),
        gross: money(jobs.reduce((s, j) => s + j.gross, 0), { pence: false }),
      }}
    />
  );
}

/* --------------------------------------------------------------- by line -- */

function ByLine({ rows, sort, onSort }: { rows: Line[]; sort: SortState; onSort: (k: string) => void }) {
  const sorted = sortRows(
    rows,
    sort.key,
    sort.dir,
    (t, k) => ({ name: t.employeeName, date: +new Date(t.date), hours: t.hours, gross: t.gross, job: t.wof.title })[k],
  ).slice(0, 400);

  const columns: Column<Line>[] = [
    { key: 'date', label: 'Date', sortKey: 'date', nowrap: true, cell: (t) => <span className="text-[13px]">{fmtDate(t.date)}</span> },
    { key: 'name', label: 'Worker', sortKey: 'name', cell: (t) => <span className="text-[13.5px] text-ink">{t.employeeName}</span> },
    { key: 'role', label: 'Role', cell: (t) => <span className="text-[13px] text-ink-2">{t.role}</span> },
    { key: 'job', label: 'Job', sortKey: 'job', cell: (t) => <span className="text-[13px] text-ink-2">{t.wof.title}</span> },
    { key: 'outcome', label: 'Outcome', nowrap: true, cell: (t) => <Pill status={t.outcome} /> },
    { key: 'hours', label: 'Hours', sortKey: 'hours', align: 'right', cell: (t) => <span className="tabular-nums">{t.hours.toFixed(1)}</span> },
    {
      key: 'rate', label: 'Rate', align: 'right', nowrap: true,
      cell: (t) =>
        ROLES.can('pay.view') ? (
          <span className="tabular-nums text-ink-2">{money(t.payRate)}</span>
        ) : (
          <span className="text-ink-3">Hidden</span>
        ),
    },
    {
      key: 'gross', label: 'Gross', sortKey: 'gross', align: 'right', nowrap: true,
      cell: (t) => <span className="tabular-nums font-semibold text-ink">{money(t.gross)}</span>,
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={sorted}
      rowKey={(t, i) => `${t.wofId}-${t.employeeId}-${t.date}-${i}`}
      sort={sort}
      onSort={onSort}
      rowHref={(t) => `/wofs/${t.wofId}#timesheets`}
      footer={{
        name: `${sorted.length} timesheet${sorted.length === 1 ? '' : 's'}${rows.length > 400 ? ' (first 400 shown)' : ''}`,
        hours: sorted.reduce((s, t) => s + t.hours, 0).toFixed(1),
        gross: money(sorted.reduce((s, t) => s + t.gross, 0), { pence: false }),
      }}
    />
  );
}
