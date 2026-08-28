/* ============================================================================
   CLIENT PORTAL — QUOTES & JOBS
   ----------------------------------------------------------------------------
   The client's side of the WOF pipeline, and the answer to the question this
   portal previously could not handle: an operator raises a work order, and the
   client sees it.

   Two decisions shape the page:

   1. A job appears from the moment it is RAISED, not from the moment it becomes
      an order. The old client view was driven by operational events, which do
      not exist until three stages later — so the client could not see the quote
      they were being asked to sign. Visibility is early; what they can DO is
      what varies by stage, and that is `clientTasks()`.

   2. The list leads with what is owed BY THE CLIENT, not with job status. A
      status tells them where EP Team has got to; a task tells them what will
      still be sitting there tomorrow if they close the tab. Anything overdue
      sorts to the top regardless of event date.

   Absent by construction, not by filtering: cost prices, margin, staff pay
   rates, and every other client's work. `portal.clientJobs()` is scoped to the
   acting client and never hands the rest over.
   ========================================================================== */

import { Link } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { EmptyState, Kpi, PageHeader, Pill, Provenance } from '@/components/primitives';
import { TONE_BG, TONE_HEX, TONE_LINE } from '@/lib/status';
import { countLabel, fmtDate, fmtRange, money } from '@/lib/format';
import * as PORTAL from '@/lib/portal';
import * as W from '@/lib/wof';
import { usePortalVersion, useWofVersion } from '@/lib/useStore';

const TASK_ICON: Record<W.ClientTaskId, string> = {
  sign: 'edit',
  deposit: 'trendUp',
  documents: 'fileText',
  variations: 'alert',
  invoice: 'download',
};

export default function ClientJobsPage() {
  useWofVersion();
  usePortalVersion();

  const client = PORTAL.actingClient();
  const rows = PORTAL.clientJobs();

  // Anything the client owes floats to the top, overdue first. Everything else
  // keeps event order.
  const sorted = rows.slice().sort((a, b) => {
    const urgency = (r: PORTAL.ClientJobRow) =>
      r.tasks.some((t) => t.overdue) ? 0 : r.tasks.length ? 1 : 2;
    return urgency(a) - urgency(b) || +new Date(a.wof.start) - +new Date(b.wof.start);
  });

  const todo = rows.flatMap((r) => r.tasks);
  const toSign = rows.filter((r) => r.tasks.some((t) => t.id === 'sign'));
  const owed = todo
    .filter((t) => t.id === 'deposit' || t.id === 'invoice')
    .reduce((s, t) => s + (t.amount || 0), 0);
  const confirmed = rows.filter((r) => W.atLeast(r.wof, 'order') && r.wof.stage !== 'complete');

  return (
    <>
      <PageHeader
        title="Quotes & jobs"
        subtitle={`Everything EP Team is working on for ${client.name}, from first quote to final invoice — and anything sitting with you.`}
        actions={
          <Link className="btn btn-secondary" to="/client/events">
            <Icon name="events" decorative className="icon-sm" /> My events
          </Link>
        }
      />

      <div className="flex flex-wrap gap-3 mb-5">
        <Kpi
          label="Waiting on you"
          value={todo.length}
          sub={
            todo.length
              ? `Across ${countLabel(rows.filter((r) => r.tasks.length).length, 'job')}`
              : 'Nothing outstanding — thank you'
          }
          tone={todo.some((t) => t.overdue) ? 'critical' : todo.length ? 'atRisk' : 'healthy'}
        />
        <Kpi
          label="Quotes to sign"
          value={toSign.length}
          sub={
            toSign.length
              ? `${money(toSign.reduce((s, r) => s + W.quoteValue(r.wof), 0), { compact: true })} of work waiting on a signature`
              : 'No quotes outstanding'
          }
          tone={toSign.length ? 'critical' : 'healthy'}
        />
        <Kpi
          label="To pay"
          value={money(owed, { compact: true })}
          sub="Deposits and invoices not yet settled"
          tone={owed ? 'atRisk' : 'healthy'}
        />
        <Kpi
          label="Confirmed jobs"
          value={confirmed.length}
          sub="Booked in and being prepared"
          tone="info"
        />
      </div>

      {sorted.length ? (
        <div className="grid gap-3.5">
          {sorted.map((r) => (
            <JobCard key={r.wof.id} row={r} />
          ))}
        </div>
      ) : (
        <div className="card">
          <EmptyState
            iconName="fileText"
            title="Nothing on the books yet"
            /* Said plainly, because the honest version of this screen is "we
               may well be working on something you cannot see". A job appears
               the moment EP Team sends its quote — not when the job is raised,
               and not while it is half-priced. */
            body={`Nothing for ${client.name} has been quoted yet. A job appears here the moment EP Team sends you its quote — you will get an email at the same time. Work already under way is not shown until then.`}
          />
        </div>
      )}

      <Provenance>
        This is the same work order EP Team works from, not a copy — the value you sign is the value that
        gets invoiced, and anything added to the job later shows up here as a change for you to approve
        before it reaches the bill.
      </Provenance>
    </>
  );
}

function JobCard({ row }: { row: PORTAL.ClientJobRow }) {
  const { wof: w, status, tasks, coverage } = row;
  const urgent = tasks.some((t) => t.overdue);

  return (
    <article
      className="card p-4"
      style={urgent ? { borderColor: TONE_LINE.critical } : undefined}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <Pill status={status.id} label={status.label} tone={status.tone} hint={status.blurb} />
            <span className="text-[11.5px] text-ink-3 font-mono">{w.ref}</span>
          </div>
          <h2 className="text-[16px] font-bold text-ink leading-tight">
            <Link to={`/client/jobs/${w.id}`} className="no-underline text-ink hover:text-accent">
              {w.title}
            </Link>
          </h2>
          <p className="text-[13px] text-ink-2 mt-1">
            {fmtRange(w.start, w.end)}
            {w.venue ? ` · ${w.venue}` : ''}
          </p>
          {coverage && coverage.required > 0 ? (
            <p className="text-[12.5px] text-ink-3 mt-1">
              {coverage.filled} of {coverage.required} roles confirmed
              {coverage.gap ? ` · ${coverage.gap} still to fill` : ''}
            </p>
          ) : null}
        </div>

        <div className="shrink-0 sm:text-right">
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1">
            {w.signoff ? 'Agreed value' : 'Quoted'}
          </div>
          <div className="text-[22px] font-bold leading-none tabular-nums text-ink">
            {W.quoteLines(w).length ? money(W.clientContractValue(w), { pence: false }) : '—'}
          </div>
          {W.clientVariationValue(w) ? (
            <div className="text-[11.5px] text-ink-3 mt-1">
              incl. {money(W.clientVariationValue(w), { pence: false })} of changes
            </div>
          ) : null}
        </div>
      </div>

      {tasks.length ? (
        <div className="mt-3.5 pt-3.5 border-t border-surface-line-soft">
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2">
            Waiting on you
          </div>
          <div className="flex flex-wrap gap-2">
            {tasks.map((t) => (
              <Link
                key={t.id}
                to={`/client/jobs/${w.id}#${t.id}`}
                className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg no-underline text-[12.5px]"
                style={{ background: TONE_BG[t.tone], color: TONE_HEX[t.tone] }}
              >
                <Icon name={TASK_ICON[t.id]} decorative className="icon-sm" />
                <span className="font-semibold">{t.label}</span>
                {t.amount ? <span className="tabular-nums">{money(t.amount, { pence: false })}</span> : null}
              </Link>
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-3.5 pt-3.5 border-t border-surface-line-soft flex items-center gap-2">
          <span style={{ color: TONE_HEX[status.tone] }}>
            <Icon name={status.id === 'preparing' ? 'clock' : 'checkCircle'} decorative className="icon-sm" />
          </span>
          <span className="text-[12.5px] text-ink-2">{status.blurb}</span>
          <div className="flex-1" />
          <Link className="btn btn-ghost btn-sm" to={`/client/jobs/${w.id}`}>
            Open job
          </Link>
        </div>
      )}

      {tasks.length ? (
        <div className="flex items-center gap-2 mt-3">
          <div className="flex-1 text-[12px] text-ink-3">
            {w.quotedAt ? `Quoted ${fmtDate(w.quotedAt)}.` : `Raised ${fmtDate(w.raisedAt)}.`} {status.blurb}
          </div>
          <Link className="btn btn-primary btn-sm" to={`/client/jobs/${w.id}`}>
            Open job
          </Link>
        </div>
      ) : null}
    </article>
  );
}
