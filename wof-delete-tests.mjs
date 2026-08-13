/* ============================================================================
   EPROSTA — verification harness for deleting a work order
   ----------------------------------------------------------------------------
   Delete is the only action in the WOF pipeline with no undo behind it, so the
   claims `deletable()` and `remove()` make are worth proving rather than
   assuming. This file proves five of them:

     1. A SEEDED WOF IS REFUSED — `load()` rebuilds the seeded pipeline from the
        seed literals on every boot, so deleting one of those would undo itself
        at the next reload. That is worse than refusing, because it looks like
        success until tomorrow. The refusal has to be real, not cosmetic: the
        menu item is disabled AND `remove()` returns false if it is called
        anyway.

     2. A WOF RAISED HERE GOES, AND STAYS GONE — including across a reload,
        which is the whole point of (1).

     3. THE STAFFING EVENT GOES WITH IT — an event seeded from a WOF exists
        only because that WOF ordered it. Leaving it behind would strand a
        rota nothing owns, visible on the staffing screen with no job behind it.

     4. THE CALENDAR ENTRY IS RELEASED — a schedule entry claimed by a deleted
        WOF must go back to reading "awaiting a WOF", or the calendar shows a
        slot claimed by a job that no longer exists and nobody can raise a new
        WOF against it.

     5. THE COLLATERAL IS NAMED BEFORE IT IS DESTROYED — `destroys` is what the
        confirm dialog renders. An empty or wrong list means an operator
        confirming a delete does not know what they are agreeing to.

   Run:  node wof-delete-tests.mjs
   ----------------------------------------------------------------------------
   Same bundling trick as the other harnesses: browser-flavoured modules using
   the `@/` alias, bundled by esbuild with a shimmed localStorage. Everything
   comes from ONE bundle — two bundles means two copies of `EVENTS` and
   `WOFS`, and the tests would then pass or fail for reasons that have nothing
   to do with the product.
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

const work = mkdtempSync(join(tmpdir(), 'eprosta-wof-delete-'));
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

/* ========================================================================== */
section('1. A seeded WOF cannot be deleted');

const seeded = W.byId('wof-101');
const seededVerdict = W.deletable(seeded);
ok('deletable() refuses it', seededVerdict.ok === false);
ok('  · and says why, in words an operator can act on',
  /reload|cancel/i.test(seededVerdict.reason), seededVerdict.reason);
ok('  · with nothing listed as collateral, because nothing is destroyed',
  seededVerdict.destroys.length === 0);
ok('remove() refuses too, rather than trusting the caller', W.remove(seeded) === false);
ok('  · and the job is still in the pipeline', !!W.byId('wof-101'));

/* ========================================================================== */
section('2. A WOF raised in this browser is deleted for good');

const before = W.all().length;
const w1 = W.create({ title: 'DELETE ME', jobCode: 'TEST-DEL-1', venue: 'Nowhere' });
ok('it was created', W.all().length === before + 1);
ok('deletable() allows it', W.deletable(w1).ok === true);
ok('remove() reports success', W.remove(w1) === true);
ok('  · it is gone from the store', W.byId(w1.id) === undefined);
ok('  · and the count is back where it started', W.all().length === before);

const w2 = W.create({ title: 'GONE FOR GOOD', jobCode: 'TEST-DEL-2' });
const w2id = w2.id;
W.remove(w2);
({ DB, W } = await boot());
ok('still absent after a reload', W.byId(w2id) === undefined);
ok('  · and the seeded pipeline survived the delete',
  W.all().filter((x) => x.id.startsWith('wof-1')).length >= 11);

/* ========================================================================== */
section('3. The staffing event goes with the job');

const w3 = W.create({ title: 'WITH STAFF', jobCode: 'TEST-DEL-3' });
W.addLine(w3, 'ch-st-event', { qty: 4, units: 8 });
W.advance(w3, { to: 'order', force: true });
const evId = w3.eventId;
ok('ordering seeded an event', !!evId && !!DB.event(evId));

const verdict = W.deletable(w3);
ok('the event is named before it is destroyed',
  verdict.destroys.some((d) => d.includes('staffing event')), verdict.destroys.join(' | '));

W.remove(w3);
ok('the event is gone from EVENTS', DB.event(evId) === undefined);
ok('  · and no WOF is left pointing at it', !W.all().some((x) => x.eventId === evId));
ok('  · and it does not come back on reload', (({ DB: d2 }) => !d2.event(evId))(await boot()));

({ DB, W } = await boot());

/* ========================================================================== */
section('4. A claimed calendar entry is released');

const orphan = W.calendarRows().find((r) => !r.wof && r.schedule);
ok('there is an unclaimed calendar entry to test with', !!orphan);

const w4 = W.create({ scheduleId: orphan.scheduleId, title: 'CLAIMS A SLOT', jobCode: 'TEST-DEL-4' });
ok('raising against it claims the slot', DB.schedule(orphan.scheduleId).wofId === w4.id);
ok('  · and the delete warns that the link goes',
  W.deletable(w4).destroys.some((d) => d.includes('calendar entry')));

W.remove(w4);
ok('the slot is unclaimed again', DB.schedule(orphan.scheduleId).wofId === null);
ok('  · the entry itself survives', !!DB.schedule(orphan.scheduleId));
ok('  · and it reads as awaiting a WOF once more',
  !W.calendarRows().find((r) => r.scheduleId === orphan.scheduleId).wof);

/* ========================================================================== */
section('5. Collateral is named specifically, not generically');

const w5 = W.create({ title: 'FULL HOUSE', jobCode: 'TEST-DEL-5' });
W.addLine(w5, 'ch-st-event', { qty: 6, units: 8 });
W.advance(w5, { to: 'order', force: true });
W.advance(w5, { to: 'documents', force: true });
W.advance(w5, { to: 'picking', force: true });
W.advance(w5, { to: 'job', force: true });
W.advance(w5, { to: 'invoice', force: true });

const full = W.deletable(w5);
ok('the invoice number is named', full.destroys.some((d) => d.includes(w5.invoice.number)));
ok('the audit trail is named', full.destroys.some((d) => d.includes('audit trail')));
ok('  · with a real count on it, not "some"', /\d+ history entr/.test(full.destroys.join(' ')));
ok('every line is a sentence, not a field name',
  full.destroys.every((d) => d.length > 12 && !/^[a-z]+[A-Z]/.test(d)), full.destroys.join(' | '));

W.remove(w5);
ok('and it deletes cleanly from the last stage', W.byId(w5.id) === undefined);

/* ================================================================ summary == */

rmSync(work, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
