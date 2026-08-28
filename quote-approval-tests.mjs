/* ============================================================================
   EPROSTA — verification harness for approving a high-value quote

   A quote is priced by one person and, the moment it is sent, it is an offer
   the client can sign. A mistyped quantity — 100 stewards where 10 were meant
   — is a five-figure error that reaches the client before anybody else in the
   building has read it. Over a threshold, the figure now needs a second,
   senior pair of eyes. This proves the control is a control:

     1. THE THRESHOLD BITES ONE WAY — a quote at or under it sends exactly as
        before. Nothing about small jobs got slower.

     2. A BIG QUOTE CANNOT BE SENT UNAPPROVED — and the block says why, in
        money, rather than greying a button out in silence.

     3. NOBODY APPROVES THEIR OWN PRICING — the person who put the lines on
        cannot sign them off, whatever their role. An approval you can give
        yourself is a checkbox, not a check.

     4. WHAT IS APPROVED IS A NUMBER — push the total above the approved
        figure and the approval lapses; bring it down and it stands.

     5. REFUSAL IS AN OUTCOME, WITH A REASON — and it keeps the quote in the
        building.

     6. A JOB CAN CROSS THE LINE AFTER IT WAS SENT — one priced under the
        threshold, sent, then amended above it cannot be re-sent unapproved.
        This is the error the control exists for.

     6b. QUOTES THAT PREDATE THE CONTROL are grandfathered — a job already
        with the client at its current figure is not retrospectively unsent.

     7. THE ROLE TABLE CARRIES IT — Senior Manager and Super Admin can
        approve; Operations, who price the work, cannot.

   Run:  node quote-approval-tests.mjs
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

const work = mkdtempSync(join(tmpdir(), 'eprosta-approval-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');

async function boot() {
  const entry = join(work, 'entry.ts');
  const out = join(work, 'bundle.mjs');
  writeFileSync(
    entry,
    `export * as W from '${p('src/lib/wof')}';\n` +
      `export * as DB from '${p('src/data/db')}';\n` +
      `export * as R from '${p('src/lib/roles')}';\n`,
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

const { W, DB, R } = await boot();
const { CHARGES, CLIENTS } = DB;

const CLIENT = CLIENTS.find((c) => c.status === 'active');
const HOURLY = CHARGES.filter((c) => c.unit === 'hour')[0];

/* The two people this control is about: one prices, the other signs it off. */
const PRICER = { by: 'm-gracie', name: 'Gracie Mullen' };
const SENIOR = { by: 'm-dawn', name: 'Dawn Cartwright' };

/** A job priced by PRICER. `qty` is what makes it big or small. */
function job(title, qty) {
  const w = W.create({
    title,
    clientId: CLIENT.id,
    start: '2026-09-04T09:00:00',
    end: '2026-09-04T18:00:00',
    jobTypeId: 'festival',
  });
  W.addLine(w, HOURLY.id, { qty, units: 10, description: 'Event Steward', addedBy: PRICER.by });
  return w;
}

/* -- 1. the threshold bites one way -------------------------------------- */
console.log('\n1. A quote under the threshold is untouched by any of this');
{
  const w = job('Small job', 1);
  ok('it is under the threshold', W.quoteValue(w) <= W.QUOTE_APPROVAL_THRESHOLD, `${W.quoteValue(w)}`);
  eq('so no approval is needed', W.quoteNeedsApproval(w), false);
  eq('the state says so', W.quoteApprovalState(w), 'not-required');
  eq('nothing blocks the send', W.quoteSendBlock(w), null);
  eq('and it sends', W.sendQuote(w, PRICER), true);
  // The gate is "exceeding", not "reaching": approving a quote that does not
  // need approving would be the control crying wolf.
  ok(
    'approval is refused as pointless on a small quote',
    (W.approveQuoteBlock(w, SENIOR) || '').includes('under the'),
    W.approveQuoteBlock(w, SENIOR),
  );
}

/* -- 2. a big quote cannot be sent unapproved ---------------------------- */
console.log('\n2. A quote over the threshold is held until it is approved');
{
  const w = job('Big job', 100);
  ok('it is over the threshold', W.quoteValue(w) > W.QUOTE_APPROVAL_THRESHOLD, `${W.quoteValue(w)}`);
  eq('approval is needed', W.quoteNeedsApproval(w), true);
  eq('and nothing has been raised yet', W.quoteApprovalState(w), 'required');

  const why = W.quoteSendBlock(w);
  ok('the send is blocked', !!why);
  ok('and the block names the threshold', (why || '').includes('5,000'), why);
  eq('sending is refused outright', W.sendQuote(w, PRICER), false);
  eq('so the client still cannot see it', w.quotedAt, null);

  eq('it can be sent up for approval', W.requestQuoteApproval(w, 'Tiered rate applied', PRICER), true);
  eq('which is a state of its own', W.quoteApprovalState(w), 'requested');
  eq('the request remembers who and how much', w.quoteApprovalRequest.by, PRICER.by);
  eq('and what they said', w.quoteApprovalRequest.note, 'Tiered rate applied');
  // Asking is not being answered.
  ok('the send is still blocked', !!W.quoteSendBlock(w));
  eq('and still refused', W.sendQuote(w, PRICER), false);
}

/* -- 3. nobody approves their own pricing -------------------------------- */
console.log('\n3. The approval has to come from somebody who did not price it');
{
  const w = job('Four eyes', 100);
  W.requestQuoteApproval(w, '', PRICER);

  ok('whoever priced it is named', W.quotePricedBy(w).includes(PRICER.by));
  const own = W.approveQuoteBlock(w, PRICER);
  ok('and cannot approve it', !!own, 'no block returned');
  ok('with a reason that says why', (own || '').includes('priced'), own);
  eq('the attempt is refused', W.approveQuote(w, '', PRICER), false);
  eq('and nothing is recorded', w.quoteApproval, null);

  eq('a second person can approve', W.approveQuoteBlock(w, SENIOR), null);
  eq('and it takes', W.approveQuote(w, 'Checked against the rate card', SENIOR), true);
  eq('the state moves', W.quoteApprovalState(w), 'approved');
  eq('the approval names the approver', w.quoteApproval.by, SENIOR.by);
  eq('the figure approved', w.quoteApproval.value, W.quoteValue(w));
  eq('and who asked for it', w.quoteApproval.requestedBy, PRICER.by);
  eq('the request is cleared', w.quoteApprovalRequest, null);

  eq('now nothing blocks the send', W.quoteSendBlock(w), null);
  eq('and it sends', W.sendQuote(w, PRICER), true);
  ok(
    'the history carries the approval',
    w.history.some((h) => h.by === SENIOR.by && h.note.includes('approved')),
  );
}

/* -- 4. what is approved is a number ------------------------------------- */
console.log('\n4. The approval is of a figure, not of a job');
{
  const w = job('Drifting', 100);
  W.approveQuote(w, '', SENIOR);
  const approved = w.quoteApproval.value;

  const extra = W.addLine(w, HOURLY.id, { qty: 20, units: 10, description: 'More stewards', addedBy: PRICER.by });
  ok('the total is now above what was approved', W.quoteValue(w) > approved);
  eq('so the approval has lapsed', W.quoteApprovalState(w), 'lapsed');
  const why = W.quoteSendBlock(w);
  ok('and the send is blocked again', !!why);
  ok('the block quotes both figures', (why || '').includes('now comes to'), why);
  eq('sending is refused', W.sendQuote(w, PRICER), false);

  // Down is not up. A manager who agreed to more has already agreed to less.
  W.removeLine(w, extra.id);
  eq('bringing it back down restores the approval', W.quoteApprovalState(w), 'approved');
  eq('and it can be sent', W.quoteSendBlock(w), null);

  // Re-approval after an increase is a fresh request, and it says what it
  // replaces rather than leaving a stale approval standing beside it.
  W.addLine(w, HOURLY.id, { qty: 20, units: 10, description: 'More stewards', addedBy: PRICER.by });
  eq('an increase lapses it again', W.quoteApprovalState(w), 'lapsed');
  eq('a fresh request can be raised', W.requestQuoteApproval(w, '', PRICER), true);
  eq('and it records what it supersedes', w.quoteApprovalRequest.replacing, approved);
  eq('the lapsed approval is cleared', w.quoteApproval, null);
  eq('re-approval takes', W.approveQuote(w, '', SENIOR), true);
  eq('at the new figure', w.quoteApproval.value, W.quoteValue(w));
}

/* -- 5. refusal is an outcome -------------------------------------------- */
console.log('\n5. A senior manager can send it back, and has to say why');
{
  const w = job('Sent back', 100);
  W.requestQuoteApproval(w, '', PRICER);

  eq('a refusal without a reason is not a refusal', W.refuseQuoteApproval(w, '   ', SENIOR), false);
  eq('the request still stands', W.quoteApprovalState(w), 'requested');

  eq('with a reason it lands', W.refuseQuoteApproval(w, 'Quantity looks like a typo', SENIOR), true);
  eq('the state says so', W.quoteApprovalState(w), 'refused');
  eq('the reason is kept', w.quoteApprovalRefusal.reason, 'Quantity looks like a typo');
  ok('the block repeats it', (W.quoteSendBlock(w) || '').includes('typo'), W.quoteSendBlock(w));
  eq('and the quote stays in the building', W.sendQuote(w, PRICER), false);
  ok(
    'the history records the refusal',
    w.history.some((h) => h.note.includes('refused') && h.note.includes('typo')),
  );

  eq('it can be sent up again', W.requestQuoteApproval(w, 'Quantity confirmed with the client', PRICER), true);
  eq('which clears the refusal', w.quoteApprovalRefusal, null);
  eq('and it can then be approved', W.approveQuote(w, '', SENIOR), true);
  eq('and sent', W.sendQuote(w, PRICER), true);
}

/* -- 6. crossing the line after it was sent ------------------------------ */
console.log('\n6. A sent quote amended above the threshold cannot be re-sent unapproved');
{
  const w = job('Grew', 1);
  eq('it goes out unapproved, as a small quote', W.sendQuote(w, PRICER), true);
  eq('the client can see it', W.quoteSent(w), true);

  W.addLine(w, HOURLY.id, { qty: 100, units: 10, description: 'Event Steward', addedBy: PRICER.by });
  ok('it is now a big quote', W.quoteNeedsApproval(w));
  ok('and it has drifted from what was sent', !!W.quoteDrift(w));
  eq('so the re-send is blocked', W.quoteApprovalState(w), 'required');
  eq('and refused', W.sendQuote(w, PRICER), false);
  eq('the client is still looking at the old figure', w.quotedValue < W.quoteValue(w), true);

  eq('once approved it re-sends', W.approveQuote(w, '', SENIOR), true);
  eq('and the send goes through', W.sendQuote(w, PRICER), true);
  eq('re-stamped at the new figure', w.quotedValue, W.quoteValue(w));
}

/* -- 6b. quotes that predate the control --------------------------------- */
console.log('\n6b. A quote already with the client at its current figure is grandfathered');
{
  const w = job('Already out', 100);
  // Sent before the control existed — which is the state every job in the seed
  // data is in. Reproduced here by sending it with the gate lifted.
  W.approveQuote(w, '', SENIOR);
  W.sendQuote(w, PRICER);
  w.quoteApproval = null;

  eq('it is still a big quote', W.quoteNeedsApproval(w), true);
  eq('but nothing is demanded of it', W.quoteApprovalState(w), 'not-required');
  eq('and it can be re-sent unchanged', W.quoteSendBlock(w), null);

  W.addLine(w, HOURLY.id, { qty: 5, units: 10, description: 'Extra', addedBy: PRICER.by });
  eq('going above what the client was sent ends that', W.quoteApprovalState(w), 'required');
  ok('and the re-send is blocked', !!W.quoteSendBlock(w));
}

/* -- 7. the role table carries it ---------------------------------------- */
console.log('\n7. Only a senior role holds the approval capability');
{
  ok('there is a Senior Manager role', !!R.role('senior-manager'));
  ok('it can approve', R.ROLES['senior-manager'].caps.includes('wof.approve'));
  ok('the Super Admin can approve', R.ROLES.owner.caps.includes('wof.approve'));
  eq('Operations cannot', R.ROLES.ops.caps.includes('wof.approve'), false);
  eq('nor can a Client Manager', R.ROLES['client-manager'].caps.includes('wof.approve'), false);

  const list = R.approvers().map((m) => m.id);
  ok('the approver list is not empty', list.length > 0);
  ok('and it holds a real senior manager', list.includes(SENIOR.by), list.join(','));
  ok(
    'everyone in it actually holds the capability',
    R.approvers().every((m) => R.ROLES[m.roleId].caps.includes('wof.approve')),
  );
}

console.log(
  failures ? `\n${failures} FAILED\n` : '\nAll quote-approval checks passed.\n',
);
process.exit(failures ? 1 : 0);
