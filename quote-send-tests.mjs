/* ============================================================================
   EPROSTA — verification harness for sending a quote

   Pricing and sending were the same act, and they are not the same act. A line
   added from the table of charges appeared in the client's portal immediately,
   so EP Team could not build a quote over two sittings without the client
   watching it happen — reading a half-priced job, seeing a figure nobody meant
   as an offer, and in the worst case signing it.

   `quotedAt` already existed on the model, was already stamped in the seed data
   and was already read in three places as "sent". Nothing ever wrote it. This
   proves the half that was missing:

     1. PRICING IS NOT PUBLISHING — a job with lines on it but no send is
        invisible to the client: not in their list, not openable by URL, not in
        their to-do count.

     2. SENDING PUBLISHES — and stamps what was sent, so the figure can be held
        to later.

     3. AN AMENDMENT AFTER SENDING IS FLAGGED — added, repriced and deleted
        lines all move the total, and the total is what is compared. A quote
        sent and then quietly changed is worse than one never sent.

     4. RE-SENDING CLEARS THE FLAG — and re-stamps, because the stamp means
        "what they are looking at now".

     5. A QUOTE CAN BE WITHDRAWN, A SIGNED ONE CANNOT — hiding an agreement
        from the party who made it is not a state this app should reach.

     6. SIGN-OFF IS BLOCKED ON AN UNSENT QUOTE — there is no client decision to
        record on a quote that never left the building.

   Run:  node quote-send-tests.mjs
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

const work = mkdtempSync(join(tmpdir(), 'eprosta-quotesend-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');

async function boot() {
  const entry = join(work, 'entry.ts');
  const out = join(work, 'bundle.mjs');
  writeFileSync(
    entry,
    `export * as W from '${p('src/lib/wof')}';\n` +
      `export * as DB from '${p('src/data/db')}';\n` +
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
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

const { W, DB, PORTAL } = await boot();
const { CHARGES, CLIENTS } = DB;

const CLIENT = CLIENTS.find((c) => c.status === 'active');
const HOURLY = CHARGES.filter((c) => c.unit === 'hour');

/** An unsent job with one priced line — what EP Team has mid-sitting. */
function pricedJob(title = 'Send gate') {
  const w = W.create({
    title,
    clientId: CLIENT.id,
    start: '2026-09-04T09:00:00',
    end: '2026-09-04T18:00:00',
    jobTypeId: 'festival',
  });
  W.addLine(w, HOURLY[0].id, { qty: 5, units: 10, description: 'Event Steward' });
  return w;
}

/** The client portal's own view, acting as this job's client. */
PORTAL.setActingClient(CLIENT.id);
const asClient = (fn) => fn();

/* -- 1. pricing is not publishing ---------------------------------------- */
console.log('\n1. A priced but unsent quote is invisible to the client');
{
  const w = pricedJob('Unsent job');
  ok('it has priced lines', W.quoteLines(w).length > 0);
  ok('and a real value', W.quoteValue(w) > 0, `${W.quoteValue(w)}`);
  eq('but it counts as not sent', W.quoteSent(w), false);
  eq('and carries no sent stamp', w.quotedAt, null);

  asClient(() => {
    const rows = PORTAL.clientJobs();
    eq('it is not in the client job list', rows.some((r) => r.wof.id === w.id), false);
    // Not merely absent from a list — unreachable by its own id, which is the
    // difference between a hidden row and a working guard.
    eq('and cannot be opened directly', PORTAL.clientJob(w.id), null);
  });
}

/* -- 2. sending publishes ------------------------------------------------- */
console.log('\n2. Sending it puts the job in the portal');
{
  const w = pricedJob('Sent job');
  const value = W.quoteValue(w);
  eq('the send is allowed', W.quoteSendBlock(w), null);
  eq('and reports success', W.sendQuote(w), true);

  eq('it is sent', W.quoteSent(w), true);
  ok('with a timestamp', !!w.quotedAt);
  eq('and the figure it was sent at', w.quotedValue, value);

  asClient(() => {
    const row = PORTAL.clientJob(w.id);
    ok('the client can now open it', !!row);
    ok('and is asked to sign it', row.tasks.some((t) => t.id === 'sign'));
  });

  // Sending is what moves a job off stage 1 — a stage advanced by hand after
  // the fact is a stage that goes stale.
  eq('the job has moved to the quote stage', w.stage, 'quote');
  ok('and the history says so', w.history.some((h) => /sent to the client/i.test(h.note)));
}

/* -- 2b. nothing to send -------------------------------------------------- */
console.log('\n2b. An unpriced job cannot be sent');
{
  const w = W.create({ title: 'No lines', clientId: CLIENT.id, jobTypeId: 'festival' });
  ok('the block explains itself', /priced/i.test(W.quoteSendBlock(w) || ''), W.quoteSendBlock(w));
  eq('and the send refuses', W.sendQuote(w), false);
  eq('leaving it unsent', W.quoteSent(w), false);
}

/* -- 3. an amendment after sending is flagged ---------------------------- */
console.log('\n3. Changing the quote after sending is flagged');
{
  // An ADDED line.
  const a = pricedJob('Added after send');
  W.sendQuote(a);
  eq('clean immediately after sending', W.quoteDrift(a), null);
  W.addLine(a, HOURLY[1 % HOURLY.length].id, { qty: 2, units: 5, description: 'Control Room Operator' });
  const da = W.quoteDrift(a);
  ok('an added line is drift', !!da);
  eq('the sent figure is remembered', da.sentValue, a.quotedValue);
  ok('the current figure is higher', da.nowValue > da.sentValue, `${da.sentValue} -> ${da.nowValue}`);
  eq('and the new line is named', da.added.length, 1);
  eq('nothing was removed', da.removed, 0);
  eq('and it is not reported as a repricing', da.repriced, false);

  // A REPRICED line — no line added, so only the total can catch it.
  const b = pricedJob('Repriced after send');
  W.sendQuote(b);
  b.lines[0].qty += 3;
  const db = W.quoteDrift(b);
  ok('a repriced line is drift', !!db, 'a quantity change must not pass silently');
  eq('with no line to name', db.added.length, 0);
  eq('and none removed', db.removed, 0);
  eq('it is reported as a repricing', db.repriced, true);

  // A DELETED line — the case line timestamps cannot see at all.
  const c = pricedJob('Deleted after send');
  W.addLine(c, HOURLY[0].id, { qty: 1, units: 4, description: 'Second line' });
  W.sendQuote(c);
  c.lines.pop();
  const dc = W.quoteDrift(c);
  ok('a deleted line is drift', !!dc, 'the id snapshot is what is compared, so a deletion counts');
  eq('the missing line is counted', dc.removed, 1);
  ok('and the figure has fallen', dc.nowValue < dc.sentValue, `${dc.sentValue} -> ${dc.nowValue}`);

  // The case that fails silently under a frozen clock: a line added in the
  // same tick as the send carries an identical `addedAt`, so only the id
  // snapshot can tell it apart from a line that was always there.
  const e = pricedJob('Same-tick addition');
  W.sendQuote(e);
  const stamp = e.quotedAt;
  W.addLine(e, HOURLY[0].id, { qty: 3, units: 3, description: 'Added the same second' });
  eq('the added line shares the send timestamp', e.lines[1].addedAt, stamp);
  eq('and is still spotted', W.quoteDrift(e).added.length, 1);

  // Editing something that is not the money must NOT raise it.
  const d = pricedJob('Note edited after send');
  W.sendQuote(d);
  d.notes = 'Rang the client about parking.';
  eq('an unrelated edit is not drift', W.quoteDrift(d), null);
}

/* -- 4. re-sending clears it --------------------------------------------- */
console.log('\n4. Re-sending clears the flag and re-stamps');
{
  const w = pricedJob('Re-sent job');
  W.sendQuote(w);
  const first = w.quotedValue;
  W.addLine(w, HOURLY[0].id, { qty: 4, units: 6, description: 'Extra stewards' });
  ok('flagged before re-sending', !!W.quoteDrift(w));

  eq('the re-send succeeds', W.sendQuote(w), true);
  eq('the flag is gone', W.quoteDrift(w), null);
  ok('the stamp has moved to the new figure', w.quotedValue > first, `${first} -> ${w.quotedValue}`);
  eq('and matches the quote exactly', w.quotedValue, W.quoteValue(w));
  ok('the history records a re-send', w.history.some((h) => /re-sent/i.test(h.note)));
}

/* -- 5. withdrawing ------------------------------------------------------- */
console.log('\n5. A quote can be withdrawn, a signed one cannot');
{
  const w = pricedJob('Withdrawn job');
  W.sendQuote(w);
  asClient(() => ok('visible while sent', !!PORTAL.clientJob(w.id)));

  eq('the withdrawal succeeds', W.unsendQuote(w), true);
  eq('it is unsent again', W.quoteSent(w), false);
  eq('and the stamp is cleared', w.quotedValue, null);
  asClient(() => eq('gone from the portal again', PORTAL.clientJob(w.id), null));
  ok('the history says it was withdrawn', w.history.some((h) => /withdrawn/i.test(h.note)));

  const signed = pricedJob('Signed job');
  W.sendQuote(signed);
  W.signQuote(signed, { signedBy: 'Test Client', method: 'Client portal' });
  eq('a signed quote refuses to be withdrawn', W.unsendQuote(signed), false);
  eq('and stays sent', W.quoteSent(signed), true);
  // Drift is a pre-signature idea; after signing, a change is a variation.
  eq('drift stops being the story once signed', W.quoteDrift(signed), null);
}

/* -- 5b. jobs from before the field existed ------------------------------- */
console.log('\n5b. A job signed before `sendQuote` shipped stays visible');
{
  // `quotedAt` was on the model long before anything wrote it, so every job
  // signed in a browser before this change has a null stamp. Read literally,
  // the new gate hides the client's own confirmed jobs from them — the exact
  // opposite of what it is for. `normaliseEventInfo` backfills from the
  // signature, which is proof the quote reached them.
  const w = pricedJob('Legacy signed job');
  W.sendQuote(w);
  W.signQuote(w, { signedBy: 'Test Client', method: 'Client portal' });

  // Wind it back to the pre-change shape: signed, ordered, no stamp.
  w.quotedAt = null;
  w.quotedValue = null;
  w.quotedLineIds = undefined;
  eq('the stamp really is gone', W.quoteSent(w), false);
  asClient(() => eq('and it would be hidden', PORTAL.clientJob(w.id), null));

  W.normaliseEventInfo(w);
  eq('normalising restores it', W.quoteSent(w), true);
  eq('dated from the signature, not from now', w.quotedAt, w.signoff.signedAt);
  eq('with the figure that was agreed', w.quotedValue, W.quoteValue(w));
  asClient(() => ok('and the client can see their own job again', !!PORTAL.clientJob(w.id)));

  // An UNSIGNED job must not be swept up by the same backfill — that would
  // undo the whole change on every reload.
  const draft = pricedJob('Legacy draft');
  W.normaliseEventInfo(draft);
  eq('an unsigned draft is left unsent', W.quoteSent(draft), false);
  asClient(() => eq('and stays out of the portal', PORTAL.clientJob(draft.id), null));
}

/* -- 6. sign-off is blocked on an unsent quote ---------------------------- */
console.log('\n6. Sign-off is blocked until the quote has been sent');
{
  const w = pricedJob('Gate to signoff');
  const g = W.gate(w, 'signoff');
  eq('the gate is shut', g.ok, false);
  ok('and names the reason', g.block.some((b) => /not been sent/i.test(b)), JSON.stringify(g.block));

  W.sendQuote(w);
  const g2 = W.gate(w, 'signoff');
  eq('sending opens it', g2.ok, true);

  // Sent, then amended: passable, but not silently.
  W.addLine(w, HOURLY[0].id, { qty: 9, units: 9, description: 'Late addition' });
  const g3 = W.gate(w, 'signoff');
  eq('an amended quote still passes', g3.ok, true);
  ok('but warns about the figure', g3.warn.some((x) => /amended since it was sent/i.test(x)),
     JSON.stringify(g3.warn));
}

/* -- report --------------------------------------------------------------- */
console.log(`\n${failures ? `${failures} FAILED` : 'All checks passed.'}\n`);
process.exit(failures ? 1 : 0);
