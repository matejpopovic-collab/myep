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
import { Modal } from '@/components/Modal';
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
import {
  DayGridCols, DayGridFrame, DayGridHead, dayRule, gridDays, phaseBg, tailCell, type GridDay,
} from '@/components/DayGrid';
import * as DOC from '@/lib/quotedoc';
import * as XERO from '@/lib/xero';
import { useJobFilesVersion, usePortalVersion, useWofVersion } from '@/lib/useStore';
import * as JF from '@/lib/jobfiles';
import {
  QueryQuoteDialog, RequestCancellationDialog, RequestMoreDialog, SignQuoteDialog,
  UploadDocDialog, VariationDialog, XeroInvoiceDialog,
} from './client/dialogs';

/**
 * The columns right of the days in the client's grid, in pixels: shifts, hours,
 * rate, total. Fixed, so the day columns get exactly what is left.
 */
const CLIENT_TAIL = [64, 68, 76, 92];

type Dialog =
  | { kind: 'sign' }
  | { kind: 'xero'; which: W.BillingKind }
  | { kind: 'upload'; doc: W.WofDocView }
  | { kind: 'variation'; line: W.LineItem; mode: 'accept' | 'query' }
  | { kind: 'queryQuote' }
  | { kind: 'requestCancellation' }
  | { kind: 'requestMore'; ask: W.ClientAskKind }
  | null;

/** The actions that commit the client to money — an approver's, not a viewer's. */
function needsApprover(d: NonNullable<Dialog>): boolean {
  // Opening an invoice is not: anyone can read it. Paying is gated inside the
  // invoice itself, because in live Xero it happens on Xero's page.
  return d.kind === 'sign' || (d.kind === 'variation' && d.mode === 'accept');
}

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
  const approvalBlock = PORTAL.clientApprovalBlock();
  const blocked = !!approvalBlock && !!dialog && needsApprover(dialog);

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

  /* An invoice lives in Xero. Against live Xero that is Xero's own page in a
     new tab; in test mode it is the stand-in, opened here. */
  const openBill = (which: W.BillingKind) => {
    const d = W.billingDoc(w, which);
    if (!d?.xero) {
      toast('That invoice has not been sent yet — it will arrive by email and appear here.', { tone: 'info' });
      return;
    }
    if (XERO.isSimUrl(d.xero.url)) setDialog({ kind: 'xero', which });
    else window.open(d.xero.url, '_blank', 'noopener');
  };
  const billReady = (which: W.BillingKind) => !!W.billingDoc(w, which)?.xero;

  const openTask = (taskId: W.ClientTaskId) => {
    if (taskId === 'sign') setDialog({ kind: 'sign' });
    if (taskId === 'deposit') openBill('deposit');
    if (taskId === 'invoice') openBill('invoice');
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

      <CancellationNotice w={w} onAsk={() => setDialog({ kind: 'requestCancellation' })} />

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
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={(task.id === 'deposit' || task.id === 'invoice') && !billReady(task.id)}
                  onClick={() => openTask(task.id)}
                >
                  {task.id === 'sign'
                    ? 'Review and sign'
                    : task.id === 'deposit' || task.id === 'invoice'
                      ? billReady(task.id)
                        ? 'View and pay invoice'
                        : 'Invoice on its way'
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
          <PaymentsCard w={w} onOpen={openBill} />
          <AskMoreCard w={w} onAsk={(ask) => setDialog({ kind: 'requestMore', ask })} />
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
            ) : w.signoff && !W.isTerminal(w.stage) ? (
              /* The same place the query button stood before signing. After
                 the signature the quote is closed to queries, and "I need more"
                 is the question a client still has. */
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={!!W.askBlock(w, 'staff')}
                title={W.askBlock(w, 'staff') || undefined}
                onClick={() => setDialog({ kind: 'requestMore', ask: 'staff' })}
              >
                <Icon name="plus" decorative className="icon-sm" /> Ask for more staff or kit
              </button>
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

      {/* 4b. WHAT YOU HAVE ASKED FOR ----------------------------------- */}
      <AsksList w={w} />

      {/* 5. YOUR DOCUMENTS ----------------------------------------------- */}
      {docs.length ? (
        <div id="documents">
          <Section title="Documents we need from you" />
          <DocsTable w={w} docs={docs} onUpload={(doc) => setDialog({ kind: 'upload', doc })} />
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

      <CancelFooter w={w} onAsk={() => setDialog({ kind: 'requestCancellation' })} />

      {/* --------------------------------------------------------- dialogs */}
      {/* Signing, accepting a variation and paying commit the client to money,
          so a viewer is shown who CAN do it instead of the dialog. */}
      {blocked ? (
        <Modal
          title="An approver needs to do this"
          width={460}
          onClose={() => setDialog(null)}
          footer={
            <button type="button" className="btn btn-primary" data-close onClick={() => setDialog(null)}>
              OK
            </button>
          }
        >
          <p className="text-[13.5px] text-ink-2 leading-relaxed">{approvalBlock}</p>
          <p className="text-[12.5px] text-ink-3 leading-relaxed mt-3">
            You can still read the quote, check the hours and download documents.
          </p>
        </Modal>
      ) : null}
      {dialog?.kind === 'sign' && !blocked ? <SignQuoteDialog w={w} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'queryQuote' ? (
        <QueryQuoteDialog w={w} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'xero' && W.billingDoc(w, dialog.which) ? (
        <XeroInvoiceDialog
          w={w}
          doc={W.billingDoc(w, dialog.which)!}
          canPay={!approvalBlock}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'upload' ? (
        <UploadDocDialog w={w} doc={dialog.doc} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'variation' && !blocked ? (
        <VariationDialog w={w} line={dialog.line} mode={dialog.mode} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'requestCancellation' ? (
        <RequestCancellationDialog w={w} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'requestMore' ? (
        <RequestMoreDialog w={w} initialKind={dialog.ask} onClose={() => setDialog(null)} />
      ) : null}
    </>
  );
}

/* ---------------------------------------------------------------- cards -- */

/**
 * Where a cancellation stands, from the client's side.
 *
 * Above everything else on the page, because "is this job happening" outranks
 * every other question here. When nothing is happening it renders a quiet
 * footer instead — see `CancelFooter`. A red button under the price is not
 * something a portal should offer as an equal to signing.
 */
function CancellationNotice({ w, onAsk }: { w: W.Wof; onAsk: () => void }) {
  const c = w.cancellation;
  const req = W.openCancellationRequest(w);
  const declined = w.cancellationRequest?.declined || null;
  if (!c && !req && !declined) return null;

  if (c) {
    return (
      <section className="card p-4 mb-5" style={{ background: TONE_BG.neutral, borderColor: TONE_LINE.neutral }}>
        <div className="flex items-start gap-2.5">
          <span style={{ color: TONE_HEX.neutral, marginTop: 1 }}>
            <Icon name="alert" decorative />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-[13.5px] font-semibold text-ink">
              This job was cancelled on {fmtDate(c.at)}
            </div>
            <div className="text-[12.5px] text-ink-2 leading-relaxed mt-0.5">“{c.reason}”</div>
            <div className="text-[12.5px] text-ink-2 leading-relaxed mt-1.5">
              {c.chargeAmount > 0 ? (
                <>
                  A cancellation charge of{' '}
                  <strong className="text-ink">{money(c.chargeAmount, { pence: false })}</strong>{' '}
                  applies, at {c.chargePct}% of the agreed value. It is on your quote as a change.
                </>
              ) : (
                'Nothing is charged for it.'
              )}
            </div>
          </div>
        </div>
      </section>
    );
  }

  if (req) {
    return (
      <section className="card p-4 mb-5" style={{ background: TONE_BG.atRisk, borderColor: TONE_LINE.atRisk }}>
        <div className="flex items-start gap-2.5">
          <span style={{ color: TONE_HEX.atRisk, marginTop: 1 }}>
            <Icon name="clock" decorative />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-[13.5px] font-semibold text-ink">
              You have asked us to cancel this job
            </div>
            <div className="text-[12.5px] text-ink-2 leading-relaxed mt-0.5">“{req.reason}”</div>
            <div className="text-[12.5px] text-ink-2 leading-relaxed mt-1.5">
              Sent {fmtDate(req.at)}. Nothing has been cancelled yet — EP Team will come back to you
              to confirm it and agree what it costs. Everything below is still live until they do.
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm mt-2.5"
              onClick={() => {
                W.withdrawCancellationRequest(w, PORTAL.clientActor());
              }}
            >
              Withdraw this request
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="card p-4 mb-5" style={{ background: TONE_BG.info, borderColor: TONE_LINE.info }}>
      <div className="text-[13.5px] font-semibold text-ink">
        We have come back on your cancellation request
      </div>
      <div className="text-[12.5px] text-ink-2 leading-relaxed mt-0.5">“{declined!.note}”</div>
      <div className="text-[12.5px] text-ink-2 leading-relaxed mt-1.5">
        The job is still going ahead.
      </div>
      {W.cancelRequestBlock(w) ? null : (
        <button type="button" className="btn btn-secondary btn-sm mt-2.5" onClick={onAsk}>
          Ask again
        </button>
      )}
    </section>
  );
}

/** The quiet way out, at the foot of the page where a decision like this belongs. */
function CancelFooter({ w, onAsk }: { w: W.Wof; onAsk: () => void }) {
  if (W.cancelRequestBlock(w)) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mt-6 pt-4 border-t border-surface-line-soft">
      <div className="text-[12.5px] text-ink-3 leading-relaxed">
        Need to stop this job? Tell us and we will come back to you with what it costs.
      </div>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onAsk}>
        Ask us to cancel this job
      </button>
    </div>
  );
}


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

/**
 * Money, and the two invoices that collect it.
 *
 * This used to end in a Pay button that recorded a payment here. Payment now
 * happens on the invoice Xero sends — so each invoice is a row with its status
 * as Xero last reported it, and a button that opens that invoice. The row is
 * shown before the invoice exists too, so the client can see what is coming.
 */
function PaymentsCard({ w, onOpen }: { w: W.Wof; onOpen: (which: W.BillingKind) => void }) {
  const toast = useToast();
  const dep = W.deposit(w);
  const client = PORTAL.actingClient();
  // What this client has been told about, not what the job is worth to EP
  // Team — a variation typed this morning and not yet sent is neither theirs
  // to see nor theirs to pay.
  const contract = W.clientContractValue(w);
  const balance = contract - dep.due;
  const depDoc = W.billingDoc(w, 'deposit');
  const invDoc = W.billingDoc(w, 'invoice');

  const row = (label: string, value: React.ReactNode, strong?: boolean) => (
    <div className="flex items-baseline justify-between gap-3 py-1.5 border-b border-surface-line-soft last:border-0">
      <span className="text-[12.5px] text-ink-3">{label}</span>
      <span className={`text-[13px] text-right ${strong ? 'text-ink font-semibold' : 'text-ink-2'}`}>{value}</span>
    </div>
  );

  const pdf = (d: W.BillingDoc) => {
    if (!DOC.openBillingDocument(w, d, { audience: 'client' }))
      toast('Your browser blocked the document window. Allow pop-ups for this site and try again.', {
        tone: 'critical',
      });
  };

  /* One invoice: what it is, where it stands, and the way to it. */
  const bill = (which: W.BillingKind, title: string, d: W.BillingDoc | null, notYet: string) => {
    const st = d?.xero || d?.paidAt ? W.billingStatus(d) : { label: 'Not issued yet', tone: 'neutral' as Tone };
    return (
      <div className="pt-3 mt-3 border-t border-surface-line">
        <div className="flex items-center justify-between gap-2 mb-1">
          <span className="text-[13px] font-semibold text-ink">{title}</span>
          <Pill label={st.label} tone={st.tone} hint={false} />
        </div>
        {d && (d.xero || d.paidAt) ? (
          <>
            <div className="text-[12.5px] text-ink-2 leading-relaxed">
              {d.number} · {money(W.billingGross(d))} inc. VAT
              {d.paidAt ? ` · paid ${fmtDate(d.paidAt)}` : d.dueAt ? ` · due ${fmtDate(d.dueAt)}` : ''}
            </div>
            <div className="flex flex-wrap gap-2 mt-2.5">
              {!d.paidAt && d.xero ? (
                <button type="button" className="btn btn-primary btn-sm flex-1" onClick={() => onOpen(which)}>
                  {which === 'deposit' ? 'View and pay invoice' : 'View and pay balance'}{' '}
                  <Icon name="externalLink" decorative className="icon-sm" />
                </button>
              ) : null}
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => pdf(d)}>
                <Icon name="download" decorative className="icon-sm" /> PDF
              </button>
            </div>
          </>
        ) : (
          <div className="text-[12.5px] text-ink-3 leading-relaxed">{notYet}</div>
        )}
      </div>
    );
  };

  return (
    <div className="card p-4">
      <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-3">Payments</div>
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
      {row(w.invoice ? 'Balance' : 'Balance so far', money(balance, { pence: false }))}
      {row('Payment terms', `${client.termsDays} days`)}

      {dep.due > 0 && w.signoff
        ? bill(
            'deposit',
            `1 · Deposit invoice`,
            depDoc,
            'Your deposit invoice is being prepared. It arrives by email and appears here.',
          )
        : null}
      {w.signoff
        ? bill(
            'invoice',
            dep.due > 0 ? '2 · Final invoice' : 'Invoice',
            invDoc,
            dep.due > 0
              ? 'Sent once the job is complete — the total and any changes you approved, less the deposit.'
              : 'Sent once the job is complete.',
          )
        : null}

      {(depDoc?.xero && !depDoc.paidAt) || (invDoc?.xero && !invDoc.paidAt) ? (
        <p className="text-[11.5px] text-ink-3 mt-3 leading-relaxed">
          Payment is taken on the invoice by Xero, by card or bank transfer. This page updates on its own once
          your payment is recorded.
        </p>
      ) : null}
      {w.invoice?.paidAt ? (
        <div className="text-[12px] text-ink-3 mt-3 text-center">
          Settled {fmtDateFull(w.invoice.paidAt)} — thank you.
        </div>
      ) : null}
    </div>
  );
}

/**
 * "I need more" — once the job is signed and the deposit is in.
 *
 * Shown from signing onwards so the client knows it exists, but disabled with
 * the reason until the deposit lands (`askBlock`). Hidden before signing: the
 * quote's own "Something is wrong or missing" is the right door then, and two
 * doors to the same room is one too many.
 */
function AskMoreCard({ w, onAsk }: { w: W.Wof; onAsk: (k: W.ClientAskKind) => void }) {
  if (!w.signoff || W.isTerminal(w.stage)) return null;
  const onJob = W.askBlock(w, 'staff');
  const quote = W.askBlock(w, 'quote');
  return (
    <div className="card p-4">
      <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2">Need more?</div>
      <p className="text-[12.5px] text-ink-2 leading-relaxed mb-3">
        Tell us what else you need. We price it and send it to you — nothing is added or charged until you
        approve the price.
      </p>
      <div className="grid gap-2">
        <button
          type="button"
          className="btn btn-primary btn-sm w-full"
          disabled={!!onJob}
          title={onJob || undefined}
          onClick={() => onAsk('staff')}
        >
          <Icon name="plus" decorative className="icon-sm" /> Extra staff or kit on this job
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm w-full"
          disabled={!!quote}
          title={quote || undefined}
          onClick={() => onAsk('quote')}
        >
          <Icon name="fileText" decorative className="icon-sm" /> Request another quote
        </button>
      </div>
      {onJob && quote ? (
        <div className="text-[11.5px] text-ink-3 mt-2 leading-relaxed">{onJob}</div>
      ) : null}
    </div>
  );
}

/** What the client has asked for since signing, and where each ask stands. */
function AsksList({ w }: { w: W.Wof }) {
  const asks = W.clientAsks(w);
  if (!asks.length) return null;
  return (
    <div id="asks">
      <Section title={`What you have asked for (${asks.length})`} />
      <div className="card divide-y divide-surface-line">
        {asks.map((a) => {
          const st = W.askStatus(w, a);
          return (
            <div key={a.id} className="flex items-start gap-3 p-3.5">
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-baseline gap-2 mb-0.5">
                  <span className="text-[13px] font-medium text-ink">{W.ASK_KIND_LABEL[a.kind]}</span>
                  <Pill label={st.label} tone={st.tone} hint={false} />
                  <span className="text-[11.5px] text-ink-3">Sent {fmtDate(a.at)}</span>
                </div>
                <div className="text-[12.5px] text-ink-2 leading-relaxed">
                  “{a.text}”{a.when ? <span className="text-ink-3"> — {a.when}</span> : null}
                </div>
                {st.detail ? (
                  <div className="text-[12px] text-ink-3 leading-relaxed mt-1">
                    {a.answer?.how === 'declined' ? `EP Team: “${st.detail}”` : st.detail}
                  </div>
                ) : null}
              </div>
              {!a.answer ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm shrink-0"
                  onClick={() => W.withdrawAsk(w, a.id, PORTAL.clientActor())}
                >
                  Withdraw
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
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
  const days = gridDays(w);
  const dayNos = days.map((d) => d.no);
  const dayLabel = (d: GridDay) =>
    d.date?.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) || `day ${d.no}`;

  const byArea: { area: string; groups: W.DeploymentView[] }[] = [];
  groups.forEach((g) => {
    const bucket = byArea.find((b) => b.area === g.area);
    if (bucket) bucket.groups.push(g);
    else byArea.push({ area: g.area, groups: [g] });
  });

  // Role, the days, then shifts / hours / rate / total.
  const span = dayNos.length + 5;
  const pin = (i: number) => tailCell(CLIENT_TAIL, i);

  return (
    <div className="card">
      <DayGridFrame days={days.length} tail={CLIENT_TAIL}>
      <table className="text-[12.5px]">
        <DayGridCols days={days} tail={CLIENT_TAIL} />
        <DayGridHead
          days={days}
          tail={CLIENT_TAIL}
          tailLabels={['Shifts', 'Hours', 'Rate', 'Total']}
          titleFor={(d) =>
            d.date
              ? `${d.date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} — ${
                  d.kind === 'event' ? 'event day' : d.kind === 'build' ? 'build day' : 'break day'
                }`
              : `Day ${d.no}`
          }
        />
        <tbody>
          {byArea.map((bucket) => (
            <Fragment key={bucket.area}>
              <tr>
                <td
                  colSpan={span}
                  className="px-3 py-1.5 text-[9.5px] uppercase tracking-[0.14em] font-semibold"
                  style={{ background: 'var(--surface-high)', color: 'var(--ink-2)' }}
                >
                  <span className="dg-pin">{bucket.area}</span>
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
                          <span className="dg-pin">
                            <span className="font-medium">{g.placeName}</span>
                            <span className="text-ink-3 tabular-nums">
                              {' '}
                              · {col.window ? `${col.window.start}–${col.window.end}` : 'times to be confirmed'}
                              {col.window ? ` · ${W.patternHours(col.window)}h shifts` : ''}
                            </span>
                            {col.window && col.window.end <= col.window.start ? (
                              <Pill label="Overnight" tone="info" hint="This shift closes the following morning" />
                            ) : null}
                          </span>
                        </td>
                      </tr>
                      {col.lines.map((l) => {
                        const pat = W.linePattern(w, l);
                        return (
                          <tr key={l.id} className="dg-line">
                            <td className="dg-role pl-6 pr-3 py-1.5 text-ink truncate" title={l.description}>
                              {l.description}
                            </td>
                            {days.map((day) => {
                              const d = day.no;
                              const covered = !!pat && pat.days.includes(d);
                              const n = covered ? W.headcountOn(w, l, d) : 0;
                              return (
                                <td
                                  key={d}
                                  className={`px-0 py-1.5 text-center tabular-nums${dayRule(day)}`}
                                  style={{
                                    color: n ? 'var(--ink)' : 'var(--ink-3)',
                                    fontWeight: n ? 600 : 400,
                                    background: phaseBg(day.kind),
                                  }}
                                  title={n ? `${n} on ${dayLabel(day)}` : `None on ${dayLabel(day)}`}
                                >
                                  {n || '·'}
                                </td>
                              );
                            })}
                            <td
                              className={`${pin(0).className} px-3 py-1.5 text-right tabular-nums text-ink-2`}
                              style={pin(0).style}
                            >
                              {W.lineShifts(w, l)}
                            </td>
                            <td
                              className={`${pin(1).className} px-3 py-1.5 text-right tabular-nums text-ink-2`}
                              style={pin(1).style}
                            >
                              {W.lineHours(w, l)}
                            </td>
                            <td
                              className={`${pin(2).className} px-3 py-1.5 text-right tabular-nums text-ink-2`}
                              style={pin(2).style}
                            >
                              {money(W.lineRate(l))}
                            </td>
                            <td
                              className={`${pin(3).className} px-3 py-1.5 text-right tabular-nums text-ink font-semibold`}
                              style={pin(3).style}
                            >
                              {money(W.lineValue(l), { pence: false })}
                            </td>
                          </tr>
                        );
                      })}
                    </Fragment>
                  ))}
                  <tr className="dg-sum">
                    <td
                      colSpan={dayNos.length + 1}
                      className="px-3 py-1.5 text-right text-[9.5px] uppercase tracking-[0.11em] text-ink-3 font-semibold"
                    >
                      <span className="dg-pin-r">{g.placeName}</span>
                    </td>
                    <td
                      className={`${pin(0).className} px-3 py-1.5 text-right tabular-nums font-semibold text-ink`}
                      style={pin(0).style}
                    >
                      {g.shifts}
                    </td>
                    <td
                      className={`${pin(1).className} px-3 py-1.5 text-right tabular-nums font-semibold text-ink`}
                      style={pin(1).style}
                    >
                      {g.hours}
                    </td>
                    <td className={pin(2).className} style={pin(2).style} />
                    <td
                      className={`${pin(3).className} px-3 py-1.5 text-right tabular-nums font-semibold text-ink`}
                      style={pin(3).style}
                    >
                      {money(g.staffValue, { pence: false })}
                    </td>
                  </tr>
                </Fragment>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
      </DayGridFrame>
      <div
        className="px-3 py-2.5 flex items-start gap-4 flex-wrap"
        style={{ borderTop: '1px solid var(--surface-line)' }}
      >
        <p className="text-[11.5px] text-ink-3 leading-relaxed" style={{ flex: '1 1 260px' }}>
          Blue columns are event days, amber are build days and grey are break days. A dot means no staff
          on that line that day. Rates are per hour. Equipment is hired across the whole event rather than by the place, so it
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
  w,
  docs,
  onUpload,
}: {
  w: W.Wof;
  docs: W.WofDocView[];
  onUpload: (d: W.WofDocView) => void;
}) {
  useJobFilesVersion();
  const toast = useToast();
  /** The last thing sent, and whether EP sent it back. */
  const fileOf = (d: W.WofDocView) => JF.latest(w.id, d.docId);
  const returned = (d: W.WofDocView) => {
    const f = fileOf(d);
    return d.status === 'required' && f?.review?.decision === 'returned' ? f.review : null;
  };

  const columns: Column<W.WofDocView>[] = [
    {
      key: 'label', label: 'Document',
      cell: (d) => {
        const f = fileOf(d);
        const back = returned(d);
        return (
          <>
            <div className="text-[13.5px] text-ink">{d.label}</div>
            {d.blocking ? (
              <div className="text-[11px] text-ink-3">We cannot sign the job off without this</div>
            ) : null}
            {back ? (
              <div className="text-[12px] mt-1 leading-snug" style={{ color: TONE_HEX.atRisk }}>
                Sent back: {back.reason}
              </div>
            ) : d.note && !d.note.startsWith('Sent back:') && d.note !== f?.note ? (
              <div className="text-[11.5px] text-ink-2 italic mt-0.5">{d.note}</div>
            ) : null}
            {f ? (
              <div className="text-[11.5px] text-ink-3 mt-1 flex items-center gap-1.5">
                <Icon name="fileText" decorative className="icon-sm" />
                <span>
                  {back ? 'Last sent' : 'You sent'}{' '}
                  {f.stored ? (
                    <button
                      type="button"
                      className="text-accent hover:underline"
                      onClick={async () => {
                        if (!(await JF.openFile(f))) toast('That file is not held in this browser.', { tone: 'critical' });
                      }}
                    >
                      {f.name}
                    </button>
                  ) : (
                    f.name
                  )}{' '}
                  on {fmtDate(f.uploadedAt)}
                </span>
              </div>
            ) : null}
          </>
        );
      },
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
        ) : returned(d) ? (
          <Pill label="Sent back" tone="atRisk" hint="EP Team needs a new version — the reason is under the name" />
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
            {d.status === 'submitted' ? 'Replace' : returned(d) ? 'Send a new version' : 'Send it'}
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
