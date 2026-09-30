/* ============================================================================
   EPROSTA — verification harness for the deposit and final invoice documents

   The deposit and the balance are two payments months apart, so they are two
   documents: a deposit invoice when the deposit lands, and a final invoice
   that bills the contract LESS that deposit, by number. What this proves:

     1. RECORDING THE DEPOSIT WRITES ONE DEPOSIT INVOICE — numbered, issued
        paid, VAT on the deposit. Recording it again writes no second one.
     2. INVOICING WRITES ONE FINAL INVOICE — quote plus variations, less the
        deposit named by its document number.
     3. BOTH ARE FROZEN — a variation priced after invoicing does not reach
        back into the invoice already issued.
     4. PAYMENT IS STAMPED ON THE DOCUMENT IT SETTLES — no new document.
     5. THE PAGE SAYS SO — number, deduction, paid mark.
     6. SEEDED JOBS whose money already moved get their documents; the rest
        get none. Numbers survive a reload.

   Run:  node billing-tests.mjs
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

const work = mkdtempSync(join(tmpdir(), 'eprosta-billing-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');

async function boot() {
  const entry = join(work, 'entry.ts');
  const out = join(work, 'bundle.mjs');
  writeFileSync(
    entry,
    `export * as W from '${p('src/lib/wof')}';\n` +
      `export * as DB from '${p('src/data/db')}';\n` +
      `export * as DOC from '${p('src/lib/quotedoc')}';\n`,
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

const { W, DB, DOC } = await boot();
const { CHARGES, CLIENTS } = DB;
const SEEDED = new Set(W.all().map((x) => x.id));

const CLIENT = CLIENTS.find((c) => c.status === 'active');
const HOURLY = CHARGES.filter((c) => c.unit === 'hour' && c.kind === 'staff')[0];
const OPS = { by: 'm-jake', name: 'Jake Wright' };
const THE_CLIENT = { by: 'client', name: 'Sharon Pike' };

function job(title) {
  const w = W.create({
    title,
    clientId: CLIENT.id,
    start: '2026-09-04T09:00:00',
    end: '2026-09-04T18:00:00',
    jobTypeId: 'festival',
  });
  W.addLine(w, HOURLY.id, { qty: 6, units: 10, description: 'Event Steward' }, OPS);
  W.sendQuote(w, OPS);
  W.signQuote(w, { signedBy: THE_CLIENT.name }, THE_CLIENT);
  w.deposit = { ...(w.deposit || {}), pct: 25, amount: null, receivedAt: null, ref: null };
  return w;
}

console.log('\n1. Recording the deposit writes one deposit invoice, issued paid');
const w = job('Billing');
{
  eq('nothing before the money lands', W.billingDocs(w).length, 0);
  W.recordDeposit(w, { ref: 'BACS 100200' }, OPS);
  const d = W.billingDoc(w, 'deposit');
  ok('a deposit invoice exists', !!d);
  ok('with its own number', /^DEP-26-\d{4}$/.test(d.number), d.number);
  eq('for 25% of the quote', d.net, r2(W.quoteValue(w) * 0.25));
  eq('VAT on the deposit', W.billingVat(d), r2(d.net * 0.2));
  ok('issued paid', !!d.paidAt);
  eq('with the bank reference', d.paidRef, 'BACS 100200');
  ok('against the signed version', / v1$/.test(d.against), d.against);
  ok('named in the history', W.all().find((x) => x.id === w.id).history.some((h) => h.note.includes(d.number)));

  W.recordDeposit(w, { ref: 'BACS 100201' }, OPS);
  eq('recording it again writes no second one', W.billingDocs(w).filter((x) => x.kind === 'deposit').length, 1);
  eq('the number did not move', W.billingDoc(w, 'deposit').number, d.number);
}

console.log('\n2. Invoicing writes one final invoice, less the deposit by number');
{
  const res = W.advance(w, { to: 'invoice', force: true }, OPS);
  ok('moved to invoice', res.ok);
  const inv = W.billingDoc(w, 'invoice');
  ok('an invoice document exists', !!inv);
  eq('carrying the invoice number', inv.number, w.invoice.number);
  const dep = W.billingDoc(w, 'deposit');
  const less = inv.lines.find((l) => l.value < 0);
  ok('the deposit is deducted', !!less);
  ok('by its document number', less.detail.includes(dep.number), less.detail);
  eq('net is contract less deposit', inv.net, r2(W.contractValue(w) - W.deposit(w).due));
  eq('matches the cash flow balance row', inv.net, W.cashflow(w).rows.find((r) => r.kind === 'balance').amount);
  eq('unpaid', inv.paidAt, null);
  eq('due when the invoice is due', inv.dueAt, w.invoice.dueAt);
}

console.log('\n3. Both documents are frozen');
{
  const inv = W.billingDoc(w, 'invoice');
  const before = inv.net;
  W.addLine(w, HOURLY.id, { qty: 2, units: 5, description: 'Late steward', source: 'variation' }, OPS);
  eq('a later line does not reach back into the invoice', W.billingDoc(w, 'invoice').net, before);
  W.advance(w, { to: 'invoice', force: true }, OPS);
  eq('and invoicing again writes no second invoice', W.billingDocs(w).filter((x) => x.kind === 'invoice').length, 1);
}

console.log('\n4. Payment is stamped on the document it settles');
{
  W.markInvoicePaid(w, THE_CLIENT);
  const inv = W.billingDoc(w, 'invoice');
  ok('the invoice is paid', !!inv.paidAt);
  eq('on the same date as the job record', inv.paidAt, w.invoice.paidAt);
  eq('by whoever recorded it', inv.paidByName, THE_CLIENT.name);
  eq('still two documents', W.billingDocs(w).length, 2);
}

console.log('\n5. The page says what it is');
{
  const dep = W.billingDoc(w, 'deposit');
  const inv = W.billingDoc(w, 'invoice');
  const dh = DOC.billingDocumentHtml(w, dep);
  ok('deposit page is titled as one', /Deposit invoice/.test(dh));
  ok('carries its number', dh.includes(dep.number));
  ok('and says it is paid', /Paid in full/.test(dh));
  const ih = DOC.billingDocumentHtml(w, inv);
  ok('invoice page carries its number', ih.includes(inv.number));
  ok('names the deposit it deducts', ih.includes(dep.number));
  ok('and the paid mark', /paidmark/.test(ih));
}

console.log('\n6. Seeded jobs, and a reload');
{
  const seeded = W.all().filter((x) => SEEDED.has(x.id));
  const paidDeposit = seeded.filter(
    (x) => x.deposit && x.deposit.receivedAt && (x.deposit.amount ?? W.deposit(x).due) > 0,
  );
  ok('there are seeded deposits', paidDeposit.length > 0);
  eq('each has a deposit invoice', paidDeposit.every((x) => !!W.billingDoc(x, 'deposit')), true);
  eq('marked backfilled', paidDeposit.every((x) => W.billingDoc(x, 'deposit').backfilled), true);
  eq(
    'no deposit, no deposit invoice',
    seeded.filter((x) => !(x.deposit && x.deposit.receivedAt)).every((x) => !W.billingDoc(x, 'deposit')),
    true,
  );
  const invoiced = seeded.filter((x) => x.invoice);
  ok('there are seeded invoices', invoiced.length > 0);
  eq('each has an invoice document', invoiced.every((x) => !!W.billingDoc(x, 'invoice')), true);
  eq(
    'paid ones read paid',
    invoiced.every((x) => !!W.billingDoc(x, 'invoice').paidAt === !!x.invoice.paidAt),
    true,
  );
  const nums = W.all().flatMap((x) => W.billingDocs(x).map((d) => d.number));
  eq('no number is used twice', new Set(nums).size, nums.length);

  const target = paidDeposit[0];
  const num = W.billingDoc(target, 'deposit').number;
  W.save();
  W.load();
  const again = W.all().find((x) => x.id === target.id);
  eq('a reload keeps the deposit number', W.billingDoc(again, 'deposit').number, num);
  const mine = W.all().find((x) => x.id === w.id);
  eq('and a job raised here keeps both documents', W.billingDocs(mine).length, 2);
}

console.log(failures ? `\n${failures} FAILED\n` : '\nAll billing-document checks passed.\n');
process.exit(failures ? 1 : 0);
