/* ============================================================================
   STAFF PORTAL — HOURS AND PAY
   ----------------------------------------------------------------------------
   The worker's own row out of the Payroll output report. Same source, same
   arithmetic, same approver's name — which is the whole point. "Payroll says
   one thing and my payslip says another" is only solvable if both are reading
   the same table, and the worker can see which one.

   Every line answers the question a worker actually asks, in order:
     how many hours did I work        -> hours, per shift, with the clock times
     at what rate                     -> the rate that applied on that day
     so what am I owed                -> gross, and what is still to be paid
     who signed it off                -> the supervisor's name, per row

   Deductions and net pay are not shown, and are not guessed at. Tax depends on
   a code this system does not hold; inventing a net figure here would be worse
   than useless.
   ========================================================================== */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import {
  EmptyState, Kpi, PageHeader, Pill, Provenance, Segmented,
} from '@/components/primitives';
import { DataTable, sortRows, useSort, type Column } from '@/components/DataTable';
import { useToast } from '@/components/Toast';
import { countLabel, fmtDate, money, round2 } from '@/lib/format';
import { ATTENDANCE } from '@/data/db';
import * as PORTAL from '@/lib/portal';
import * as W from '@/lib/wof';
import { useWofVersion } from '@/lib/useStore';

type Group = 'shift' | 'job' | 'month';

interface PayRow extends W.Timesheet {
  wof: W.Wof;
  clock: string | null;
}

interface GroupRow {
  key: string;
  name: string;
  sub?: string;
  hours: number;
  gross: number;
  shifts: number;
}

/** The clock times behind a timesheet row, when attendance recorded them. */
const clockFor = (t: W.Timesheet): string | null =>
  ATTENDANCE.find((x) => x.id === t.sourceId)?.actual ?? null;

const monthLabel = (k: string): string => {
  const [y, m] = k.split('-');
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
  });
};

export default function StaffPayPage() {
  const toast = useToast();
  useWofVersion();

  const me = PORTAL.actingEmployee();
  const [group, setGroup] = useState<Group>('shift');
  const [year, setYear] = useState('all');
  const { sort, toggle } = useSort({ key: 'date', dir: -1 });

  /* Payroll's own view, narrowed to one person. Going through allTimesheets()
     rather than re-deriving from attendance means the worker cannot be shown a
     number payroll would disagree with. */
  const mine: PayRow[] = W.allTimesheets()
    .filter((t) => t.employeeId === me.id)
    .map((t) => ({ ...t, clock: clockFor(t) }));

  const rows = mine.filter((t) => year === 'all' || String(t.date).slice(0, 4) === year);

  const hours = round2(rows.reduce((s, t) => s + t.hours, 0));
  const gross = round2(rows.reduce((s, t) => s + t.gross, 0));
  const shifts = rows.filter((t) => t.hours > 0).length;
  const jobs = new Set(rows.map((t) => t.wofId)).size;
  const years = [...new Set(mine.map((t) => String(t.date).slice(0, 4)))].sort().reverse();
  const rate = round2(me.payRate + (me.payUplift || 0));

  // Anything worked but not yet in a paid period. The prototype treats a shift
  // as awaiting payment until the job reaches invoicing, which is the honest
  // answer: the money has not moved yet.
  const pending = rows.filter((t) => !W.atLeast(t.wof, 'invoice'));
  const pendingGross = round2(pending.reduce((s, t) => s + t.gross, 0));

  return (
    <>
      <PageHeader
        title="Hours and pay"
        subtitle="Every approved shift you have worked, the rate that applied on the day, and what it came to. These are the same rows that go to payroll — if something here looks wrong, it is worth raising before payday rather than after."
        actions={
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() =>
              toast(
                `${countLabel(rows.length, 'shift')} · ${hours.toFixed(1)} hours · ${money(gross)} gross. In the live system this downloads a CSV for your own records.`,
                { tone: 'healthy' },
              )
            }
          >
            <Icon name="download" decorative className="icon-sm" /> Download my record
          </button>
        }
      />

      <div className="flex flex-wrap gap-3 mb-5">
        <Kpi
          label="Hours worked"
          value={hours.toLocaleString(undefined, { maximumFractionDigits: 1 })}
          sub={`${countLabel(shifts, 'shift')} across ${countLabel(jobs, 'job')}`}
          tone="info"
        />
        <Kpi label="Gross earned" value={money(gross, { pence: false })} sub="Before tax and any deductions" tone="neutral" />
        <Kpi
          label="Your rate"
          value={`${money(rate)}/hr`}
          sub={`${me.employmentType}${me.payUplift ? ` · includes a ${money(me.payUplift)} role uplift` : ' · no uplift applies'}`}
          tone="neutral"
        />
        <Kpi
          label="Still to be paid"
          value={money(pendingGross, { pence: false })}
          sub={
            pending.length
              ? `${countLabel(pending.length, 'shift')} on jobs not yet invoiced`
              : 'Everything worked has been processed'
          }
          tone={pendingGross ? 'atRisk' : 'healthy'}
        />
      </div>

      <div className="card p-3.5 mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <Segmented<Group>
            ariaLabel="Group my pay by"
            value={group}
            onChange={setGroup}
            options={[
              ['shift', 'Every shift'],
              ['job', 'By job'],
              ['month', 'By month'],
            ]}
          />
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1.5" htmlFor="year">
              Year
            </label>
            <select className="field w-auto" id="year" value={year} onChange={(e) => setYear(e.target.value)}>
              <option value="all">All time</option>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {!rows.length ? (
        <div className="card">
          <EmptyState
            iconName="trendUp"
            title="No paid shifts yet"
            body="A shift appears here once you have worked it and the on-site supervisor has approved your check-in. Until then it lives on My shifts."
            action={
              <Link className="btn btn-primary" to="/my/jobs">
                Find open jobs
              </Link>
            }
          />
        </div>
      ) : group === 'shift' ? (
        <ShiftTable rows={rows} sort={sort} onSort={toggle} />
      ) : (
        <GroupTable rows={rows} group={group} sort={sort} onSort={toggle} />
      )}

      <Provenance>
        Each row is an approved check-in from the shift you worked, joined to your pay rate and employment
        type on the staff register. The rate stored is the one that applied on the day — a later pay rise
        does not silently reprice work you have already done. Nothing here is re-keyed by hand, so what you
        see is what payroll sees.
      </Provenance>
    </>
  );
}

function ShiftTable({
  rows,
  sort,
  onSort,
}: {
  rows: PayRow[];
  sort: { key: string; dir: 1 | -1 };
  onSort: (k: string) => void;
}) {
  const sorted = sortRows(
    rows,
    sort.key,
    sort.dir,
    (t, k) => ({ date: t.date, hours: t.hours, gross: t.gross, role: t.role })[k],
  );

  const columns: Column<PayRow>[] = [
    {
      key: 'date', label: 'Date', sortKey: 'date', nowrap: true,
      cell: (t) => <span className="text-[13px] text-ink-2">{fmtDate(t.date)}</span>,
    },
    { key: 'job', label: 'Job', cell: (t) => <span className="text-[13px] text-ink">{t.wof.title}</span> },
    {
      key: 'role', label: 'Role', sortKey: 'role',
      cell: (t) => <span className="text-[13px] text-ink-2">{t.role}</span>,
    },
    {
      key: 'clock', label: 'Clocked', nowrap: true,
      cell: (t) => <span className="text-[12.5px] text-ink-2 tabular-nums">{t.clock || '—'}</span>,
    },
    {
      key: 'hours', label: 'Hours', sortKey: 'hours', align: 'right', nowrap: true,
      cell: (t) => <span className="tabular-nums text-[13px] text-ink">{t.hours.toFixed(2)}</span>,
    },
    {
      key: 'rate', label: 'Rate', align: 'right', nowrap: true,
      cell: (t) => <span className="tabular-nums text-[13px] text-ink-2">{money(t.payRate)}</span>,
    },
    {
      key: 'gross', label: 'Gross', sortKey: 'gross', align: 'right', nowrap: true,
      cell: (t) => <span className="tabular-nums text-[13px] font-semibold text-ink">{money(t.gross)}</span>,
    },
    { key: 'outcome', label: 'Outcome', cell: (t) => <Pill status={t.outcome} /> },
    {
      key: 'paid', label: 'Payment',
      cell: (t) =>
        W.atLeast(t.wof, 'invoice') ? (
          <Pill label="Processed" tone="healthy" hint="Included in a payroll run" />
        ) : (
          <Pill
            label="Awaiting run"
            tone="atRisk"
            hint="The job has not reached invoicing, so this has not been paid out yet"
          />
        ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={sorted}
      rowKey={(t, i) => `${t.wofId}-${t.employeeId}-${t.date}-${i}`}
      sort={sort}
      onSort={onSort}
      footer={{
        date: <span className="text-[12.5px] text-ink-3">{countLabel(sorted.length, 'shift')}</span>,
        hours: (
          <span className="tabular-nums font-bold text-ink">
            {round2(sorted.reduce((s, t) => s + t.hours, 0)).toFixed(2)}
          </span>
        ),
        gross: (
          <span className="tabular-nums font-bold text-ink">
            {money(round2(sorted.reduce((s, t) => s + t.gross, 0)))}
          </span>
        ),
      }}
    />
  );
}

function GroupTable({
  rows,
  group,
  sort,
  onSort,
}: {
  rows: PayRow[];
  group: 'job' | 'month';
  sort: { key: string; dir: 1 | -1 };
  onSort: (k: string) => void;
}) {
  const map = new Map<string, GroupRow>();
  rows.forEach((t) => {
    const key = group === 'job' ? t.wofId : String(t.date).slice(0, 7);
    const e =
      map.get(key) ||
      ({
        key,
        name: group === 'job' ? t.wof.title : monthLabel(key),
        sub: group === 'job' ? t.wof.venue : undefined,
        hours: 0,
        gross: 0,
        shifts: 0,
      } as GroupRow);
    e.hours = round2(e.hours + t.hours);
    e.gross = round2(e.gross + t.gross);
    e.shifts++;
    map.set(key, e);
  });

  const label = group === 'job' ? 'Job' : 'Month';
  const list = [...map.values()];
  if (group === 'month') list.sort((a, b) => b.key.localeCompare(a.key));

  const sorted = sortRows(
    list,
    sort.key,
    sort.dir,
    (g, k) => ({ date: g.key, hours: g.hours, gross: g.gross, role: g.name })[k] ?? g.key,
  );

  const columns: Column<GroupRow>[] = [
    {
      key: 'name', label,
      cell: (g) => (
        <>
          <span className="text-[13px] text-ink">{g.name}</span>
          {g.sub ? <span className="block text-[11.5px] text-ink-3">{g.sub}</span> : null}
        </>
      ),
    },
    {
      key: 'shifts', label: 'Shifts', align: 'right',
      cell: (g) => <span className="tabular-nums text-[13px] text-ink-2">{g.shifts}</span>,
    },
    {
      key: 'hours', label: 'Hours', sortKey: 'hours', align: 'right',
      cell: (g) => <span className="tabular-nums text-[13px] text-ink">{g.hours.toFixed(1)}</span>,
    },
    {
      key: 'gross', label: 'Gross', sortKey: 'gross', align: 'right',
      cell: (g) => <span className="tabular-nums text-[13px] font-semibold text-ink">{money(g.gross)}</span>,
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={sorted}
      rowKey={(g) => g.key}
      sort={sort}
      onSort={onSort}
      footer={{
        name: (
          <span className="text-[12.5px] text-ink-3">
            {sorted.length} {label.toLowerCase()}
            {sorted.length === 1 ? '' : 's'}
          </span>
        ),
        shifts: <span className="tabular-nums text-ink-2">{sorted.reduce((s, g) => s + g.shifts, 0)}</span>,
        hours: (
          <span className="tabular-nums font-bold text-ink">
            {round2(sorted.reduce((s, g) => s + g.hours, 0)).toFixed(1)}
          </span>
        ),
        gross: (
          <span className="tabular-nums font-bold text-ink">
            {money(round2(sorted.reduce((s, g) => s + g.gross, 0)))}
          </span>
        ),
      }}
    />
  );
}
