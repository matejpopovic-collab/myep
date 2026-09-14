/* ============================================================================
   WOF PIPELINE
   ----------------------------------------------------------------------------
   The replacement for the Google Sheet. Every potential and live job, grouped
   by lifecycle stage, with the thing that is holding each one up shown on the
   row rather than discovered by opening it.

   Two views because two different people use this screen:
     · Board  — Colin, working the pipeline stage by stage
     · Table  — Gracie, doing data entry and chasing specific jobs
   ========================================================================== */

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import {
  CoverageBar, EmptyState, Kpi, PageHeader, Pill, Provenance, SearchField, Segmented,
} from '@/components/primitives';
import { DataTable, sortRows, useSort, type Column, type SortState } from '@/components/DataTable';
import { ClientLink, DocChip, ManagerChip, StagePill, TierPill, TimingPill } from '@/components/wof-ui';
import { MenuButton } from '@/components/Modal';
import { TONE_HEX, TONE_LINE } from '@/lib/status';
import * as C from '@/lib/classification';
import { coverageTone, eventCoverage } from '@/lib/coverage';
import { fmtDate, money, timing } from '@/lib/format';
import { MANAGERS, client as clientById, event as eventById, manager as managerById } from '@/data/db';
import * as ROLES from '@/lib/roles';
import * as W from '@/lib/wof';
import { useWofs } from '@/lib/useStore';
import { NewWofDialog } from './wof/NewWofDialog';
import { DeleteWofDialog } from './wof/dialogs';

type View = 'board' | 'table';

export default function WofsPage() {
  const all = useWofs();

  const [view, setView] = useState<View>(() => {
    try {
      return (localStorage.getItem('eprosta.wofs.view') as View) || 'board';
    } catch {
      return 'board';
    }
  });
  const [owner, setOwner] = useState('all');
  const [client, setClient] = useState('all');
  const [tier, setTier] = useState('all');
  const [query, setQuery] = useState('');
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [includeClosed, setIncludeClosed] = useState(false);
  const [raising, setRaising] = useState(false);
  const { sort, toggle } = useSort({ key: 'start', dir: 1 });

  const q = query.trim().toLowerCase();
  const rows = all.filter((w) => {
    if (!includeClosed && w.stage === 'complete') return false;
    if (owner !== 'all' && w.ownerId !== owner) return false;
    if (client !== 'all' && w.clientId !== client) return false;
    if (tier !== 'all') {
      const v = C.wofScale(w);
      // 'none' is a real answer, not the absence of a filter: "what has come
      // in that nobody has priced yet" is the question this screen gets asked
      // every Monday.
      if (tier === 'none' ? !!v : v?.scale !== tier) return false;
    }
    if (attentionOnly) {
      const g = W.gate(w);
      if (!g.block.length && !g.warn.length) return false;
    }
    if (q) {
      const c = clientById(w.clientId);
      if (!`${w.ref} ${w.title} ${c ? c.name : ''} ${w.venue}`.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const live = rows.filter((w) => !W.isTerminal(w.stage));
  const unconfirmed = live.filter((w) => !W.atLeast(w, 'order'));
  const confirmedJobs = live.filter((w) => W.atLeast(w, 'order'));
  const pipelineValue = unconfirmed.reduce((s, w) => s + W.contractValue(w), 0);
  const confirmedValue = confirmedJobs.reduce((s, w) => s + W.contractValue(w), 0);
  const attention = rows.filter((w) => {
    const g = W.gate(w);
    return g.block.length || g.warn.length;
  });
  const blocked = rows.filter((w) => W.gate(w).block.length);

  return (
    <>
      <PageHeader
        title="WOF pipeline"
        subtitle="Every work order from first enquiry to settled invoice. The WOF is the record — the calendar, the staffing tool, the reports and the invoice all read from it."
        actions={
          <>
            {/* The reset moved to Account settings. It never only reset work
                orders — it discards team changes, check-in approvals,
                notifications and preferences too — and a button on the pipeline
                screen gave no hint of that scope. */}
            <Link className="btn btn-secondary" to="/settings/account">
              <Icon name="refresh" decorative /> Reset demo data
            </Link>
            <button type="button" className="btn btn-primary" onClick={() => setRaising(true)}>
              <Icon name="plus" decorative /> Raise WOF
            </button>
          </>
        }
      />

      <div className="flex flex-wrap gap-3 mb-5">
        <Kpi
          label="Unconfirmed pipeline"
          value={money(pipelineValue, { compact: true })}
          sub={`${unconfirmed.length} WOFs not yet signed and ordered`}
          tone="info"
        />
        <Kpi
          label="Confirmed order book"
          value={money(confirmedValue, { compact: true })}
          sub={`${confirmedJobs.length} jobs confirmed and in delivery`}
          tone="healthy"
          to="/reports/cashflow"
          hint="Opens the cash flow forecast"
        />
        <Kpi
          label="Need attention"
          value={String(attention.length)}
          sub={blocked.length ? `${blocked.length} cannot progress at all` : 'None hard-blocked'}
          tone={blocked.length ? 'critical' : attention.length ? 'atRisk' : 'healthy'}
        />
        <Kpi
          label="Events with no WOF"
          value={String(W.calendarRows().filter((r) => !r.wof).length)}
          sub="Known events on the calendar with no paperwork raised"
          tone="atRisk"
          to="/calendar"
          hint="Opens the event calendar"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2.5 mb-5">
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Filter by reference, job or client…"
          ariaLabel="Filter work orders"
          className="w-64"
        />

        <button
          type="button"
          className="chip"
          aria-pressed={attentionOnly}
          onClick={() => setAttentionOnly((a) => !a)}
        >
          <Icon name="alert" decorative className="icon-sm" /> Needs attention
          <span className="text-2xs opacity-70">{attention.length}</span>
        </button>

        <label className="sr-only" htmlFor="owner">
          Filter by manager
        </label>
        <select className="field w-auto" id="owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="all">All managers</option>
          {MANAGERS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor="client">
          Filter by client
        </label>
        <select className="field w-auto" id="client" value={client} onChange={(e) => setClient(e.target.value)}>
          <option value="all">All clients</option>
          {[...new Set(all.map((w) => w.clientId))].map((id) => {
            const c = clientById(id);
            return c ? (
              <option key={id} value={id}>
                {c.name}
              </option>
            ) : null;
          })}
        </select>

        <label className="sr-only" htmlFor="tier">
          Filter by tier
        </label>
        <select className="field w-auto" id="tier" value={tier} onChange={(e) => setTier(e.target.value)}>
          <option value="all">All tiers</option>
          {/* Biggest first: the reason to filter by tier is almost always to
              find the jobs that need the most planning. */}
          {[...C.AUTO_SCALES].reverse().map((sc) => (
            <option key={sc} value={sc}>
              {C.SCALE_LABEL[sc]}
            </option>
          ))}
          {C.MANUAL_ONLY_SCALES.map((sc) => (
            <option key={sc} value={sc}>
              {C.SCALE_LABEL[sc]}
            </option>
          ))}
          <option value="none">Not yet quoted</option>
        </select>

        <label className="chip" style={{ cursor: 'pointer' }}>
          <input type="checkbox" checked={includeClosed} onChange={(e) => setIncludeClosed(e.target.checked)} />
          Show completed
        </label>

        <div className="flex-1" />

        <Segmented<View>
          ariaLabel="View"
          value={view}
          onChange={(v) => {
            setView(v);
            try {
              localStorage.setItem('eprosta.wofs.view', v);
            } catch {
              /* private mode */
            }
          }}
          options={[
            ['board', 'Board'],
            ['table', 'Table'],
          ]}
        />
      </div>

      {!rows.length ? (
        <div className="card">
          <EmptyState
            iconName="fileText"
            title="No work orders match"
            body="Clear the filters, or raise a WOF against a known event from the calendar."
            action={
              <Link className="btn btn-secondary" to="/calendar">
                Open the event calendar
              </Link>
            }
          />
        </div>
      ) : view === 'board' ? (
        <Board rows={rows} />
      ) : (
        <TableView rows={rows} sort={sort} onSort={toggle} />
      )}

      {rows.length ? <TierLegend /> : null}

      {raising ? <NewWofDialog onClose={() => setRaising(false)} /> : null}

    </>
  );
}

/* ----------------------------------------------------------- tier legend -- */

/**
 * What the tier on every row actually means.
 *
 * The tier is on the board cards, the table column and the filter, and until
 * now the only place it was explained was a tooltip you had to know to hover.
 * A scale with seven steps and no key on the screen is a number people invent
 * their own meaning for — and the two manual bands, which no threshold can
 * produce, are the ones most likely to be guessed at.
 *
 * Ordered biggest first, the same order as the filter, because the reason to
 * look a tier up is almost always the job that needs the most planning. The
 * chips are the same quiet pill the rows use rather than a second swatch
 * system, so the key and the thing it keys read as one scale.
 */
function TierLegend() {
  const bands: C.EventScale[] = [...[...C.AUTO_SCALES].reverse(), ...C.MANUAL_ONLY_SCALES];

  return (
    <div className="card p-4 mt-5">
      <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2.5">Tier legend</div>
      <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">
        {bands.map((sc) => (
          <div key={sc} className="flex items-baseline gap-2.5">
            <span className="shrink-0">
              <Pill label={C.SCALE_LABEL[sc]} tone={C.scaleTone(sc)} hint={false} variant="quiet" />
            </span>
            <span className="text-[12px] text-ink-3 leading-relaxed">{C.SCALE_DESCRIPTION[sc]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ board -- */

function Board({ rows }: { rows: W.Wof[] }) {
  const cols: { id: string; n: number; label: string; blurb?: string; wofs: W.Wof[] }[] = W.STAGES.map((s) => ({
    ...s,
    wofs: rows.filter((w) => w.stage === s.id),
  }));
  const closed = rows.filter((w) => W.isTerminal(w.stage));
  if (closed.length)
    cols.push({ id: 'complete', n: 9, label: 'Closed', wofs: closed, blurb: 'Delivered, invoiced and settled.' });

  return (
    <div className="flex gap-3 overflow-x-auto pb-4" role="list" aria-label="WOF pipeline by stage">
      {cols.map((c) => (
        <section key={c.id} className="flex-none w-[268px]" role="listitem">
          <div className="flex items-baseline justify-between gap-2 mb-2 px-1">
            <h2 className="text-[12.5px] font-bold text-ink tracking-tight">
              <span className="text-ink-3 tabular-nums">{c.n}.</span> {c.label}
            </h2>
            <span className="text-[11.5px] text-ink-3 tabular-nums">{c.wofs.length}</span>
          </div>
          <p className="text-[11px] text-ink-3 leading-snug px-1 mb-2 min-h-[28px]">{c.blurb || ''}</p>
          <div className="space-y-2">
            {c.wofs.length ? (
              c.wofs.map((w) => <BoardCard key={w.id} w={w} />)
            ) : (
              <div className="rounded-xl border border-dashed border-surface-line px-3 py-5 text-center text-[12px] text-ink-3">
                Nothing at this stage
              </div>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

function BoardCard({ w }: { w: W.Wof }) {
  const g = W.gate(w);
  const t = timing(w.start, w.end);
  const ds = W.docState(w);
  const ev = w.eventId ? eventById(w.eventId) : null;
  const cov = ev ? eventCoverage(ev) : null;
  const tone = g.block.length ? 'critical' : g.warn.length ? 'atRisk' : 'neutral';
  const c = clientById(w.clientId);
  const first = g.block[0] || g.warn[0];

  return (
    <Link
      to={`/wofs/${w.id}`}
      className="card p-3 block no-underline hover:bg-surface-raised transition-colors"
      style={g.block.length || g.warn.length ? { borderColor: TONE_LINE[tone] } : undefined}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <span className="font-mono text-[11px] text-accent">{w.ref}</span>
        <span className="text-[11px] tabular-nums font-semibold text-ink-2">
          {money(W.contractValue(w), { compact: true })}
        </span>
      </div>
      <div className="text-[13px] font-semibold text-ink leading-snug mb-1">{w.title}</div>
      <div className="text-[11.5px] text-ink-3 mb-2 truncate">{c ? c.name : ''}</div>

      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        <TimingPill t={t} status={t.phase} />
        <TierPill wof={w} dash={false} />
        {ds.total ? <DocChip wof={w} /> : null}
      </div>

      {cov ? (
        <div className="mb-2">
          <div className="flex items-baseline justify-between text-[11px] mb-1">
            <span className="text-ink-3">Staffing</span>
            <span className="tabular-nums font-semibold text-ink-2">
              {cov.filled}/{cov.required}
            </span>
          </div>
          <CoverageBar cov={cov} tone={coverageTone(cov, w.start, w.end)} height={5} />
        </div>
      ) : null}

      {first ? (
        <div
          className="flex items-start gap-1.5 text-[11.5px] leading-snug pt-2 border-t border-surface-line-soft"
          style={{ color: TONE_HEX[tone] }}
        >
          <Icon name="alert" decorative className="icon-sm" />
          <span className="flex-1">
            {first.slice(0, 96)}
            {first.length > 96 ? '…' : ''}
          </span>
        </div>
      ) : null}
    </Link>
  );
}

/* ------------------------------------------------------------------ table -- */

function TableView({
  rows,
  sort,
  onSort,
}: {
  rows: W.Wof[];
  sort: SortState;
  onSort: (k: string) => void;
}) {
  const navigate = useNavigate();
  // The row being deleted, not a boolean: the dialog needs the WOF, and the
  // table is a list of them.
  const [deleting, setDeleting] = useState<W.Wof | null>(null);

  const accessor = (w: W.Wof, key: string) =>
    ({
      ref: w.ref,
      title: w.title,
      client: clientById(w.clientId)?.name,
      stage: W.stageIndex(w.stage) < 0 ? 99 : W.stageIndex(w.stage),
      tier: C.scaleRank(C.wofScale(w)?.scale ?? null),
      start: +new Date(w.start),
      value: W.contractValue(w),
      docs: W.docState(w).late,
      owner: managerById(w.ownerId)?.name,
    })[key];

  const sorted = sortRows(rows, sort.key, sort.dir, accessor);

  const columns: Column<W.Wof>[] = [
    {
      key: 'ref', label: 'Reference', sortKey: 'ref', nowrap: true,
      cell: (w) => <span className="font-mono text-[12px] text-accent">{w.ref}</span>,
    },
    {
      key: 'title', label: 'Job', sortKey: 'title',
      cell: (w) => (
        <>
          <div className="text-[13.5px] text-ink font-medium">{w.title}</div>
          <div className="text-[11.5px] text-ink-3">{w.venue || ''}</div>
        </>
      ),
    },
    { key: 'client', label: 'Client', sortKey: 'client', cell: (w) => <ClientLink id={w.clientId} /> },
    { key: 'stage', label: 'Stage', sortKey: 'stage', nowrap: true, cell: (w) => <StagePill wof={w} /> },
    { key: 'tier', label: 'Tier', sortKey: 'tier', nowrap: true, cell: (w) => <TierPill wof={w} /> },
    {
      key: 'start', label: 'Event date', sortKey: 'start', nowrap: true,
      cell: (w) => (
        <>
          <div className="text-[13px]">{fmtDate(w.start)}</div>
          <div className="text-[11.5px] text-ink-3">{timing(w.start, w.end).label}</div>
        </>
      ),
    },
    { key: 'docs', label: 'Documents', sortKey: 'docs', nowrap: true, cell: (w) => <DocChip wof={w} /> },
    { key: 'owner', label: 'Owner', sortKey: 'owner', nowrap: true, cell: (w) => <ManagerChip id={w.ownerId} /> },
    {
      key: 'value', label: 'Contract value', sortKey: 'value', align: 'right', nowrap: true,
      cell: (w) => (
        <>
          <span className="tabular-nums font-semibold text-ink">{money(W.contractValue(w), { pence: false })}</span>
          {W.variationValue(w) ? (
            <div className="text-[11px] text-status-at-risk tabular-nums">
              incl. {money(W.variationValue(w), { pence: false })} variations
            </div>
          ) : null}
        </>
      ),
    },
    {
      /* Row actions. Unsorted and unlabelled — a column header over a menu
         button reads as a data column and invites a click on the header.
         `DataTable` already ignores clicks that land on a button, so this does
         not fight the row link. */
      key: 'actions', label: '', align: 'right', nowrap: true,
      cell: (w) => {
        const del = W.deletable(w);
        const why = ROLES.denial('wof.cancel');
        return (
          <MenuButton
            label={`Actions for ${w.ref}`}
            items={[
              { label: 'Open this job', icon: 'externalLink', onSelect: () => navigate(`/wofs/${w.id}`) },
              '-',
              {
                label: 'Delete this job',
                icon: 'trash',
                danger: true,
                disabled: !del.ok || !!why,
                hint: why || (del.ok ? 'Removes the job and everything it owns. No undo.' : del.reason),
                onSelect: () => setDeleting(w),
              },
            ]}
          />
        );
      },
    },
  ];

  return (
    <>
      <DataTable
        columns={columns}
        rows={sorted}
        rowKey={(w) => w.id}
        sort={sort}
        onSort={onSort}
        rowHref={(w) => `/wofs/${w.id}`}
        footer={{
          title: `${sorted.length} work order${sorted.length === 1 ? '' : 's'}`,
          value: money(sorted.reduce((s, w) => s + W.contractValue(w), 0), { pence: false }),
        }}
      />
      <Provenance>
        {/* The bands themselves are in the legend under this table, so this
            says only where the reading is TAKEN FROM — which is the part the
            legend cannot show and the part that changes mid-job. */}
        Tier is the Master Calendar's classification, read from the quote until the job is ordered and from
        the staffing plan after that.{' '}
        Contract value is the signed quote plus every variation added since, priced at the rate that applied
        when each line was added. It is the same figure the invoice and the cash flow forecast use.
      </Provenance>
      {/* Deleting from the list leaves you on the list. The row goes, the
          filters and scroll position stay — this is the screen for clearing
          several test records, and bouncing to a detail page between each one
          would make that ten clicks instead of three. */}
      {deleting ? (
        <DeleteWofDialog w={deleting} onClose={() => setDeleting(null)} />
      ) : null}
    </>
  );
}
