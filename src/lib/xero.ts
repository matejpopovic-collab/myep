/* ============================================================================
   EPROSTA — Xero, the accounts package where invoices are raised and paid
   ----------------------------------------------------------------------------
   Two invoices per job, both raised IN Xero:

     stage 4  Order + deposit   the deposit invoice   (raiseDeposit)
     stage 8  Invoice           the final invoice     (raiseFinal) — the
                                contract plus variations, less the deposit

   The client pays on the invoice Xero sends them (its online invoice page,
   card or bank transfer), never inside this app. When Xero records the
   payment it tells the app, and the app stamps the document paid exactly as a
   manual payment always did — so the deposit still unlocks allocation and the
   final payment still closes the job.

   WHY A GATEWAY

   Xero's API is called with an OAuth token that must never sit in a browser,
   and this app currently has no server. So everything goes through the
   `XeroGateway` interface below, and there are two of them:

     · `SIMULATED` — the default. Behaves like Xero (numbers, statuses, an
       online invoice the client can "pay") and keeps its state in this
       browser. It is what the screens and the tests run against.
     · a live gateway — a few lines that POST the same requests to a small
       server, which holds the Xero token, calls Xero, and forwards Xero's
       invoice webhooks back. The server contract is in WIRING.md. Install it
       with `useGateway()`; nothing else in the app changes.

   The store's half (what may be raised, what changes when Xero answers) is in
   `lib/wof.ts` — `raiseDepositInvoice`, `xeroRaiseBlock`, `attachXero`,
   `xeroPaymentReceived`. This file is only the conversation with Xero.
   ========================================================================== */

import { client as clientById } from '@/data/db';
import * as W from './wof';
import { round2 } from './format';

/* --------------------------------------------------------------- contract */

export interface XeroInvoiceRequest {
  /** The app's own document number, kept as Xero's InvoiceNumber. */
  number: string;
  /** Printed on the invoice: `WOF-2026-0128 · DEP-26-0003`. */
  reference: string;
  contactName: string;
  /** Null raises it without emailing — the operator sends it themselves. */
  emailTo: string | null;
  lines: { description: string; amount: number }[];
  vatRate: number;
  /** ISO date. */
  dueAt: string | null;
}

export interface XeroInvoiceResult {
  invoiceId: string;
  url: string;
  status: W.XeroStatus;
}

export interface XeroInvoiceState {
  status: W.XeroStatus;
  payment: W.XeroPayment | null;
}

export interface XeroGateway {
  /** `simulated` is the in-browser stand-in; screens say so. */
  mode: 'simulated' | 'live';
  /** Which Xero organisation invoices go to, as the screens name it. */
  organisation: string;
  createInvoice(req: XeroInvoiceRequest): Promise<XeroInvoiceResult>;
  getInvoice(invoiceId: string): Promise<XeroInvoiceState | null>;
}

/* ---------------------------------------------------- the simulated Xero */

const SIM_KEY = 'eprosta.xero.sim.v1';

interface SimInvoice {
  invoiceId: string;
  number: string;
  reference: string;
  contactName: string;
  total: number;
  dueAt: string | null;
  status: W.XeroStatus;
  payment: W.XeroPayment | null;
}

let simMemory: Record<string, SimInvoice> | null = null;

function simLoad(): Record<string, SimInvoice> {
  if (simMemory) return simMemory;
  try {
    simMemory = JSON.parse(localStorage.getItem(SIM_KEY) || '{}') as Record<string, SimInvoice>;
  } catch {
    simMemory = {};
  }
  return simMemory!;
}

function simSave(): void {
  try {
    localStorage.setItem(SIM_KEY, JSON.stringify(simMemory || {}));
  } catch {
    /* private window or storage off: the stand-in simply forgets on reload */
  }
}

/** A Xero-shaped id. Random enough not to collide inside one browser. */
function uuid(): string {
  const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${h()}${h()}-${h()}-4${h().slice(1)}-a${h().slice(1)}-${h()}${h()}${h()}`;
}

export const SIM_URL_PREFIX = 'xero-sim:';

export const SIMULATED: XeroGateway = {
  mode: 'simulated',
  organisation: 'EP Team Ltd (test mode)',
  async createInvoice(req) {
    const net = round2(req.lines.reduce((s, l) => s + l.amount, 0));
    const inv: SimInvoice = {
      invoiceId: uuid(),
      number: req.number,
      reference: req.reference,
      contactName: req.contactName,
      total: round2(net * (1 + req.vatRate)),
      dueAt: req.dueAt,
      status: 'AUTHORISED',
      payment: null,
    };
    simLoad()[inv.invoiceId] = inv;
    simSave();
    return { invoiceId: inv.invoiceId, url: `${SIM_URL_PREFIX}${inv.invoiceId}`, status: inv.status };
  },
  async getInvoice(invoiceId) {
    const inv = simLoad()[invoiceId];
    return inv ? { status: inv.status, payment: inv.payment } : null;
  },
};

/** The stand-in's own record of an invoice — what its online page shows. */
export function simInvoice(invoiceId: string): SimInvoice | null {
  return simLoad()[invoiceId] || null;
}

/**
 * The client pays on the stand-in's online invoice.
 *
 * In live Xero this happens on Xero's page and reaches the app as a webhook;
 * here the "webhook" is a direct call, so the job updates the moment the
 * client presses Pay — which is what the live version will look like to them.
 */
export function simPay(invoiceId: string, method: string): W.XeroPayment | null {
  const inv = simLoad()[invoiceId];
  if (!inv || inv.status !== 'AUTHORISED') return null;
  inv.status = 'PAID';
  inv.payment = {
    paidAt: new Date().toISOString(),
    ref: `${method} · ${inv.number}`,
    amount: inv.total,
  };
  simSave();
  deliverWebhook(invoiceId, inv.payment);
  return inv.payment;
}

/* ------------------------------------------------------------- the switch */

let gateway: XeroGateway = SIMULATED;

/** Install the live gateway once a server exists. See WIRING.md. */
export function useGateway(g: XeroGateway): void {
  gateway = g;
}

export const current = (): XeroGateway => gateway;
export const isSimulated = (): boolean => gateway.mode === 'simulated';

/** True when the url is the stand-in's page rather than Xero's own. */
export const isSimUrl = (url: string): boolean => url.startsWith(SIM_URL_PREFIX);
export const simIdFromUrl = (url: string): string => url.slice(SIM_URL_PREFIX.length);

/* ---------------------------------------------------------------- actions */

export interface RaiseResult {
  ok: boolean;
  /** Why not, in a sentence the toast can show. */
  reason?: string;
  doc?: W.BillingDoc;
}

function requestFor(w: W.Wof, d: W.BillingDoc, email: boolean): XeroInvoiceRequest {
  const cl = clientById(w.clientId);
  return {
    number: d.number,
    reference: W.billingRef(w, d),
    contactName: cl?.name || 'Client',
    emailTo: email ? cl?.billingEmail || cl?.email || null : null,
    lines: d.lines.map((l) => ({ description: `${l.label} — ${l.detail}`, amount: l.value })),
    vatRate: d.vatRate,
    dueAt: d.dueAt,
  };
}

async function raise(w: W.Wof, kind: W.BillingKind, email: boolean, actor: W.Actor): Promise<RaiseResult> {
  const block = W.xeroRaiseBlock(w, kind);
  if (block) return { ok: false, reason: block };
  const doc = kind === 'deposit' ? W.raiseDepositInvoice(w, actor) : W.billingDoc(w, 'invoice');
  if (!doc) return { ok: false, reason: 'There is no document to raise.' };
  const req = requestFor(w, doc, email);
  try {
    const res = await gateway.createInvoice(req);
    const now = new Date().toISOString();
    W.attachXero(
      w,
      kind,
      {
        invoiceId: res.invoiceId,
        url: res.url,
        status: res.status,
        raisedAt: now,
        raisedByName: actor.name,
        emailedTo: req.emailTo,
        syncedAt: now,
        simulated: gateway.mode === 'simulated' || undefined,
      },
      actor,
    );
    return { ok: true, doc };
  } catch (e) {
    return { ok: false, reason: `Xero did not accept it: ${(e as Error).message || 'no reply'}.` };
  }
}

/** Stage 4: write the deposit invoice and raise it in Xero. */
export const raiseDeposit = (w: W.Wof, opts: { email: boolean }, actor: W.Actor = W.OPERATOR) =>
  raise(w, 'deposit', opts.email, actor);

/** Stage 8: raise the final invoice the Invoice stage already wrote. */
export const raiseFinal = (w: W.Wof, opts: { email: boolean }, actor: W.Actor = W.OPERATOR) =>
  raise(w, 'invoice', opts.email, actor);

/**
 * Ask Xero where this job's invoices stand and apply any payment.
 *
 * The live server pushes payments as they happen; this is the pull for when a
 * webhook was missed, and what the "Check Xero" button does.
 */
export async function sync(w: W.Wof): Promise<number> {
  let applied = 0;
  for (const d of W.billingDocs(w)) {
    if (!d.xero || d.paidAt) continue;
    const st = await gateway.getInvoice(d.xero.invoiceId);
    if (!st) continue;
    d.xero.syncedAt = new Date().toISOString();
    if (st.status === 'PAID' && st.payment) {
      if (W.xeroPaymentReceived(w, d.kind, st.payment)) applied += 1;
    } else {
      d.xero.status = st.status;
      W.save();
    }
  }
  return applied;
}

/**
 * Xero's invoice webhook, as the app receives it: an invoice id and a payment.
 * The live server calls this (through whatever channel it uses to reach the
 * app); the stand-in calls it from `simPay`.
 */
export function deliverWebhook(invoiceId: string, payment: W.XeroPayment): boolean {
  for (const w of W.all()) {
    const d = W.billingDocs(w).find((x) => x.xero?.invoiceId === invoiceId);
    if (d) return W.xeroPaymentReceived(w, d.kind, payment);
  }
  return false;
}
