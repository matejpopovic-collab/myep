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
import * as PORTAL from '@/lib/portal';
import * as W from '@/lib/wof';
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

/* ----------------------------------------------------------------- pay --- */

export function PayDialog({
  w,
  kind,
  onClose,
}: {
  w: W.Wof;
  kind: 'deposit' | 'invoice';
  onClose: () => void;
}) {
  const toast = useToast();
  const dep = W.deposit(w);
  const balance = W.contractValue(w) - dep.due;
  const amount = kind === 'deposit' ? dep.outstanding : balance;
  const [method, setMethod] = useState('Bank transfer');
  const [ref, setRef] = useState('');

  return (
    <Modal
      title={kind === 'deposit' ? `Pay the ${dep.pct}% deposit` : `Pay invoice ${w.invoice?.number ?? ''}`}
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
            onClick={() => {
              const actor = PORTAL.clientActor();
              if (kind === 'deposit') {
                W.recordDeposit(w, { amount, ref: ref.trim() || `${method} — client portal` }, actor);
                toast(`Deposit of ${money(amount, { pence: false })} recorded. Thank you.`, { tone: 'healthy' });
              } else {
                W.markInvoicePaid(w, actor);
                toast(`Payment of ${money(amount, { pence: false })} recorded against ${w.invoice?.number}. Thank you.`, {
                  tone: 'healthy',
                });
              }
              onClose();
            }}
          >
            Confirm payment of {money(amount, { pence: false })}
          </button>
        </>
      }
    >
      <p className="text-[13.5px] text-ink-2 leading-relaxed mb-4">
        {kind === 'deposit' ? (
          <>
            {dep.pct}% of the agreed {money(W.quoteValue(w), { pence: false })} for{' '}
            <strong className="text-ink">{w.title}</strong>. Kit and staff are released once it lands.
          </>
        ) : (
          <>
            The balance on <strong className="text-ink">{w.title}</strong> — the agreed{' '}
            {money(W.contractValue(w), { pence: false })}
            {dep.due > 0 ? ` less the ${money(dep.due, { pence: false })} deposit you have already paid` : ''}.
          </>
        )}
      </p>

      <div className="well p-3 mb-4">
        <div className="flex items-baseline justify-between">
          <span className="text-[13px] text-ink-2">Amount</span>
          <span className="text-[20px] font-bold text-ink tabular-nums">{money(amount)}</span>
        </div>
        {kind === 'invoice' && w.invoice ? (
          <div className="text-[11.5px] text-ink-3 mt-1">
            Invoice {w.invoice.number}, due {fmtDate(w.invoice.dueAt)}
          </div>
        ) : null}
      </div>

      <div className="space-y-3.5">
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">How you are paying</span>
          <select className="field" value={method} onChange={(e) => setMethod(e.target.value)}>
            <option>Bank transfer</option>
            <option>Card</option>
            <option>Direct debit</option>
          </select>
        </label>
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
            Your reference <span className="font-normal text-ink-3">Optional</span>
          </span>
          <input
            className="field"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder="e.g. BACS 884120 or your PO number"
          />
        </label>
      </div>

      <p className="text-[12px] text-ink-3 mt-3 leading-relaxed">
        This prototype records the payment against the job so you can see the effect. In the live system it
        hands off to the payment provider first and records it when the money clears.
      </p>
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
  const meta = docType(doc.docId);

  return (
    <Modal
      title={`Send us your ${doc.label.toLowerCase()}`}
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
            onClick={() => {
              W.clientSubmitDoc(w, doc.docId, note, PORTAL.clientActor());
              onClose();
              toast(`${doc.label} received. EP Compliance will check it and mark it approved.`, {
                tone: 'healthy',
              });
            }}
          >
            Send it
          </button>
        </>
      }
    >
      <p className="text-[13.5px] text-ink-2 leading-relaxed mb-3">
        We need this {meta ? `${meta.leadDays} days before the event` : 'before the event'} — by{' '}
        <strong className={doc.overdue ? 'text-status-critical' : 'text-ink'}>{fmtDate(doc.dueDate)}</strong>
        {doc.overdue ? ', which has passed' : ''}. Without it we cannot sign the job off as ready.
      </p>

      <div className="well p-6 text-center mb-3">
        <div className="text-ink-3 mb-2 flex justify-center">
          <Icon name="fileText" decorative className="icon-xl" />
        </div>
        <p className="text-[13px] text-ink-2">Drag a file here, or choose one.</p>
        <p className="text-[12px] text-ink-3 mt-1">Up to 25 MB. PDF, Word or an image.</p>
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

      <div className="rounded-lg p-3 mt-3" style={{ background: TONE_BG.info }}>
        <p className="text-[12.5px] text-ink-2 leading-relaxed">
          It arrives with EP Compliance as <strong className="text-ink">submitted</strong>, not approved —
          somebody checks it before the job is marked ready. You will see the status change here.
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
