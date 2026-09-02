/* ============================================================================
   EPROSTA — verification harness for confirmation
   ----------------------------------------------------------------------------
   Briefing §2.2: "Once a WOF has passed client sign off and becomes an order,
   it will seed the event calendar and subsequently provide shifts for the staff
   allocation tool."

   That is one act. The system used to implement it as three — record the
   signature, click to sign-off, click to order — with the seeding hidden behind
   the third click, so a signed job could sit unstaffed for as long as nobody
   remembered to advance it. `signQuoteAndConfirm()` now closes that gap, and
   this file proves the six claims it makes:

     1. A SIGNATURE ORDERS THE JOB — on its own, through `signoff` rather than
        over it, so the history keeps both moments and "when did they sign"
        stays answerable.

     2. THE ROTA EXISTS THE MOMENT THEY SIGN — one shift per day of the run,
        role slots matching the quantities on the quote. Not one 129-hour shift,
        and not nothing.

     3. THE KIT LIST IS PREPARED, NOT SENT — a manifest is held in the office
        with NO EP HOP reference on it. The reference is the thing that must
        be issued once and never reissued, and a quote can still gain a
        variation between sign-off and picking.

     4. WHAT DOES NOT APPLY IS NOT INVENTED — a kit-only hire gets no empty
        rota, and a staff-only job gets no empty pick list. An empty rota
        reading "fully staffed" is the failure this rebuild exists to remove.

     5. A BLOCKED JOB STOPS AND SAYS WHY — a signature is a fact about the
        client, not a licence to skip a check about us. It never forces a gate.

     6. IT ALL SURVIVES A RELOAD — a confirmation that evaporates overnight is
        worse than one that never happened, because the operator has stopped
        watching for it.

   Run:  node confirm-tests.mjs
   ----------------------------------------------------------------------------
   Same bundling trick as the other harnesses: browser-flavoured modules using
   the `@/` alias, bundled by esbuild with a shimmed localStorage. Everything
   comes from ONE bundle — two bundles means two copies of `EVENTS` and `WOFS`,
   and the tests would then pass or fail for reasons that have nothing to do
   with the product.
   ========================================================================== */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

/* --------------------------------------------------------- localStorage --- */
/* Kept across "reloads" on purpose — that is what makes them reloads.        */

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

/* ---------------------------------------------------------------- bundle --- */

const work = mkdtempSync(join(tmpdir(), 'eprosta-confirm-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');

let generation = 0;

/** Bundle and import a fresh copy of the modules — i.e. reload the tab. */
async function boot() {
  generation += 1;
  const entry = join(work, `entry-${generation}.ts`);
  const out = join(work, `bundle-${generation}.mjs`);
  writeFileSync(
    entry,
    `export * as DB from '${p('src/data/db')}';\n` +
      `export * as W from '${p('src/lib/wof')}';\n`,
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
  const mod = await import(pathToFileURL(out).href);
  mod.W.load();
  return mod;
}

/* ------------------------------------------------------------------ tiny --- */

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ok    ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`);
  }
};
const section = (n) => console.log(`\n${n}`);

let { DB, W } = await boot();

/** A quoted job with staff and kit on it, ready to be signed. */
const quoted = (cfg = {}) => {
  const w = W.create({ jobCode: `TEST-CNF-${Math.random().toString(36).slice(2, 7)}`, ...cfg });
  (cfg.lines || [['ch-st-event', { qty: 6, units: 8 }], ['ch-kit-radio', { qty: 12, units: 2 }]])
    .forEach(([id, opts]) => W.addLine(w, id, opts));
  W.advance(w, { to: 'quote' });
  return w;
};

const sign = (w, actor) =>
  W.signQuoteAndConfirm(w, { signedBy: 'Dana Fletcher', signedByRole: 'Ops Director' }, actor);

/* ========================================================================== */
section('1. The signature orders the job, through sign-off rather than over it');

const w1 = quoted({ title: 'CONFIRMS ITSELF' });
ok('it starts at quote, not order', w1.stage === 'quote');
const c1 = sign(w1);

ok('signing reports the job as ordered', c1.ordered === true);
ok('  · and the stage agrees', w1.stage === 'order');
ok('  · with nothing blocking it', c1.blocked.length === 0);

const stages = w1.history.map((h) => h.stage);
ok('the history passes through sign-off', stages.includes('signoff'));
ok('  · and lands on order', stages.includes('order'));
ok('  · in that order, not the other way round',
  stages.lastIndexOf('signoff') < stages.lastIndexOf('order'));
ok('the signature itself is recorded', !!w1.signoff && w1.signoff.signedBy === 'Dana Fletcher');
ok('orderedAt is stamped, so downstream dates have something to derive from', !!w1.orderedAt);

const orderNote = w1.history.find((h) => h.stage === 'order').note;
ok('the order entry says a signature caused it, not "moved to order"',
  /signature/i.test(orderNote), orderNote);

/* ========================================================================== */
section('2. The rota exists the moment they sign');

ok('an event was seeded', !!w1.eventId && !!DB.event(w1.eventId));
const ev1 = DB.event(w1.eventId);
ok('  · and the confirmation counted it', c1.event && c1.event.id === ev1.id);
ok('  · with shifts on it, not an empty record', c1.shifts > 0 && c1.shifts === ev1.shifts.length);
ok('  · and role slots to fill', c1.roles > 0);

const req = ev1.shifts.flatMap((s) => s.splits).reduce((n, sp) => n + sp.required, 0);
ok('the requirement matches the quantity sold, per day',
  req === 6 * ev1.shifts.length, `${req} vs ${6 * ev1.shifts.length}`);
ok('no shift runs the whole event as one block',
  ev1.shifts.every((s) => (+new Date(s.end) - +new Date(s.start)) / 36e5 <= 24));
ok('nobody is assigned yet — seeding rosters the need, not the people',
  ev1.shifts.every((s) => s.splits.every((sp) => sp.assignments.length === 0)));

/* ========================================================================== */
section('3. The kit is prepared for the warehouse, and not sent to it');

ok('a kit list was prepared', !!w1.kitPrep);
ok('  · attributed to the confirmation, not to a manual click',
  w1.kitPrep.source === 'confirmation');
ok('  · holding the kit lines from the quote', w1.kitPrep.manifest.length === 1);
ok('  · with the quantity on it', c1.kitItems === 12);
ok('NOTHING has gone to EP HOP', w1.picking === null || w1.picking === undefined);
ok('  · so no reference has been burned',
  !JSON.stringify(w1.kitPrep).includes('HH-2026-'));

const prepNote = w1.history.find((h) => /prepared/i.test(h.note)).note;
ok('and the trail says so in words, not a status code',
  /not yet sent to EP HOP/i.test(prepNote), prepNote);

section('   … and a variation after confirmation is visible before it is picked');

W.addLine(w1, 'ch-kit-lighting', { qty: 4, units: 2 });
const drift = W.kitChangesSincePrep(w1);
ok('the change since preparation is reported', drift.length === 1);
ok('  · named, rather than counted', /Tower light/i.test(drift[0].description));
ok('  · as an addition', drift[0].kind === 'added');

const pk = W.sendToHop(w1);
ok('sending now assigns the reference — once, and with the EP HOP prefix',
   /^EPH-2026-\d+$/.test(pk.epHopRef), pk.epHopRef);
ok('  · and sends what is on the job now, not what was prepared',
  pk.manifest.length === 2);
ok('  · leaving nothing outstanding for the warehouse',
  W.kitChangesSincePush(w1).length === 0);

const ref = pk.epHopRef;
W.sendToHop(w1);
ok('a re-send keeps the same reference', w1.picking.epHopRef === ref);

/* ========================================================================== */
section('4. What does not apply is not invented');

const kitOnly = quoted({
  title: 'KIT ONLY HIRE',
  lines: [['ch-kit-buggy', { qty: 1, units: 3 }], ['ch-kit-welfare', { qty: 1, units: 3 }]],
});
const cKit = sign(kitOnly);
ok('a kit-only hire still becomes an order', cKit.ordered === true);
ok('  · but gets no staffing event', cKit.event === null && !kitOnly.eventId);
ok('  · and no shifts are claimed', cKit.shifts === 0 && cKit.roles === 0);
ok('  · while its kit IS prepared', !!kitOnly.kitPrep && cKit.kitItems === 2);
ok('  · and hasStaffWork() agrees there is nobody to roster', W.hasStaffWork(kitOnly) === false);

const staffOnly = quoted({
  title: 'STAFF ONLY JOB',
  lines: [['ch-st-carpark', { qty: 3, units: 8 }]],
});
const cStaff = sign(staffOnly);
ok('a staff-only job becomes an order', cStaff.ordered === true);
ok('  · with a rota', cStaff.roles > 0);
ok('  · and no pick list, rather than an empty one',
  cStaff.kit === null && !staffOnly.kitPrep);
ok('  · so the picking screen has nothing to claim was prepared',
  W.kitChangesSincePrep(staffOnly).length === 0);

/* ========================================================================== */
section('5. A blocked job stops where it is, and says why');

const empty = W.create({ title: 'NOTHING PRICED', jobCode: 'TEST-CNF-EMPTY' });
const cEmpty = sign(empty);
ok('an unpriced quote is not ordered', cEmpty.ordered === false);
ok('  · the stage did not move to order', empty.stage !== 'order');
ok('  · a reason came back', cEmpty.blocked.length > 0);
ok('  · and it names the missing thing', /priced lines/i.test(cEmpty.blocked.join(' ')),
  cEmpty.blocked.join(' | '));
ok('  · nothing was seeded on the way', !empty.eventId && !empty.kitPrep);
ok('the signature is still recorded, because they did sign', !!empty.signoff);
ok('and describeConfirmation() says so rather than claiming success',
  /not an order yet/i.test(W.describeConfirmation(cEmpty)), W.describeConfirmation(cEmpty));

/* ========================================================================== */
section('   … and confirming twice does not double anything');

const before = w1.history.length;
const again = W.confirmOrder(w1);
ok('a second confirmation is a no-op on the stage', w1.stage === 'order');
ok('  · it does not seed a second event', again.event && again.event.id === w1.eventId);
ok('  · and writes no new history', w1.history.length === before);

/* ========================================================================== */
section('   … and the preview matches what actually happens');

const w6 = quoted({ title: 'PREVIEWED', lines: [['ch-st-sia', { qty: 2, units: 12 }], ['ch-kit-cone', { qty: 40, units: 4 }]] });
const pv = W.orderPreview(w6);
const c6 = sign(w6);
ok('the previewed shift count was right', pv.shifts === c6.shifts, `${pv.shifts} vs ${c6.shifts}`);
ok('the previewed role count was right', pv.roles === c6.roles, `${pv.roles} vs ${c6.roles}`);
ok('the previewed kit count was right', pv.kitItems === c6.kitItems);
ok('and it did not create anything by looking', pv.alreadySeeded === false);

/* ========================================================================== */
section('6. It all survives a reload');

const id = w6.id;
const evId = w6.eventId;
const prepAt = w6.kitPrep.preparedAt;
const orderedAt = w6.orderedAt;

({ DB, W } = await boot());
const back = W.byId(id);

ok('the job is still there', !!back);
ok('  · still at order', back.stage === 'order');
ok('  · orderedAt survived', back.orderedAt === orderedAt);
ok('  · the signature survived', !!back.signoff);
ok('  · the prepared kit list survived', !!back.kitPrep && back.kitPrep.preparedAt === prepAt);
ok('  · attributed to the confirmation still', back.kitPrep.source === 'confirmation');
ok('  · and the staffing event is still findable', back.eventId === evId && !!DB.event(evId));
ok('  · with its shifts intact', DB.event(evId).shifts.length > 0);

/* ================================================================ summary == */

rmSync(work, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
