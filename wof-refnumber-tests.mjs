/* ============================================================================
   EPROSTA — verification harness for WOF reference allocation
   ----------------------------------------------------------------------------
   `create()` issues the job number that everything downstream is keyed on: the
   WOF id, the WOF ref, the staffing event's id (`ev-wof-<n>`), and every shift
   and split id under it. If two jobs can be issued the same number, the two
   staffing events collide on one id, and `event(id)` — a plain `find` — returns
   whichever was pushed first. The second event becomes unreachable: clicking it
   on the staffing screen opens the other job.

   That is not a hypothetical. The number was allocated by COUNTING the jobs in
   the pipeline, and a count goes down when a job is deleted, so the next job
   re-issues a number already in use. `nextHireHopRef()` two hundred lines up
   solves the same problem correctly — scan what has been issued, take the first
   free one — and says in its own comment why: "two jobs sharing a warehouse
   reference is exactly the class of bug that produced the duplicate YYY client
   codes". This file holds `create()` to the same standard.

     1. NUMBERS ARE UNIQUE ACROSS A DELETE — raise three, delete the middle one,
        raise a fourth. The fourth must not re-use a live number.

     2. THE STAFFING EVENT IS REACHABLE — every event on the staffing screen
        must resolve, via its own id, back to itself. An event you cannot open
        is worse than one that does not exist.

   Run:  node wof-refnumber-tests.mjs
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

const work = mkdtempSync(join(tmpdir(), 'eprosta-wof-ref-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');

let generation = 0;

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

const { DB, W } = await boot();

/* ========================================================================== */
section('1. A deleted job does not release its number to the next job');

const a = W.create({ title: 'REF TEST A' });
const b = W.create({ title: 'REF TEST B' });
const c = W.create({ title: 'REF TEST C' });

ok('three jobs, three distinct ids',
  new Set([a.id, b.id, c.id]).size === 3, `${a.id} ${b.id} ${c.id}`);
ok('  · and three distinct references',
  new Set([a.ref, b.ref, c.ref]).size === 3, `${a.ref} ${b.ref} ${c.ref}`);

// Delete the MIDDLE one. Deleting the newest would legitimately free the top
// number; deleting from the middle leaves a hole that a count cannot see.
W.remove(b);

const d = W.create({ title: 'REF TEST D' });

ok('the job raised after a delete does not re-use a live id',
  d.id !== a.id && d.id !== c.id, `${d.id} collides`);
ok('  · nor a live reference',
  d.ref !== a.ref && d.ref !== c.ref, `${d.ref} collides`);

const ids = W.all().map((w) => w.id);
ok('  · and no two jobs in the pipeline share an id',
  new Set(ids).size === ids.length,
  ids.filter((x, i) => ids.indexOf(x) !== i).join(', '));

const refs = W.all().map((w) => w.ref);
ok('  · nor a reference',
  new Set(refs).size === refs.length,
  refs.filter((x, i) => refs.indexOf(x) !== i).join(', '));

/* ========================================================================== */
section('2. Every staffing event can be opened from the staffing screen');

// Give the colliding pair staff, so each seeds a real staffing event.
for (const w of [c, d]) W.addLine(w, 'ch-st-event', { qty: 4, units: 8 });

const evC = W.seedEvent(c);
const evD = W.seedEvent(d);

ok('both jobs seeded a staffing event', !!evC && !!evD);
ok('  · with distinct event ids',
  !!evC && !!evD && evC.id !== evD.id, `${evC?.id} vs ${evD?.id}`);

// This is the click. The card links to /events/<ev.id>; the detail page resolves
// it with DB.event(id). Landing on a different job is the reported bug.
ok('opening the newer event lands on the newer event',
  !!evD && DB.event(evD.id)?.name === evD.name,
  `opened "${DB.event(evD?.id)?.name}", expected "${evD?.name}"`);

const evIds = DB.EVENTS.map((e) => e.id);
ok('  · and no two events anywhere share an id',
  new Set(evIds).size === evIds.length,
  evIds.filter((x, i) => evIds.indexOf(x) !== i).join(', '));

/* ========================================================================== */
section('3. The job code the raise dialog promises is the one issued');

// The dialog shows `nextRef()` in the job code field before the WOF exists. An
// operator who reads a reference off that field and writes it on a purchase
// order needs it to be the reference the job actually gets.
const promised = W.nextRef();
ok('previewing does not consume the number', W.nextRef() === promised, promised);

const e = W.create({ title: 'REF TEST E' });
ok('the job is issued the reference that was previewed',
  e.ref === promised, `promised ${promised}, issued ${e.ref}`);
ok('  · and the next preview has moved on', W.nextRef() !== promised);

/* ========================================================================== */
section('4. A collision already written to disk is repaired on the next load');

// Forge the state the old allocator produced: two jobs on one number, each with
// a staffing event on the same id. This is what is sitting in the browser of
// anyone who deleted a job before the fix landed, and the fix above cannot
// reach it — the record is only repairable on the way in.
const raw = JSON.parse(globalThis.localStorage.getItem('eprosta.wof.v1'));
const donorWof = raw.wofs.find((w) => w.id === c.id);
const donorEv = raw.events.find((e) => e.id === `ev-wof-${c.id.replace('wof-', '')}`);

const twinWof = JSON.parse(JSON.stringify(donorWof));
twinWof.title = 'THE UNREACHABLE ONE';
const twinEv = JSON.parse(JSON.stringify(donorEv));
twinEv.name = 'THE UNREACHABLE ONE';
// A worker already rostered on the twin — the repair must not cost them a shift.
twinEv.shifts[0].splits[0].assignments = [
  { employeeId: 'e-9', status: 'confirmed', checkIn: null, note: '' },
];

raw.wofs.push(twinWof);
raw.events.push(twinEv);
delete raw.issued; // saved before the high-water mark existed
globalThis.localStorage.setItem('eprosta.wof.v1', JSON.stringify(raw));

const { DB: DB2, W: W2 } = await boot();

const twin = W2.all().find((w) => w.title === 'THE UNREACHABLE ONE');
const orig = W2.all().find((w) => w.id === c.id);

ok('both jobs survived the repair', !!twin && !!orig);
ok('  · on different ids', !!twin && twin.id !== c.id, twin?.id);
ok('  · and different references', !!twin && !!orig && twin.ref !== orig.ref);

const healedIds = W2.all().map((w) => w.id);
ok('  · with no duplicate left in the pipeline',
  new Set(healedIds).size === healedIds.length);

const healedEvIds = DB2.EVENTS.map((e) => e.id);
ok('  · nor among the events', new Set(healedEvIds).size === healedEvIds.length,
  healedEvIds.filter((x, i) => healedEvIds.indexOf(x) !== i).join(', '));

ok('the previously unreachable event now opens as itself',
  !!twin && DB2.event(twin.eventId)?.name === 'THE UNREACHABLE ONE',
  `opened "${DB2.event(twin?.eventId)?.name}"`);
ok('  · and the other job still opens as itself',
  !!orig && DB2.event(orig.eventId)?.name === orig.title,
  `opened "${DB2.event(orig?.eventId)?.name}"`);

const moved = DB2.event(twin?.eventId);
ok('  · the rostered worker came with it',
  moved?.shifts[0]?.splits[0]?.assignments?.[0]?.employeeId === 'e-9');
ok('  · and its shift and split ids moved too, rather than dangling',
  !!moved && moved.shifts.every((s) =>
    s.id.includes(String(twin.id).replace('wof-', '')) &&
    s.splits.every((p) => p.id.startsWith(moved.id))),
  moved?.shifts[0]?.id);

// The repair is written, not recomputed — otherwise every boot reshuffles.
const twinIdAfterHeal = twin.id;
const { W: W3 } = await boot();
ok('the repair is stable across a further reload',
  !!W3.all().find((w) => w.id === twinIdAfterHeal), twinIdAfterHeal);

/* ========================================================================== */
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
