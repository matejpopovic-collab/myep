/* ============================================================================
   EPROSTA — verification harness for the quote paper trail

   A quote is not one document but a sequence of them: sent, argued about,
   amended, sent again, signed. Keeping only the latest is why "that is not
   what you quoted us" has no answer except the current figure, which is the
   very thing in dispute.

   The rule this file exists to hold: A VERSION IS A DOCUMENT THAT WAS SENT.
   Nothing else writes one. Amending a line in the office is not publishing,
   and a trail of fifteen versions of which the client has seen two is not a
   record anybody can read. What it proves:

     1. AMENDING A LINE WRITES NO VERSION — it writes a note on the unsent
        list, named, with the money on it. A re-price that moves nothing is
        not a change and writes nothing at all.

     2. SENDING WRITES ONE — carrying every amendment made since the last
        document, and clearing the list. Sending again with nothing changed
        writes nothing: the client already holds that piece of paper.

     3. A VERSION IS IMMUTABLE — later edits to the job do not reach back into
        the documents already sent. This is the whole point.

     4. THE CLIENT SEES EVERY VERSION THERE IS — because every one of them was
        sent to them. A quote held for approval has no document at all.

     5. AN OBJECTION ATTACHES TO THE VERSION THEY WERE HOLDING — in their own
        words — and closes itself when they are sent something newer.

     6. VARIATIONS RUN THEIR OWN SEQUENCE — VAR-1, VAR-2 — do not disturb the
        signed quote's numbering, and reach the client only when somebody
        sends them. The client's answer is stamped on the document they
        answered rather than writing a new one: they sent nothing.

     7. A SIGNATURE IS A FACT ABOUT ONE DOCUMENT.

     8. A JOB THAT PREDATES ALL THIS HAS A TRAIL IF IT REACHED THE CLIENT, AND
        NO TRAIL IF IT DID NOT.

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

/* -- 1. amending a line writes a note, not a document --------------------- */
console.log('\n1. A change to a priced line writes a note, and nothing the client can see');
{
  const w = job('Trail');
  eq('pricing it wrote no version', W.quoteVersions(w).length, 0);
  eq('but the change is on the unsent list', W.pendingChanges(w).length, 1);
  ok('and says what it was', /Added Event Steward/.test(W.pendingChanges(w)[0].text), W.pendingChanges(w)[0].text);
  eq('under the name of whoever did it', W.pendingChanges(w)[0].by, GRACIE.by);
  eq('the job knows it has unsent work', W.hasUnsentChanges(w), true);

  const extra = W.addLine(w, HOURLY.id, { qty: 2, units: 4, description: 'Supervisor', addedBy: GRACIE.by }, GRACIE);
  W.removeLine(w, extra.id, GRACIE);
  eq('a line added and taken away again is two notes', W.pendingChanges(w).length, 3);
  eq('and still no document', W.quoteVersions(w).length, 0);
  ok('the removal is named too', /Removed Supervisor/.test(W.pendingChanges(w)[2].text), W.pendingChanges(w)[2].text);

  // A re-price against the same rate card moves no money. Noting it would
  // put a line on the next document that says nothing happened.
  W.repriceLine(w, W.quoteLines(w)[0].id, GRACIE);
  eq('a re-price that changed nothing wrote nothing', W.pendingChanges(w).length, 3);

  // The history is where the office work is recorded. It always was.
  ok(
    'every one of them is in the job history regardless',
    w.history.filter((h) => /Quote line added|Line removed/.test(h.note)).length >= 3,
  );
}

/* -- 2. sending writes the version --------------------------------------- */
console.log('\n2. Sending writes one document, carrying everything since the last');
{
  const w = job('Sent', 10);
  W.addLine(w, HOURLY.id, { qty: 1, units: 2, description: 'Radio', addedBy: GRACIE.by }, GRACIE);
  eq('two amendments are waiting', W.pendingChanges(w).length, 2);

  W.sendQuote(w, GRACIE);
  eq('the send wrote v1', W.quoteVersions(w).length, 1);
  eq('numbered from one', W.quoteVersions(w)[0].label, 'v1');
  eq('issued by definition', !!W.quoteVersions(w)[0].issuedAt, true);
  eq('it is what the client holds', W.latestIssued(w).label, 'v1');
  eq('it carries both amendments', W.quoteVersions(w)[0].changes.length, 2);
  ok('and leads with the count', /2 changes/.test(W.quoteVersions(w)[0].change), W.quoteVersions(w)[0].change);
  eq('with the value at the time', W.quoteVersions(w)[0].value, W.quoteValue(w));
  eq('the unsent list is cleared', W.pendingChanges(w).length, 0);
  eq('and nothing is outstanding', W.hasUnsentChanges(w), false);

  // Sending again with nothing changed is not a second document.
  W.sendQuote(w, GRACIE);
  eq('an unchanged re-send wrote nothing', W.quoteVersions(w).length, 1);
  ok(
    'and says so in the history',
    w.history.some((h) => /re-sent to the client unchanged/i.test(h.note)),
    w.history.map((h) => h.note).join(' | '),
  );

  // One amendment, sent: the document leads with the amendment itself.
  W.addLine(w, HOURLY.id, { qty: 1, units: 3, description: 'Marshal', addedBy: GRACIE.by }, GRACIE);
  eq('the amendment is unsent', W.pendingChanges(w).length, 1);
  eq('and the client still holds v1', W.latestIssued(w).label, 'v1');
  W.sendQuote(w, GRACIE);
  eq('sending wrote v2', W.latestIssued(w).label, 'v2');
  eq('carrying the one change', W.quoteVersions(w)[1].changes.length, 1);
  eq('named as itself', W.quoteVersions(w)[1].change, W.quoteVersions(w)[1].changes[0].text);
}

/* -- 3. a version is immutable -------------------------------------------- */
console.log('\n3. What a version says cannot be changed afterwards');
{
  const w = job('Frozen', 10);
  W.sendQuote(w, GRACIE);
  const v1 = W.quoteVersions(w)[0];
  const wasValue = v1.value;
  const wasQty = v1.lines[0].qty;

  W.addLine(w, HOURLY.id, { qty: 40, units: 10, description: 'Event Steward', addedBy: GRACIE.by }, GRACIE);
  const line = W.quoteLines(w)[0];
  line.qty = 999; // the live line moves under it

  eq('the document keeps its figure', v1.value, wasValue);
  eq('and its quantities', v1.lines[0].qty, wasQty);
  ok('while the job has moved on', W.quoteValue(w) !== wasValue);
  ok('which the screen can see', W.hasUnsentChanges(w));
}

/* -- 4. the trail is the client's trail ----------------------------------- */
console.log('\n4. Every version there is, is one the client was given');
{
  const w = job('Held back', 300); // over the approval threshold
  W.sendQuote(w, GRACIE); // blocked: needs approval
  eq('the big quote could not be sent', W.quoteSent(w), false);
  eq('so no document exists at all', W.quoteVersions(w).length, 0);

  W.approveQuote(w, '', DAWN);
  eq('approving it writes no document either', W.quoteVersions(w).length, 0);

  W.sendQuote(w, GRACIE);
  eq('sending it does', W.latestIssued(w).label, 'v1');
  ok('and it carries the approval', !!W.latestIssued(w).approval, 'no approval stamp');
  eq('named on the document', W.latestIssued(w).approval.byName, DAWN.name);

  // A working edit, superseded before anyone sent it.
  const scrap = W.addLine(w, HOURLY.id, { qty: 5, units: 5, description: 'Mistake', addedBy: GRACIE.by }, GRACIE);
  W.removeLine(w, scrap.id, GRACIE);
  eq('the mistake left no document behind', W.quoteVersions(w).length, 1);
  eq('the client still holds v1', W.latestIssued(w).label, 'v1');
  eq('and the money is back where it was', W.hasUnsentChanges(w), true);

  W.sendQuote(w, GRACIE);
  eq('sending again writes v2', W.latestIssued(w).label, 'v2');
  eq('which admits both edits', W.quoteVersions(w)[1].changes.length, 2);

  const epCopy = DOC.quoteDocumentHtml(w, W.latestIssued(w), { audience: 'ep' });
  const clientCopy = DOC.quoteDocumentHtml(w, W.latestIssued(w), { audience: 'client' });
  eq('neither copy has a version to hide', clientCopy.includes('Not issued'), false);
  eq('nor does the EP copy', epCopy.includes('Not issued'), false);
  ok('and the client copy names both versions', clientCopy.includes('v1') && clientCopy.includes('v2'));

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
  eq('their query wrote no version', W.quoteVersions(w).length, 1);

  // Amending is not answering: the client is still holding the disputed one.
  W.addLine(w, HOURLY.id, { qty: 1, units: 1, description: 'Correction', addedBy: GRACIE.by }, GRACIE);
  ok('still open after an amendment', !!W.openObjection(w));

  W.sendQuote(w, GRACIE);
  eq('and closed once they have been sent a newer one', W.openObjection(w), null);
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
  eq('typing it wrote no schedule', W.variationVersions(w).length, 0);
  eq('it is a note on the variation list', W.pendingChanges(w, 'variation').length, 1);
  eq('and left the quote sequence alone', W.quoteVersions(w).length, quoteVersionsAtSigning);
  eq('the quote has nothing unsent', W.hasUnsentChanges(w, 'quote'), false);

  eq('the client cannot see it', W.clientVariations(w).length, 0);
  eq("it is on EP Team's unsent list", W.unsentVariations(w).length, 1);
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
  eq('which wrote VAR-1', W.variationVersions(w)[0].label, 'VAR-1');
  eq('issued', !!W.variationVersions(w)[0].issuedAt, true);
  ok('naming the line it carried', /Extra steward/.test(W.variationVersions(w)[0].change), W.variationVersions(w)[0].change);
  eq('the client can see it', W.clientVariations(w).length, 1);
  eq('it is awaiting their approval', W.pendingVariations(w).length, 1);
  eq('and there is nothing left to send', W.variationSendBlock(w) !== null, true);

  eq('now they can accept it', W.acceptVariation(w, v.id, THE_CLIENT), true);
  eq('which wrote no new schedule — they sent nothing', W.variationVersions(w).length, 1);
  eq('their answer is stamped on the one they hold', W.variationVersions(w)[0].answers.length, 1);
  eq('saying what they did', W.variationVersions(w)[0].answers[0].approval, 'accepted');
  eq('to which line', W.variationVersions(w)[0].answers[0].description, 'Extra steward');
  eq('under their own name', W.variationVersions(w)[0].answers[0].byName, THE_CLIENT.name);

  // A second variation is held back on its own, and does not drag the first
  // one out of the client's hands.
  const later = W.addLine(w, HOURLY.id, { qty: 1, units: 2, description: 'Late request', addedBy: GRACIE.by }, GRACIE);
  eq('the new line is unsent', W.pendingChanges(w, 'variation').length, 1);
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
  eq('sending wrote VAR-2', W.variationVersions(w)[1].label, 'VAR-2');
  eq('and puts both lines with them', W.clientVariations(w).length, 2);
  eq('clearing the unsent list', W.unsentVariations(w).length, 0);
  eq('and the notes behind it', W.pendingChanges(w, 'variation').length, 0);
  // VAR-1 is still the document it was, answer and all.
  eq('VAR-1 keeps its own line count', W.variationVersions(w)[0].lines.length, 1);
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

  // A signature taken outside the portal proves a quote reached them, so one
  // is written rather than leaving a signed job with no paper behind it.
  const off = job('Signed off-system', 6);
  eq('nothing has been sent', W.quoteVersions(off).length, 0);
  W.signQuote(off, { signedBy: 'Sharon Pike', method: 'Countersigned order' }, THE_CLIENT);
  eq('the signature wrote the document it implies', W.quoteVersions(off).length, 1);
  eq('issued', !!W.quoteVersions(off)[0].issuedAt, true);
  eq('stamped at the send it back-dates, not at now', W.quoteVersions(off)[0].issuedAt, off.quotedAt);
  ok('and signed', !!W.quoteVersions(off)[0].signedAt);
}

/* -- 8. jobs that predate the trail --------------------------------------- */
console.log('\n8. Existing jobs have a trail if they reached the client, and none if they did not');
{
  const withLines = W.all().filter((x) => SEEDED.has(x.id) && W.quoteLines(x).length);
  ok('there are seeded jobs to check', withLines.length > 0);

  const sent = withLines.filter((x) => x.quotedAt);
  ok('some of them went to the client', sent.length > 0);
  eq('every one of those has a document', sent.every((x) => W.quoteVersions(x).length > 0), true);
  eq('and all of them are issued', sent.every((x) => W.quoteVersions(x).every((v) => !!v.issuedAt)), true);
  ok(
    'the first one says what it is',
    sent.every((x) => /version history began/.test(W.quoteVersions(x)[0].change)),
  );

  eq(
    'a quote nobody sent has no document at all',
    withLines.filter((x) => !x.quotedAt).every((x) => W.quoteVersions(x).length === 0),
    true,
  );

  // The portal is the guard the client actually meets.
  PORTAL.setActingClient(CLIENT.id);
  const unsent = W.all().find((x) => !x.quotedAt && W.quoteLines(x).length);
  if (unsent) eq('an unsent job is unreachable by its own id', PORTAL.clientJob(unsent.id), null);
}

console.log(failures ? `\n${failures} FAILED\n` : '\nAll paper-trail checks passed.\n');
process.exit(failures ? 1 : 0);
