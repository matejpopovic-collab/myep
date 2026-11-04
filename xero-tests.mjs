/* ============================================================================
   EPROSTA — verification harness for invoicing through Xero

   Stage 4 raises the deposit invoice in Xero; the Invoice stage raises the
   final one. The client pays on the invoice Xero sends them, and Xero's
   "paid" comes back and is stamped on the document. What this proves:

     1. THE DEPOSIT CANNOT BE RAISED BEFORE SIGNING — there is no agreed figure.
     2. RAISING THE DEPOSIT writes one deposit invoice, UNPAID, due in 14 days,
        and links it to Xero. Raising again is refused, not duplicated.
     3. XERO'S PAYMENT is stamped on that same document — no second deposit
        invoice — records the deposit net of VAT, and opens allocation.
        A repeated webhook changes nothing.
     4. THE FINAL INVOICE is raised once the job is at Invoice, deducts the
        deposit by number, and Xero's payment closes the job.
     5. A PULL ("Check Xero") applies a payment the push missed.
     6. THE CLIENT'S TASK points at the invoice once it exists.

   Run:  node xero-tests.mjs
   ========================================================================== */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const work = mkdtempSync(join(tmpdir(), 'eprosta-xero-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');

async function boot() {
  const entry = join(work, 'entry.ts');
  const out = join(work, 'bundle.mjs');
  writeFileSync(
    entry,
    `export * as W from '${p('src/lib/wof')}';\n` +
      `export * as X from '${p('src/lib/xero')}';\n` +
      `export * as DB from '${p('src/data/db')}';\n`,
  );
  try {
    execFileSync(
      'npx',
      ['--yes', 'esbuild', entry, '--bundle', '--format=esm', `--outfile=${out}`,
        `--alias:@=${join(ROOT, 'src')}`, '--log-level=error'],
      { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] },
    );
  } catch {
    console.error('\nCould not bundle. esbuild is fetched via npx and needs network on first run.\n');
    process.exit(2);
  }
  return import(pathToFileURL(out).href);
}

let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const eq = (name, got, want) =>
  ok(name, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const r2 = (n) => Math.round(n * 100) / 100;

const { W, X, DB } = await boot();
const { CHARGES, CLIENTS } = DB;

const CLIENT = CLIENTS.find((c) => c.status === 'active');
const HOURLY = CHARGES.filter((c) => c.unit === 'hour' && c.kind === 'staff')[0];
const OPS = { by: 'm-jake', name: 'Jake Wright' };
const THE_CLIENT = { by: 'client', name: 'Sharon Pike' };

function job(title, sign = true) {
  const w = W.create({
    title,
    clientId: CLIENT.id,
    start: '2026-09-04T09:00:00',
    end: '2026-09-04T18:00:00',
    jobTypeId: 'festival',
  });
  W.addLine(w, HOURLY.id, { qty: 6, units: 10, description: 'Event Steward' }, OPS);
  W.sendQuote(w, OPS);
  w.deposit = { ...(w.deposit || {}), pct: 30, amount: null, receivedAt: null, ref: null };
  if (sign) W.signQuote(w, { signedBy: THE_CLIENT.name }, THE_CLIENT);
  return w;
}

console.log('\n1. No deposit invoice before the quote is signed');
{
  const u = job('Unsigned', false);
  ok('the raise is blocked', !!W.xeroRaiseBlock(u, 'deposit'));
  const res = await X.raiseDeposit(u, { email: true }, OPS);
  ok('and refused', !res.ok);
  eq('nothing written', W.billingDocs(u).length, 0);
}

console.log('\n2. Raising the deposit writes one unpaid invoice, linked to Xero');
const w = job('Xero billing');
{
  ok('the raise is allowed once signed', W.xeroRaiseBlock(w, 'deposit') === null, W.xeroRaiseBlock(w, 'deposit'));
  const res = await X.raiseDeposit(w, { email: true }, OPS);
  ok('raised', res.ok, res.reason);
  const d = W.billingDoc(w, 'deposit');
  ok('a numbered deposit invoice', /^DEP-26-\d{4}$/.test(d.number), d.number);
  eq('for 30% of the quote', d.net, r2(W.quoteValue(w) * 0.3));
  eq('unpaid', d.paidAt, null);
  ok('with a due date', !!d.dueAt);
  ok('linked to Xero', !!d.xero && !!d.xero.invoiceId);
  eq('Xero says awaiting payment', d.xero.status, 'AUTHORISED');
  ok('emailed to the client', d.xero.emailedTo === (CLIENT.billingEmail || CLIENT.email), d.xero.emailedTo);
  eq('the deposit is not yet received', W.deposit(w).receivedAt, null);
  ok('allocation still waits on it', !W.depositCleared(w));
  eq('status reads awaiting payment', W.billingStatus(d).label, 'Awaiting payment');
  ok('history names it', w.history.some((h) => h.note.includes(`${d.number} raised in Xero`)));

  const again = await X.raiseDeposit(w, { email: true }, OPS);
  ok('raising again is refused', !again.ok);
  eq('still one deposit invoice', W.billingDocs(w).filter((x) => x.kind === 'deposit').length, 1);
}

console.log('\n3. Xero reports it paid — stamped on the same document');
{
  const d = W.billingDoc(w, 'deposit');
  const sim = X.simInvoice(d.xero.invoiceId);
  eq('Xero holds the gross', sim.total, W.billingGross(d));
  const pmt = X.simPay(d.xero.invoiceId, 'Card');
  ok('the client paid on the invoice', !!pmt);
  const after = W.billingDoc(w, 'deposit');
  eq('still one deposit invoice', W.billingDocs(w).filter((x) => x.kind === 'deposit').length, 1);
  eq('the same number', after.number, d.number);
  ok('stamped paid', !!after.paidAt);
  eq('with Xero’s reference', after.paidRef, pmt.ref);
  eq('Xero status is paid', after.xero.status, 'PAID');
  eq('deposit recorded net of VAT', W.deposit(w).received, d.net);
  ok('allocation can open', W.depositCleared(w));
  ok('history credits Xero', w.history.some((h) => h.byName === 'Xero' && h.note.includes(d.number)));
  const n = w.history.length;
  ok('a repeated webhook is ignored', X.deliverWebhook(d.xero.invoiceId, pmt) === false);
  eq('and writes no history', w.history.length, n);
}

console.log('\n4. The final invoice deducts the deposit and Xero’s payment closes the job');
{
  ok('blocked before the Invoice stage', !!W.xeroRaiseBlock(w, 'invoice'));
  W.advance(w, { to: 'invoice', force: true }, OPS);
  ok('allowed at Invoice', W.xeroRaiseBlock(w, 'invoice') === null, W.xeroRaiseBlock(w, 'invoice'));
  const res = await X.raiseFinal(w, { email: false }, OPS);
  ok('raised', res.ok, res.reason);
  const inv = W.billingDoc(w, 'invoice');
  const dep = W.billingDoc(w, 'deposit');
  ok('linked to Xero', !!inv.xero);
  eq('not emailed when asked not to', inv.xero.emailedTo, null);
  ok('deducts the deposit by number', inv.lines.some((l) => l.value < 0 && l.detail.includes(dep.number)));
  eq('net is contract less deposit', inv.net, r2(W.contractValue(w) - W.deposit(w).due));
  X.simPay(inv.xero.invoiceId, 'Bank transfer');
  ok('stamped paid', !!W.billingDoc(w, 'invoice').paidAt);
  ok('the invoice is settled', !!w.invoice.paidAt);
  eq('and the job is closed', w.stage, 'complete');
}

console.log('\n5. "Check Xero" applies a payment the webhook missed');
{
  const v = job('Missed webhook');
  await X.raiseDeposit(v, { email: true }, OPS);
  const d = W.billingDoc(v, 'deposit');
  // Paid in Xero, but the push never arrived.
  const sim = X.simInvoice(d.xero.invoiceId);
  sim.status = 'PAID';
  sim.payment = { paidAt: new Date().toISOString(), ref: 'BACS 77', amount: sim.total };
  eq('the job does not know yet', W.billingDoc(v, 'deposit').paidAt, null);
  const n = await X.sync(v);
  eq('one payment applied', n, 1);
  ok('now paid', !!W.billingDoc(v, 'deposit').paidAt);
  eq('a second check finds nothing new', await X.sync(v), 0);
}

console.log('\n6. The client’s task points at the invoice once it exists');
{
  const c = job('Client view');
  const before = W.clientTasks(c).find((t) => t.id === 'deposit');
  ok('a deposit task before it is raised', !!before);
  ok('saying it is on its way', /on its way/.test(before.detail), before.detail);
  await X.raiseDeposit(c, { email: true }, OPS);
  const d = W.billingDoc(c, 'deposit');
  const after = W.clientTasks(c).find((t) => t.id === 'deposit');
  ok('names the invoice once raised', after.detail.includes(d.number), after.detail);
  X.simPay(d.xero.invoiceId, 'Card');
  ok('and is gone once paid', !W.clientTasks(c).some((t) => t.id === 'deposit'));
}

console.log(failures ? `\n${failures} check(s) failed.\n` : '\nAll Xero invoicing checks passed.\n');
process.exit(failures ? 1 : 0);
