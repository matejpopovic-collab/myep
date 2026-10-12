/* ============================================================================
   EPROSTA — verification harness for the client asking for more

   After signing, the portal's "Something is wrong or missing" is gone — the
   quote is closed to queries — and a client who needed four more stewards on
   the Sunday had no button to say so. This proves the ask that replaces it:

     1. THE DOOR OPENS ON THE DEPOSIT — not before signing (the quote's own
        query is the door then), not between signing and the deposit, and
        not on a closed job. An invoiced job still takes a separate-quote ask.

     2. THE CLIENT DESCRIBES, NOTHING IS PRICED — an ask moves no stage, adds
        no line and changes no total. Empty asks are refused.

     3. PRICED → A VARIATION THE CLIENT APPROVES — the line is tied back to
        the ask, the client sees "Being priced" until it is SENT, then the
        price. A second line on the same ask is appended.

     4. A SEPARATE QUOTE IS A SEPARATE JOB — same client, linked back.

     5. DECLINED NEEDS A NOTE, WITHDRAWN IS STAMPED NOT DELETED.

     6. IT SURVIVES A RELOAD — the `load()` whitelist trap.

   Dates are COMPUTED, never named. See `drift-check.mjs`.

   Run:  node client-asks-tests.mjs
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

const work = mkdtempSync(join(tmpdir(), 'eprosta-asks-'));
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
const eq = (name, got, want) =>
  ok(name, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

const { W, DB } = await boot();
const { CHARGES, CLIENTS } = DB;
const SEEDED = new Set(W.all().map((w) => w.id));

const CLIENT = CLIENTS.find((c) => c.status === 'active');
const HOURLY = CHARGES.filter((c) => c.unit === 'hour' && c.kind === 'staff')[0];
const OPS = { by: 'm-jake', name: 'Jake Wright' };
const CLIENT_ACTOR = { by: 'client', name: CLIENT.contact || CLIENT.name };

const pad = (n) => String(n).padStart(2, '0');
function day(n, hour = 9) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:00:00`;
}

/** A job `startsIn` days out: priced, sent, optionally signed and paid. */
function job(title, startsIn, { signed = true, paid = true } = {}) {
  const w = W.create({ title, clientId: CLIENT.id, start: day(startsIn, 8), end: day(startsIn + 1, 20), jobTypeId: 'festival' });
  W.addLine(w, HOURLY.id, { qty: 4, units: 10, description: 'Event Steward' });
  W.sendQuote(w, OPS);
  if (signed) W.signQuote(w, { signedBy: CLIENT_ACTOR.name }, CLIENT_ACTOR);
  if (signed && paid) W.recordDeposit(w, {}, OPS);
  return w;
}
const ASK = { kind: 'staff', text: 'Four more stewards on the north gate', when: 'Sunday 10–6' };

/* -- 1. when the door is open --------------------------------------------- */
console.log('\n1. The ask opens once the deposit is in');
{
  const unsigned = job('Unsigned', 30, { signed: false });
  ok('not before signing', !!W.askBlock(unsigned));
  ok('and it points at the quote query', /Something is wrong or missing/.test(W.askBlock(unsigned) || ''));
  eq('requestMore refuses it', W.requestMore(unsigned, ASK, CLIENT_ACTOR), null);

  const unpaid = job('Signed, unpaid', 30, { paid: false });
  const dep = W.deposit(unpaid);
  ok('the fixture has a deposit due', dep.due > 0 && dep.outstanding > 0, JSON.stringify(dep));
  ok('not while the deposit is outstanding', /deposit/.test(W.askBlock(unpaid) || ''));

  const paid = job('Paid', 30);
  eq('open once the deposit is in', W.askBlock(paid), null);
  eq('a separate quote is open too', W.askBlock(paid, 'quote'), null);

  W.requestCancellation(paid, 'Thinking about it', CLIENT_ACTOR);
  ok('not while they have asked to cancel', !!W.askBlock(paid));
  W.withdrawCancellationRequest(paid, CLIENT_ACTOR);
  eq('open again once withdrawn', W.askBlock(paid), null);

  const closed = job('Closed', 30);
  W.cancelWof(closed, { reason: 'Gone', initiator: 'ep' }, OPS);
  eq('a closed job takes nothing', W.askBlock(closed, 'quote'), 'This job is closed.');

  const invoiced = job('Invoiced', 30);
  invoiced.invoice = { number: 'INV-T', issuedAt: day(0), dueAt: day(30), paidAt: null };
  ok('an invoiced job takes no more on it', !!W.askBlock(invoiced, 'staff'));
  eq('but can still ask for a separate quote', W.askBlock(invoiced, 'quote'), null);
}

/* -- 2. nothing priced ---------------------------------------------------- */
console.log('\n2. The client describes; nothing is priced');
{
  const w = job('Describe', 30);
  const stage = w.stage;
  const lines = w.lines.length;
  const value = W.contractValue(w);
  eq('an empty ask is refused', W.requestMore(w, { kind: 'staff', text: '   ' }, CLIENT_ACTOR), null);
  const a = W.requestMore(w, ASK, CLIENT_ACTOR);
  ok('the ask is recorded', !!a);
  eq('in their words', a.text, ASK.text);
  eq('with their when', a.when, ASK.when);
  eq('no stage moved', w.stage, stage);
  eq('no line added', w.lines.length, lines);
  eq('no total changed', W.contractValue(w), value);
  eq('it is open', W.openAsks(w).length, 1);
  eq('the client sees it with EP Team', W.askStatus(w, a).label, 'With EP Team');
  ok('it is on the history', w.history.some((h) => h.note.includes(ASK.text)));
}

/* -- 3. priced as a variation --------------------------------------------- */
console.log('\n3. Priced, it becomes a variation the client approves');
{
  const w = job('Priced', 30);
  const a = W.requestMore(w, ASK, CLIENT_ACTOR);
  const line = W.addLine(w, HOURLY.id, { qty: 4, units: 8, description: ASK.text });
  ok('the line is a variation (signed job)', W.variationLines(w).some((l) => l.id === line.id));
  ok('askPriced ties it back', W.askPriced(w, a.id, line.id, OPS));
  eq('the ask is no longer open', W.openAsks(w).length, 0);
  eq('the answer says priced', a.answer.how, 'priced');
  eq('until sent, the client sees it being priced', W.askStatus(w, a).label, 'Being priced');
  ok('and no price', !/£/.test(W.askStatus(w, a).detail));

  ok('sending the variations works', W.sendVariations(w, OPS), W.variationSendBlock(w) || '');
  eq('once sent, the client sees the price', W.askStatus(w, a).label, 'Priced');
  ok('with a figure', /£/.test(W.askStatus(w, a).detail), W.askStatus(w, a).detail);

  const radios = W.addLine(w, HOURLY.id, { qty: 1, units: 8, description: 'Supervisor' });
  ok('a second line on the same ask is appended', W.askPriced(w, a.id, radios.id, OPS));
  eq('both lines are on it', a.answer.lineIds.length, 2);
}

/* -- 4. a separate quote -------------------------------------------------- */
console.log('\n4. A separate quote is a separate job');
{
  const w = job('Parent', 30);
  const a = W.requestMore(w, { kind: 'quote', text: 'Same team for the winter market', when: 'December' }, CLIENT_ACTOR);
  const before = W.all().length;
  const nw = W.raiseQuoteFromAsk(w, a.id, OPS);
  ok('a job was raised', !!nw);
  eq('one more job on the pipeline', W.all().length, before + 1);
  eq('for the same client', nw.clientId, w.clientId);
  ok('carrying their words', (nw.notes || '').includes('winter market'));
  eq('linked from the ask', a.answer.wofId, nw.id);
  eq('the client sees a quote started', W.askStatus(w, a).label, 'Quote started');
  eq('it cannot be raised twice', W.raiseQuoteFromAsk(w, a.id, OPS), null);
}

/* -- 5. declined and withdrawn -------------------------------------------- */
console.log('\n5. Declined needs a note; withdrawn is stamped, not deleted');
{
  const w = job('Decline', 30);
  const a = W.requestMore(w, ASK, CLIENT_ACTOR);
  ok('a decline with no note is refused', !W.declineAsk(w, a.id, '  ', OPS));
  ok('a decline with a note is taken', W.declineAsk(w, a.id, 'No SIA staff free that day', OPS));
  eq('the client sees it declined', W.askStatus(w, a).label, 'Declined');
  eq('with the note', W.askStatus(w, a).detail, 'No SIA staff free that day');
  ok('a declined ask cannot then be priced', !W.askPriced(w, a.id, 'x', OPS));

  const b = W.requestMore(w, { kind: 'kit', text: 'Another 20m of barrier' }, CLIENT_ACTOR);
  ok('the client can withdraw an open ask', W.withdrawAsk(w, b.id, CLIENT_ACTOR));
  ok('it is still on the record', !!W.askById(w, b.id));
  ok('but not open', !W.openAsks(w).some((x) => x.id === b.id));
  ok('and not on the client list', !W.clientAsks(w).some((x) => x.id === b.id));
  ok('an answered ask cannot be withdrawn', !W.withdrawAsk(w, a.id, CLIENT_ACTOR));
  const c = W.requestMore(w, ASK, CLIENT_ACTOR);
  ok('ids do not collide after a withdrawal', new Set(w.asks.map((x) => x.id)).size === w.asks.length && !!c);
}

/* -- 6. reload ------------------------------------------------------------ */
console.log('\n6. An ask is still there after a reload');
{
  const seeded = W.all().filter(
    (x) => SEEDED.has(x.id) && !W.isTerminal(x.stage) && !!x.signoff && !W.askBlock(x, 'quote'),
  );
  ok('there is a seeded job open to asks', seeded.length > 0, `${seeded.length}`);
  if (seeded.length) {
    const w = seeded[0];
    const id = w.id;
    W.requestMore(w, { kind: 'quote', text: 'Reload me' }, CLIENT_ACTOR);
    W.save();
    W.load();
    const back = W.byId(id);
    ok('the ask survived', (back.asks || []).some((a) => a.text === 'Reload me'), 'check the load() whitelist');
    eq('and is still open', W.openAsks(back).length >= 1, true);
  }
}

console.log(
  failures
    ? `\n${failures} client-ask check${failures === 1 ? '' : 's'} FAILED.\n`
    : '\nAll client-ask checks passed.\n',
);
process.exit(failures ? 1 : 0);
