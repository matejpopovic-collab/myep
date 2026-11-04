/* ============================================================================
   WOF — the two invoices, raised in Xero
   ----------------------------------------------------------------------------
   Stage 4 raises the deposit invoice; the Invoice stage raises the final one.
   Each row says where that invoice stands as Xero last reported it, and holds
   the one action that moves it on. A payment is never typed here: it arrives
   from Xero. The manual "Record deposit received" / "Record payment received"
   stay where they were, for money that reaches EP Team some other way.
   ========================================================================== */

import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { Modal } from '@/components/Modal';
import { Pill } from '@/components/primitives';
import { useToast } from '@/components/Toast';
import { TONE_BG, TONE_HEX } from '@/lib/status';
import { addDays, fmtDate, fmtDateFull, money, round2 } from '@/lib/format';
import { client as clientById } from '@/data/db';
import * as W from '@/lib/wof';
import * as ROLES from '@/lib/roles';
import * as XERO from '@/lib/xero';

export function XeroBillingCard({ w }: { w: W.Wof }) {
  const toast = useToast();
  const [raising, setRaising] = useState<W.BillingKind | null>(null);
  const [checking, setChecking] = useState(false);
  const dep = W.deposit(w);
  const gw = XERO.current();
  const denial = ROLES.denial('wof.confirm');

  // Nothing to bill before the client has signed — the deposit is a share of
  // an agreed figure, and there is none yet.
  if (!w.signoff && !W.billingDocs(w).length) return null;

  const linked = W.billingDocs(w).some((d) => d.xero && !d.paidAt);

  const check = async () => {
    setChecking(true);
    const n = await XERO.sync(w);
    setChecking(false);
    toast(n ? `Xero reported ${n === 1 ? 'a payment' : `${n} payments`} — recorded on the job.` : 'Up to date with Xero.', {
      tone: n ? 'healthy' : 'info',
    });
  };

  const open = (d: W.BillingDoc) => {
    if (!d.xero) return;
    if (XERO.isSimUrl(d.xero.url))
      toast('Test mode: there is no Xero page to open. The client sees the invoice on their job page.', {
        tone: 'info',
      });
    else window.open(d.xero.url, '_blank', 'noopener');
  };

  const row = (kind: W.BillingKind, title: string, d: W.BillingDoc | null, idle: string) => {
    const block = W.xeroRaiseBlock(w, kind);
    const st = W.billingStatus(d);
    const canRaise = !block && !denial;
    return (
      <div className="flex-1 min-w-[260px] p-4 rounded-lg border border-surface-line">
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className="text-[13px] font-bold text-ink">{title}</span>
          <Pill label={d ? st.label : 'Not raised'} tone={d ? st.tone : 'neutral'} hint={false} />
        </div>
        {d ? (
          <div className="text-[12.5px] text-ink-2 leading-relaxed space-y-0.5">
            <div>
              <span className="font-semibold text-ink">{d.number}</span> · {money(W.billingGross(d))} inc. VAT
            </div>
            <div className="text-ink-3">
              {d.xero
                ? `In Xero since ${fmtDate(d.xero.raisedAt)} · ${d.xero.raisedByName}${
                    d.xero.emailedTo ? ` · emailed to ${d.xero.emailedTo}` : ' · not emailed'
                  }`
                : 'Written here, not yet raised in Xero.'}
            </div>
            <div className="text-ink-3">
              {d.paidAt
                ? `Paid ${fmtDateFull(d.paidAt)}${d.paidRef ? ` · ${d.paidRef}` : ''}`
                : d.dueAt
                  ? `Due ${fmtDateFull(d.dueAt)}`
                  : 'Due on receipt'}
            </div>
          </div>
        ) : (
          <p className="text-[12.5px] text-ink-3 leading-relaxed">{idle}</p>
        )}
        <div className="flex flex-wrap gap-2 mt-3">
          {!d?.xero && !d?.paidAt ? (
            <button
              type="button"
              className="btn btn-primary btn-sm tip"
              disabled={!canRaise}
              data-tip={denial || block || undefined}
              onClick={() => setRaising(kind)}
            >
              <Icon name="externalLink" decorative className="icon-sm" />{' '}
              {kind === 'deposit' ? 'Raise deposit invoice' : 'Raise final invoice'}
            </button>
          ) : null}
          {d?.xero ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => open(d)}>
              Open in Xero
            </button>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3">Invoicing · Xero</div>
          <div className="flex items-center gap-1.5 text-[12px] text-ink-3 mt-1">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ background: gw.mode === 'live' ? TONE_HEX.healthy : TONE_HEX.info }}
            />
            {gw.mode === 'live' ? `Connected · ${gw.organisation}` : 'Test mode — invoices go to a stand-in for Xero'}
          </div>
        </div>
        {linked ? (
          <button type="button" className="btn btn-secondary btn-sm" disabled={checking} onClick={check}>
            {checking ? 'Checking…' : 'Check Xero for payments'}
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-3">
        {dep.due > 0
          ? row(
              'deposit',
              `1 · Deposit (${dep.pct}%)`,
              W.billingDoc(w, 'deposit'),
              `${money(dep.due)} + VAT, raised at this stage. Allocation opens once Xero reports it paid.`,
            )
          : null}
        {row(
          'invoice',
          dep.due > 0 ? '2 · Final invoice' : 'Invoice',
          W.billingDoc(w, 'invoice'),
          'Written when the job reaches the Invoice stage: the contract and variations, less the deposit.',
        )}
      </div>
      {raising ? <RaiseXeroDialog w={w} kind={raising} onClose={() => setRaising(null)} /> : null}
    </div>
  );
}

/** Confirm what is about to go to Xero — and to the client's inbox. */
function RaiseXeroDialog({ w, kind, onClose }: { w: W.Wof; kind: W.BillingKind; onClose: () => void }) {
  const toast = useToast();
  const cl = clientById(w.clientId);
  const to = cl?.billingEmail || cl?.email || null;
  const [email, setEmail] = useState(!!to);
  const [busy, setBusy] = useState(false);
  const dep = W.deposit(w);
  const doc = W.billingDoc(w, kind);

  // The deposit invoice is written by the raise itself, so preview its figures.
  const lines: W.BillingLine[] = doc
    ? doc.lines
    : [{ label: `Deposit — ${dep.pct}% of the quotation`, detail: `${dep.pct}% of ${money(W.quoteValue(w))}`, value: dep.due }];
  const net = doc ? doc.net : round2(dep.due);
  const vat = round2(net * W.VAT_RATE);
  const due = doc ? doc.dueAt : addDays(new Date(), W.DEPOSIT_TERMS_DAYS);

  const go = async () => {
    setBusy(true);
    const res =
      kind === 'deposit' ? await XERO.raiseDeposit(w, { email }) : await XERO.raiseFinal(w, { email });
    setBusy(false);
    if (!res.ok) {
      toast(res.reason || 'Could not raise it in Xero.', { tone: 'critical' });
      return;
    }
    toast(
      `${res.doc!.number} raised in Xero${email && to ? ` and emailed to ${to}` : ''}. The client can pay it from their job page.`,
      { tone: 'healthy' },
    );
    onClose();
  };

  return (
    <Modal
      title={kind === 'deposit' ? 'Raise the deposit invoice in Xero' : 'Raise the final invoice in Xero'}
      width={540}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={go}>
            {busy ? 'Raising…' : 'Raise in Xero'}
          </button>
        </>
      }
    >
      <p className="text-[13px] text-ink-2 leading-relaxed mb-4">
        {kind === 'deposit'
          ? 'Issued now and due in '
          : 'Bills the job as it stands, less the deposit, under the client’s terms — due '}
        {kind === 'deposit' ? `${W.DEPOSIT_TERMS_DAYS} days` : due ? fmtDate(due) : 'on receipt'}. Once raised it
        cannot be edited here; a correction is a credit note in Xero.
      </p>
      <div className="well p-3 mb-4">
        {lines.map((l, i) => (
          <div key={i} className="flex items-baseline justify-between gap-3 py-1">
            <span className="text-[13px] text-ink-2">
              {l.label}
              <span className="block text-[11.5px] text-ink-3">{l.detail}</span>
            </span>
            <span className="text-[13px] tabular-nums">
              {l.value < 0 ? '−' : ''}
              {money(Math.abs(l.value))}
            </span>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-3 py-1 border-t border-surface-line mt-1.5 pt-2">
          <span className="text-[13px] text-ink-2">VAT {Math.round(W.VAT_RATE * 100)}%</span>
          <span className="text-[13px] tabular-nums">{money(vat)}</span>
        </div>
        <div className="flex items-baseline justify-between gap-3 pt-1.5">
          <span className="text-[13px] font-semibold text-ink">Total</span>
          <span className="text-[18px] font-bold tabular-nums text-ink">{money(round2(net + vat))}</span>
        </div>
      </div>
      <label className="flex items-start gap-2.5 cursor-pointer">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={email}
          disabled={!to}
          onChange={(e) => setEmail(e.target.checked)}
        />
        <span className="text-[13px] text-ink-2 leading-relaxed">
          {to ? (
            <>
              Email it from Xero to <strong className="text-ink">{to}</strong>
            </>
          ) : (
            <>No billing email on {cl?.name}&apos;s record — it will be raised without emailing.</>
          )}
        </span>
      </label>
      {XERO.isSimulated() ? (
        <div
          className="rounded-md px-3 py-2 mt-4 text-[12px] leading-relaxed"
          style={{ background: TONE_BG.info, color: TONE_HEX.info }}
        >
          Test mode: this goes to a stand-in for Xero, not your Xero organisation, and nothing is emailed.
        </div>
      ) : null}
    </Modal>
  );
}
