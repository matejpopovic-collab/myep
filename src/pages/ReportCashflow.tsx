/* ============================================================================
   CASH FLOW FORECAST
   ----------------------------------------------------------------------------
   Briefing §2.3: "Expected income based on signed orders and outstanding
   invoices. Expected vs received view."

   Every figure comes from wof.cashflow(), the same function the WOF detail page
   uses — so a job's invoice tab and this forecast cannot disagree.

   Two things this deliberately does that a spreadsheet cannot:
     · A job's balance appears as EXPECTED before it has been invoiced, dated
       from the client's payment terms. That is the forecast, not the ledger.
     · Deposits and balances are separate rows with separate dates, because they
       land months apart on the big festival jobs.
   ========================================================================== */

import { useState } from 'react';
import { Icon } from '@/components/Icon';
import {
  Kpi, PageHeader, Pill, Provenance, Section, Segmented,
} from '@/components/primitives';
import { DataTable, sortRows, useSort, type Column } from '@/components/DataTable';
import { ClientLink } from '@/components/wof-ui';
import { useToast } from '@/components/Toast';
import { TONE_BG, TONE_HEX } from '@/lib/status';
import { fmtDate, money, timing } from '@/lib/format';
import { NOW, client as clientById } from '@/data/db';
import * as W from '@/lib/wof';
import { useWofs } from '@/lib/useStore';

type Show = 'all' | 'outstanding' | 'overdue' | 'received';

interface Row extends W.CashflowRow {
  wof: W.Wof;
  clientId: string;
  overdue: boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default function ReportCashflow() {
  const toast = useToast();
  const wofs = useWofs();

  const [horizon, setHorizon] = useState(() => {
    try {
      return Number(localStorage.getItem('eprosta.cf.horizon') || 6);
    } catch {
      return 6;
    }
  });
  const [clientId, setClientId] = useState('all');
  const [show, setShow] = useState<Show>('all');
  const { sort, toggle } = useSort({ key: 'dueAt', dir: 1 });

  /** Flatten every WOF's cash flow into dated rows. */
  const allRows: Row[] = wofs.flatMap((w) => {
    // Nothing is expected income until the client has signed and ordered.
    if (!W.atLeast(w, 'order')) return [];
    return W.cashflow(w)
      .rows.filter((r) => r.amount > 0)
      .map((r) => ({
        ...r,
        wof: w,
        clientId: w.clientId,
        overdue: !r.received && new Date(r.dueAt) < NOW,
      }));
  });

  const cutoff = (() => {
    const x = new Date(NOW);
    x.setMonth(x.getMonth() + horizon);
    return x;
  })();

  const rows = allRows.filter((r) => {
    if (clientId !== 'all' && r.clientId !== clientId) return false;
    if (show === 'outstanding' && r.received) return false;
    if (show === 'overdue' && !r.overdue) return false;
    if (show === 'received' && !r.received) return false;
    // Received rows stay visible regardless of horizon; forecast rows are capped.
    if (!r.received && new Date(r.dueAt) > cutoff) return false;
    return true;
  });

  const expected = rows.reduce((s, r) => s + r.amount, 0);
  const received = rows.filter((r) => r.received).reduce((s, r) => s + r.amount, 0);
  const outstanding = expected - received;
  const overdueRows = rows.filter((r) => r.overdue);
  const overdue = overdueRows.reduce((s, r) => s + r.amount, 0);
  const notInvoiced = rows.filter((r) => !r.received && r.kind === 'balance' && !r.invoiced);

  const accessor = (r: Row, k: string) =>
    ({
      dueAt: +new Date(r.dueAt),
      amount: r.amount,
      client: clientById(r.clientId)?.name,
      job: r.wof.title,
      kind: r.kind,
      status: r.received ? 2 : r.overdue ? 0 : 1,
    })[k];

  const sorted = sortRows(rows, sort.key, sort.dir, accessor);

  const columns: Column<Row>[] = [
    {
      key: 'dueAt', label: 'Due', sortKey: 'dueAt', nowrap: true,
      cell: (r) => (
        <>
          <div className={`text-[13px] ${r.overdue ? 'text-status-critical font-semibold' : 'text-ink'}`}>
            {fmtDate(r.dueAt)}
          </div>
          <div className="text-[11.5px] text-ink-3">{timing(r.dueAt, r.dueAt).label}</div>
        </>
      ),
    },
    {
      key: 'job', label: 'Job', sortKey: 'job',
      cell: (r) => (
        <>
          <div className="text-[13.5px] text-ink font-medium">{r.wof.title}</div>
          <div className="text-[11.5px] text-ink-3 font-mono">{r.wof.ref}</div>
        </>
      ),
    },
    { key: 'client', label: 'Client', sortKey: 'client', cell: (r) => <ClientLink id={r.clientId} /> },
    {
      key: 'kind', label: 'Receipt', sortKey: 'kind', nowrap: true,
      cell: (r) => (
        <>
          <div className="text-[13px] text-ink-2">{r.label}</div>
          {!r.invoiced && r.kind === 'balance' ? (
            <div className="text-[11px] text-ink-3">
              Projected from {clientById(r.clientId)?.termsDays}-day terms
            </div>
          ) : null}
        </>
      ),
    },
    {
      key: 'status', label: 'Status', sortKey: 'status', nowrap: true,
      cell: (r) => (
        <Pill
          label={r.received ? 'Received' : r.overdue ? 'Overdue' : 'Expected'}
          tone={r.received ? 'healthy' : r.overdue ? 'critical' : 'info'}
          hint={r.received && r.receivedAt ? `Received ${fmtDate(r.receivedAt)}` : false}
        />
      ),
    },
    {
      key: 'amount', label: 'Amount', sortKey: 'amount', align: 'right', nowrap: true,
      cell: (r) => (
        <span className={`tabular-nums font-semibold ${r.received ? 'text-ink-2' : 'text-ink'}`}>
          {money(r.amount, { pence: false })}
        </span>
      ),
    },
  ];

  const exportCsv = () => {
    const csv = ['Due,Reference,Job,Client,Receipt,Status,Amount']
      .concat(
        rows.map((r) =>
          [
            fmtDate(r.dueAt), r.wof.ref, `"${r.wof.title}"`, `"${clientById(r.clientId)?.name ?? ''}"`,
            `"${r.label}"`, r.received ? 'Received' : r.overdue ? 'Overdue' : 'Expected',
            r.amount.toFixed(2),
          ].join(','),
        ),
      )
      .join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'cash-flow-forecast.csv';
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`Exported ${rows.length} rows.`, { tone: 'healthy' });
  };

  return (
    <>
      <PageHeader
        title="Cash flow forecast"
        subtitle="Expected income from signed orders and outstanding invoices, against what has actually landed. A job appears here the moment it becomes an order — not when it is invoiced."
        actions={
          <button type="button" className="btn btn-secondary" onClick={exportCsv}>
            <Icon name="download" decorative /> Export
          </button>
        }
      />

      <div className="flex flex-wrap gap-3 mb-5">
        <Kpi
          label="Expected"
          value={money(expected, { compact: true })}
          sub={`Across ${rows.length} scheduled receipts`}
          tone="info"
        />
        <Kpi
          label="Received"
          value={money(received, { compact: true })}
          sub={`${Math.round(expected ? (received / expected) * 100 : 0)}% of expected`}
          tone="healthy"
        />
        <Kpi
          label="Outstanding"
          value={money(outstanding, { compact: true })}
          sub={`${notInvoiced.length} not yet invoiced`}
          tone="atRisk"
        />
        <Kpi
          label="Overdue"
          value={money(overdue, { compact: true })}
          sub={overdueRows.length ? `${overdueRows.length} receipts past their due date` : 'Nothing overdue'}
          tone={overdue ? 'critical' : 'healthy'}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2.5 mb-5">
        <Segmented<Show>
          ariaLabel="Filter receipts"
          value={show}
          onChange={setShow}
          options={[
            ['all', 'Everything'],
            ['outstanding', 'Outstanding'],
            ['overdue', 'Overdue'],
            ['received', 'Received'],
          ]}
        />

        <label className="sr-only" htmlFor="client">
          Filter by client
        </label>
        <select className="field w-auto" id="client" value={clientId} onChange={(e) => setClientId(e.target.value)}>
          <option value="all">All clients</option>
          {[...new Set(allRows.map((r) => r.clientId))].map((id) => {
            const c = clientById(id);
            return c ? (
              <option key={id} value={id}>
                {c.name}
              </option>
            ) : null;
          })}
        </select>

        <div className="flex-1" />

        <label className="text-[12.5px] text-ink-3" htmlFor="horizon">
          Forecast horizon
        </label>
        <select
          className="field w-auto"
          id="horizon"
          value={horizon}
          onChange={(e) => {
            const m = Number(e.target.value);
            setHorizon(m);
            try {
              localStorage.setItem('eprosta.cf.horizon', String(m));
            } catch {
              /* private mode */
            }
          }}
        >
          {[3, 6, 12, 24].map((m) => (
            <option key={m} value={m}>
              {m} months
            </option>
          ))}
        </select>
      </div>

      <MonthChart rows={rows} />

      <Section title="Scheduled receipts" />

      <DataTable
        columns={columns}
        rows={sorted}
        rowKey={(r, i) => `${r.wof.id}-${r.kind}-${i}`}
        sort={sort}
        onSort={toggle}
        rowHref={(r) => `/wofs/${r.wof.id}#invoice`}
        footer={{
          job: `${sorted.length} receipt${sorted.length === 1 ? '' : 's'}`,
          amount: money(sorted.reduce((s, r) => s + r.amount, 0), { pence: false }),
        }}
      />

      <Provenance>
        Each row links back to the WOF it came from. The amounts are contract value net of deposit — the
        same numbers on the WOF's invoice tab and on job costing.
      </Provenance>
    </>
  );
}

/* A plain CSS bar chart: expected vs received per month. No library, because
   the point is the shape of the money, not the chart. */
function MonthChart({ rows }: { rows: Row[] }) {
  const buckets = new Map<string, { key: string; label: string; expected: number; received: number; overdue: number }>();
  rows.forEach((r) => {
    const d = new Date(r.dueAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const b =
      buckets.get(key) ||
      {
        key,
        label: `${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`,
        expected: 0, received: 0, overdue: 0,
      };
    b.expected += r.amount;
    if (r.received) b.received += r.amount;
    if (r.overdue) b.overdue += r.amount;
    buckets.set(key, b);
  });

  const months = [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key));
  if (!months.length) return null;
  const max = Math.max(...months.map((m) => m.expected)) || 1;

  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between mb-4">
        <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3">
          Expected vs received by month
        </div>
        <div className="flex items-center gap-4 text-[11.5px]">
          {(
            [
              ['healthy', 'Received'],
              ['critical', 'Overdue'],
              ['info', 'Expected'],
            ] as const
          ).map(([tone, label]) => (
            <span key={label} className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: TONE_HEX[tone] }} />
              <span className="text-ink-2">{label}</span>
            </span>
          ))}
        </div>
      </div>
      <div
        className="flex items-end gap-3 h-44"
        role="img"
        aria-label="Bar chart of expected against received income by month"
      >
        {months.map((m) => {
          const h = (m.expected / max) * 100;
          const recH = m.expected ? (m.received / m.expected) * 100 : 0;
          const ovH = m.expected ? (m.overdue / m.expected) * 100 : 0;
          return (
            <div key={m.key} className="flex-1 flex flex-col items-center gap-1.5 min-w-0">
              <div className="text-[11px] tabular-nums text-ink-2 whitespace-nowrap">
                {money(m.expected, { compact: true })}
              </div>
              <div
                className="w-full rounded-t-md relative tip"
                tabIndex={0}
                style={{ height: `${Math.max(h, 2)}%`, background: TONE_BG.info, minHeight: 4 }}
                data-tip={`${m.label}: ${money(m.expected, { pence: false })} expected, ${money(m.received, { pence: false })} received`}
              >
                <div
                  className="absolute bottom-0 left-0 right-0 rounded-t-md"
                  style={{ height: `${recH}%`, background: TONE_HEX.healthy }}
                />
                <div
                  className="absolute bottom-0 left-0 right-0"
                  style={{ height: `${ovH}%`, background: TONE_HEX.critical, opacity: 0.85 }}
                />
              </div>
              <div className="text-[11px] text-ink-3 whitespace-nowrap">{m.label}</div>
            </div>
          );
        })}
      </div>
      <Provenance>
        Deposits are dated from the order confirmation; balances from the invoice due date, or projected
        from the client's payment terms where no invoice exists yet.
      </Provenance>
    </div>
  );
}
