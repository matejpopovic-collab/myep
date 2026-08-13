/* ============================================================================
   DOCUMENT CHECKLIST REPORT
   ----------------------------------------------------------------------------
   Briefing §2.3: "Per-job view of required documents, their status (Required /
   Submitted / Approved / Outstanding), responsible party, and due date."

   This is Colin's screen, and the one that replaces Monday. Two cuts of the
   same rows because chasing works two ways:
     By job      — is this event ready to run
     By document — who owes me what, across every job

   Statuses can be changed inline. Every change writes to the WOF history, so
   there is a record of who approved what and when.
   ========================================================================== */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import {
  EmptyState, Kpi, PageHeader, Pill, Provenance, SearchField, Segmented,
} from '@/components/primitives';
import { DataTable, sortRows, useSort, type Column, type SortState } from '@/components/DataTable';
import { DocChip, ManagerChip } from '@/components/wof-ui';
import { useToast } from '@/components/Toast';
import { TONE_BG, TONE_HEX, TONE_LINE } from '@/lib/status';
import { addDays, fmtDate, timing } from '@/lib/format';
import { DOCUMENT_TYPES, NOW, client as clientById, docType } from '@/data/db';
import * as W from '@/lib/wof';
import { useWofs } from '@/lib/useStore';

type Group = 'job' | 'doc' | 'flat';
type StatusFilter = 'all' | 'attention' | 'outstanding' | W.DocStatusId;

type Doc = W.WofDocView & { wof: W.Wof };

const STATUS_OPTIONS: [StatusFilter, string][] = [
  // 'Needs attention' is the working list: anything late, whoever it is with.
  // 'Not received' is the narrower chase list — see docStatusMeta in wof.ts for
  // why those two are no longer the same question.
  ['attention', 'Needs attention'],
  ['outstanding', 'Not received'],
  ['submitted', 'With us to check'],
  ['required', 'Required'],
  ['approved', 'Approved'],
  ['all', 'All statuses'],
];

export default function ReportDocuments() {
  const toast = useToast();
  const wofs = useWofs();

  const [group, setGroup] = useState<Group>(() => {
    try {
      return (localStorage.getItem('eprosta.doc.group') as Group) || 'job';
    } catch {
      return 'job';
    }
  });
  const [owner, setOwner] = useState('all');
  const [status, setStatus] = useState<StatusFilter>('attention');
  const [horizon, setHorizon] = useState(60);
  const [query, setQuery] = useState('');
  // Off by default: this page is a chase list, and nobody should be chasing
  // paperwork for work the client has not committed to. On, it becomes a
  // register — which is what you want when checking a job you have just raised
  // and cannot otherwise see anywhere but the WOF's own Documents tab.
  const [unconfirmed, setUnconfirmed] = useState(() => {
    try {
      return localStorage.getItem('eprosta.doc.unconfirmed') === '1';
    } catch {
      return false;
    }
  });
  const { sort, toggle } = useSort({ key: 'due', dir: 1 });

  const showUnconfirmed = (on: boolean) => {
    setUnconfirmed(on);
    try {
      localStorage.setItem('eprosta.doc.unconfirmed', on ? '1' : '0');
    } catch {
      /* private browsing — the toggle just does not persist */
    }
    // A job raised today has no overdue documents, so leaving the filter on
    // 'Needs attention' would turn this on and change nothing on screen. That
    // reads as a broken switch, so widen the filter with it.
    if (on && status === 'attention') setStatus('all');
  };

  /** Every document on every live WOF, flattened. */
  const everything: Doc[] = wofs.flatMap((w) => {
    if (w.stage === 'complete') return [];
    // A checklist only matters for chasing once the job is confirmed.
    if (!W.atLeast(w, 'order') && !unconfirmed) return [];
    return W.docState(w).docs.map((d) => ({ ...d, wof: w }));
  });

  const cutoff = addDays(NOW, horizon);
  const q = query.trim().toLowerCase();
  /** Rows the date window alone is hiding — the other invisible filter here. */
  const beyondHorizon = everything.filter((d) => new Date(d.wof.start) > new Date(cutoff)).length;
  const docs = everything.filter((d) => {
    if (new Date(d.wof.start) > new Date(cutoff)) return false;
    if (owner !== 'all' && d.owner !== owner) return false;
    if (status === 'attention' && !d.overdue) return false;
    if (status === 'outstanding' && d.effectiveStatus !== 'outstanding') return false;
    if (['required', 'submitted', 'approved'].includes(status) && d.status !== status) return false;
    if (q && !`${d.label} ${d.wof.title} ${d.owner}`.toLowerCase().includes(q)) return false;
    return true;
  });

  // KPIs and the mandatory-missing banner read the confirmed book only, whatever
  // the toggle is doing. A view switch must not move the numbers people report
  // upwards, or two people quoting "documents outstanding" disagree by however
  // many test jobs happened to be in the pipeline that morning.
  const book = everything.filter((d) => W.atLeast(d.wof, 'order'));
  const outstanding = book.filter((d) => d.effectiveStatus === 'outstanding');
  const awaitingReview = book.filter((d) => d.status === 'submitted');
  const blocking = outstanding.filter((d) => d.blocking);
  const approved = book.filter((d) => d.status === 'approved');
  const jobsAtRisk = new Set(blocking.map((d) => d.wof.id));
  const unconfirmedRows = everything.length - book.length;
  /** What the stage gate is currently holding back, for the empty state. */
  const hiddenUnconfirmed = unconfirmed
    ? 0
    : wofs.reduce(
        (n, w) =>
          w.stage === 'complete' || W.atLeast(w, 'order') ? n : n + (w.documents?.length ?? 0),
        0,
      );

  const setDoc = (d: Doc, next: W.DocStatusId) => {
    W.setDocStatus(d.wof, d.docId, next);
    toast(`${docType(d.docId)?.label} marked ${W.DOC_STATUS[next].label.toLowerCase()} on ${d.wof.title}.`, {
      tone: next === 'approved' ? 'healthy' : 'info',
    });
  };

  const exportCsv = () => {
    // Status and Late are separate columns so a filter in Excel can tell
    // "we never got it" from "we got it late", which one column cannot.
    // Confirmed travels with the rows too: a chase list emailed round the
    // office must not quietly mix in jobs nobody has ordered yet.
    const csv = ['Due,Document,Mandatory,Reference,Job,EventDate,Client,Responsible,Status,Late,Confirmed']
      .concat(
        docs.map((d) =>
          [
            fmtDate(d.dueDate), `"${d.label}"`, d.blocking ? 'Yes' : 'No', d.wof.ref, `"${d.wof.title}"`,
            fmtDate(d.wof.start), `"${clientById(d.wof.clientId)?.name ?? ''}"`, `"${d.owner}"`,
            W.DOC_STATUS[d.status].label, d.overdue ? 'Yes' : 'No',
            W.atLeast(d.wof, 'order') ? 'Yes' : 'No',
          ].join(','),
        ),
      )
      .join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'document-checklist.csv';
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`Exported ${docs.length} rows.`, { tone: 'healthy' });
  };

  return (
    <>
      <PageHeader
        title="Document checklist"
        subtitle="Required documents per job, their status, who is responsible and when they are due. Lists are configured per job type, so a fixture is not chased for a traffic management plan it never needed."
        actions={
          <>
            <Link className="btn btn-secondary" to="/job-types">
              <Icon name="settings" decorative /> Configure checklists
            </Link>
            <button type="button" className="btn btn-secondary" onClick={exportCsv}>
              <Icon name="download" decorative /> Export
            </button>
          </>
        }
      />

      <div className="flex flex-wrap gap-3 mb-5">
        <Kpi
          label="Not received"
          value={String(outstanding.length)}
          sub="Past due, never arrived — chase"
          tone={outstanding.length ? 'atRisk' : 'healthy'}
        />
        <Kpi
          label="With us to check"
          value={String(awaitingReview.length)}
          sub="Received, waiting on our approval"
          tone={awaitingReview.length ? 'info' : 'healthy'}
        />
        <Kpi
          label="Mandatory missing"
          value={String(blocking.length)}
          sub={`Across ${jobsAtRisk.size} job${jobsAtRisk.size === 1 ? '' : 's'}`}
          tone={blocking.length ? 'critical' : 'healthy'}
        />
        <Kpi
          label="Approved"
          value={`${approved.length}/${book.length}`}
          sub={`${Math.round(book.length ? (approved.length / book.length) * 100 : 100)}% of the confirmed book`}
          tone="healthy"
        />
        <Kpi
          label="Waiting on the client"
          value={String(book.filter((d) => d.owner === 'Client' && d.status !== 'approved').length)}
          sub="Documents EP cannot produce itself"
          tone="info"
        />
      </div>

      {blocking.length ? (
        <div className="card p-3.5 mb-5" style={{ background: TONE_BG.critical, borderColor: TONE_LINE.critical }}>
          <div className="flex items-start gap-2.5">
            <span style={{ color: TONE_HEX.critical, marginTop: 1 }}>
              <Icon name="alert" decorative />
            </span>
            <div className="flex-1">
              <div className="text-[13px] font-semibold text-ink mb-1">
                {jobsAtRisk.size} job{jobsAtRisk.size > 1 ? 's are' : ' is'} missing a mandatory document
              </div>
              <div className="text-[13px] text-ink-2 leading-relaxed mb-1.5">
                {[...jobsAtRisk].map((id, i) => {
                  const w = W.byId(id)!;
                  const n = blocking.filter((d) => d.wof.id === id).length;
                  return (
                    <span key={id}>
                      {i ? ' · ' : ''}
                      <Link to={`/wofs/${id}#documents`} className="text-accent no-underline hover:underline">
                        {w.title}
                      </Link>{' '}
                      <span className="text-ink-3">({n})</span>
                    </span>
                  );
                })}
              </div>
              <p className="text-[11.5px] text-ink-3">
                Current policy warns rather than blocks. Switch the policy in Reference data once OPS have
                agreed which documents should genuinely stop a job going out.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2.5 mb-5">
        <Segmented<Group>
          ariaLabel="Group by"
          value={group}
          onChange={(g) => {
            setGroup(g);
            try {
              localStorage.setItem('eprosta.doc.group', g);
            } catch {
              /* private mode */
            }
          }}
          options={[
            ['job', 'By job'],
            ['doc', 'By document'],
            ['flat', 'Flat list'],
          ]}
        />

        <label className="sr-only" htmlFor="status">
          Filter by status
        </label>
        <select
          className="field w-auto"
          id="status"
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
        >
          {STATUS_OPTIONS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor="owner">
          Filter by responsible party
        </label>
        <select className="field w-auto" id="owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="all">Anyone responsible</option>
          {[...new Set(DOCUMENT_TYPES.map((d) => d.owner))].map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>

        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Filter…"
          ariaLabel="Filter documents"
          className="w-56"
        />

        <label className="inline-flex items-center gap-2 text-[12.5px] text-ink-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={unconfirmed}
            onChange={(e) => showUnconfirmed(e.target.checked)}
          />
          Include unconfirmed
          <span
            className="text-ink-3"
            title="Jobs not yet at Order stage. Their checklists exist but nobody should be chased for them yet, so they are hidden by default and never counted in the totals above."
          >
            <Icon name="info" decorative className="icon-sm" />
          </span>
        </label>

        <div className="flex-1" />

        <label className="text-[12.5px] text-ink-3" htmlFor="horizon">
          Events within
        </label>
        <select
          className="field w-auto"
          id="horizon"
          value={horizon}
          onChange={(e) => setHorizon(Number(e.target.value))}
        >
          {[14, 30, 60, 180].map((d) => (
            <option key={d} value={d}>
              {d} days
            </option>
          ))}
        </select>
      </div>

      {unconfirmed ? (
        <p className="text-[12.5px] text-ink-3 -mt-3 mb-5">
          Showing {unconfirmedRows} row{unconfirmedRows === 1 ? '' : 's'} from jobs not yet confirmed as
          orders, marked <span className="text-ink-2">Not confirmed</span>. They are excluded from the totals
          above, and their due dates are provisional until the event date is agreed.
        </p>
      ) : null}

      {!docs.length ? (
        <div className="card">
          <EmptyState
            iconName="checkCircle"
            title="Nothing outstanding"
            body="Every document matching these filters is submitted or approved."
          />
          {/* The stage gate is invisible from here, so an empty page looks like
              a missing job rather than a hidden one. Say what is being held
              back and offer the switch. */}
          {hiddenUnconfirmed ? (
            <p className="text-[12.5px] text-ink-3 px-4 pb-2 text-center">
              {hiddenUnconfirmed} document{hiddenUnconfirmed === 1 ? '' : 's'} on jobs not yet confirmed as
              orders {hiddenUnconfirmed === 1 ? 'is' : 'are'} hidden.{' '}
              <button
                type="button"
                className="text-accent no-underline hover:underline bg-transparent border-0 p-0 cursor-pointer font-inherit"
                onClick={() => {
                  showUnconfirmed(true);
                  setQuery('');
                }}
              >
                Include unconfirmed jobs
              </button>
              .
            </p>
          ) : null}
          {beyondHorizon ? (
            <p className="text-[12.5px] text-ink-3 px-4 pb-4 text-center">
              {beyondHorizon} more {beyondHorizon === 1 ? 'is' : 'are'} on events beyond {horizon} days.{' '}
              <button
                type="button"
                className="text-accent no-underline hover:underline bg-transparent border-0 p-0 cursor-pointer font-inherit"
                onClick={() => setHorizon(180)}
              >
                Widen to 180 days
              </button>
              .
            </p>
          ) : null}
        </div>
      ) : group === 'job' ? (
        <ByJob docs={docs} onSet={setDoc} />
      ) : group === 'doc' ? (
        <ByDoc docs={docs} onSet={setDoc} />
      ) : (
        <FlatList docs={docs} sort={sort} onSort={toggle} onSet={setDoc} />
      )}

      {docs.length ? (
        <Provenance>
          Checklists are generated from the job type when the WOF is raised, and due dates are worked back
          from the event date using each document's lead time. Changing a status here writes to that WOF's
          history. Jobs below Order stage are hidden unless <em>Include unconfirmed</em> is on, and are never
          counted in the totals at the top.
        </Provenance>
      ) : null}
    </>
  );
}

/* --------------------------------------------------------------- doc row -- */

function StatusSelect({ d, onSet }: { d: Doc; onSet: (d: Doc, s: W.DocStatusId) => void }) {
  return (
    <select
      className="field w-auto text-[12.5px]"
      value={d.status}
      aria-label={`Set status of ${d.label} on ${d.wof.title}`}
      onChange={(e) => onSet(d, e.target.value as W.DocStatusId)}
    >
      {(['required', 'submitted', 'approved'] as W.DocStatusId[]).map((s) => (
        <option key={s} value={s}>
          {W.DOC_STATUS[s].label}
        </option>
      ))}
    </select>
  );
}

/** One document row. `showJob` swaps the label for the job it belongs to. */
function DocRow({ d, showJob, onSet }: { d: Doc; showJob: boolean; onSet: (d: Doc, s: W.DocStatusId) => void }) {
  const meta = W.docStatusMeta(d);
  return (
    <div className="flex flex-wrap items-center gap-3 px-2.5 py-2 border-b border-surface-line-soft last:border-0">
      <div className="flex-1 min-w-[180px]">
        {showJob ? (
          <Link to={`/wofs/${d.wof.id}#documents`} className="no-underline">
            <div className="text-[13.5px] text-ink">{d.wof.title}</div>
            <div className="text-[11.5px] text-ink-3 font-mono">
              {d.wof.ref}
              {W.atLeast(d.wof, 'order') ? '' : ' · not confirmed'}
            </div>
          </Link>
        ) : (
          <>
            <div className="text-[13.5px] text-ink">{d.label}</div>
            {d.blocking ? <div className="text-[11px] text-ink-3">Mandatory for this job type</div> : null}
          </>
        )}
      </div>
      <div className="w-32 text-[12.5px] text-ink-2">{d.owner}</div>
      <div className="w-32">
        <div className={`text-[12.5px] ${d.overdue ? 'text-status-critical font-semibold' : 'text-ink-2'}`}>
          {fmtDate(d.dueDate)}
        </div>
        <div className="text-[11px] text-ink-3">{timing(d.dueDate, d.dueDate).label}</div>
      </div>
      <div className="w-28">
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
      </div>
      <StatusSelect d={d} onSet={onSet} />
    </div>
  );
}

/* --------------------------------------------------------- job grouping -- */

function ByJob({ docs, onSet }: { docs: Doc[]; onSet: (d: Doc, s: W.DocStatusId) => void }) {
  const map = new Map<string, { wof: W.Wof; docs: Doc[] }>();
  docs.forEach((d) => {
    const g = map.get(d.wof.id) || { wof: d.wof, docs: [] };
    g.docs.push(d);
    map.set(d.wof.id, g);
  });
  const groups = [...map.values()].sort((a, b) => +new Date(a.wof.start) - +new Date(b.wof.start));

  return (
    <>
      {groups.map((g) => {
        const t = timing(g.wof.start, g.wof.end);
        return (
          <section key={g.wof.id} className="card mb-3 overflow-hidden">
            <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-surface-line-soft bg-surface-raised">
              <div className="flex-1 min-w-0">
                <Link to={`/wofs/${g.wof.id}#documents`} className="no-underline">
                  <div className="text-[14px] font-semibold text-ink">{g.wof.title}</div>
                  <div className="text-[11.5px] text-ink-3">
                    <span className="font-mono">{g.wof.ref}</span> · {clientById(g.wof.clientId)?.name ?? ''} ·{' '}
                    {fmtDate(g.wof.start)}
                  </div>
                </Link>
              </div>
              <Pill status={t.phase} label={t.label} tone={t.tone} hint={false} />
              {W.atLeast(g.wof, 'order') ? null : (
                <Pill
                  label={`Not confirmed · ${W.stage(g.wof.stage)?.short ?? g.wof.stage}`}
                  tone="neutral"
                  hint="Not yet an order — nobody should be chased for these yet"
                />
              )}
              <DocChip wof={g.wof} />
              <ManagerChip id={g.wof.ownerId} />
            </div>
            <div className="px-2 py-1">
              {g.docs
                .slice()
                .sort((a, b) => +new Date(a.dueDate) - +new Date(b.dueDate))
                .map((d) => (
                  <DocRow key={`${d.wof.id}-${d.docId}`} d={d} showJob={false} onSet={onSet} />
                ))}
            </div>
          </section>
        );
      })}
    </>
  );
}

/* ---------------------------------------------------- document grouping -- */

function ByDoc({ docs, onSet }: { docs: Doc[]; onSet: (d: Doc, s: W.DocStatusId) => void }) {
  const map = new Map<string, { docId: string; label: string; owner: string; blocking: boolean; docs: Doc[] }>();
  docs.forEach((d) => {
    const g = map.get(d.docId) || { docId: d.docId, label: d.label, owner: d.owner, blocking: d.blocking, docs: [] };
    g.docs.push(d);
    map.set(d.docId, g);
  });
  const groups = [...map.values()].sort((a, b) => b.docs.length - a.docs.length);

  return (
    <>
      {groups.map((g) => (
        <section key={g.docId} className="card mb-3 overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-surface-line-soft bg-surface-raised">
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-semibold text-ink">{g.label}</div>
              <div className="text-[11.5px] text-ink-3">
                Responsible: {g.owner}
                {g.blocking ? ' · mandatory where it applies' : ''}
              </div>
            </div>
            <span className="text-[12.5px] text-ink-2">
              {g.docs.length} job{g.docs.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="px-2 py-1">
            {g.docs
              .slice()
              .sort((a, b) => +new Date(a.dueDate) - +new Date(b.dueDate))
              .map((d) => (
                <DocRow key={`${d.wof.id}-${d.docId}`} d={d} showJob onSet={onSet} />
              ))}
          </div>
        </section>
      ))}
    </>
  );
}

/* ------------------------------------------------------------ flat list -- */

function FlatList({
  docs,
  sort,
  onSort,
  onSet,
}: {
  docs: Doc[];
  sort: SortState;
  onSort: (k: string) => void;
  onSet: (d: Doc, s: W.DocStatusId) => void;
}) {
  const sorted = sortRows(
    docs,
    sort.key,
    sort.dir,
    (d, k) =>
      ({
        due: +new Date(d.dueDate),
        doc: d.label,
        job: d.wof.title,
        owner: d.owner,
        status: W.docStatusMeta(d).n,
      })[k],
  );

  const columns: Column<Doc>[] = [
    {
      key: 'due', label: 'Due', sortKey: 'due', nowrap: true,
      cell: (d) => (
        <>
          <div className={`text-[13px] ${d.overdue ? 'text-status-critical font-semibold' : 'text-ink'}`}>
            {fmtDate(d.dueDate)}
          </div>
          <div className="text-[11.5px] text-ink-3">{timing(d.dueDate, d.dueDate).label}</div>
        </>
      ),
    },
    {
      key: 'doc', label: 'Document', sortKey: 'doc',
      cell: (d) => (
        <>
          <div className="text-[13.5px] text-ink">{d.label}</div>
          {d.blocking ? <div className="text-[11px] text-ink-3">Mandatory</div> : null}
        </>
      ),
    },
    {
      key: 'job', label: 'Job', sortKey: 'job',
      cell: (d) => (
        <Link to={`/wofs/${d.wof.id}#documents`} className="no-underline">
          <div className="text-[13px] text-ink-2">{d.wof.title}</div>
          <div className="text-[11px] text-ink-3">
            {fmtDate(d.wof.start)}
            {W.atLeast(d.wof, 'order') ? '' : ' · not confirmed'}
          </div>
        </Link>
      ),
    },
    {
      key: 'owner', label: 'Responsible', sortKey: 'owner', nowrap: true,
      cell: (d) => <span className="text-[13px] text-ink-2">{d.owner}</span>,
    },
    {
      key: 'status', label: 'Status', sortKey: 'status', nowrap: true,
      cell: (d) => {
        const meta = W.docStatusMeta(d);
        return <Pill status={d.effectiveStatus} label={meta.label} tone={meta.tone} hint={false} />;
      },
    },
    { key: 'set', label: '', align: 'right', nowrap: true, cell: (d) => <StatusSelect d={d} onSet={onSet} /> },
  ];

  return (
    <DataTable
      columns={columns}
      rows={sorted}
      rowKey={(d) => `${d.wof.id}-${d.docId}`}
      sort={sort}
      onSort={onSort}
    />
  );
}
