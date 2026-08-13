/* ============================================================================
   JOB COSTING
   ----------------------------------------------------------------------------
   Briefing §2.3: "Kit and staff costs vs invoice value per job. Requires cost
   prices as well as charge-out rates in the table of charges."

   The cost prices are on every line of the table of charges, so this report
   exists without anyone re-keying anything. The important columns are the two
   that a spreadsheet never gets right:

     Planned staff cost   from the cost prices on the quote
     Actual staff cost    hours worked x pay rate, from approved timesheets

   The variance between them is where the margin on an event job actually goes,
   and it is the same number the Payroll report pays out.
   ========================================================================== */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import {
  CoverageBar, Kpi, PageHeader, Provenance, Segmented,
} from '@/components/primitives';
import { DataTable, sortRows, useSort, type Column } from '@/components/DataTable';
import { ClientLink } from '@/components/wof-ui';
import { useToast } from '@/components/Toast';
import { TONE_BG, TONE_HEX, TONE_LINE } from '@/lib/status';
import { fmtDate, money, round2 } from '@/lib/format';
import { NOW, client as clientById } from '@/data/db';
import type { Tone } from '@/data/types';
import * as W from '@/lib/wof';
import { useWofs } from '@/lib/useStore';

type Scope = 'delivered' | 'all';

interface Row {
  w: W.Wof;
  ts: W.Timesheet[];
  value: number;
  quote: number;
  variations: number;
  plannedStaff: number;
  actualStaff: number;
  staffVariance: number;
  kit: number;
  cost: number;
  margin: number;
  marginPct: number;
  hours: number;
  hasActuals: boolean;
}

function analyse(w: W.Wof): Row {
  const ts = W.timesheets(w);
  const plannedStaff = W.plannedStaffCost(w);
  const actualStaff = ts.length ? W.actualStaffCost(w) : plannedStaff;
  const kit = W.plannedKitCost(w);
  const cost = W.actualCost(w);
  const value = W.contractValue(w);
  return {
    w, ts, value,
    quote: W.quoteValue(w),
    variations: W.variationValue(w),
    plannedStaff, actualStaff,
    staffVariance: round2(actualStaff - plannedStaff),
    kit, cost,
    margin: round2(value - cost),
    marginPct: value ? Math.round(((value - cost) / value) * 100) : 0,
    hours: round2(ts.reduce((s, t) => s + t.hours, 0)),
    hasActuals: ts.length > 0,
  };
}

const marginTone = (p: number): Tone => (p >= 30 ? 'healthy' : p >= 15 ? 'atRisk' : 'critical');

export default function ReportCosting() {
  const toast = useToast();
  const wofs = useWofs();

  const [scope, setScope] = useState<Scope>(() => {
    try {
      return (localStorage.getItem('eprosta.jc.scope') as Scope) || 'delivered';
    } catch {
      return 'delivered';
    }
  });
  const [clientId, setClientId] = useState('all');
  const { sort, toggle } = useSort({ key: 'marginPct', dir: 1 });

  const rows = wofs
    .filter((w) => {
      if (clientId !== 'all' && w.clientId !== clientId) return false;
      // "Delivered" = the job has run, so actual costs mean something.
      if (scope === 'delivered' && !W.atLeast(w, 'job')) return false;
      if (scope === 'delivered' && new Date(w.start) > NOW) return false;
      return true;
    })
    .map(analyse);

  const value = rows.reduce((s, r) => s + r.value, 0);
  const cost = rows.reduce((s, r) => s + r.cost, 0);
  const margin = value - cost;
  const p = value ? Math.round((margin / value) * 100) : 0;
  const staffVar = rows.reduce((s, r) => s + (r.hasActuals ? r.staffVariance : 0), 0);
  const thin = rows.filter((r) => r.marginPct < 15);

  const setScopePersisted = (s: Scope) => {
    setScope(s);
    try {
      localStorage.setItem('eprosta.jc.scope', s);
    } catch {
      /* private mode */
    }
  };

  const accessor = (r: Row, k: string) =>
    ({
      job: r.w.title,
      client: clientById(r.w.clientId)?.name,
      date: +new Date(r.w.start),
      value: r.value,
      cost: r.cost,
      margin: r.margin,
      marginPct: r.marginPct,
      staffVariance: r.staffVariance,
    })[k];

  const sorted = sortRows(rows, sort.key, sort.dir, accessor);

  const columns: Column<Row>[] = [
    {
      key: 'job', label: 'Job', sortKey: 'job',
      cell: (r) => (
        <Link to={`/wofs/${r.w.id}`} className="no-underline">
          <div className="text-[13.5px] text-ink font-medium">{r.w.title}</div>
          <div className="text-[11.5px] text-ink-3 font-mono">
            {r.w.ref} · {fmtDate(r.w.start)}
          </div>
        </Link>
      ),
    },
    { key: 'client', label: 'Client', sortKey: 'client', cell: (r) => <ClientLink id={r.w.clientId} /> },
    {
      key: 'value', label: 'Contract', sortKey: 'value', align: 'right', nowrap: true,
      cell: (r) => (
        <>
          <span className="tabular-nums text-ink">{money(r.value, { pence: false })}</span>
          {r.variations ? (
            <div className="text-[11px] tabular-nums" style={{ color: TONE_HEX.atRisk }}>
              incl. {money(r.variations, { pence: false })} var.
            </div>
          ) : null}
        </>
      ),
    },
    {
      key: 'staff', label: 'Staff cost', align: 'right', nowrap: true,
      cell: (r) => (
        <>
          <span className="tabular-nums text-ink-2">{money(r.actualStaff, { pence: false })}</span>
          <div className="text-[11px] text-ink-3">
            {r.hasActuals ? `${r.hours.toFixed(0)} actual hours` : 'planned'}
          </div>
        </>
      ),
    },
    {
      key: 'staffVariance', label: 'vs plan', sortKey: 'staffVariance', align: 'right', nowrap: true,
      cell: (r) => {
        if (!r.hasActuals) return <span className="text-ink-3">—</span>;
        const t: Tone =
          r.staffVariance > r.plannedStaff * 0.1 ? 'critical' : r.staffVariance > 0 ? 'atRisk' : 'healthy';
        return (
          <span className="tabular-nums font-medium" style={{ color: TONE_HEX[t] }}>
            {r.staffVariance > 0 ? '+' : ''}
            {money(r.staffVariance, { pence: false })}
          </span>
        );
      },
    },
    {
      key: 'kit', label: 'Kit & services', align: 'right', nowrap: true,
      cell: (r) => <span className="tabular-nums text-ink-2">{money(r.kit, { pence: false })}</span>,
    },
    {
      key: 'cost', label: 'Total cost', sortKey: 'cost', align: 'right', nowrap: true,
      cell: (r) => <span className="tabular-nums text-ink-2">{money(r.cost, { pence: false })}</span>,
    },
    {
      key: 'margin', label: 'Margin', sortKey: 'margin', align: 'right', nowrap: true,
      cell: (r) => (
        <span className="tabular-nums font-semibold" style={{ color: TONE_HEX[marginTone(r.marginPct)] }}>
          {money(r.margin, { pence: false })}
        </span>
      ),
    },
    {
      key: 'marginPct', label: '%', sortKey: 'marginPct', align: 'right', nowrap: true,
      cell: (r) => {
        const t = marginTone(r.marginPct);
        return (
          <div className="flex items-center gap-2 justify-end">
            <div className="w-16">
              <CoverageBar
                cov={{
                  required: 100,
                  assigned: 0,
                  filled: Math.max(0, Math.min(100, r.marginPct)),
                  awaiting: 0,
                  gap: 0,
                }}
                tone={t}
                height={5}
              />
            </div>
            <span className="tabular-nums text-[12.5px] w-9 text-right" style={{ color: TONE_HEX[t] }}>
              {r.marginPct}%
            </span>
          </div>
        );
      },
    },
  ];

  const exportCsv = () => {
    const csv = [
      'Reference,Job,Client,Date,Contract,Variations,StaffCost,StaffVsPlan,KitCost,TotalCost,Margin,MarginPct',
    ]
      .concat(
        rows.map((r) =>
          [
            r.w.ref, `"${r.w.title}"`, `"${clientById(r.w.clientId)?.name ?? ''}"`, fmtDate(r.w.start),
            r.value.toFixed(2), r.variations.toFixed(2), r.actualStaff.toFixed(2),
            r.hasActuals ? r.staffVariance.toFixed(2) : '', r.kit.toFixed(2), r.cost.toFixed(2),
            r.margin.toFixed(2), r.marginPct,
          ].join(','),
        ),
      )
      .join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'job-costing.csv';
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`Exported ${rows.length} jobs.`, { tone: 'healthy' });
  };

  return (
    <>
      <PageHeader
        title="Job costing"
        subtitle="Kit and staff cost against contract value, per job. Staff cost switches from planned to actual as soon as timesheets are approved."
        actions={
          <button type="button" className="btn btn-secondary" onClick={exportCsv}>
            <Icon name="download" decorative /> Export
          </button>
        }
      />

      <div className="flex flex-wrap gap-3 mb-5">
        <Kpi
          label="Contract value"
          value={money(value, { compact: true })}
          sub={`${rows.length} job${rows.length === 1 ? '' : 's'}`}
          tone="info"
        />
        <Kpi
          label="Cost to deliver"
          value={money(cost, { compact: true })}
          sub="Staff at actual hours where available, kit at cost price"
          tone="neutral"
        />
        <Kpi
          label="Margin"
          value={money(margin, { compact: true })}
          sub={`${p}% of contract value`}
          tone={marginTone(p)}
        />
        <Kpi
          label="Staff cost variance"
          value={money(staffVar, { compact: true })}
          sub={staffVar > 0 ? 'More than was planned' : 'Within plan'}
          tone={staffVar > 0 ? 'atRisk' : 'healthy'}
        />
      </div>

      {thin.length ? (
        <div className="card p-3.5 mb-5" style={{ background: TONE_BG.atRisk, borderColor: TONE_LINE.atRisk }}>
          <div className="flex items-start gap-2.5">
            <span style={{ color: TONE_HEX.atRisk, marginTop: 1 }}>
              <Icon name="alert" decorative />
            </span>
            <div className="flex-1">
              <div className="text-[13px] font-semibold text-ink mb-1">
                {thin.length} job{thin.length > 1 ? 's are' : ' is'} running under 15% margin
              </div>
              <div className="text-[13px] text-ink-2 leading-relaxed">
                {thin.map((r, i) => (
                  <span key={r.w.id}>
                    {i ? ' · ' : ''}
                    <Link to={`/wofs/${r.w.id}`} className="text-accent no-underline hover:underline">
                      {r.w.title}
                    </Link>{' '}
                    <span className="text-ink-3">({r.marginPct}%)</span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2.5 mb-5">
        <Segmented<Scope>
          ariaLabel="Which jobs to include"
          value={scope}
          onChange={setScopePersisted}
          options={[
            ['delivered', 'Delivered jobs'],
            ['all', 'Every WOF'],
          ]}
        />
        <label className="sr-only" htmlFor="client">
          Filter by client
        </label>
        <select
          className="field w-auto"
          id="client"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
        >
          <option value="all">All clients</option>
          {[...new Set(wofs.map((w) => w.clientId))].map((id) => {
            const c = clientById(id);
            return c ? (
              <option key={id} value={id}>
                {c.name}
              </option>
            ) : null;
          })}
        </select>
        <p className="text-[12px] text-ink-3 flex-1 min-w-[240px]">
          {scope === 'delivered'
            ? 'Jobs that have run, so actual hours exist. This is the view for a margin review.'
            : 'Every WOF including unstarted ones, where staff cost is still the planned figure.'}
        </p>
      </div>

      <DataTable
        columns={columns}
        rows={sorted}
        rowKey={(r) => r.w.id}
        sort={sort}
        onSort={toggle}
        footer={{
          job: `${sorted.length} job${sorted.length === 1 ? '' : 's'}`,
          value: money(sorted.reduce((s, r) => s + r.value, 0), { pence: false }),
          cost: money(sorted.reduce((s, r) => s + r.cost, 0), { pence: false }),
          margin: money(sorted.reduce((s, r) => s + r.margin, 0), { pence: false }),
        }}
      />

      <Provenance>
        Staff cost is the sum of gross pay on approved timesheets — the identical figure the Payroll output
        report pays. Kit and services are valued at the cost price held against each line in the table of
        charges. Contract value includes every variation, so a job that grew on site shows both the extra
        income and the extra cost.
      </Provenance>
    </>
  );
}
