/* ============================================================================
   EPROSTA — verification harness for when a client is asked for paperwork

   A checklist is a commitment on both sides. Document due dates are worked back
   from the EVENT date, so a quote sent three weeks out already showed the
   client a site plan two weeks "overdue" — on a job they had not signed, would
   not be charged for and might never confirm. Three red OVERDUE pills on an
   enquiry is not a chase; it is a portal teaching its users that red means
   nothing, so that the one that matters is ignored too.

   The rule is now signature AND deposit, in one predicate, so the page and the
   to-do list cannot drift apart.

   This proves the claims it makes:

     1. AN UNSIGNED JOB ASKS FOR NOTHING — whatever the dates say.

     2. A SIGNED JOB WITH THE DEPOSIT UNPAID STILL ASKS FOR NOTHING — the half
        of this change that is new, and the half most easily lost.

     3. THE DEPOSIT LANDING OPENS IT — and everything the client owes appears
        at once, with its real deadlines.

     4. A JOB WITH NO DEPOSIT DUE OPENS ON SIGNATURE — a nil policy must not
        hold the checklist shut forever.

     5. THE PAGE AND THE TO-DO LIST AGREE — one gate, checked from both sides,
        because a badge counting a task the page will not show is worse than
        either behaviour on its own.

     6. EP TEAM STILL SEES EVERYTHING — this is a visibility rule for the
        portal, not a change to the checklist. Compliance must not lose sight
        of a blocking document because a client has not paid yet.

   Run:  node client-docs-tests.mjs
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

const work = mkdtempSync(join(tmpdir(), 'eprosta-clientdocs-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');

async function boot() {
  const entry = join(work, 'entry.ts');
  const out = join(work, 'bundle.mjs');
  writeFileSync(
    entry,
    `export * as W from '${p('src/lib/wof')}';\n` + `export * as DB from '${p('src/data/db')}';\n`,
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

const { W, DB } = await boot();
const { CHARGES } = DB;

/** A priced job dated far enough out that its document deadlines are already
 *  past — the exact case that produced three OVERDUE pills on an enquiry. */
function pricedJob() {
  const w = W.create({
    title: 'Gate check — client docs',
    start: '2026-09-04T09:00:00',
    end: '2026-09-04T18:00:00',
    jobTypeId: 'festival',
  });
  // Something to sign. Priced through the same path the quote screen uses.
  const charge = CHARGES.find((c) => c.unit === 'hour') || CHARGES[0];
  W.addLine(w, charge.id, { qty: 10, units: 8, description: 'Event Steward' });
  return w;
}

const ACTOR = { kind: 'client', id: 'test', name: 'Test Client' };
const sign = (w) => W.signQuote(w, { signedBy: 'Test Client', method: 'Client portal' }, ACTOR);
const pay = (w) => W.recordDeposit(w, { amount: W.deposit(w).due, ref: 'BACS-TEST' }, ACTOR);

const hasDocTask = (w) => W.clientTasks(w).some((t) => t.id === 'documents');
const clientOwned = (w) => W.clientDocs(w).length;

/* -- 1. an unsigned job asks for nothing ---------------------------------- */
console.log('\n1. An unsigned job asks the client for nothing');
{
  const w = pricedJob();
  ok('the job does have client documents on its checklist', clientOwned(w) > 0, `${clientOwned(w)} found`);
  eq('but the checklist is shut', W.clientDocsOpen(w), false);
  eq('no document task on the to-do list', hasDocTask(w), false);
  ok('the client is told what opens it', /sign/i.test(W.clientDocsGate(w) || ''), W.clientDocsGate(w));

  // The bug this replaces: overdue deadlines on a job nobody has agreed to.
  const overdue = W.clientDocs(w).filter((d) => d.overdue);
  ok('the overdue documents that caused this exist underneath', overdue.length > 0, `${overdue.length} overdue`);
  eq('and none of them reach the client', hasDocTask(w), false);
}

/* -- 2. signed but unpaid still asks for nothing -------------------------- */
console.log('\n2. Signed, deposit unpaid — still shut');
{
  const w = pricedJob();
  sign(w);
  ok('the quote is signed', !!w.signoff);
  const dep = W.deposit(w);
  ok('a deposit is due', dep.due > 0, `due ${dep.due}`);
  ok('and outstanding', dep.outstanding > 0, `outstanding ${dep.outstanding}`);

  eq('the checklist is still shut', W.clientDocsOpen(w), false);
  eq('still no document task', hasDocTask(w), false);
  ok('the client is now told it is the deposit', /deposit/i.test(W.clientDocsGate(w) || ''), W.clientDocsGate(w));
  ok('and is not told to sign again', !/sign/i.test(W.clientDocsGate(w) || ''), W.clientDocsGate(w));

  // The deposit itself must still be asked for, or the job stalls silently.
  ok('the deposit is on the to-do list', W.clientTasks(w).some((t) => t.id === 'deposit'));
}

/* -- 3. the deposit opens it ---------------------------------------------- */
console.log('\n3. The deposit landing opens the checklist');
{
  const w = pricedJob();
  sign(w);
  pay(w);

  eq('nothing outstanding on the deposit', W.deposit(w).outstanding, 0);
  eq('the checklist is open', W.clientDocsOpen(w), true);
  eq('no gate note left to show', W.clientDocsGate(w), null);
  ok('the document task appears', hasDocTask(w));

  const task = W.clientTasks(w).find((t) => t.id === 'documents');
  eq('it counts every unapproved client document',
     task.count,
     W.clientDocs(w).filter((d) => d.status !== 'approved').length);
  ok('the real deadlines come with it', W.clientDocs(w).every((d) => !!d.dueDate));
}

/* -- 4. no deposit due opens on signature --------------------------------- */
console.log('\n4. A job with no deposit due opens on signature alone');
{
  const w = pricedJob();
  // A nil deposit policy — the client billed wholly in arrears.
  w.deposit = { pct: 0, amount: null, receivedAt: null, ref: null };
  eq('nothing is due', W.deposit(w).due, 0);
  eq('shut before signing all the same', W.clientDocsOpen(w), false);
  sign(w);
  eq('open on signature', W.clientDocsOpen(w), true);
  ok('and the checklist arrives', hasDocTask(w));
}

/* -- 5. one gate, both sides --------------------------------------------- */
console.log('\n5. The page and the to-do list cannot disagree');
{
  // Whatever state a job is in, "the page shows documents" and "the badge
  // counts a document task" must be the same answer. A badge counting work the
  // page will not show is the worst of both.
  const states = [];

  const a = pricedJob(); states.push(['unsigned', a]);
  const b = pricedJob(); sign(b); states.push(['signed, unpaid', b]);
  const c = pricedJob(); sign(c); pay(c); states.push(['signed, paid', c]);
  const d = pricedJob(); d.deposit = { pct: 0, amount: null, receivedAt: null, ref: null }; sign(d);
  states.push(['no deposit due', d]);

  states.forEach(([name, w]) => {
    const open = W.clientDocsOpen(w);
    const task = hasDocTask(w);
    // A job can be open with nothing outstanding — everything already approved
    // — so the task may be absent where the page is open. The forbidden pairing
    // is the other way round: a task raised against a shut checklist.
    ok(`${name}: no task while shut`, !(task && !open), `open=${open} task=${task}`);
    ok(`${name}: gate note present exactly when shut`, !!W.clientDocsGate(w) === !open);
  });
}

/* -- 6. EP Team still sees the whole checklist ---------------------------- */
console.log('\n6. This hides nothing from EP Team');
{
  const w = pricedJob();
  const before = W.docState(w);
  ok('the operator checklist is populated on an unsigned job', before.docs.length > 0);
  ok('including the sign-off blocking ones', before.docs.some((d) => d.blocking));
  ok('and the client-owned ones', before.docs.some((d) => d.owner === 'Client'));

  sign(w);
  pay(w);
  const after = W.docState(w);
  eq('signing and paying does not change the checklist itself', after.docs.length, before.docs.length);
  eq('nor how many are outstanding', after.outstanding, before.outstanding);
}

/* -- report --------------------------------------------------------------- */
console.log(`\n${failures ? `${failures} FAILED` : 'All checks passed.'}\n`);
process.exit(failures ? 1 : 0);
