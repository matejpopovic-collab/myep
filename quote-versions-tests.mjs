/* ============================================================================
   EPROSTA — verification harness for the quote paper trail

   A quote is not one document but a sequence of them: priced, sent, argued
   about, repriced, sent again, signed. Keeping only the latest is why "that is
   not what you quoted us" has no answer except the current figure, which is
   the very thing in dispute. This proves the trail holds:

     1. EVERY CHANGE TO A LINE WRITES A VERSION — added, removed, repriced.
        A re-price that moves no money is not a change and writes nothing.

     2. A VERSION IS IMMUTABLE — later edits to the job do not reach back into
        the documents already written. This is the whole point.

     3. SENDING ISSUES ONE VERSION — the client's copy is a specific document,
        not "the quote", and a version prepared and superseded in the office is
        kept and never issued.

     4. THE CLIENT SEES ONLY WHAT THEY WERE SENT — including nothing at all
        before the first send.

     5. AN OBJECTION ATTACHES TO THE VERSION THEY WERE HOLDING — in their own
        words — and closes itself when they are issued something newer.

     6. VARIATIONS RUN THEIR OWN SEQUENCE — VAR-1, VAR-2 — do not disturb the
        signed quote's numbering, and reach the client only when somebody
        sends them. Pricing is not publishing after the signature either.

     7. A SIGNATURE IS A FACT ABOUT ONE DOCUMENT.

     8. EVERY JOB THAT PREDATES ALL THIS STILL HAS A TRAIL — backfilled from
        the lines as they stand, honestly labelled.

   Run:  node quote-versions-tests.mjs
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

const work = mkdtempSync(join(tmpdir(), 'eprosta-versions-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');

async function boot() {
  const entry = join(work, 'entry.ts');
  const out = join(work, 'bundle.mjs');
  writeFileSync(
    entry,
    `export * as W from '${p('src/lib/wof')}';\n` +
      `export * as DB from '${p('src/data/db')}';\n` +
      `export * as DOC from '${p('src/lib/quotedoc')}';\n` +
      `export * as PORTAL from '${p('src/lib/portal')}';\n`,
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

const { W, DB, DOC, PORTAL } = await boot();
const { CHARGES, CLIENTS } = DB;

const CLIENT = CLIENTS.find((c) => c.status === 'active');
const HOURLY = CHARGES.filter((c) => c.unit === 'hour')[0];

/** The jobs that were already here — the ones section 8 is about. */
const SEEDED = new Set(W.all().map((x) => x.id));

const GRACIE = { by: 'm-gracie', name: 'Gracie Mullen' };
const DAWN = { by: 'm-dawn', name: 'Dawn Cartwright' };
const THE_CLIENT = { by: 'client', name: 'Sharon Pike' };

function job(title, qty = 5) {
  const w = W.create({
    title,
    clientId: CLIENT.id,
    start: '2026-09-04T09:00:00',
    end: '2026-09-04T18:00:00',
    jobTypeId: 'festival',
  });
  W.addLine(w, HOURLY.id, { qty, units: 10, description: 'Event Steward', addedBy: GRACIE.by }, GRACIE);
  return w;
}

/* -- 1. every change to a line writes a version --------------------------- */
console.log('\n1. A change to a priced line writes a version');
{
  const w = job('Trail');
  eq('the first line wrote v1', W.quoteVersions(w).length, 1);
  eq('numbered from one', W.quoteVersions(w)[0].label, 'v1');
  ok('and says what changed', /Added Event Steward/.test(W.quoteVersions(w)[0].change), W.quoteVersions(w)[0].change);
  eq('with the value at the time', W.quoteVersions(w)[0].value, W.quoteValue(w));
  eq('and who did it', W.quoteVersions(w)[0].by, GRACIE.by);

  const extra = W.addLine(w, HOURLY.id, { qty: 2, units: 4, description: 'Supervisor', addedBy: GRACIE.by }, GRACIE);
  eq('a second line wrote v2', W.quoteVersions(w).length, 2);

  W.removeLine(w, extra.id, GRACIE);
  eq('removing it wrote v3', W.quoteVersions(w).length, 3);
  ok('named in the change', /Removed Supervisor/.test(W.quoteVersions(w)[2].change), W.quoteVersions(w)[2].change);

  // A re-price against the same rate card moves no money. Writing a document
  // for it would teach people that versions mean nothing.
  W.repriceLine(w, W.quoteLines(w)[0].id, GRACIE);
  eq('a re-price that changed nothing wrote nothing', W.quoteVersions(w).length, 3);
}

/* -- 2. a version is immutable -------------------------------------------- */
console.log('\n2. What a version says cannot be changed afterwards');
{
  const w = job('Frozen', 10);
  const v1 = W.quoteVersions(w)[0];
  const wasValue = v1.value;
  const wasQty = v1.lines[0].qty;

  W.addLine(w, HOURLY.id, { qty: 40, units: 10, description: 'Event Steward', addedBy: GRACIE.by }, GRACIE);
  const line = W.quoteLines(w)[0];
  line.qty = 999; // the live line moves under it

  eq('the old version keeps its figure', v1.value, wasValue);
  eq('and its quantities', v1.lines[0].qty, wasQty);
  ok('while the job has moved on', W.quoteValue(w) !== wasValue);
  eq('and the newest version is a different document', W.quoteVersions(w)[1].value !== wasValue, true);
}

/* -- 3. sending issues one version ---------------------------------------- */
console.log('\n3. Sending issues the version in hand, and only that one');
{
  const w = job('Issued', 10);
  eq('nothing is issued before the send', W.issuedVersions(w).length, 0);
  eq('and there is no current document with the client', W.latestIssued(w), null);

  W.sendQuote(w, GRACIE);
  eq('the send issued v1', W.issuedVersions(w).length, 1);
  eq('which is what they are holding', W.latestIssued(w).label, 'v1');
  ok('stamped when it went', !!W.quoteVersions(w)[0].issuedAt);

  // Amend, and the new document is not theirs until it is sent.
  W.addLine(w, HOURLY.id, { qty: 1, units: 2, description: 'Radio', addedBy: GRACIE.by }, GRACIE);
  eq('the amendment wrote v2', W.quoteVersions(w).length, 2);
  eq('but the client still holds v1', W.latestIssued(w).label, 'v1');
  eq('and v2 is unissued', W.quoteVersions(w)[1].issuedAt, null);

  W.sendQuote(w, GRACIE);
  eq('re-sending issues v2', W.latestIssued(w).label, 'v2');
  eq('and v1 keeps its own issue stamp', W.issuedVersions(w).length, 2);
}

/* -- 4. the client sees only what they were sent -------------------------- */
console.log('\n4. A version the client never received stays out of their copy');
{
  const w = job('Held back', 300); // over the approval threshold
  W.sendQuote(w, GRACIE); // blocked: needs approval
  eq('the big quote could not be sent', W.quoteSent(w), false);
  eq('so nothing is issued', W.issuedVersions(w).length, 0);

  W.approveQuote(w, '', DAWN);
  W.sendQuote(w, GRACIE);
  eq('once approved, v1 is issued', W.latestIssued(w).label, 'v1');
  ok('and carries the approval', !!W.latestIssued(w).approval, 'no approval stamp');
  eq('named on the document', W.latestIssued(w).approval.byName, DAWN.name);

  // A working edit, superseded before anyone sent it.
  const scrap = W.addLine(w, HOURLY.id, { qty: 5, units: 5, description: 'Mistake', addedBy: GRACIE.by }, GRACIE);
  W.removeLine(w, scrap.id, GRACIE);
  eq('two more versions exist', W.quoteVersions(w).length, 3);
  eq('but the client still holds v1', W.latestIssued(w).label, 'v1');

  W.sendQuote(w, GRACIE);
  eq('sending again issues v3', W.latestIssued(w).label, 'v3');

  const epCopy = DOC.quoteDocumentHtml(w, W.quoteVersions(w)[2], { audience: 'ep' });
  const clientCopy = DOC.quoteDocumentHtml(w, W.latestIssued(w), { audience: 'client' });
  ok('the EP copy shows the versions nobody sent', epCopy.includes('Not issued'), 'v2 missing from EP copy');
  eq('the client copy does not', clientCopy.includes('Not issued'), false);
  ok('and says why v2 is missing from their trail', clientCopy.includes('never sent'));

  // Cost and margin are EP Team's business. Checked as the actual figure
  // rather than the word, because the word appears in a stylesheet.
  const cost = W.lineCost(W.quoteLines(w)[0]);
  ok('the line cost is a real figure', cost > 0);
  eq('and it is nowhere on the client copy', clientCopy.includes(cost.toLocaleString('en-GB')), false);
}

/* -- 5. an objection attaches to the version they were holding ------------ */
console.log('\n5. The client objects, in their own words, to a specific version');
{
  const w = job('Queried', 10);
  eq('they cannot query what they have not been sent', W.queryQuote(w, 'Too much', THE_CLIENT), false);

  W.sendQuote(w, GRACIE);
  eq('an empty query is not a query', W.queryQuote(w, '   ', THE_CLIENT), false);
  eq('a real one lands', W.queryQuote(w, 'We asked for 8, not 10.', THE_CLIENT), true);

  const raised = W.openObjection(w);
  ok('it is open', !!raised);
  eq('against the version they hold', raised.version.label, 'v1');
  eq('in their words', raised.objection.note, 'We asked for 8, not 10.');
  eq('under their name', raised.objection.byName, THE_CLIENT.name);
  eq('and they cannot raise a second', W.queryQuote(w, 'Also the dates', THE_CLIENT), false);

  // Amending is not answering: the client is still holding the disputed one.
  W.addLine(w, HOURLY.id, { qty: 1, units: 1, description: 'Correction', addedBy: GRACIE.by }, GRACIE);
  ok('still open after an amendment', !!W.openObjection(w));

  W.sendQuote(w, GRACIE);
  eq('and closed once they have a newer version', W.openObjection(w), null);
  ok('while the objection stays on the document it was about', !!W.quoteVersions(w)[0].objection);
}

/* -- 6. variations run their own sequence, and are sent deliberately ------ */
console.log('\n6. Variations are numbered on their own and go out when EP Team sends them');
{
  const w = job('Signed then varied', 10);
  W.sendQuote(w, GRACIE);
  W.signQuote(w, { signedBy: 'Sharon Pike', signedByRole: 'Operations' }, THE_CLIENT);

  const quoteVersionsAtSigning = W.quoteVersions(w).length;
  const v = W.addLine(w, HOURLY.id, { qty: 4, units: 6, description: 'Extra steward', addedBy: GRACIE.by }, GRACIE);
  eq('the line is a variation', v.source, 'variation');
  eq('it wrote VAR-1', W.variationVersions(w)[0].label, 'VAR-1');
  eq('and left the quote sequence alone', W.quoteVersions(w).length, quoteVersionsAtSigning);

  // Pricing is not publishing here either.
  eq('nothing is issued by typing it', W.variationVersions(w)[0].issuedAt, null);
  eq('the client cannot see it', W.clientVariations(w).length, 0);
  eq('it is on EP Team\'s unsent list', W.unsentVariations(w).length, 1);
  eq('and is not counted as awaiting their approval', W.pendingVariations(w).length, 0);
  eq('the client cannot accept what they were never sent', W.acceptVariation(w, v.id, THE_CLIENT), false);
  // The warning belongs to the stage that turns work into money.
  ok(
    'and invoicing warns that nobody sent it',
    W.gate(w, 'invoice').warn.some((x) => /never been sent/.test(x)),
    W.gate(w, 'invoice').warn.join(' | '),
  );

  eq('sending it is allowed', W.variationSendBlock(w), null);
  eq('and reports success', W.sendVariations(w, GRACIE), true);
  eq('VAR-1 is now issued', !!W.variationVersions(w)[0].issuedAt, true);
  eq('the client can see it', W.clientVariations(w).length, 1);
  eq('it is awaiting their approval', W.pendingVariations(w).length, 1);
  eq('and there is nothing left to send', W.variationSendBlock(w) !== null, true);

  eq('now they can accept it', W.acceptVariation(w, v.id, THE_CLIENT), true);
  eq('which wrote VAR-2', W.variationVersions(w).length, 2);
  eq('recording what they did', W.variationVersions(w)[1].lines[0].clientApproval, 'accepted');
  ok('and naming it', /accepted/i.test(W.variationVersions(w)[1].change), W.variationVersions(w)[1].change);
  // Their own answer is a document they are entitled to hold.
  eq('their answer is issued on the spot', !!W.variationVersions(w)[1].issuedAt, true);

  // A second variation is held back on its own, and does not drag the first
  // one out of the client's hands.
  const later = W.addLine(w, HOURLY.id, { qty: 1, units: 2, description: 'Late request', addedBy: GRACIE.by }, GRACIE);
  eq('the new line wrote VAR-3', W.variationVersions(w).length, 3);
  eq('unissued', W.variationVersions(w)[2].issuedAt, null);
  eq('the client still sees only the first', W.clientVariations(w).length, 1);
  eq('and cannot answer the new one', W.acceptVariation(w, later.id, THE_CLIENT), false);

  // Nor may the money leak. EP Team's contract value counts the new line
  // because the job is worth that; the client's total must not, because
  // nobody has told them about it.
  ok('the job is worth more to EP Team', W.contractValue(w) > W.clientContractValue(w));
  eq(
    'and the client total is the quote plus what they hold',
    W.clientContractValue(w),
    Math.round((W.quoteValue(w) + W.clientVariationValue(w)) * 100) / 100,
  );
  eq('which excludes the unsent line', W.clientVariationValue(w) < W.variationValue(w), true);

  W.sendVariations(w, GRACIE);
  eq('sending again puts both with them', W.clientVariations(w).length, 2);
  eq('and clears the unsent list', W.unsentVariations(w).length, 0);
}

/* -- 7. a signature is a fact about one document -------------------------- */
console.log('\n7. The signature lands on the document that was signed');
{
  const w = job('Signature', 10);
  W.sendQuote(w, GRACIE);
  const signed = W.latestIssued(w);
  W.signQuote(w, { signedBy: 'Sharon Pike' }, THE_CLIENT);
  ok('the version they held is stamped', !!signed.signedAt);
  eq('and it is the same document', signed.label, 'v1');
}

/* -- 8. jobs that predate the trail --------------------------------------- */
console.log('\n8. Every existing job has a trail, honestly labelled');
{
  const withLines = W.all().filter((x) => SEEDED.has(x.id) && W.quoteLines(x).length);
  ok('there are seeded jobs to check', withLines.length > 0);
  eq(
    'every one of them has at least one version',
    withLines.every((x) => W.quoteVersions(x).length > 0),
    true,
  );
  ok(
    'the first version says what it is',
    withLines.every((x) => /version history began/.test(W.quoteVersions(x)[0].change)),
  );
  eq(
    'a job already with the client has it issued',
    withLines.filter((x) => x.quotedAt).every((x) => !!W.quoteVersions(x)[0].issuedAt),
    true,
  );
  eq(
    'and one never sent does not',
    withLines.filter((x) => !x.quotedAt).every((x) => !W.quoteVersions(x)[0].issuedAt),
    true,
  );

  // The portal is the guard the client actually meets.
  PORTAL.setActingClient(CLIENT.id);
  const unsent = W.all().find((x) => !x.quotedAt && W.quoteLines(x).length);
  if (unsent) eq('an unsent job is unreachable by its own id', PORTAL.clientJob(unsent.id), null);
}

console.log(failures ? `\n${failures} FAILED\n` : '\nAll paper-trail checks passed.\n');
process.exit(failures ? 1 : 0);
