/* ============================================================================
   EPROSTA — verification harness for the WOA (Work Order Allocation)

   The rule: when the client pays the deposit, operations allocate the job —
   real headcount per role group, split across staff pools, and the kit really
   going — and ONLY THEN can staffing assign and the kit go to the warehouse.
   The client never sees it.

     1. BEFORE THE DEPOSIT nothing can be allocated, assigned, called out or
        sent, and workers cannot see the job.
     2. AFTER THE DEPOSIT the plan opens at the sold numbers — and is still
        locked downstream until it is released.
     3. EDITING is a draft: pools, headcounts and kit move nothing downstream,
        and nothing the client can see.
     4. RELEASE writes the rota (required, booked, pools) and the kit list, and
        opens staffing, the warehouse, the worker portal and the Picking gate.
     5. THE CLIENT'S VIEW counts against what they booked.
     6. A REVISION stays a draft until re-released, and the warehouse is told
        what changed.
     7. POOLS reach the worker portal: a worker outside every pool is not
        offered the role.
     8. EXISTING JOBS: anything past Order is treated as allocated; a seeded
        job sitting at Order with its deposit in waits for one.
     9. PERMISSION: `wof.allocate` is operations', not staffing's or the yard's.
    10. IT SURVIVES A RELOAD.

   Dates are computed, never named — see drift-check.mjs.
   Run:  node allocation-tests.mjs
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

const work = mkdtempSync(join(tmpdir(), 'eprosta-alloc-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');
let boots = 0;

async function boot() {
  boots += 1;
  const entry = join(work, `entry-${boots}.ts`);
  const out = join(work, `bundle-${boots}.mjs`);
  writeFileSync(
    entry,
    `export * as W from '${p('src/lib/wof')}';\n` +
      `export * as A from '${p('src/lib/allocation')}';\n` +
      `export * as DB from '${p('src/data/db')}';\n` +
      `export * as R from '${p('src/lib/roles')}';\n` +
      `export * as EV from '${p('src/lib/events')}';\n` +
      `export * as COV from '${p('src/lib/coverage')}';\n` +
      `export * as P from '${p('src/lib/portal')}';\n` +
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
let passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    passes += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const eq = (name, got, want) =>
  ok(name, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

const { W, A, DB, R, EV, COV, P } = await boot();
const { CHARGES, CLIENTS, EMPLOYEES } = DB;

// A client who pays a deposit — the trigger this whole feature hangs off.
const CLIENT = CLIENTS.find((c) => c.status === 'active' && c.depositPolicy !== 0);
const HOURLY = CHARGES.filter((c) => c.unit === 'hour' && c.kind === 'staff')[0];
const KIT = CHARGES.filter((c) => c.kind === 'kit' && !/replacement|excess/i.test(c.name))[0];
const OPS = { by: 'm-gracie', name: 'Gracie (Operations)' };
const CLIENT_ACTOR = { by: 'client', name: 'Client signatory' };

const pad = (n) => String(n).padStart(2, '0');
function day(n, hour = 9) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:00:00`;
}

/** A two-day job, signed: 4 stewards a day and 4 of a kit item. */
function job(title, startsIn = 12) {
  const w = W.create({
    title,
    clientId: CLIENT.id,
    start: day(startsIn, 8),
    end: day(startsIn + 1, 20),
    jobTypeId: 'festival',
  });
  W.addLine(w, HOURLY.id, { qty: 4, units: 10, description: 'Event Steward' });
  W.addLine(w, KIT.id, { qty: 4, units: 2, description: KIT.name });
  W.sendQuote(w, OPS);
  W.signQuote(w, { signedBy: CLIENT_ACTOR.name }, CLIENT_ACTOR);
  return w;
}

const someone = (w) => {
  const ev = DB.event(w.eventId);
  const sp = ev.shifts[0].splits[0];
  const cand = EMPLOYEES.find((e) => e.status === 'verified' && !sp.assignments.some((a) => a.employeeId === e.id));
  return { ev, sp, cand };
};

/* -- 1. before the deposit ---------------------------------------------- */
console.log('\n1. Before the deposit, nothing downstream moves');
const w = job('WOA TEST — Riverside Fair');
{
  ok('the signature made it an order', W.atLeast(w, 'order'), w.stage);
  ok('with a staffing event', !!w.eventId);
  ok('a deposit is due on it', W.deposit(w).due > 0, String(W.deposit(w).due));
  eq('the allocation is waiting for the deposit', A.state(w), 'deposit');
  ok('and says so', /deposit/i.test(W.allocationBlock(w) || ''), W.allocationBlock(w));
  ok('it cannot be edited yet', !A.setPools(w, someone(w).sp.id, [{ pool: A.POOLS[0], count: 1 }], OPS).ok);

  const { ev, sp, cand } = someone(w);
  const r = EV.assign(ev.id, sp.id, [cand.id]);
  eq('staffing cannot assign', r.assigned, 0);
  ok('and is told why, per person', r.refused.length === 1 && /deposit/i.test(r.refused[0].reason));
  ok('the event says it is locked', !!EV.assignLock(ev.id));
  eq('the kit list cannot go to the warehouse', W.sendToHop(w, OPS), null);
  ok('workers cannot see the job', !W.visibleToWorkers(w).visible, W.visibleToWorkers(w).reason);
  ok('Picking is blocked', W.gate(w, 'picking').block.some((m) => /deposit/i.test(m)));
}

/* -- 2. the deposit lands ------------------------------------------------ */
console.log('\n2. The deposit opens the allocation, at the sold numbers');
{
  W.recordDeposit(w, {}, OPS);
  eq('ready to allocate', A.state(w), 'ready');
  const v = A.read(w);
  const ev = DB.event(w.eventId);
  const groups = ev.shifts.reduce((n, sh) => n + sh.splits.length, 0);
  eq('one row per role group on the rota', v.staff.length, groups);
  eq('staff plan starts at what was sold', v.totals.staff, v.totals.soldStaff);
  eq('kit plan starts at what was sold', v.totals.kit, 4);
  ok('still locked for staffing until released', !!EV.assignLock(ev.id));
  ok('and the message now names the allocation', /allocation/i.test(EV.assignLock(ev.id)));
  eq('still nothing to the warehouse', W.sendToHop(w, OPS), null);
}

/* -- 3. editing is a draft ---------------------------------------------- */
console.log('\n3. Editing the plan moves nothing downstream, and nothing the client sees');
const POOL_A = A.POOLS.find((x) => x === 'London') || A.POOLS[0];
const POOL_B = A.POOLS.find((x) => x === 'Midlands') || A.POOLS[1];
let firstSplit;
{
  const valueBefore = W.contractValue(w);
  const versionsBefore = (w.quoteVersions || []).length;
  const linesBefore = JSON.stringify(w.lines.map((l) => [l.id, l.qty, l.units]));
  const ev = DB.event(w.eventId);
  firstSplit = ev.shifts[0].splits[0];
  const sold = firstSplit.required;

  ok('pools split one group', A.setPools(w, firstSplit.id, [{ pool: POOL_A, count: 3 }, { pool: POOL_B, count: 2 }], OPS).ok);
  ok('an unknown pool is refused', !A.setPools(w, firstSplit.id, [{ pool: 'Narnia', count: 1 }], OPS).ok);
  ok('a negative headcount is refused', !A.setPools(w, firstSplit.id, [{ pool: POOL_A, count: -1 }], OPS).ok);
  // A pool added at nought must still be there to type into.
  A.setPools(w, firstSplit.id, [{ pool: POOL_A, count: 3 }, { pool: POOL_B, count: 2 }, { pool: A.POOLS.find((x) => x !== POOL_A && x !== POOL_B), count: 0 }], OPS);
  eq('a pool added at zero stays in the draft', A.read(w).staff.find((r) => r.splitId === firstSplit.id).pools.length, 3);
  A.setPools(w, firstSplit.id, [{ pool: POOL_A, count: 3 }, { pool: POOL_B, count: 2 }], OPS);
  const kitLine = W.kitLines(w)[0];
  ok('kit cut from 4 to 2', A.setKit(w, kitLine.id, 2, OPS).ok);
  eq('it is a draft now', A.state(w), 'draft');

  eq('the rota is untouched', firstSplit.required, sold);
  eq('no pools on the rota yet', firstSplit.pools, undefined);
  eq('kitQty is still the sold figure', W.kitQty(w, kitLine), 4);
  ok('still locked downstream', !!EV.assignLock(ev.id));

  eq('contract value unchanged', W.contractValue(w), valueBefore);
  eq('no new quote version', (w.quoteVersions || []).length, versionsBefore);
  eq('no line touched', JSON.stringify(w.lines.map((l) => [l.id, l.qty, l.units])), linesBefore);
  eq('no variation raised', W.variationLines(w).length, 0);

  const copied = A.copyAcrossDays(w, firstSplit.id, OPS);
  ok('pools copy to the same group on the other day', copied >= 1, String(copied));
  const v = A.read(w);
  ok('every copied group carries both pools', v.staff.filter((r) => r.role === v.staff[0].role).every((r) => r.pools.length === 2));
}

/* -- 3b. a group with its own window ------------------------------------- */
console.log('\n3b. A group with its own window reads as real times, not NaN');
{
  // Deployments give a group its own window as a bare clock time from the
  // shift-pattern library — "06:00", no date. The shift carries the date.
  const sp = DB.event(w.eventId).shifts[0].splits[0];
  const was = { start: sp.start, end: sp.end };
  sp.start = '06:00';
  sp.end = '14:00';
  const row = A.read(w).staff.find((r) => r.splitId === sp.id);
  ok('start is a full date-time', /^\d{4}-\d{2}-\d{2}T06:00:00$/.test(row.start), row.start);
  ok('end is a full date-time', /^\d{4}-\d{2}-\d{2}T14:00:00$/.test(row.end), row.end);
  ok('and parses', !Number.isNaN(new Date(row.start).getTime()));
  if (was.start === undefined) delete sp.start; else sp.start = was.start;
  if (was.end === undefined) delete sp.end; else sp.end = was.end;
}

/* -- 4. release ---------------------------------------------------------- */
console.log('\n4. Release writes the rota and the kit list, and opens the job');
{
  const pre = A.releasePreview(w);
  ok('the preview allows it', !pre.block, pre.block);
  ok('and names the changes', pre.staffChanges.length >= 1 && pre.kitChanges.length === 1);
  ok('the summary names the pools', pre.summary.includes(POOL_A) && pre.summary.includes(POOL_B), pre.summary);

  const res = A.release(w, { sendKit: true }, OPS);
  ok('released', res.ok, res.error);
  ok('the kit list went to EP HOP with it', !!res.sentKit && /^EPH-/.test(res.sentKit), String(res.sentKit));
  eq('state is released', A.state(w), 'released');

  const ev = DB.event(w.eventId);
  const sp = ev.shifts[0].splits[0];
  eq('the group now needs 5', sp.required, 5);
  eq('and remembers the 4 that were sold', sp.booked, 4);
  eq('with both pools on it', A.describePools(sp.pools), `3 ${POOL_A} + 2 ${POOL_B}`);
  eq('the largest pool becomes its office', sp.office, POOL_A);

  const kitLine = W.kitLines(w)[0];
  eq('kitQty is the allocation', W.kitQty(w, kitLine), 2);
  eq('the warehouse manifest says 2', w.picking.manifest[0].qty, 2);
  eq('the client is still billed for 4', kitLine.qty, 4);

  ok('nothing locks staffing now', !EV.assignLock(ev.id));
  const cand = EMPLOYEES.find((e) => e.status === 'verified' && e.available && e.office === POOL_A);
  const r = EV.assign(ev.id, sp.id, [cand.id]);
  eq('staffing can assign', r.assigned, 1);
  ok('workers can see the job', W.visibleToWorkers(w).visible);
  ok('Picking is no longer blocked by allocation', !W.gate(w, 'picking').block.some((m) => /allocation|deposit/i.test(m)));
  ok('the history says who released what', w.history.some((h) => /Allocation \(WOA\) released/.test(h.note) && h.by === OPS.by));
}

/* -- 5. the client's view ------------------------------------------------ */
console.log("\n5. The client's portal counts against what they booked");
{
  const ev = DB.event(w.eventId);
  const ops = COV.eventCoverage(ev);
  const cli = COV.clientEventCoverage(ev);
  const v = A.read(w);
  eq('staffing fills against the allocation', ops.required, v.totals.staff);
  eq('the client sees what they booked', cli.required, v.totals.soldStaff);
  ok('filled is never shown above the booking', cli.filled <= cli.required);
}

/* -- 6. a revision ------------------------------------------------------- */
console.log('\n6. Editing after release is a revision until it is re-released');
{
  const kitLine = W.kitLines(w)[0];
  A.setKit(w, kitLine.id, 3, OPS);
  eq('state is revising', A.state(w), 'revising');
  eq('the yard still has 2', W.kitQty(w, kitLine), 2);
  eq('no change the warehouse has not seen, yet', W.kitChangesSincePush(w).length, 0);
  ok('staffing is NOT locked by a revision', !EV.assignLock(w.eventId));

  const res = A.release(w, { sendKit: false }, OPS);
  ok('re-released', res.ok, res.error);
  eq('second release counted', w.allocation.releases, 2);
  eq('kitQty moved to 3', W.kitQty(w, kitLine), 3);
  const ch = W.kitChangesSincePush(w);
  ok('the Picking tab now reports 2 → 3 for a re-send', ch.length === 1 && ch[0].from === 2 * kitLine.units && ch[0].to === 3 * kitLine.units, JSON.stringify(ch));
  ok('nothing to release when nothing changed', !!A.releasePreview(w).block);
}

/* -- 7. pools reach the worker portal ------------------------------------ */
console.log('\n7. A worker outside every allocated pool is not offered the role');
{
  const inside = EMPLOYEES.find((e) => e.status === 'verified' && e.office === POOL_A && !DB.event(w.eventId).shifts.some((sh) => sh.splits.some((sp) => sp.assignments.some((a) => a.employeeId === e.id))));
  const outside = EMPLOYEES.find((e) => e.status === 'verified' && e.office !== 'All Offices' && e.office !== POOL_A && e.office !== POOL_B);
  ok('fixture has a worker in the pool and one outside', !!inside && !!outside);
  P.setActingStaff(inside.id);
  ok('the London worker is offered it', P.openEventRoles().some((r) => r.event.id === w.eventId));
  P.setActingStaff(outside.id);
  ok(`the ${outside.office} worker is not`, !P.openEventRoles().some((r) => r.event.id === w.eventId));
}

/* -- 8. existing jobs ---------------------------------------------------- */
console.log('\n8. Jobs already moving are treated as allocated; one at Order waits');
{
  const live = W.all().find((x) => x.id === 'wof-101');
  eq('a job in delivery is legacy', A.state(live), 'legacy');
  ok('and is not locked', !W.allocationBlock(live));
  const atOrder = W.all().find((x) => x.id === 'wof-108');
  ok('a seeded job at Order with its deposit in needs allocating', ['ready', 'draft'].includes(A.state(atOrder)), A.state(atOrder));
  ok('its event is locked for staffing', !!EV.assignLock(atOrder.eventId));
  const unpaid = W.all().find((x) => x.id === 'wof-105');
  eq('a seeded job at Order without its deposit is waiting for it', A.state(unpaid), 'deposit');
}

/* -- 9. permission ------------------------------------------------------- */
console.log('\n9. Allocating is an operations permission');
{
  ok('Operations hold it', R.ROLES.ops.caps.includes('wof.allocate'));
  ok('Senior managers hold it', R.ROLES['senior-manager'].caps.includes('wof.allocate'));
  for (const id of ['recruitment', 'scheduling', 'warehouse', 'client-manager', 'finance', 'readonly'])
    ok(`${id} does not`, !R.ROLES[id].caps.includes('wof.allocate'));
}

/* -- 10. reload ----------------------------------------------------------- */
console.log('\n10. It survives a reload');
{
  const R2 = await boot();
  const w2 = R2.W.byId(w.id);
  ok('the job is back', !!w2);
  ok('released, twice', w2?.allocation?.releasedAt && w2.allocation.releases === 2);
  eq('the kit allocation is back', R2.W.kitQty(w2, R2.W.kitLines(w2)[0]), 3);
  const sp2 = R2.DB.event(w2.eventId).shifts[0].splits[0];
  eq('the group still needs 5', sp2.required, 5);
  eq('booked survives', sp2.booked, 4);
  ok('pools survive', (sp2.pools || []).length === 2, JSON.stringify(sp2.pools));
  ok('still open to staffing', !R2.EV.assignLock(w2.eventId));
  const seeded = R2.W.byId('wof-108');
  ok('a seeded job still waits for its allocation', !!R2.W.allocationBlock(seeded));
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
console.log('All allocation checks passed.');
