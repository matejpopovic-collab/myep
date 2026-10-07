/* ============================================================================
   EPROSTA — verification harness for the Event info tab
   ----------------------------------------------------------------------------
   The tab is the page a new WOF opens on. What it promises:

     1. A NEW WOF STARTS FROM ITS CLIENT — service lines default to what EP
        sells the account; nobody is named in a responsible role yet.
     2. SAVING WRITES THE FIELDS AND SURVIVES A RELOAD, and the history names
        what changed.
     3. A DUPLICATE JOB CODE IS REFUSED, and nothing is written.
     4. THE CLIENT LOCKS once the quote has lines (they are priced on its rates).
     5. THE DATES LOCK once a staffing event exists, and a new span that cuts
        off a day the deployment grid uses is refused.

   Run:  node eventinfo-tests.mjs   (same bundling trick as the other harnesses)
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

const work = mkdtempSync(join(tmpdir(), 'eprosta-eventinfo-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');
let generation = 0;
async function boot() {
  generation += 1;
  const entry = join(work, `entry-${generation}.ts`);
  const out = join(work, `bundle-${generation}.mjs`);
  writeFileSync(entry, `export * as DB from '${p('src/data/db')}';\nexport * as W from '${p('src/lib/wof')}';\n`);
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
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
};
const section = (n) => console.log(`\n${n}`);

let { DB, W } = await boot();

/* ========================================================================== */
section('1. A new WOF starts from its client');
const client = DB.CLIENTS.find((c) => c.status === 'active');
// The seed carries no services on most accounts; give this one two.
client.serviceTypes = ['event', 'traffic'];
let w = W.create({ title: 'Night event', clientId: client.id, start: '2026-11-12T10:00:00', end: '2026-11-18T18:00:00' });
ok('service lines copied from the client', JSON.stringify([...w.serviceIds].sort()) === JSON.stringify([...client.serviceTypes].sort()),
  `${w.serviceIds} vs ${client.serviceTypes}`);
ok('nobody in a responsible role yet', Object.keys(w.people || {}).length === 0);
ok('provisional by default', w.confirmed === false);
ok('dates editable on a fresh WOF', W.datesLock(w) === null);
ok('client editable on a fresh WOF', W.clientLock(w) === null);

/* ========================================================================== */
section('2. Saving writes the fields, names them, and survives a reload');
const team = DB.TEAM.find((t) => t.name === 'Becky Bumford');
let f = W.eventInfoOf(w);
f.costCode = 'CC-104';
f.workGroup = 'South';
f.confirmed = true;
f.people = { ...f.people, opsLead: team.id };
f.serviceIds = ['event', 'staffing'];
f.start = '2026-11-12T08:00';
let r = W.updateEventInfo(w, f);
ok('save succeeds', r.ok, JSON.stringify(r.errors));
ok('history names the change', /Event info edited:.*cost code → CC-104/.test(w.history.at(-1).note), w.history.at(-1).note);
ok('start time moved', w.start.startsWith('2026-11-12T08:00'));
const id = w.id;
({ DB, W } = await boot());
w = W.byId(id);
ok('cost code survives reload', w.costCode === 'CC-104');
ok('ops lead survives reload', w.people.opsLead === team.id);
ok('confirmed survives reload', w.confirmed === true);
ok('service lines survive reload', JSON.stringify(w.serviceIds) === JSON.stringify(['event', 'staffing']));
const before = w.history.length;
r = W.updateEventInfo(w, W.eventInfoOf(w));
ok('saving an unchanged form writes no history', r.ok && w.history.length === before);

/* ========================================================================== */
section('3. A duplicate job code is refused');
const other = W.all().find((x) => x.id !== w.id);
f = W.eventInfoOf(w);
f.jobCode = other.jobCode;
f.costCode = 'SHOULD-NOT-LAND';
r = W.updateEventInfo(w, f);
ok('refused', !r.ok && !!r.errors.jobCode);
ok('nothing written', w.costCode === 'CC-104');

/* ========================================================================== */
section('4. The client locks once the quote has lines');
const priced = W.all().find((x) => x.lines.length && !x.eventId) || W.all().find((x) => x.lines.length);
ok('locked with a reason', !!W.clientLock(priced));
f = W.eventInfoOf(priced);
f.clientId = DB.CLIENTS.find((c) => c.id !== priced.clientId).id;
ok('a client swap is an error', !!W.eventInfoErrors(priced, f).clientId);

/* ========================================================================== */
section('5. Dates lock with an event, and cannot cut off a planned day');
const withEvent = W.all().find((x) => x.eventId);
ok('locked once an event exists', !!W.datesLock(withEvent));
f = W.eventInfoOf(withEvent);
f.end = '2030-01-01T18:00';
ok('moving them is an error', !!W.eventInfoErrors(withEvent, f).start);

w.patterns = [{ id: 'p-t', area: 'Test', placeId: null, shiftPatternId: 'x', days: [5] }];
f = W.eventInfoOf(w);
f.end = '2026-11-13T18:00';
const e = W.eventInfoErrors(w, f);
ok('shrinking below day 5 is refused', !!e.end && /day 5/.test(e.end), e.end);
f.end = '2026-11-11T18:00';
ok('an end before the start is refused', /after the start/.test(W.eventInfoErrors(w, f).end || ''));
w.patterns = [];

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
