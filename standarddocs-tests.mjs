/* ============================================================================
   EPROSTA — verification harness for the standard document library
   ----------------------------------------------------------------------------
   Proves the rules in src/lib/standarddocs.ts: only EP documents can be
   standard; raising a WOF attaches every file that fits and is valid through
   the event's end; approval on attach is per document; jobs keep their own
   copy when the library file is replaced; withdrawal and settings survive a
   reload. Run:  node standarddocs-tests.mjs
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

const work = mkdtempSync(join(tmpdir(), 'eprosta-stddocs-'));
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
      `export * as W from '${p('src/lib/wof')}';\n` +
      `export * as S from '${p('src/lib/schedules')}';\n` +
      `export * as JT from '${p('src/lib/jobtypes')}';\n` +
      `export * as JF from '${p('src/lib/jobfiles')}';\n` +
      `export * as SD from '${p('src/lib/standarddocs')}';\n`,
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
const group = (t) => console.log(`\n${t}`);



const DAY = 86400000;
const dayOut = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const pdf = (name, size = 2048) => new File([new Uint8Array(size)], name, { type: 'application/pdf' });

let { DB, W, S, JT, JF, SD } = await boot();
const ACTOR = { by: 'm-jake', name: 'Jake Wright' };
const raise = (title, endDay = 60) =>
  W.create({
    title, clientId: DB.CLIENTS.find((c) => c.status === 'active').id, jobTypeId: 'festival',
    start: `${dayOut(endDay - 1)}T09:00:00`, end: `${dayOut(endDay)}T18:00:00`, ownerId: DB.MANAGERS[0].id,
  });
const row = (w, id) => w.documents.find((d) => d.docId === id);

/* =========================================================== 1. library == */
group('1. What the library accepts');

ok('a client-owned document cannot be standard', !(await SD.upload('site-plan', pdf('a.pdf'), { autoApprove: false, actor: ACTOR })).ok);
ok('a date already passed is refused', !(await SD.upload('insurance', pdf('a.pdf'), { validUntil: dayOut(-1), autoApprove: true, actor: ACTOR })).ok);
ok('an empty file is refused', !(await SD.upload('insurance', new File([], 'a.pdf'), { autoApprove: true, actor: ACTOR })).ok);
ok('nothing was written by the refusals', SD.eligibleTypes().every((d) => !SD.current(d.id)));
ok('client documents are not offered at all', !SD.eligibleTypes().some((d) => d.owner === 'Client'));

const ins = await SD.upload('insurance', pdf('EL-PL-2026.pdf'), { validUntil: dayOut(200), autoApprove: true, actor: ACTOR });
const ms = await SD.upload('method-statement', pdf('Method-Statement.pdf'), { autoApprove: false, actor: ACTOR });
const sia = await SD.upload('sia-licences', pdf('SIA-register.pdf'), { validUntil: dayOut(30), autoApprove: true, actor: ACTOR });
ok('three standard files saved', ins.ok && ms.ok && sia.ok);

/* ============================================================ 2. on raise == */
group('2. Raising a WOF attaches what fits');

const w1 = raise('Std test festival', 60);
const a1 = await SD.attachAllTo(w1, ACTOR);
ok('insurance and method statement attached', a1.attached.length === 2, a1.attached.join());
ok('  · the certificate counts as approved', row(w1, 'insurance').status === 'approved');
ok('  · the method statement waits for review', row(w1, 'method-statement').status === 'submitted');
ok('  · the job file remembers where it came from', JF.latest(w1.id, 'insurance')?.standardId === ins.doc.id);
ok('a file that runs out before the event ends is NOT attached', row(w1, 'sia-licences').status === 'required' && a1.expired.length === 1);
ok('  · and the operator is told', /expires before the event/.test(SD.describe(a1)));
ok('rows with no standard file are untouched', row(w1, 'risk-assessment').status === 'required' && !JF.latest(w1.id, 'risk-assessment'));

const a1b = await SD.attachAllTo(w1, ACTOR);
ok('running it again changes nothing', a1b.attached.length === 0 && JF.versions(w1.id, 'insurance').length === 1);

const w0 = raise('Short job', 20);
ok('the SIA file IS attached to an event inside its validity', (await SD.attachAllTo(w0, ACTOR)).attached.includes('SIA licence register'));

/* ============================================================== 3. manual == */
group('3. Use standard document by hand');
ok('blocked once the row is approved', !!SD.attachBlocker(w1, 'insurance'));
ok('blocked when it already has the current file', !!SD.attachBlocker(w1, 'method-statement'));
JF.review(w1, 'method-statement', 'returned', 'Wrong site');
ok('allowed again after a send-back', !SD.attachBlocker(w1, 'method-statement'));
ok('  · and attaching gives a new version', (await SD.attachTo(w1, 'method-statement', ACTOR)).ok && JF.versions(w1.id, 'method-statement').length === 2);

/* ===================================================== 4. replace/withdraw == */
group('4. Replacing and withdrawing');
const ins2 = await SD.upload('insurance', pdf('EL-PL-2027.pdf'), { validUntil: dayOut(400), autoApprove: true, actor: ACTOR });
ok('the new file is current', SD.current('insurance')?.id === ins2.doc.id && SD.versions('insurance').length === 2);
ok('the earlier job keeps the file it was given', JF.latest(w1.id, 'insurance').standardId === ins.doc.id);
const w2 = raise('After renewal', 90);
await SD.attachAllTo(w2, ACTOR);
ok('a new job gets the new file', JF.latest(w2.id, 'insurance')?.standardId === ins2.doc.id);
ok('usage is counted per file', JF.standardUses(ins.doc.id) === 2 && JF.standardUses(ins2.doc.id) === 1,
  `${JF.standardUses(ins.doc.id)}/${JF.standardUses(ins2.doc.id)}`);

SD.withdraw('method-statement');
ok('a withdrawn document has no current file', !SD.current('method-statement'));
const w3 = raise('After withdrawal', 90);
await SD.attachAllTo(w3, ACTOR);
ok('  · so new jobs ask for their own again', row(w3, 'method-statement').status === 'required');

/* ============================================================== 5. reload == */
group('5. It survives a reload');
SD.updateCurrent('insurance', { autoApprove: false });
({ DB, W, S, JT, JF, SD } = await boot());
ok('the library is still there', SD.current('insurance')?.name === 'EL-PL-2027.pdf');
ok('  · with its edited setting', SD.current('insurance')?.autoApprove === false);
ok('  · and the withdrawal', !SD.current('method-statement') && SD.versions('method-statement').length === 1);

SD.resetStandardDocs();
JF.resetJobFiles();
({ DB, W, S, JT, JF, SD } = await boot());
ok('reset empties the library', SD.eligibleTypes().every((d) => SD.versions(d.id).length === 0));

rmSync(work, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
