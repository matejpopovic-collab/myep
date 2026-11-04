/* ============================================================================
   CLIENT PORTAL — action dialogs
   ----------------------------------------------------------------------------
   Every one of these writes to the same WOF the operator is looking at, and
   every one records the CLIENT as the actor. That is the whole point of the
   round trip: the admin history should read "signed by Dana Reilly (Festival
   Republic)", not "signed by Jake Wright".

   None of them skip a stage. Signing makes a WOF eligible to become an order;
   an operator still confirms it, because seeding shifts into the staffing tool
   is EP Team's call. The client's job is to say yes and to pay.
   ========================================================================== */

import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { TONE_BG, TONE_HEX } from '@/lib/status';
import { fmtDate, money } from '@/lib/format';
import { docType } from '@/data/db';
import * as JF from '@/lib/jobfiles';
import { FileDrop } from '@/components/FileDrop';
import * as PORTAL from '@/lib/portal';
import * as W from '@/lib/wof';
import * as XERO from '@/lib/xero';
import * as NOTIFY from '@/lib/notifications';

/* ---------------------------------------------------------------- sign --- */

export function SignQuoteDialog({ w, onClose }: { w: W.Wof; onClose: () => void }) {
  const toast = useToast();
  const client = PORTAL.actingClient();
  const [name, setName] = useState(client.contact || '');
  const [role, setRole] = useState(client.contactRole || '');
  const [accepted, setAccepted] = useState(false);

  const value = W.quoteValue(w);
  const dep = W.deposit(w);

  return (
    <Modal
      title="Sign the quote"
      width={560}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!accepted || !name.trim()}
            onClick={() => {
              const c = W.signQuoteAndConfirm(
                w,
                { signedBy: name.trim(), signedByRole: role.trim(), method: 'Client portal' },
                PORTAL.clientActor(),
              );
              onClose();
              // The client is told their booking is confirmed, not that it has
              // been "notified" and awaits a human. It no longer does — the
              // signature seeded the rota and the kit list on its way through.
              // What the client does not need is our shift counts, so they are
              // deliberately not in this message.
              toast(
                c.ordered
                  ? `Signed — thank you. Your booking is confirmed and we have started allocating staff and equipment.${dep.due > 0 ? ` A ${dep.pct}% deposit of ${money(dep.due, { pence: false })} is now due.` : ''}`
                  : 'Signed — thank you. EP Team has been notified and will confirm your booking.',
                { tone: 'healthy' },
              );
            }}
          >
            Sign and accept
          </button>
        </>
      }
    >
      <p className="text-[13.5px] text-ink-2 leading-relaxed mb-4">
        You are accepting <strong className="text-ink">{money(value)}</strong> of work on{' '}
        <strong className="text-ink">{w.title}</strong>, {fmtDate(w.start)}. This is a digital signature and
        carries the same weight as a signed order.
      </p>

      <div className="well p-3 mb-4">
        <div className="flex items-baseline justify-between py-1">
          <span className="text-[12.5px] text-ink-3">Quoted work</span>
          <span className="text-[13px] tabular-nums text-ink">{money(value)}</span>
        </div>
        {dep.due > 0 ? (
          <div className="flex items-baseline justify-between py-1 border-t border-surface-line-soft">
            <span className="text-[12.5px] text-ink-3">Deposit on signing ({dep.pct}%)</span>
            <span className="text-[13px] tabular-nums text-ink">{money(dep.due)}</span>
          </div>
        ) : null}
        <div className="flex items-baseline justify-between py-1 border-t border-surface-line-soft">
          <span className="text-[12.5px] text-ink-3">Payment terms</span>
          <span className="text-[13px] text-ink">{client.termsDays} days from invoice</span>
        </div>
      </div>

      <div className="space-y-3.5">
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Your name</span>
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
        </label>
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Your role</span>
          <input className="field" value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Head of Operations" />
        </label>
        <label className="flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
          />
          <span className="text-[13px] text-ink-2 leading-relaxed">
            I am authorised to accept this quote on behalf of {client.name}, and I understand that work
            added later — extra staff or kit requested on site — is charged on top and will be sent to me to
            approve.
          </span>
        </label>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------ Xero invoice --- */

/**
 * The invoice as Xero shows it to the client, and where they pay it.
 *
 * Only reached in test mode: against live Xero the button opens Xero's own
 * online invoice in a new tab, and nothing in this app takes a payment. This
 * is the stand-in for that page, so the round trip — pay on the invoice, the
 * job updates on its own — can be clicked through before a server exists.
 */
export function XeroInvoiceDialog({
  w,
  doc,
  canPay,
  onClose,
}: {
  w: W.Wof;
  doc: W.BillingDoc;
  canPay: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const [method, setMethod] = useState('Card');
  const sim = doc.xero ? XERO.simInvoice(XERO.simIdFromUrl(doc.xero.url)) : null;
  const paid = !!doc.paidAt || sim?.status === 'PAID';
  const gross = W.billingGross(doc);
  const client = PORTAL.actingClient();

  return (
    <Modal
      title={`Invoice ${doc.number}`}
      width={560}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Close
          </button>
          {!paid && canPay && sim ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                const pmt = XERO.simPay(sim.invoiceId, method);
                if (pmt) {
                  toast(`Paid ${money(pmt.amount)} on ${doc.number}. Thank you — your job has been updated.`, {
                    tone: 'healthy',
                  });
                } else {
                  toast('This invoice could not be paid. It may already be settled.', { tone: 'critical' });
                }
                onClose();
              }}
            >
              Pay {money(gross)}
            </button>
          ) : null}
        </>
      }
    >
      <div
        className="rounded-md px-3 py-2 mb-4 text-[12px] leading-relaxed"
        style={{ background: TONE_BG.info, color: TONE_HEX.info }}
      >
        Test mode. In the live system this is Xero&apos;s own invoice page, opened in a new tab, and payment
        is taken by Xero.
      </div>

      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1">From</div>
          <div className="text-[13.5px] font-semibold text-ink">EP Team Ltd</div>
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mt-3 mb-1">To</div>
          <div className="text-[13.5px] text-ink">{client.name}</div>
        </div>
        <div className="text-right text-[12.5px] text-ink-2 leading-relaxed">
          <div className="font-semibold text-ink">{doc.number}</div>
          <div>Reference {W.billingRef(w, doc)}</div>
          <div>Issued {fmtDate(doc.at)}</div>
          <div>{doc.dueAt ? `Due ${fmtDate(doc.dueAt)}` : 'Due on receipt'}</div>
        </div>
      </div>

      <div className="well p-3 mb-3">
        {doc.lines.map((l, i) => (
          <div key={i} className="flex items-baseline justify-between gap-3 py-1">
            <span className="text-[13px] text-ink-2">
              {l.label}
              <span className="block text-[11.5px] text-ink-3">{l.detail}</span>
            </span>
            <span className="text-[13px] tabular-nums text-ink">
              {l.value < 0 ? '−' : ''}
              {money(Math.abs(l.value))}
            </span>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-3 py-1 border-t border-surface-line mt-1.5 pt-2">
          <span className="text-[13px] text-ink-2">VAT {Math.round(doc.vatRate * 100)}%</span>
          <span className="text-[13px] tabular-nums text-ink">{money(W.billingVat(doc))}</span>
        </div>
        <div className="flex items-baseline justify-between gap-3 pt-1.5">
          <span className="text-[13.5px] font-semibold text-ink">{paid ? 'Total paid' : 'Amount due'}</span>
          <span className="text-[20px] font-bold text-ink tabular-nums">{money(gross)}</span>
        </div>
      </div>

      {paid ? (
        <div
          className="rounded-md px-3 py-2.5 text-[13px] font-semibold"
          style={{ background: TONE_BG.healthy, color: TONE_HEX.healthy }}
        >
          Paid{doc.paidAt ? ` ${fmtDate(doc.paidAt)}` : ''} — thank you.
        </div>
      ) : canPay ? (
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Pay by</span>
          <select className="field" value={method} onChange={(e) => setMethod(e.target.value)}>
            <option>Card</option>
            <option>Bank transfer</option>
          </select>
        </label>
      ) : (
        <p className="text-[12.5px] text-ink-3 leading-relaxed">
          Only an approver on your account can pay invoices. You can still read and download it.
        </p>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------ document --- */

export function UploadDocDialog({
  w,
  doc,
  onClose,
}: {
  w: W.Wof;
  doc: W.WofDocView;
  onClose: () => void;
}) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = docType(doc.docId);
  const prev = JF.latest(w.id, doc.docId);
  const sentBack = prev?.review?.decision === 'returned' && doc.status === 'required' ? prev.review : null;
  const replacing = doc.status !== 'required' || !!sentBack;

  const send = async () => {
    if (!file) {
      setError('Choose the file to send first.');
      return;
    }
    setBusy(true);
    const r = await JF.submit(w, doc.docId, file, { note, actor: PORTAL.clientActor(), side: 'client' });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    onClose();
    toast(`${doc.label} received. EP Compliance will check it and let you know here.`, { tone: 'healthy' });
  };

  return (
    <Modal
      title={replacing ? `Send a new version of your ${doc.label.toLowerCase()}` : `Send us your ${doc.label.toLowerCase()}`}
      width={520}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} aria-disabled={!file} onClick={send}>
            {busy ? 'Sending…' : 'Send it'}
          </button>
        </>
      }
    >
      {sentBack ? (
        <div className="rounded-lg p-3 mb-3" style={{ background: TONE_BG.atRisk }}>
          <p className="text-[12.5px] font-semibold text-ink mb-0.5">We sent the last one back</p>
          <p className="text-[12.5px] text-ink-2 leading-relaxed">“{sentBack.reason}” — {sentBack.by}</p>
        </div>
      ) : null}

      <p className="text-[13.5px] text-ink-2 leading-relaxed mb-3">
        We need this {meta ? `${meta.leadDays} days before the event` : 'before the event'} — by{' '}
        <strong className={doc.overdue ? 'text-status-critical' : 'text-ink'}>{fmtDate(doc.dueDate)}</strong>
        {doc.overdue ? ', which has passed' : ''}. Without it we cannot sign the job off as ready.
      </p>

      <div className="mb-3">
        <FileDrop
          file={file}
          onFile={(f) => {
            setFile(f);
            setError(null);
          }}
          check={JF.uploadBlocker}
          accept={JF.ACCEPT_ATTR}
          hint={`Up to ${JF.fmtSize(JF.MAX_BYTES)}. PDF, Word, Excel, a drawing or an image.`}
        />
      </div>

      <label className="block">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
          Anything we should know? <span className="font-normal text-ink-3">Optional</span>
        </span>
        <textarea
          className="field"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. This is the draft — the licensing authority signs it off next week."
        />
      </label>

      {error ? (
        <p role="alert" className="text-[12.5px] text-status-critical mt-2">
          {error}
        </p>
      ) : null}

      <div className="rounded-lg p-3 mt-3" style={{ background: TONE_BG.info }}>
        <p className="text-[12.5px] text-ink-2 leading-relaxed">
          It arrives with EP Compliance as <strong className="text-ink">submitted</strong>, not approved —
          somebody checks it before the job is marked ready. You will see the status change here
          {replacing ? ', and the earlier version is kept' : ''}.
        </p>
      </div>
    </Modal>
  );
}

/* ----------------------------------------------------------- variation --- */

export function VariationDialog({
  w,
  line,
  mode,
  onClose,
}: {
  w: W.Wof;
  line: W.LineItem;
  mode: 'accept' | 'query';
  onClose: () => void;
}) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const value = W.lineValue(line);

  return (
    <Modal
      title={mode === 'accept' ? 'Approve this change' : 'Query this change'}
      width={520}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={mode === 'accept' ? 'btn btn-primary' : 'btn btn-secondary'}
            disabled={mode === 'query' && !note.trim()}
            onClick={() => {
              const actor = PORTAL.clientActor();
              if (mode === 'accept') {
                W.acceptVariation(w, line.id, actor);
                toast(`Approved. ${money(value, { pence: false })} will appear on your invoice.`, {
                  tone: 'healthy',
                });
              } else {
                W.queryVariation(w, line.id, note, actor);
                toast('Query sent. Your account manager will come back to you before this is invoiced.', {
                  tone: 'info',
                });
              }
              onClose();
            }}
          >
            {mode === 'accept' ? `Approve ${money(value, { pence: false })}` : 'Send query'}
          </button>
        </>
      }
    >
      <div className="well p-3 mb-4">
        <div className="text-[13.5px] text-ink font-semibold">{line.description}</div>
        <div className="text-[12.5px] text-ink-2 mt-1">
          {line.qty} × {line.units} {line.unitLabel}
          {line.units === 1 ? '' : 's'}
        </div>
        <div className="flex items-baseline justify-between mt-2 pt-2 border-t border-surface-line-soft">
          <span className="text-[12.5px] text-ink-3">Added to your bill</span>
          <span className="text-[17px] font-bold text-ink tabular-nums">{money(value)}</span>
        </div>
        {line.duringEvent ? (
          <div className="text-[11.5px] mt-2" style={{ color: TONE_HEX.atRisk }}>
            <Icon name="alert" decorative className="icon-sm" /> Added while your event was running
          </div>
        ) : null}
      </div>

      {line.note ? (
        <p className="text-[13px] text-ink-2 leading-relaxed mb-4">
          <span className="text-ink-3">EP Team's reason: </span>
          {line.note}
        </p>
      ) : null}

      {mode === 'accept' ? (
        <p className="text-[13px] text-ink-2 leading-relaxed">
          Approving adds this to the agreed value of the job. It appears as a separate line on your invoice
          so it is clear what you are paying for and why.
        </p>
      ) : (
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">What is the question?</span>
          <textarea
            className="field"
            rows={4}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. We only asked for two of these, not four — can you check with the site manager?"
          />
          <span className="block text-[11.5px] text-ink-3 mt-1.5">
            Nothing is invoiced while a change is under query.
          </span>
        </label>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------- querying a quote -- */

/**
 * The client comes back on the quote.
 *
 * Their words go on the record unedited and against the version they were
 * looking at, because "the client objected" without saying to what, in whose
 * words, on which figure, is not a paper trail — it is a memory of a phone
 * call.
 */

/* ------------------------------------------------- asking us to cancel --- */

/**
 * The client asking EP Team to stop the job.
 *
 * It shows what cancelling would cost BEFORE they ask. A cancellation policy
 * discovered after the event is the same failure as a missing item buried at
 * the end of a complaint: technically disclosed, actually a surprise, and the
 * surprise arrives with an invoice attached.
 *
 * It is a request and says so twice. Nothing here moves a stage — what the
 * notice period is worth is a conversation, and a client pressing a button in
 * a portal is not that conversation.
 */
export function RequestCancellationDialog({ w, onClose }: { w: W.Wof; onClose: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const block = W.cancelRequestBlock(w);
  const p = W.cancelPreview(w, { initiator: 'client' });
  const days = p.band.daysNotice;

  return (
    <Modal
      title="Ask us to cancel this job"
      width={520}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!!block || !reason.trim()}
            title={block || undefined}
            onClick={() => {
              const actor = PORTAL.clientActor();
              if (!W.requestCancellation(w, reason, actor)) {
                toast(W.cancelRequestBlock(w) || 'That request could not be sent.', { tone: 'critical' });
                return;
              }
              NOTIFY.cancellationRequested({
                wofId: w.id,
                ref: w.jobCode || w.ref,
                title: w.title,
                client: actor.name,
                reason,
                daysNotice: days,
              });
              onClose();
              toast('Sent. EP Team will come back to you — nothing has been cancelled yet.', {
                tone: 'info',
              });
            }}
          >
            Send the request
          </button>
        </>
      }
    >
      <p className="text-[13.5px] text-ink-2 leading-relaxed mb-4">
        This does not cancel the job. It tells EP Team you want to stop, and somebody will come back
        to you to confirm it and agree what it costs.
      </p>

      {w.signoff ? (
        <div className="well p-3 mb-4">
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1.5">
            What it would cost today
          </div>
          <div className="text-[12.5px] text-ink-2 leading-relaxed">
            {days < 0
              ? 'This job has already started, so the whole of it is charged: '
              : `With ${days} ${days === 1 ? 'day' : 'days'} to go, ${p.band.label.toLowerCase()} means `}
            <strong className="text-ink">{p.band.chargePct}%</strong> of the agreed{' '}
            {money(p.contractValue, { pence: false })} — {money(p.charge, { pence: false })}
            {p.refundDue > 0
              ? `, with ${money(p.refundDue, { pence: false })} of your deposit coming back.`
              : p.balanceDue > 0
                ? `, of which ${money(p.balanceDue, { pence: false })} is still to invoice.`
                : '.'}
          </div>
          <div className="text-[11.5px] text-ink-3 mt-2 leading-relaxed">
            The closer to the date, the more of the job EP has already committed — staff turned away
            from other work, kit taken off the shelf. This figure moves as the date gets nearer.
          </div>
        </div>
      ) : (
        <div className="well p-3 mb-4">
          <div className="text-[12.5px] text-ink-2 leading-relaxed">
            You have not signed this quote, so there is nothing to pay. Say the word and we will
            close it off.
          </div>
        </div>
      )}

      <label className="block">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
          Why do you need to cancel? <span className="font-normal text-ink-3">Required</span>
        </span>
        <textarea
          className="field"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. The council has refused our licence for the weekend."
        />
        <span className="block text-[11.5px] text-ink-3 mt-1.5 leading-relaxed">
          It goes straight to the team looking after your account. If some of the job can still go
          ahead, say so — we would rather move it than lose it.
        </span>
      </label>
    </Modal>
  );
}

export function QueryQuoteDialog({ w, onClose }: { w: W.Wof; onClose: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  /* The missing list is its own field, not a sentence inside the note.
     "and we also need a supervisor on the Sunday" buried at the end of a
     paragraph is a thing an operator skims past while they are busy arguing
     about the steward count — which is how a quote gets re-sent with the same
     hole in it. Asking for it separately makes it a list somebody has to
     answer, item by item. */
  const [missing, setMissing] = useState<string[]>(['']);
  const v = W.latestIssued(w, 'quote');
  const block = W.queryQuoteBlock(w);

  const setAt = (i: number, text: string) =>
    setMissing((m) => m.map((x, j) => (j === i ? text : x)));
  const removeAt = (i: number) =>
    setMissing((m) => (m.length === 1 ? [''] : m.filter((_, j) => j !== i)));
  const wants = missing.map((t) => t.trim()).filter(Boolean);

  return (
    <Modal
      title="Send this quote back"
      width={520}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!!block}
            title={block || undefined}
            onClick={() => {
              if (!note.trim() && !wants.length) {
                toast('Tell EP Team what is wrong, or what is missing — that is the part they can act on.', {
                  tone: 'critical',
                });
                return;
              }
              const actor = PORTAL.clientActor();
              if (!W.queryQuote(w, note, actor, wants)) {
                toast(W.queryQuoteBlock(w) || 'That query could not be sent.', { tone: 'critical' });
                return;
              }
              NOTIFY.quoteQueried({
                wofId: w.id,
                ref: w.jobCode || w.ref,
                version: v ? v.label : 'the quote',
                client: actor.name,
                note: note.trim(),
                missing: wants.length,
              });
              onClose();
              toast('Sent to EP Team. Nothing is agreed while a query is open.', { tone: 'info' });
            }}
          >
            Send it back
          </button>
        </>
      }
    >
      {block ? (
        <div className="card p-3 mb-4" style={{ background: TONE_BG.atRisk }}>
          <p className="text-[13px] text-ink-2 leading-relaxed">{block}</p>
        </div>
      ) : null}

      <p className="text-[13px] text-ink-2 leading-relaxed mb-4">
        This goes to EP Team against{' '}
        <strong className="text-ink">{v ? v.label : 'the quote you were sent'}</strong>
        {v ? <> — the {money(v.value, { pence: false })} you are looking at</> : null}. Nothing is agreed
        while a query is open, and you will be sent a new version rather than an edited copy of this one.
        Fill in either part, or both.
      </p>

      <label className="block mb-4">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
          What is wrong with what we sent
        </span>
        <textarea
          className="field"
          rows={4}
          value={note}
          placeholder="Numbers, dates, rates — whatever does not match what you asked for."
          onChange={(e) => setNote(e.target.value)}
        />
      </label>

      <div className="block">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">What is missing from it</span>
        <p className="text-[12px] text-ink-3 leading-relaxed mb-2">
          Work you asked for that is not on the quote at all. One thing per line, in your own words —
          EP Team prices it and it comes back on the next version.
        </p>
        <div className="flex flex-col gap-2">
          {missing.map((text, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                className="field flex-1"
                value={text}
                placeholder={
                  i === 0 ? 'e.g. a supervisor on the Sunday, 12:00–20:00' : 'Something else we have missed'
                }
                onChange={(e) => setAt(i, e.target.value)}
              />
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                aria-label="Remove this item"
                title="Remove this item"
                onClick={() => removeAt(i)}
              >
                <Icon name="close" decorative className="icon-sm" />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm mt-2"
          onClick={() => setMissing((m) => m.concat(['']))}
        >
          <Icon name="plus" decorative className="icon-sm" /> Add another
        </button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------- asking for more -- */

const ASK_HINT: Record<W.ClientAskKind, { what: string; when: string; placeholder: string }> = {
  staff: {
    what: 'Who do you need, and doing what?',
    when: 'Which days and times?',
    placeholder: 'e.g. Four more stewards on the north gate, and a supervisor for them.',
  },
  kit: {
    what: 'What do you need?',
    when: 'Which days, and where on site?',
    placeholder: 'e.g. Another 20 metres of barrier for the bar queue.',
  },
  other: {
    what: 'What do you need?',
    when: 'Which days or times, if it matters?',
    placeholder: 'e.g. Someone to run the lost-property tent on both days.',
  },
  quote: {
    what: 'What is the work?',
    when: 'Dates and venue',
    placeholder: 'e.g. The same team for our winter market — same site.',
  },
};

/**
 * The client asking for more after signing. Nothing priced here: the client
 * says what they need in their own words, EP Team picks the charge. See
 * `requestMore` in lib/wof.ts.
 */
export function RequestMoreDialog({
  w,
  initialKind = 'staff',
  onClose,
}: {
  w: W.Wof;
  initialKind?: W.ClientAskKind;
  onClose: () => void;
}) {
  const toast = useToast();
  const [kind, setKind] = useState<W.ClientAskKind>(initialKind);
  const [text, setText] = useState('');
  const [when, setWhen] = useState('');
  const block = W.askBlock(w, kind);
  const hint = ASK_HINT[kind];
  const kinds: W.ClientAskKind[] = ['staff', 'kit', 'other', 'quote'];

  return (
    <Modal
      title="Ask for more"
      width={560}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!!block || !text.trim()}
            title={block || undefined}
            onClick={() => {
              const actor = PORTAL.clientActor();
              const a = W.requestMore(w, { kind, text, when }, actor);
              if (!a) {
                toast(W.askBlock(w, kind) || 'That request could not be sent.', { tone: 'critical' });
                return;
              }
              NOTIFY.clientAsked({
                wofId: w.id,
                ref: w.jobCode || w.ref,
                title: w.title,
                client: actor.name,
                what: W.ASK_KIND_LABEL[kind],
                text,
                when,
              });
              onClose();
              toast(
                kind === 'quote'
                  ? 'Sent. EP Team will put a quote together and send it to you.'
                  : 'Sent. EP Team will price it and send it to you to approve.',
                { tone: 'info' },
              );
            }}
          >
            Send to EP Team
          </button>
        </>
      }
    >
      <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2">What do you need?</div>
      <div className="grid grid-cols-2 gap-2 mb-4">
        {kinds.map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={kind === k}
            className={`btn btn-sm ${kind === k ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setKind(k)}
          >
            {W.ASK_KIND_LABEL[k]}
          </button>
        ))}
      </div>

      <label className="block mb-3">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
          {hint.what} <span className="text-status-critical">*</span>
        </span>
        <textarea
          className="field"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={hint.placeholder}
        />
      </label>
      <label className="block">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
          {hint.when} <span className="font-normal text-ink-3">Optional</span>
        </span>
        <input
          className="field"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
          placeholder={kind === 'quote' ? 'e.g. 12–13 December, same venue' : 'e.g. Sunday only, 10am–6pm'}
        />
      </label>

      <div className="well p-3 mt-4">
        <div className="text-[12.5px] text-ink-2 leading-relaxed">
          {kind === 'quote'
            ? 'This starts a separate quote — for another date or event, not this one. It arrives in your jobs list when EP Team sends it, and nothing is agreed until you sign it.'
            : 'Nothing is added or charged yet. EP Team prices it and sends it to you under "Changes since you signed" — you approve the price before it reaches your invoice.'}
        </div>
      </div>
      {block ? <p className="text-[11.5px] text-status-critical mt-2 leading-relaxed">{block}</p> : null}
    </Modal>
  );
}
