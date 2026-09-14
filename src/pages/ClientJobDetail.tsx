/* ============================================================================
   CLIENT PORTAL — one job
   ----------------------------------------------------------------------------
   The same work order the operator has open, rendered for the person paying for
   it. Four rules:

   1. WHAT WE NEED FROM YOU comes first, above the money and above the status.
      A client opening this page has one question — is there anything I have to
      do — and every task carries the button that resolves it.

   2. No cost prices, no margin, no pay rates. The client sees the charge-out
      value and nothing behind it. That is not a filter applied here; the fields
      are simply never rendered.

   3. Changes since sign-off are shown with EP Team's reason attached, and can
      be approved or queried. A variation the client has queried is visibly not
      going to be invoiced yet.

   4. Every action writes to the same history the operator reads, naming the
      client. `portal.clientJob()` refuses to return another client's job, so a
      guessed URL yields "not found" rather than a leak.
   ========================================================================== */

import { Fragment, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/Toast';
import {
  Breadcrumb, CoverageBar, EmptyState, Pill, Provenance, Section,
} from '@/components/primitives';
import { DataTable, type Column } from '@/components/DataTable';
import { TONE_BG, TONE_HEX, TONE_LINE } from '@/lib/status';
import { coverageTone } from '@/lib/coverage';
import { countLabel, fmtDate, fmtDateFull, fmtRange, money, timing } from '@/lib/format';
import { docType } from '@/data/db';
import type { Tone } from '@/data/types';
import * as PORTAL from '@/lib/portal';
import * as W from '@/lib/wof';
import * as DOC from '@/lib/quotedoc';
import { usePortalVersion, useWofVersion } from '@/lib/useStore';
import {
  PayDialog, QueryQuoteDialog, SignQuoteDialog, UploadDocDialog, VariationDialog,
} from './client/dialogs';

type Dialog =
  | { kind: 'sign' }
  | { kind: 'pay'; which: 'deposit' | 'invoice' }
  | { kind: 'upload'; doc: W.WofDocView }
  | { kind: 'variation'; line: W.LineItem; mode: 'accept' | 'query' }
  | { kind: 'queryQuote' }
  | null;

const TASK_ICON: Record<W.ClientTaskId, string> = {
  sign: 'edit',
  deposit: 'trendUp',
  documents: 'fileText',
  variations: 'alert',
  invoice: 'download',
};

export default function ClientJobDetailPage() {
  const { id } = useParams();
  useWofVersion();
  usePortalVersion();

  const [dialog, setDialog] = useState<Dialog>(null);
  const toast = useToast();

  const row = id ? PORTAL.clientJob(id) : null;
  if (!row) {
    return (
      <EmptyState
        iconName="fileText"
        title="Job not found"
        body="That job either does not exist or belongs to a different account."
        action={
          <Link className="btn btn-primary" to="/client/jobs">
            Back to my jobs
          </Link>
        }
      />
    );
  }

  const { wof: w, status, tasks, event: ev, coverage } = row;
  const quote = W.quoteLines(w);
  // Only the variations EP Team has sent. One typed a minute ago and not yet
  // sent is their working note, not a change awaiting this client's decision.
  const variations = W.clientVariations(w);
  // Held back until the job is committed on both sides — see `clientDocsOpen`.
  const docsOpen = W.clientDocsOpen(w);
  const docsGate = W.clientDocsGate(w);
  const docs = docsOpen ? W.clientDocs(w) : [];
  // Counted even while closed, so the note can say the checklist is coming
  // rather than leaving the client to discover it on the day they sign.
  const docsPending = docsOpen ? 0 : W.clientDocs(w).length;
  const t = timing(w.start, w.end);
  // Only what EP Team actually sent. Versions held and superseded inside their
  // office are not part of this client's record of events.
  const issued = [...W.issuedVersions(w, 'quote'), ...W.issuedVersions(w, 'variation')];
  const latest = W.latestIssued(w, 'quote');
  const raised = W.openObjection(w);

  const openTask = (taskId: W.ClientTaskId) => {
    if (taskId === 'sign') setDialog({ kind: 'sign' });
    if (taskId === 'deposit') setDialog({ kind: 'pay', which: 'deposit' });
    if (taskId === 'invoice') setDialog({ kind: 'pay', which: 'invoice' });
    if (taskId === 'documents') document.getElementById('documents')?.scrollIntoView({ behavior: 'smooth' });
    if (taskId === 'variations') document.getElementById('variations')?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <>
      <Breadcrumb trail={[{ label: 'Quotes & jobs', to: '/client/jobs' }, { label: w.title }]} />

      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4 mb-5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5 flex-wrap mb-1.5">
            <h1 className="text-[24px] font-bold text-ink leading-tight tracking-tight">{w.title}</h1>
            <Pill status={status.id} label={status.label} tone={status.tone} hint={status.blurb} />
          </div>
          <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-[13px] text-ink-2">
            <span className="inline-flex items-center gap-1.5">
              <Icon name="calendar" decorative className="icon-sm" />
              {fmtRange(w.start, w.end)}
            </span>
            {w.venue ? (
              <span className="inline-flex items-center gap-1.5">
                <Icon name="mapPin" decorative className="icon-sm" />
                {w.venue}
              </span>
            ) : null}
            <span className="text-ink-3">{t.label}</span>
            <span className="text-ink-3 font-mono text-[12px]">{w.ref}</span>
          </div>
        </div>

        <div className="shrink-0 sm:text-right">
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1">
            {w.signoff ? 'Agreed value' : 'Quoted value'}
          </div>
          <div className="text-[26px] font-bold leading-none tabular-nums text-ink">
            {quote.length ? money(W.clientContractValue(w), { pence: false }) : '—'}
          </div>
          <div className="text-[12px] text-ink-3 mt-1">
            {w.signoff ? `Signed ${fmtDate(w.signoff.signedAt)}` : 'Not yet signed'}
          </div>
        </div>
      </div>

      {/* 1. WHAT WE NEED FROM YOU ---------------------------------------- */}
      {tasks.length ? (
        <section
          className="card p-4 mb-5"
          style={{
            borderColor: tasks.some((x) => x.overdue) ? TONE_LINE.critical : TONE_LINE.atRisk,
          }}
        >
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-3">
            What we need from you
          </div>
          <div className="grid gap-2">
            {tasks.map((task) => (
              <div
                key={task.id}
                className="flex flex-wrap items-center gap-3 px-3 py-2.5 rounded-lg"
                style={{ background: TONE_BG[task.tone] }}
              >
                <span style={{ color: TONE_HEX[task.tone] }}>
                  <Icon name={TASK_ICON[task.id]} decorative />
                </span>
                <div className="flex-1 min-w-[200px]">
                  <div className="text-[13.5px] font-semibold text-ink">{task.label}</div>
                  <div className="text-[12.5px] text-ink-2 leading-snug">{task.detail}</div>
                </div>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => openTask(task.id)}>
                  {task.id === 'sign'
                    ? 'Review and sign'
                    : task.id === 'deposit' || task.id === 'invoice'
                      ? `Pay ${money(task.amount || 0, { pence: false })}`
                      : task.id === 'documents'
                        ? 'Send documents'
                        : 'Review changes'}
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <section className="card p-4 mb-5" style={{ background: TONE_BG.healthy, borderColor: TONE_LINE.healthy }}>
          <div className="flex items-start gap-2.5">
            <span style={{ color: TONE_HEX.healthy, marginTop: 1 }}>
              <Icon name="checkCircle" decorative />
            </span>
            <div>
              <div className="text-[13.5px] font-semibold text-ink">Nothing needed from you</div>
              <div className="text-[12.5px] text-ink-2 leading-snug">{status.blurb}</div>
            </div>
          </div>
        </section>
      )}

      {/* 2. PROGRESS ----------------------------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          <ProgressCard w={w} />

          {/* Staffing, if the job has been confirmed and seeded shifts. A kit
              hire has no rota, and 0/0 must not read as "fully staffed". */}
          {ev && coverage && coverage.required > 0 ? (
            <div className="card p-4">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1">Staffing</div>
                  <p className="text-[12.5px] text-ink-3 leading-snug max-w-md">
                    A role counts as filled only once the worker has confirmed they are attending.
                  </p>
                </div>
                <Link className="btn btn-secondary btn-sm" to="/client/events">
                  All my events
                </Link>
              </div>
              <div className="flex items-baseline justify-between mb-1.5">
                <span className="text-[24px] font-bold text-ink tabular-nums">
                  {coverage.filled}
                  <span className="text-ink-3 text-[17px]">/{coverage.required}</span>
                </span>
                <span className="text-[13px] text-ink-2">
                  {coverage.gap ? `${coverage.gap} still to fill` : 'Fully staffed and confirmed'}
                </span>
              </div>
              <CoverageBar cov={coverage} tone={coverageTone(coverage, w.start, w.end)} height={8} />
            </div>
          ) : null}
        </div>

        <div className="space-y-4">
          <MoneyCard w={w} onPay={(which) => setDialog({ kind: 'pay', which })} />
          <ContactCard />
        </div>
      </div>

      {/* 3. THE QUOTE ---------------------------------------------------- */}
      <div id="quote">
        <Section
          title="What you are paying for"
          right={
            !w.signoff && quote.length ? (
              <div className="flex items-center gap-2">
                {/* Querying is offered beside signing, not buried under it. A
                    client who thinks the numbers are wrong should not have to
                    choose between signing something they dispute and finding
                    somebody's email address. */}
                {W.queryQuoteBlock(w) ? null : (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setDialog({ kind: 'queryQuote' })}
                  >
                    <Icon name="alert" decorative className="icon-sm" /> Something is wrong or missing
                  </button>
                )}
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setDialog({ kind: 'sign' })}>
                  <Icon name="edit" decorative className="icon-sm" /> Review and sign
                </button>
              </div>
            ) : undefined
          }
        />
        {raised ? (
          <div
            className="card p-3.5 mb-3"
            style={{ background: TONE_BG.atRisk, borderColor: TONE_LINE.atRisk }}
          >
            <div className="flex items-start gap-2.5">
              <span style={{ color: TONE_HEX.atRisk, marginTop: 1 }}>
                <Icon name="clock" decorative />
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold text-ink mb-0.5">
                  You sent {raised.version.label} back — it is with EP Team
                </div>
                {raised.objection.note ? (
                  <div className="text-[12.5px] text-ink-2 leading-relaxed">
                    “{raised.objection.note}”
                  </div>
                ) : null}
                {W.objectionRequests(raised.objection).length ? (
                  <div className="mt-1.5">
                    <div className="text-[12px] font-medium text-ink-2 mb-0.5">
                      You said the quote is missing:
                    </div>
                    <ul className="text-[12.5px] text-ink-2 leading-relaxed list-disc pl-4">
                      {W.objectionRequests(raised.objection).map((r) => (
                        <li key={r.id}>{r.text}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <div className="text-[12.5px] text-ink-2 leading-relaxed mt-1.5">
                  Sent {fmtDate(raised.objection.at)}. They will send you a new version rather than change
                  this one. Nothing is agreed in the meantime.
                </div>
              </div>
            </div>
          </div>
        ) : null}
        <QuoteBreakdown w={w} />
      </div>

      {/* 3b. WHAT YOU HAVE BEEN SENT ------------------------------------- */}
      {issued.length ? (
        <div id="quote-documents">
          <Section title="Your quote documents" />
          <div className="card divide-y divide-surface-line">
            {issued.map((v) => (
              <div key={`${v.kind}-${v.no}`} className="flex items-start gap-3 p-3.5">
                <span className="text-[13px] font-bold text-ink tabular-nums w-[54px] shrink-0 pt-0.5">
                  {v.label}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-[13px] font-medium text-ink">
                      {money(v.value, { pence: false })}
                    </span>
                    {v.signedAt ? (
                      <Pill label="Signed" tone="info" hint={false} />
                    ) : v.objection ? (
                      <Pill label="You queried this" tone="atRisk" hint={false} />
                    ) : v.no === (latest ? latest.no : -1) && v.kind === 'quote' ? (
                      <Pill label="Current" tone="healthy" hint={false} />
                    ) : (
                      <Pill label="Superseded" tone="neutral" hint={false} />
                    )}
                    <span className="text-[11.5px] text-ink-3">Sent {fmtDate(v.issuedAt!)}</span>
                  </div>
                  <div className="text-[12.5px] text-ink-2 leading-relaxed mt-0.5">{v.change}</div>
                  {v.objection ? (
                    <div className="text-[12px] text-ink-3 leading-relaxed mt-1">
                      You sent this back: {W.objectionSummary(v.objection)}
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm shrink-0"
                  onClick={() => {
                    if (!DOC.openQuoteDocument(w, v, { audience: 'client' })) {
                      toast('Your browser blocked the document window. Allow pop-ups and try again.', {
                        tone: 'critical',
                      });
                    }
                  }}
                >
                  <Icon name="download" decorative className="icon-sm" /> Open
                </button>
              </div>
            ))}
          </div>
          <Provenance>
            Every version EP Team has sent you, exactly as it was sent. A quote is never edited in place —
            a change means a new version, and this list is the record of which one you were holding when.
          </Provenance>
        </div>
      ) : null}


      {/* 4. CHANGES SINCE SIGN-OFF --------------------------------------- */}
      {variations.length ? (
        <div id="variations">
          <Section title={`Changes since you signed (${variations.length})`} />
          <div className="grid gap-2.5">
            {variations.map((l) => (
              <VariationCard
                key={l.id}
                line={l}
                onAccept={() => setDialog({ kind: 'variation', line: l, mode: 'accept' })}
                onQuery={() => setDialog({ kind: 'variation', line: l, mode: 'query' })}
              />
            ))}
          </div>
          <Provenance>
            Anything added after sign-off is charged on top of the agreed quote — extra staff called in on
            the day, extra kit requested on site. You see it here with the reason attached before it reaches
            the invoice, and nothing under query gets billed.
          </Provenance>
        </div>
      ) : null}

      {/* 5. YOUR DOCUMENTS ----------------------------------------------- */}
      {docs.length ? (
        <div id="documents">
          <Section title="Documents we need from you" />
          <DocsTable docs={docs} onUpload={(doc) => setDialog({ kind: 'upload', doc })} />
          <Provenance>
            These are the items on this job's checklist that are yours to produce — the rest are EP Team's
            and you do not need to chase them. What you send arrives as "with EP Team" until Compliance has
            checked it.
          </Provenance>
        </div>
      ) : docsPending ? (
        /* Named but not asked for. A deadline worked back from the event date
           is already red on a job that has not been signed, and showing that
           to somebody who has not committed is a demand for paperwork they may
           never owe. Saying the list exists and what opens it is the honest
           middle — it lets a client get a licence moving early without the
           portal pretending they are late. */
        <div id="documents">
          <Section title="Documents we will need from you" />
          <Provenance>
            This job has {countLabel(docsPending, 'document')} for you to produce. We will ask for{' '}
            {docsPending === 1 ? 'it' : 'them'} {docsGate}, with the dates we need{' '}
            {docsPending === 1 ? 'it' : 'them'} by — nothing is outstanding from you yet.
          </Provenance>
        </div>
      ) : null}

      {/* --------------------------------------------------------- dialogs */}
      {dialog?.kind === 'sign' ? <SignQuoteDialog w={w} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'queryQuote' ? (
        <QueryQuoteDialog w={w} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'pay' ? (
        <PayDialog w={w} kind={dialog.which} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'upload' ? (
        <UploadDocDialog w={w} doc={dialog.doc} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'variation' ? (
        <VariationDialog w={w} line={dialog.line} mode={dialog.mode} onClose={() => setDialog(null)} />
      ) : null}
    </>
  );
}

/* ---------------------------------------------------------------- cards -- */

/**
 * The lifecycle in the client's language. The operator's eight stages are an
 * internal workflow; a client needs four milestones and a sentence each.
 */
function ProgressCard({ w }: { w: W.Wof }) {
  const dep = W.deposit(w);
  const steps: { label: string; done: boolean; now: boolean; detail: string }[] = [
    {
      label: 'Quote prepared',
      done: W.quoteLines(w).length > 0,
      now: !W.quoteLines(w).length,
      detail: W.quoteLines(w).length
        ? `${W.quoteLines(w).length} lines, ${money(W.quoteValue(w), { pence: false })}${w.quotedAt ? `, sent ${fmtDate(w.quotedAt)}` : ''}.`
        : 'EP Team is pricing the work.',
    },
    {
      label: 'You sign',
      done: !!w.signoff,
      now: !w.signoff && W.quoteLines(w).length > 0,
      detail: w.signoff
        ? `Signed by ${w.signoff.signedBy} on ${fmtDate(w.signoff.signedAt)}.`
        : 'Waiting on your signature.',
    },
    {
      label: 'Booking confirmed',
      done: W.atLeast(w, 'order'),
      now: !!w.signoff && !W.atLeast(w, 'order'),
      detail: W.atLeast(w, 'order')
        ? `Confirmed${w.orderedAt ? ` ${fmtDate(w.orderedAt)}` : ''}. ${
            dep.due > 0
              ? dep.received
                ? 'Deposit received.'
                : `Deposit of ${money(dep.due, { pence: false })} outstanding.`
              : 'No deposit required on your terms.'
          }`
        : 'EP Team confirms once your signature is in.',
    },
    {
      label: 'Delivered and invoiced',
      done: !!w.invoice,
      now: W.atLeast(w, 'job') && !w.invoice,
      detail: w.invoice
        ? `${w.invoice.number} raised ${fmtDate(w.invoice.issuedAt)}${w.invoice.paidAt ? `, paid ${fmtDate(w.invoice.paidAt)}` : `, due ${fmtDate(w.invoice.dueAt)}`}.`
        : 'Invoiced after the event, net of any deposit.',
    },
  ];

  return (
    <div className="card p-4">
      <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-3">Where this job is up to</div>
      <ol className="space-y-2.5">
        {steps.map((s) => (
          <li key={s.label} className="flex items-start gap-2.5">
            <span
              className="mt-0.5 flex-none"
              style={{ color: s.done ? TONE_HEX.healthy : s.now ? TONE_HEX.info : 'var(--ink-3)' }}
            >
              <Icon name={s.done ? 'checkCircle' : s.now ? 'clock' : 'info'} decorative />
            </span>
            <div className="flex-1 min-w-0">
              <div className={`text-[13px] ${s.done || s.now ? 'text-ink font-medium' : 'text-ink-3'}`}>
                {s.label}
              </div>
              <div className="text-[12px] text-ink-3 leading-snug">{s.detail}</div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function MoneyCard({ w, onPay }: { w: W.Wof; onPay: (which: 'deposit' | 'invoice') => void }) {
  const dep = W.deposit(w);
  const client = PORTAL.actingClient();
  // What this client has been told about, not what the job is worth to EP
  // Team — a variation typed this morning and not yet sent is neither theirs
  // to see nor theirs to pay.
  const contract = W.clientContractValue(w);
  const balance = contract - dep.due;

  const row = (label: string, value: React.ReactNode, strong?: boolean) => (
    <div className="flex items-baseline justify-between gap-3 py-1.5 border-b border-surface-line-soft last:border-0">
      <span className="text-[12.5px] text-ink-3">{label}</span>
      <span className={`text-[13px] text-right ${strong ? 'text-ink font-semibold' : 'text-ink-2'}`}>{value}</span>
    </div>
  );

  return (
    <div className="card p-4">
      <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-3">Money</div>
      {row('Quoted', money(W.quoteValue(w), { pence: false }))}
      {W.clientVariationValue(w)
        ? row(
            'Changes since signing',
            <span className="text-status-at-risk">
              +{money(W.clientVariationValue(w), { pence: false })}
            </span>,
          )
        : null}
      {row('Total for the job', money(contract, { pence: false }), true)}
      {dep.due > 0
        ? row(
            `Deposit (${dep.pct}%)`,
            dep.received ? (
              <span className="text-status-healthy">{money(dep.received, { pence: false })} paid</span>
            ) : (
              <span className="text-status-at-risk">{money(dep.due, { pence: false })} due</span>
            ),
          )
        : null}
      {row('Balance', money(balance, { pence: false }))}
      {row('Payment terms', `${client.termsDays} days`)}

      {dep.due > 0 && dep.outstanding > 0 && w.signoff ? (
        <button type="button" className="btn btn-primary btn-sm w-full mt-3" onClick={() => onPay('deposit')}>
          Pay the deposit
        </button>
      ) : null}
      {w.invoice && !w.invoice.paidAt ? (
        <button type="button" className="btn btn-primary btn-sm w-full mt-2" onClick={() => onPay('invoice')}>
          Pay {w.invoice.number}
        </button>
      ) : null}
      {w.invoice?.paidAt ? (
        <div className="text-[12px] text-ink-3 mt-3 text-center">
          Settled {fmtDateFull(w.invoice.paidAt)} — thank you.
        </div>
      ) : null}
    </div>
  );
}

function ContactCard() {
  const c = PORTAL.actingClient();
  return (
    <div className="card p-4">
      <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-3">Your account</div>
      <div className="text-[14px] font-semibold text-ink mb-0.5">{c.name}</div>
      <div className="text-[12.5px] text-ink-3 mb-3">
        {c.contact || 'No named contact'}
        {c.contactRole ? ` · ${c.contactRole}` : ''}
      </div>
      <div className="text-[12.5px] text-ink-2 leading-relaxed">
        Questions about this job go to your account manager at EP Team. Anything you approve or pay here is
        recorded against the job the moment you do it.
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- tables -- */

/** No cost column, no margin. The client sees what they are charged. */
function QuoteTable({
  w,
  lines,
  showTotal = true,
}: {
  w: W.Wof;
  lines: W.LineItem[];
  showTotal?: boolean;
}) {
  const spanWins = W.spanWindowsOf(w.start, w.end);
  const onSite = (d: number) =>
    spanWins[d - 1]?.start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) || `day ${d}`;

  if (!lines.length) {
    return (
      <div className="card p-4">
        <p className="text-[13px] text-ink-3 leading-relaxed">
          Nothing priced yet. EP Team is putting your quote together and you will get an email when it is
          ready to sign.
        </p>
      </div>
    );
  }

  const columns: Column<W.LineItem>[] = [
    {
      key: 'kind', label: '', nowrap: true,
      cell: (l) => (
        <span className="text-ink-3 tip" tabIndex={0} data-tip={l.kind === 'staff' ? 'Staff' : l.kind === 'kit' ? 'Equipment' : 'Service'}>
          <Icon name={l.kind === 'staff' ? 'users' : l.kind === 'kit' ? 'inbox' : 'settings'} decorative />
        </span>
      ),
    },
    {
      key: 'description', label: 'Item',
      cell: (l) => {
        const where = W.placementLabel(w, l);
        // Equipment is hired for the event, not for a place, so the dates it
        // is on site have to be on the line itself now that it is no longer
        // sitting under a place that said them.
        const h = l.kind === 'kit' ? W.hireWindow(w, l) : null;
        const days = h && !(h.from === 1 && h.to === W.eventDays(w))
          ? `on site ${onSite(h.from)}–${onSite(h.to)}`
          : h
            ? 'on site throughout'
            : '';
        const sub = [where ? `for ${where}` : '', days].filter(Boolean).join(' · ');
        return (
          <>
            <div className="text-[13.5px] text-ink">{l.description}</div>
            {sub ? <div className="text-[11.5px] text-ink-3">{sub}</div> : null}
          </>
        );
      },
    },
    {
      key: 'qty', label: 'How many', align: 'right', nowrap: true,
      cell: (l) => <span className="tabular-nums text-ink-2">{l.qty.toLocaleString()}</span>,
    },
    {
      key: 'units', label: 'For', align: 'right', nowrap: true,
      cell: (l) => (
        <span className="tabular-nums text-ink-2">
          {l.units} {l.unitLabel}
          {l.units === 1 ? '' : 's'}
        </span>
      ),
    },
    {
      key: 'rate', label: 'Rate', align: 'right', nowrap: true,
      cell: (l) => <span className="tabular-nums text-ink-2">{money(W.lineRate(l))}</span>,
    },
    {
      key: 'value', label: 'Total', align: 'right', nowrap: true,
      cell: (l) => (
        <span className="tabular-nums font-semibold text-ink">{money(W.lineValue(l), { pence: false })}</span>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={lines}
      rowKey={(l) => l.id}
      footer={
        showTotal
          ? {
              description: `${lines.length} item${lines.length === 1 ? '' : 's'}`,
              value: money(lines.reduce((s, l) => s + W.lineValue(l), 0), { pence: false }),
            }
          : undefined
      }
    />
  );
}

/**
 * What the client is paying for, laid out the way the job is actually staffed:
 * area, then place and window, then the roles standing there, with the
 * headcount for every day across the page.
 *
 * This is the operator's own quote grid with everything that is EP Team's
 * business left out — there is no cost column here because the fields are never
 * rendered, not because a flag hides them — and with nothing editable. A client
 * typing in a headcount would be typing in a price.
 *
 * Why the client gets the day columns at all. "22 Car Park Steward shifts" is a
 * number to be taken on trust; the same 22 spread over six dated columns is a
 * plan somebody can hold against their own site plan before they sign it. The
 * spread is how the total was arrived at, not a separate promise about which
 * steward stands where on the Friday — the note under the table says so, so
 * that moving one steward from a Friday to a Saturday stays an operational
 * matter rather than a variation.
 */
export function ClientDeploymentTable({ w, groups: all }: { w: W.Wof; groups: W.DeploymentView[] }) {
  // Equipment is hired across the whole event, so it is listed once below
  // rather than repeated inside every place it was ordered for. A place with
  // equipment and nobody rostered to it therefore has no row here at all.
  const groups = all.filter((g) => g.columns.length);
  if (!groups.length) return null;
  const dayNos = Array.from({ length: W.eventDays(w) }, (_, i) => i + 1);
  const spanWins = W.spanWindowsOf(w.start, w.end);
  const dayLabel = (d: number) =>
    spanWins[d - 1]?.start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) || `day ${d}`;

  const byArea: { area: string; groups: W.DeploymentView[] }[] = [];
  groups.forEach((g) => {
    const bucket = byArea.find((b) => b.area === g.area);
    if (bucket) bucket.groups.push(g);
    else byArea.push({ area: g.area, groups: [g] });
  });

  // Role, the days, then shifts / hours / rate / total.
  const span = dayNos.length + 5;

  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-[12.5px]" style={{ borderCollapse: 'collapse', minWidth: 720 }}>
        <thead>
          <tr>
            <th className="text-left px-3 py-2 text-[9.5px] uppercase tracking-[0.11em] text-ink-3 font-semibold">
              Role
            </th>
            {dayNos.map((d) => {
              const kind = W.dayKind(w, d);
              const date = spanWins[d - 1]?.start;
              return (
                <th
                  key={d}
                  className="px-1 py-2 text-center"
                  style={{ minWidth: 34, background: kind === 'event' ? 'var(--accent-soft)' : undefined }}
                  title={
                    date
                      ? `${date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} — ${
                          kind === 'event' ? 'event day' : kind === 'build' ? 'build day' : 'breakdown day'
                        }`
                      : `Day ${d}`
                  }
                >
                  <div className="text-[9px] uppercase tracking-[0.06em] text-ink-3 font-semibold">
                    {date ? date.toLocaleDateString('en-GB', { weekday: 'short' }).slice(0, 2) : ''}
                  </div>
                  <div
                    className="text-[11px] tabular-nums font-semibold"
                    style={{ color: kind === 'event' ? 'var(--ink-2)' : 'var(--ink-3)' }}
                  >
                    {date ? date.getDate() : d}
                  </div>
                </th>
              );
            })}
            {['Shifts', 'Hours', 'Rate', 'Total'].map((x) => (
              <th
                key={x}
                className="text-right px-3 py-2 text-[9.5px] uppercase tracking-[0.11em] text-ink-3 font-semibold"
              >
                {x}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {byArea.map((bucket) => (
            <Fragment key={bucket.area}>
              <tr>
                <td
                  colSpan={span}
                  className="px-3 py-1.5 text-[9.5px] uppercase tracking-[0.14em] font-semibold"
                  style={{ background: 'var(--surface-high)', color: 'var(--ink-2)' }}
                >
                  {bucket.area}
                </td>
              </tr>
              {bucket.groups.map((g) => (
                <Fragment key={g.key}>
                  {g.columns.map((col) => (
                    <Fragment key={col.pattern.id}>
                      <tr>
                        <td
                          colSpan={span}
                          className="px-3 py-1 text-[11.5px] text-ink-2"
                          style={{ borderTop: '1px solid var(--surface-line-soft)' }}
                        >
                          <span className="font-medium">{g.placeName}</span>
                          <span className="text-ink-3 tabular-nums">
                            {' '}
                            · {col.window ? `${col.window.start}–${col.window.end}` : 'times to be confirmed'}
                            {col.window ? ` · ${W.patternHours(col.window)}h shifts` : ''}
                          </span>
                          {col.window && col.window.end <= col.window.start ? (
                            <Pill label="Overnight" tone="info" hint="This shift closes the following morning" />
                          ) : null}
                        </td>
                      </tr>
                      {col.lines.map((l) => {
                        const pat = W.linePattern(w, l);
                        return (
                          <tr key={l.id} style={{ borderTop: '1px solid var(--surface-line-soft)' }}>
                            <td className="pl-6 pr-3 py-1.5 text-ink whitespace-nowrap">{l.description}</td>
                            {dayNos.map((d) => {
                              const covered = !!pat && pat.days.includes(d);
                              const n = covered ? W.headcountOn(w, l, d) : 0;
                              const shaded = W.dayKind(w, d) === 'event';
                              return (
                                <td
                                  key={d}
                                  className="px-1 py-1.5 text-center tabular-nums"
                                  style={{
                                    color: n ? 'var(--ink)' : 'var(--ink-3)',
                                    fontWeight: n ? 600 : 400,
                                    background: shaded ? 'var(--accent-soft)' : undefined,
                                  }}
                                  title={n ? `${n} on ${dayLabel(d)}` : `None on ${dayLabel(d)}`}
                                >
                                  {n || '·'}
                                </td>
                              );
                            })}
                            <td className="px-3 py-1.5 text-right tabular-nums text-ink-2">{W.lineShifts(w, l)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-ink-2">{W.lineHours(w, l)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-ink-2">
                              {money(W.lineRate(l))}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-ink font-semibold">
                              {money(W.lineValue(l), { pence: false })}
                            </td>
                          </tr>
                        );
                      })}
                    </Fragment>
                  ))}
                  <tr style={{ borderTop: '1px solid var(--surface-line)' }}>
                    <td
                      colSpan={dayNos.length + 1}
                      className="px-3 py-1.5 text-right text-[9.5px] uppercase tracking-[0.11em] text-ink-3 font-semibold"
                    >
                      {g.placeName}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums font-semibold text-ink">{g.shifts}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums font-semibold text-ink">{g.hours}</td>
                    <td />
                    <td className="px-3 py-1.5 text-right tabular-nums font-semibold text-ink">
                      {money(g.staffValue, { pence: false })}
                    </td>
                  </tr>
                </Fragment>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
      <div
        className="px-3 py-2.5 flex items-start gap-4 flex-wrap"
        style={{ borderTop: '1px solid var(--surface-line)' }}
      >
        <p className="text-[11.5px] text-ink-3 leading-relaxed" style={{ flex: '1 1 260px' }}>
          Shaded columns are event days; the rest are build and breakdown. A dot is a day nobody is on that
          line. Rates are per hour. Equipment is hired across the whole event rather than by the place, so it
          is listed once below with the dates it is on site.
        </p>
        <p className="text-[11.5px] text-ink-3 leading-relaxed" style={{ flex: '1 1 260px' }}>
          The day-by-day spread is how these totals were built and is the plan we are working to. Moving
          somebody between days without changing the shifts, hours or rates above does not change what you
          pay, so it is not raised as a variation.
        </p>
      </div>
    </div>
  );
}
/**
 * Everything the client is paying for, in the order it is easiest to check:
 * the deployment grid for whatever stands somewhere, then the flat lines for
 * whatever does not, then one total over both.
 *
 * A quote raised before deployments existed has no groups and falls straight
 * through to the table it has always had.
 */
export function QuoteBreakdown({ w }: { w: W.Wof }) {
  const lines = W.quoteLines(w);
  // Only places with people in them make a grid. Equipment ordered for a car
  // park is hired for the whole event, so it goes in the flat list below with
  // the car park as a caption, not into a block of its own.
  const groups = W.deployments(w, 'quote').filter((g) => g.columns.length);
  const flat = lines.filter(W.isFlatLine);

  // Nothing priced, or nothing deployed: one table, exactly as before. The
  // empty state lives in `QuoteTable` so there is only one of it.
  if (!lines.length || !groups.length) return <QuoteTable w={w} lines={flat} />;

  return (
    <>
      <ClientDeploymentTable w={w} groups={groups} />
      {flat.length ? (
        <>
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2 mt-4">
            Across the whole event
          </div>
          <QuoteTable w={w} lines={flat} showTotal={false} />
        </>
      ) : null}
      <div className="card p-3.5 mt-3 flex items-center justify-between gap-4 flex-wrap">
        <span className="text-[12.5px] text-ink-3">
          {countLabel(lines.length, 'line')} ·{' '}
          {countLabel(
            groups.reduce((n, g) => n + g.shifts, 0),
            'shift',
          )}{' '}
          · {countLabel(groups.reduce((n, g) => n + g.hours, 0), 'hour')} sold
        </span>
        <span className="text-[13px] text-ink-2">
          Total <strong className="text-[15px] text-ink tabular-nums ml-1">{money(W.quoteValue(w), { pence: false })}</strong>
        </span>
      </div>
    </>
  );
}

function VariationCard({
  line,
  onAccept,
  onQuery,
}: {
  line: W.LineItem;
  onAccept: () => void;
  onQuery: () => void;
}) {
  const state = line.clientApproval ?? 'pending';
  const tone: Tone = state === 'accepted' ? 'healthy' : state === 'queried' ? 'atRisk' : 'info';

  return (
    <article className="card p-3.5" style={state === 'pending' ? { borderColor: TONE_LINE.info } : undefined}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <Pill
              label={
                state === 'accepted' ? 'You approved this' : state === 'queried' ? 'You queried this' : 'Needs your approval'
              }
              tone={tone}
              hint={
                state === 'queried'
                  ? 'Not invoiced while it is under query'
                  : state === 'accepted'
                    ? 'Will appear on your invoice'
                    : 'Extra work added since you signed'
              }
            />
            {line.duringEvent ? (
              <span className="pill" style={{ background: TONE_BG.atRisk, color: TONE_HEX.atRisk }}>
                Added on site
              </span>
            ) : null}
            <span className="text-[11.5px] text-ink-3">{fmtDate(line.addedAt)}</span>
          </div>
          <div className="text-[14px] font-semibold text-ink">{line.description}</div>
          <div className="text-[12.5px] text-ink-2 mt-0.5">
            {line.qty} × {line.units} {line.unitLabel}
            {line.units === 1 ? '' : 's'}
          </div>
          {line.note ? (
            <p className="text-[12.5px] text-ink-2 mt-1.5 leading-relaxed">
              <span className="text-ink-3">Reason: </span>
              {line.note}
            </p>
          ) : null}
          {line.clientNote ? (
            <p className="text-[12.5px] mt-1.5 leading-relaxed" style={{ color: TONE_HEX.atRisk }}>
              <span className="text-ink-3">Your query: </span>
              {line.clientNote}
            </p>
          ) : null}
        </div>

        <div className="shrink-0 sm:text-right">
          <div className="text-[19px] font-bold tabular-nums text-ink">
            {money(W.lineValue(line), { pence: false })}
          </div>
          {state === 'pending' ? (
            <div className="flex items-center gap-2 mt-2">
              <button type="button" className="btn btn-secondary btn-sm" onClick={onQuery}>
                Query
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={onAccept}>
                Approve
              </button>
            </div>
          ) : state === 'queried' ? (
            <button type="button" className="btn btn-secondary btn-sm mt-2" onClick={onAccept}>
              Approve after all
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function DocsTable({
  docs,
  onUpload,
}: {
  docs: W.WofDocView[];
  onUpload: (d: W.WofDocView) => void;
}) {
  const columns: Column<W.WofDocView>[] = [
    {
      key: 'label', label: 'Document',
      cell: (d) => (
        <>
          <div className="text-[13.5px] text-ink">{d.label}</div>
          {d.blocking ? (
            <div className="text-[11px] text-ink-3">We cannot sign the job off without this</div>
          ) : null}
          {d.note ? <div className="text-[11.5px] text-ink-2 italic mt-0.5">{d.note}</div> : null}
        </>
      ),
    },
    {
      key: 'due', label: 'We need it by', nowrap: true,
      cell: (d) => (
        <>
          <div className={`text-[13px] ${d.overdue ? 'text-status-critical font-semibold' : 'text-ink-2'}`}>
            {fmtDate(d.dueDate)}
          </div>
          <div className="text-[11.5px] text-ink-3">
            {docType(d.docId) ? `${docType(d.docId)!.leadDays} days before the event` : ''}
          </div>
        </>
      ),
    },
    {
      key: 'status', label: 'Status', nowrap: true,
      cell: (d) =>
        d.status === 'approved' ? (
          <Pill label="Approved" tone="healthy" hint="Checked and accepted by EP Compliance" />
        ) : d.status === 'submitted' ? (
          <Pill label="With EP Team" tone="info" hint="Received, being checked by Compliance" />
        ) : (
          <Pill
            label={d.overdue ? 'Overdue' : 'Needed'}
            tone={d.overdue ? 'critical' : 'atRisk'}
            hint={d.overdue ? 'Past the date we need it by' : 'Not received yet'}
          />
        ),
    },
    {
      key: 'act', label: '', align: 'right', nowrap: true,
      cell: (d) =>
        d.status === 'approved' ? (
          <span className="text-[12.5px] text-ink-3">Nothing to do</span>
        ) : (
          <button
            type="button"
            className={`btn btn-sm ${d.status === 'submitted' ? 'btn-secondary' : 'btn-primary'}`}
            onClick={() => onUpload(d)}
          >
            {d.status === 'submitted' ? 'Replace' : 'Send it'}
          </button>
        ),
    },
  ];

  // "Still with you" has to mean still with *them*. Counting everything not yet
  // approved put documents the client had already sent in their own to-do
  // count, so the footer contradicted the 'With EP Team' badge one row above it.
  const toSend = docs.filter((d) => d.status === 'required').length;
  const withUs = docs.filter((d) => d.status === 'submitted').length;

  return (
    <DataTable
      columns={columns}
      rows={docs}
      rowKey={(d) => d.docId}
      footer={{
        label: toSend
          ? `${countLabel(toSend, 'document')} still with you${withUs ? ` · ${withUs} with us for checking` : ''}`
          : withUs
            ? `All sent — ${withUs === 1 ? 'it is' : `all ${withUs} are`} with us for checking`
            : 'All received — thank you',
      }}
    />
  );
}
