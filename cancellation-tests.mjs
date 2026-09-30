/* ============================================================================
   EPROSTA — verification harness for cancelling a job

   `cancelled` and `lost` had been in the type since the first commit and
   nothing wrote either of them. A client who pulled out left a confirmed job
   on the pipeline drawing stock, an event with people still assigned to it and
   a prep job in the warehouse queue. This proves the act that was missing:

     1. THE NOTICE BANDS, ON BOTH SIDES OF EVERY BOUNDARY — 0% beyond
        fourteen days, 50% inside them, 100% inside two, and a job already
        running is in the dearest band rather than off the end of the table.

     2. BEFORE A SIGNATURE IT IS LOST, AND IT IS FREE — whatever the notice,
        and whatever anyone types in the override.

     3. EP STANDING A JOB DOWN CHARGES NOBODY — unless somebody overrides it
        on purpose.

     4. THE CHARGE IS A REAL LINE — a variation, priced from `snap` and not
        from the rate card, which the client's own total picks up.

     5. THE JOB STANDS DOWN — assignments released, attendance for days
        nobody will now work marked `cancelled` rather than no-show, and the
        event itself kept.

     6. THE WAREHOUSE LETS GO — a cancelled job leaves the queue, unless the
        kit has already gone out, in which case it has to come back.

     7. THE SHELF IS GIVEN BACK — availability on a committed item recovers.

     8. REINSTATEMENT — back to the stage it stopped at, the charge taken off,
        and the staffing honestly NOT restored.

     9. THE CLIENT ASKS, EP DECIDES — a request moves no stage, cannot be
        raised twice, is answered by a decline that stamps rather than
        deletes, and can be withdrawn.

    10. PERMISSION — `wof.cancel`, and who does and does not hold it.

    11. IT SURVIVES A RELOAD — the `load()` whitelist trap, caught here
        rather than by the user.

   Dates are COMPUTED, never named: `src/data/clock.ts` shifts the seed to sit
   around today, so a fixture that names a Tuesday is a test with an expiry
   stamped on it. See `drift-check.mjs`.

   Run:  node cancellation-tests.mjs
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

const work = mkdtempSync(join(tmpdir(), 'eprosta-cancel-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');

async function boot() {
  const entry = join(work, 'entry.ts');
  const out = join(work, 'bundle.mjs');
  writeFileSync(
    entry,
    `export * as W from '${p('src/lib/wof')}';\n` +
      `export * as DB from '${p('src/data/db')}';\n` +
      `export * as R from '${p('src/lib/roles')}';\n` +
      `export * as EV from '${p('src/lib/events')}';\n` +
      `export * as HOP from '${p('src/lib/hop')}';\n`,
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

const { W, DB, R, EV, HOP } = await boot();
const { CHARGES, CLIENTS, ATTENDANCE, EMPLOYEES } = DB;

/* Captured before a single fixture exists. `load()` REBUILDS these from the
   seed literals and overlays a whitelist of fields on top, while a job raised
   in the browser is restored whole — so only a seeded job can prove the
   whitelist. A fixture would pass either way, which is exactly the assertion
   that catches nothing. */
const SEEDED = new Set(W.all().map((w) => w.id));

const CLIENT = CLIENTS.find((c) => c.status === 'active');
const HOURLY = CHARGES.filter((c) => c.unit === 'hour' && c.kind === 'staff')[0];
const KIT = CHARGES.filter((c) => c.kind === 'kit' && !/replacement|excess/i.test(c.name))[0];

const OPS = { by: 'm-jake', name: 'Jake Wright' };
const CLIENT_ACTOR = { by: 'client', name: CLIENT.contact || CLIENT.name };

/** Midnight N days from now, as the local ISO shape every date in the app uses. */
const pad = (n) => String(n).padStart(2, '0');
function day(n, hour = 9) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:00:00`;
}

/**
 * A job starting `startsIn` days from today, priced and optionally signed.
 * Nothing here names a date: the seed moves, and so must the fixtures.
 */
function job(title, startsIn, { qty = 4, signed = true, kit = 0 } = {}) {
  const w = W.create({
    title,
    clientId: CLIENT.id,
    start: day(startsIn, 8),
    end: day(startsIn + 1, 20),
    jobTypeId: 'festival',
  });
  W.addLine(w, HOURLY.id, { qty, units: 10, description: 'Event Steward' });
  if (kit) W.addLine(w, KIT.id, { qty: kit, units: 2, description: KIT.name });
  W.sendQuote(w, OPS);
  if (signed) W.signQuote(w, { signedBy: CLIENT_ACTOR.name }, CLIENT_ACTOR);
  return w;
}

/* -- 1. the bands, on both sides of every boundary ----------------------- */
console.log('\n1. What the notice period is worth, at every boundary');
{
  const cases = [
    [40, 0, 'six weeks out'],
    [15, 0, 'fifteen days out'],
    [14, 50, 'fourteen days out'],
    [3, 50, 'three days out'],
    [2, 100, 'two days out'],
    [1, 100, 'tomorrow'],
    [0, 100, 'today'],
    [-1, 100, 'started yesterday'],
  ];
  for (const [days, pct, label] of cases) {
    const w = job(`Band ${label}`, days);
    eq(`${label} is ${pct}%`, W.cancellationBand(w).chargePct, pct);
  }

  const w = job('Notice count', 9);
  eq('the notice itself is counted in whole days', W.cancellationBand(w).daysNotice, 9);
  const started = job('Already running', -3);
  ok(
    'a job that has started has negative notice',
    W.cancellationBand(started).daysNotice < 0,
    `${W.cancellationBand(started).daysNotice}`,
  );
  eq(
    'and the table still answers for it',
    W.cancellationBand(started).chargePct,
    100,
  );
}

/* -- 2. before a signature it is lost, and it is free -------------------- */
console.log('\n2. A quote nobody signed is lost, never cancelled, and never charged');
{
  const w = job('Unsigned, tomorrow', 1, { signed: false });
  const q = W.cancellationQuote(w, { initiator: 'client' });
  eq('the terminal is lost', q.target, 'lost');
  eq('there is no percentage of an unsigned contract', q.chargePct, null);
  eq('so nothing is charged', q.charge, 0);

  const forced = W.cancellationQuote(w, { initiator: 'client', chargePct: 100 });
  eq('and an override cannot reach past that', forced.charge, 0);

  const before = w.lines.length;
  W.cancelWof(w, { reason: 'Client went elsewhere', initiator: 'client', chargePct: 100 }, OPS);
  eq('the job is lost', w.stage, 'lost');
  eq('and no line was raised', w.lines.length, before);
  eq('the record says nothing was charged', w.cancellation.chargeAmount, 0);
}

/* -- 3. EP standing a job down charges nobody ---------------------------- */
console.log('\n3. EP cancelling its own job charges the client nothing');
{
  const w = job('EP pulls out', 1);
  eq('the band would be 100%', W.cancellationBand(w).chargePct, 100);
  eq('but EP is cancelling', W.cancellationQuote(w, { initiator: 'ep' }).charge, 0);
  eq(
    'and the client keeps their deposit position',
    W.cancellationQuote(w, { initiator: 'ep' }).chargePct,
    0,
  );
  const deliberate = W.cancellationQuote(w, { initiator: 'ep', chargePct: 25 });
  eq('an override is still honoured when it is deliberate', deliberate.chargePct, 25);
}

/* -- 4. the charge is a real line --------------------------------------- */
console.log('\n4. The cancellation charge is a variation, priced from the agreement');
{
  const w = job('Charged cancellation', 5);
  const contract = W.clientContractValue(w);
  const q = W.cancellationQuote(w, { initiator: 'client' });
  eq('five days out is the 50% band', q.chargePct, 50);
  ok('which is half the contract', Math.abs(q.charge - contract / 2) < 0.02, `${q.charge} vs ${contract}`);

  const c = W.cancelWof(w, { reason: 'Site flooded', initiator: 'client' }, OPS);
  const line = w.lines.find((l) => l.id === c.chargeLineId);
  ok('a line was raised', !!line);
  eq('on the cancellation charge', line.chargeId, W.CANCELLATION_CHARGE_ID);
  eq('as a variation, not a quote line', line.source, 'variation');
  eq('for one of it', line.qty, 1);
  ok(
    'priced at the computed figure rather than the rate card',
    Math.abs(W.lineValue(line) - q.charge) < 0.02,
    `${W.lineValue(line)} vs ${q.charge}`,
  );
  ok('the card itself carries no price', DB.charge(W.CANCELLATION_CHARGE_ID).charge === 0);
  eq('and the record agrees with the line', c.chargeAmount, q.charge);
  eq('the stage is cancelled, not lost', w.stage, 'cancelled');
  eq('the job is no longer active', w.active, false);
  ok('the reason is on the history', w.history.some((h) => h.note.includes('Site flooded')));
}

/* -- 4b. the deposit position ------------------------------------------- */
console.log('\n4b. What goes back, and what is still owed');
{
  const w = job('Deposit taken', 20);
  W.recordDeposit(w, {}, OPS);
  const held = W.deposit(w).received;
  ok('a deposit is held', held > 0, `${held}`);

  const far = W.cancellationQuote(w, { initiator: 'client' });
  eq('beyond fourteen days nothing is charged', far.charge, 0);
  eq('so the whole deposit goes back', far.refundDue, held);
  eq('and nothing is owed', far.balanceDue, 0);

  const near = job('Deposit taken, close in', 1);
  W.recordDeposit(near, {}, OPS);
  const q = W.cancellationQuote(near, { initiator: 'client' });
  eq('inside two days the whole contract is charged', q.chargePct, 100);
  ok('which is more than the deposit', q.charge > q.depositHeld);
  eq('so nothing is refunded', q.refundDue, 0);
  ok(
    'and the balance is the difference',
    Math.abs(q.balanceDue - (q.charge - q.depositHeld)) < 0.02,
    `${q.balanceDue}`,
  );
}

/* -- 5. the job stands down --------------------------------------------- */
console.log('\n5. Cancelling releases the staff and keeps the event');
{
  const w = job('Staffed job', 9, { qty: 6 });
  const conf = W.confirmOrder(w, OPS);
  ok('it became an order', conf.ordered, conf.blocked.join('; '));
  const ev = conf.event;
  ok('with a staffing event', !!ev, 'no event seeded');
  ok('and roles on it', conf.roles > 0, `${conf.roles}`);

  const split = ev.shifts[0].splits[0];
  const candidates = EMPLOYEES.slice(0, 12).map((e) => e.id);
  let placed = 0;
  for (const id of candidates) {
    if (placed >= 2) break;
    placed += EV.assign(ev.id, split.id, [id]).assigned;
  }
  ok('somebody is assigned', placed > 0, 'the roster refused every candidate');

  const c = W.cancelWof(w, { reason: 'Client cancelled the festival', initiator: 'client' }, OPS);
  eq('the release is counted on the record', c.released.assignments, placed);
  const left = ev.shifts.reduce(
    (n, sh) => n + sh.splits.reduce((m, sp) => m + (sp.assignments || []).length, 0),
    0,
  );
  eq('nobody is left on the event', left, 0);
  ok('and the event itself is still there', !!DB.event(ev.id));
  eq('which the screens can see off the work order', W.eventStoodDown(ev.id), true);
}

/* -- 5b. attendance is cancelled, not a no-show ------------------------- */
console.log('\n5b. A day nobody will now work is cancelled, not missed');
{
  const w = job('Attendance job', 6, { qty: 3 });
  const conf = W.confirmOrder(w, OPS);
  const ev = conf.event;
  ok('the fixture has an event', !!ev);

  const future = { id: `att-fx-${Date.now()}`, employeeId: EMPLOYEES[0].id, eventId: ev.id,
    role: 'Event Steward', date: day(6).slice(0, 10), scheduled: '08:00–20:00', actual: '—',
    hours: 0, outcome: 'no-show', approvedBy: '' };
  const past = { id: `att-fx-${Date.now()}-p`, employeeId: EMPLOYEES[1].id, eventId: ev.id,
    role: 'Event Steward', date: day(-10).slice(0, 10), scheduled: '08:00–20:00', actual: '—',
    hours: 0, outcome: 'no-show', approvedBy: '' };
  const worked = { id: `att-fx-${Date.now()}-w`, employeeId: EMPLOYEES[2].id, eventId: ev.id,
    role: 'Event Steward', date: day(6).slice(0, 10), scheduled: '08:00–20:00', actual: '08:00–20:00',
    hours: 12, outcome: 'worked', approvedBy: 'm-jake' };
  ATTENDANCE.push(future, past, worked);

  W.cancelWof(w, { reason: 'Pulled', initiator: 'client' }, OPS);
  eq('a day still ahead becomes cancelled', future.outcome, 'cancelled');
  eq('a no-show that already happened is left alone', past.outcome, 'no-show');
  eq('and hours actually worked are untouched', worked.outcome, 'worked');
}

/* -- 6. the warehouse lets go ------------------------------------------- */
console.log('\n6. The warehouse queue lets a cancelled job go — unless the kit is out');
{
  const w = job('Kit job', 10, { qty: 2, kit: 4 });
  W.confirmOrder(w, OPS);
  W.sendToHop(w, OPS);
  HOP.hydratePreps();
  ok('it is in the queue', HOP.queue().some((r) => r.w.id === w.id));
  ok('and on the to-pick list', HOP.toPick().some((r) => r.w.id === w.id));

  W.cancelWof(w, { reason: 'Cancelled before picking', initiator: 'client' }, OPS);
  HOP.hydratePreps();
  eq('cancelled, it leaves the queue', HOP.queue().some((r) => r.w.id === w.id), false);
  eq('and the to-pick list with it', HOP.toPick().some((r) => r.w.id === w.id), false);

  W.reinstateWof(w, 'Client changed their mind', OPS);
  HOP.hydratePreps();
  ok('reinstated, it comes back', HOP.queue().some((r) => r.w.id === w.id));
}
{
  const w = job('Kit already out', 12, { qty: 2, kit: 3 });
  W.confirmOrder(w, OPS);
  W.sendToHop(w, OPS);
  HOP.hydratePreps();
  const prep = HOP.preps().find((x) => x.wofId === w.id);
  ok('there is a prep to walk', !!prep);
  // Walking the prep needs `kit.prepare`, which Operations does not hold —
  // the warehouse is somebody else's job. Act as the Super Admin for these
  // four steps and hand the console back afterwards.
  const wasActing = R.acting().id;
  R.setActing(R.MEMBERS.find((m) => m.roleId === 'owner').id);
  prep.lines.forEach((l) => HOP.setPicked(w, l.lineId, l.wanted));
  for (const state of ['picking', 'picked', 'loaded', 'out']) {
    const r = HOP.advancePrep(w, state);
    ok(`the prep reaches ${state}`, r.ok, r.reason);
  }
  eq('the kit is out', HOP.preps().find((x) => x.wofId === w.id).state, 'out');
  R.setActing(wasActing);

  W.cancelWof(w, { reason: 'Cancelled mid-hire', initiator: 'client' }, OPS);
  HOP.hydratePreps();
  ok(
    'kit that has left the building stays on the list until it is back',
    HOP.queue().some((r) => r.w.id === w.id),
  );
}

/* -- 7. the shelf is given back ----------------------------------------- */
console.log('\n7. Stock committed to a cancelled job goes back on the shelf');
{
  // `stockList()` is already only what EP owns and counts, so anything on it
  // is managed. Pick one with room to spare, so the fixture's two pieces are a
  // draw the register can actually meet.
  const item = HOP.stockList().find((s) => !HOP.isConsumable(s.chargeId) && HOP.issuable(s) > 4);
  ok('there is a managed item to measure', !!item);
  const itemCharge = DB.charge(item.chargeId);
  const on = day(18).slice(0, 10);
  const before = HOP.freeOn(item.chargeId, on);

  const w = W.create({
    title: 'Stock draw',
    clientId: CLIENT.id,
    start: day(18, 8),
    end: day(19, 20),
    jobTypeId: 'festival',
  });
  W.addLine(w, HOURLY.id, { qty: 2, units: 8, description: 'Event Steward' });
  W.addLine(w, item.chargeId, { qty: 2, units: 2, description: itemCharge.name });
  W.sendQuote(w, OPS);
  W.signQuote(w, { signedBy: CLIENT_ACTOR.name }, CLIENT_ACTOR);
  W.confirmOrder(w, OPS);
  const during = HOP.freeOn(item.chargeId, on);
  ok('an ordered job draws the stock', during < before, `${during} vs ${before}`);

  W.cancelWof(w, { reason: 'Cancelled', initiator: 'client' }, OPS);
  eq('cancelling gives every one of them back', HOP.freeOn(item.chargeId, on), before);
}

/* -- 8. reinstatement ---------------------------------------------------- */
console.log('\n8. Reinstating puts the job back — and is honest about what it cannot');
{
  const w = job('Reinstated', 5, { qty: 4 });
  W.confirmOrder(w, OPS);
  const ev = DB.event(w.eventId);
  let placed = 0;
  for (const e of EMPLOYEES.slice(0, 12)) {
    if (placed >= 1) break;
    placed += EV.assign(ev.id, ev.shifts[0].splits[0].id, [e.id]).assigned;
  }
  const stageBefore = w.stage;
  const valueBefore = W.contractValue(w);

  const c = W.cancelWof(w, { reason: 'Client pulled out', initiator: 'client' }, OPS);
  ok('a charge was raised', c.chargeAmount > 0, `${c.chargeAmount}`);
  eq('the stage it stopped at is on the record', c.fromStage, stageBefore);

  eq('an empty reason is refused', W.reinstateWof(w, '   ', OPS), false);
  eq('with a reason it comes back', W.reinstateWof(w, 'Event is back on', OPS), true);
  eq('to exactly where it stopped', w.stage, stageBefore);
  eq('the charge line is gone', w.lines.some((l) => l.id === c.chargeLineId), false);
  ok(
    'and the contract value with it',
    Math.abs(W.contractValue(w) - valueBefore) < 0.02,
    `${W.contractValue(w)} vs ${valueBefore}`,
  );
  eq('the cancellation record is cleared', w.cancellation, null);
  eq('it is active again', w.active, true);
  eq(
    'the staffing is NOT restored',
    DB.event(w.eventId).shifts.reduce(
      (n, sh) => n + sh.splits.reduce((m, sp) => m + (sp.assignments || []).length, 0),
      0,
    ),
    0,
  );
  ok('both decisions are on the history', w.history.some((h) => h.note.includes('Reinstated')));
  eq('and it cannot be reinstated twice', W.reinstateWof(w, 'Again', OPS), false);
}

/* -- 9. the client asks, EP decides -------------------------------------- */
console.log('\n9. A client request is an ask, not an act');
{
  const w = job('Client asks', 8);
  const stageBefore = w.stage;
  const req = W.requestCancellation(w, 'Our headline act has pulled out', CLIENT_ACTOR);
  ok('the request is recorded', !!req);
  eq('and it moved no stage', w.stage, stageBefore);
  eq('nothing was charged', w.lines.some((l) => l.chargeId === W.CANCELLATION_CHARGE_ID), false);
  eq('the client status says so', W.clientStatus(w).id, 'cancellation-requested');
  ok('an empty ask is refused', !W.requestCancellation(w, '   ', CLIENT_ACTOR));
  ok('and a second ask is refused while the first is open', !!W.cancelRequestBlock(w));

  ok('an empty decline note is refused', !W.declineCancellationRequest(w, '  ', OPS));
  eq('declining works', W.declineCancellationRequest(w, 'We can move it to the 14th', OPS), true);
  eq('the ask is stamped, not deleted', !!w.cancellationRequest, true);
  eq('but it is no longer open', W.openCancellationRequest(w), null);
  eq('so they can ask again', W.cancelRequestBlock(w), null);
  eq('and the status is back to normal', W.clientStatus(w).id === 'cancellation-requested', false);
}
{
  const w = job('Client withdraws', 8);
  W.requestCancellation(w, 'Might have to pull', CLIENT_ACTOR);
  eq('withdrawing clears it', W.withdrawCancellationRequest(w, CLIENT_ACTOR), true);
  eq('leaving nothing behind', w.cancellationRequest, null);
  eq('and withdrawing twice does nothing', W.withdrawCancellationRequest(w, CLIENT_ACTOR), false);
}
{
  const w = job('Unsent job', 8, { signed: false });
  w.quotedAt = null;
  ok('a job the client cannot see cannot be cancelled by them', !!W.cancelRequestBlock(w));
}
{
  const w = job('Closed job', 8);
  W.cancelWof(w, { reason: 'Gone', initiator: 'client' }, OPS);
  eq('a closed job refuses a request', W.cancelRequestBlock(w), 'This job is closed.');
  eq('and refuses a second cancellation', W.cancelWof(w, { reason: 'Again', initiator: 'ep' }, OPS), null);
  ok('the blocker says which terminal it is in', /already cancelled/.test(W.cancelBlock(w)));
}

/* -- 9b. what cannot be cancelled --------------------------------------- */
console.log('\n9b. What the gate refuses, and why');
{
  const w = job('Complete job', -30);
  W.cancelWof(w, { reason: 'x', initiator: 'ep' }, OPS);
  W.reinstateWof(w, 'back', OPS);
  w.stage = 'complete';
  ok('a completed job cannot be cancelled', /already run/.test(W.cancelBlock(w) || ''));
  eq('and the call is a no-op rather than a throw', W.cancelWof(w, { reason: 'x', initiator: 'ep' }, OPS), null);
}
{
  const w = job('Paid job', -30);
  w.invoice = { number: 'INV-TEST', issuedAt: day(-20), dueAt: day(10), paidAt: day(-5) };
  ok('a paid job is a credit note, not a cancellation', /credit note/.test(W.cancelBlock(w) || ''));
}
{
  const w = job('Reasonless', 8);
  eq('a cancellation with no reason is refused', W.cancelWof(w, { reason: '   ', initiator: 'client' }, OPS), null);
  eq('and the job is untouched', w.stage !== 'cancelled', true);
}

/* -- 10. permission ------------------------------------------------------ */
console.log('\n10. Cancelling is a permission, and not everybody has it');
{
  ok('the capability exists', R.CAP_GROUPS.some((g) => g.caps.some((c) => c.id === 'wof.cancel')));
  const holders = Object.values(R.ROLES).filter((r) => r.caps.includes('wof.cancel'));
  ok('somebody holds it', holders.length > 0);
  ok('the Super Admin does', R.ROLES.owner.caps.includes('wof.cancel'));
  ok('Operations does — they run the job', R.ROLES.ops.caps.includes('wof.cancel'));
  eq('Payroll does not', R.ROLES.payroll.caps.includes('wof.cancel'), false);
  eq('nor does the Warehouse Manager', R.ROLES.warehouse.caps.includes('wof.cancel'), false);
  eq('nor Read only', R.ROLES.readonly.caps.includes('wof.cancel'), false);
  /* The pairing that makes the two guards on the menu item distinguishable:
     Scheduling can see a work order and cannot cancel one, so a test that
     only checked "the button was refused" could not tell the permission from
     the stage gate. */
  ok('Scheduling can see a job', R.ROLES.scheduling.caps.includes('wof.view'));
  eq('but cannot cancel one', R.ROLES.scheduling.caps.includes('wof.cancel'), false);
}

/* -- 11. it survives a reload ------------------------------------------- */
console.log('\n11. A cancellation is still there after a reload');
{
  const seeded = W.all().filter((x) => SEEDED.has(x.id) && !W.isTerminal(x.stage) && !!x.signoff);
  ok('there is a seeded job to cancel', seeded.length > 1, `${seeded.length}`);
  const w = seeded[0];
  const c = W.cancelWof(w, { reason: 'Pulled the weekend', initiator: 'client' }, OPS);
  ok('it cancelled', !!c);
  const id = w.id;
  const charged = c.chargeAmount;

  const asking = seeded[1];
  W.requestCancellation(asking, 'Thinking about pulling', CLIENT_ACTOR);
  const askingId = asking.id;

  W.save();
  W.load();

  const back = W.byId(id);
  ok('the job is still there', !!back);
  eq('still cancelled', back.stage, 'cancelled');
  ok('with its record', !!back.cancellation, 'the cancellation vanished — check the load() whitelist');
  eq('and its figure', back.cancellation.chargeAmount, charged);
  eq('and its reason', back.cancellation.reason, 'Pulled the weekend');
  ok(
    'the charge line came back too',
    back.lines.some((l) => l.id === back.cancellation.chargeLineId),
  );

  const asked = W.byId(askingId);
  ok('the open request survived as well', !!W.openCancellationRequest(asked));
  eq('with what they said', W.openCancellationRequest(asked).reason, 'Thinking about pulling');
}

/* -- 12. a job with no event, and a job with no lines -------------------- */
console.log('\n12. The edges: nothing to stand down, and nothing to charge');
{
  // A kit hire has no rota and never will — `seedEvent` builds shifts from
  // staff lines and there are none. Several screens were written assuming
  // every job has staff; standing one down must not be another of them.
  const w = W.create({
    title: 'Kit only',
    clientId: CLIENT.id,
    start: day(5, 8),
    end: day(6, 20),
    jobTypeId: 'festival',
  });
  W.addLine(w, KIT.id, { qty: 3, units: 2, description: KIT.name });
  W.sendQuote(w, OPS);
  W.signQuote(w, { signedBy: CLIENT_ACTOR.name }, CLIENT_ACTOR);
  eq('a kit hire has no staffing event', w.eventId, null);
  const c = W.cancelWof(w, { reason: 'Pulled early', initiator: 'client' }, OPS);
  eq('cancelling still works', w.stage, 'cancelled');
  eq('and releases nobody', c.released.assignments, 0);
  ok('while still charging for the notice', c.chargeAmount > 0, `${c.chargeAmount}`);
}
{
  const w = W.create({
    title: 'Empty job',
    clientId: CLIENT.id,
    start: day(3, 8),
    end: day(4, 20),
    jobTypeId: 'festival',
  });
  const c = W.cancelWof(w, { reason: 'Raised by mistake', initiator: 'client' }, OPS);
  eq('an unpriced job is lost, not cancelled', w.stage, 'lost');
  eq('and costs nothing', c.chargeAmount, 0);
}

console.log(
  failures
    ? `\n${failures} cancellation check${failures === 1 ? '' : 's'} FAILED.\n`
    : '\nAll cancellation checks passed.\n',
);
process.exit(failures ? 1 : 0);
