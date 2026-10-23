/* ============================================================================
   EPROSTA — verification harness for job types (Checklist configuration)
   ----------------------------------------------------------------------------
   "New job type" and "Delete job type" on the checklist configuration screen.
   Proves: a created type is a real record every picker sees; edits to custom
   AND seeded types survive a reload; delete is blocked while a work order or
   scheduled event uses the type; reset returns to the seed.

   Run:  node jobtypes-tests.mjs   (same bundling trick as schedules-tests.mjs)
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

const work = mkdtempSync(join(tmpdir(), 'eprosta-jobtypes-'));
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
      `export * as JT from '${p('src/lib/jobtypes')}';\n`,
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


/* ============================================================== 1. create == */

let { DB, W, S, JT } = await boot();
const seeded = DB.JOB_TYPES.length;

group('1. A new job type is a real record');

const bad = JT.createJobType({ label: '  ', depositPct: 120, termsDays: -1 });
ok('a blank form is refused', !bad.ok);
ok('  · missing name is caught', !!bad.errors?.label);
ok('  · deposit over 100% is caught', !!bad.errors?.depositPct);
ok('  · negative terms are caught', !!bad.errors?.termsDays);
const dup = JT.createJobType({ label: 'venue / ARENA night', depositPct: 0, termsDays: 30 });
ok('a duplicate name (any case) is refused', !dup.ok && !!dup.errors?.label);
ok('nothing was written by the refused saves', DB.JOB_TYPES.length === seeded);

const a = JT.createJobType({ label: 'Conference / exhibition', depositPct: 30, termsDays: 21 });
ok('a valid type is created', a.ok);
const A = a.jobType.id;
ok('  · it is in JOB_TYPES, so every picker sees it', DB.JOB_TYPES.length === seeded + 1 && !!DB.jobType(A));
ok('  · starts with no documents', DB.jobType(A).docs.length === 0);
ok('  · is flagged custom', JT.isCustom(A) && !JT.isCustom('festival'));

const b = JT.createJobType({ label: 'Film shoot', depositPct: 50, termsDays: 14, copyDocsFrom: 'venue' });
const B = b.jobType.id;
ok('copying a checklist copies the documents', DB.jobType(B).docs.join() === DB.jobType('venue').docs.join());
JT.setDocIncluded(B, 'site-plan', true);
ok('  · and the copy is independent of its source', !DB.jobType('venue').docs.includes('site-plan'));

const c = JT.createJobType({ label: 'Film-shoot', depositPct: 0, termsDays: 0 });
ok('a name that slugs the same still gets a unique id', c.ok && c.jobType.id !== B, c.jobType?.id);

ok('a WOF checklist built from the new type uses its documents',
  W.buildChecklist(B, new Date(Date.now() + 60 * 86400000).toISOString()).length === DB.jobType(B).docs.length);

/* ================================================================ 2. edit == */

group('2. Edits survive a reload — custom AND seeded types');

JT.setDocIncluded(A, 'risk-assessment', true);
JT.updateJobType(A, { depositPct: 10 });
JT.setDocIncluded('venue', 'site-plan', true);
JT.updateJobType('venue', { termsDays: 60 });

({ DB, W, S, JT } = await boot());
ok('the custom type is still there', !!DB.jobType(A));
ok('  · with its ticked document', DB.jobType(A).docs.includes('risk-assessment'));
ok('  · and its edited deposit', DB.jobType(A).depositPct === 10);
ok('a seeded type keeps its ticked document', DB.jobType('venue').docs.includes('site-plan'));
ok('  · and its edited terms', DB.jobType('venue').termsDays === 60);
ok('  · while untouched fields still come from the seed', DB.jobType('venue').depositPct === 0);
ok('list order is seed first, then custom in creation order',
  DB.JOB_TYPES.slice(seeded).map((j) => j.id).join() === [A, B, c.jobType.id].join());

/* ============================================================== 3. delete == */

group('3. Delete is blocked while anything uses the type');

ok('a seeded type with work orders cannot be deleted', !!JT.deleteBlocker('festival'));
ok('  · and the call refuses too', !JT.deleteJobType('festival').ok && !!DB.jobType('festival'));

const sch = S.createSchedule({
  name: 'Tech Expo', clientId: DB.CLIENTS[0].id, venue: 'ExCeL', type: B, recurrence: 'One-off',
  start: new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 16),
  end: new Date(Date.now() + 91 * 86400000).toISOString().slice(0, 16), leadDays: 30,
});
ok('(fixture) a scheduled event uses the film-shoot type', sch.ok, JSON.stringify(sch.errors));
ok('a type a scheduled event uses cannot be deleted', /scheduled event/.test(JT.deleteBlocker(B) || ''));

ok('an unused custom type can be deleted', JT.deleteJobType(A).ok && !DB.jobType(A));
const unusedSeed = DB.JOB_TYPES.find((j) => !JT.deleteBlocker(j.id) && !JT.isCustom(j.id));
if (unusedSeed) ok('an unused seeded type can be deleted', JT.deleteJobType(unusedSeed.id).ok);

({ DB, W, S, JT } = await boot());
ok('a deleted type stays deleted after a reload', !DB.jobType(A));
if (unusedSeed) ok('  · seeded ones too', !DB.jobType(unusedSeed.id));
const again = JT.createJobType({ label: 'Conference / exhibition', depositPct: 0, termsDays: 0 });
ok('the name is free again but the old id is not reused', again.ok && again.jobType.id !== A, again.jobType?.id);

/* =============================================================== 4. reset == */

group('4. Reset returns to the seeded list');
JT.resetJobTypes();
S.resetSchedules();
({ DB, W, S, JT } = await boot());
ok('back to the seeded count', DB.JOB_TYPES.length === seeded, String(DB.JOB_TYPES.length));
ok('the seeded edit is undone', !DB.jobType('venue').docs.includes('site-plan') && DB.jobType('venue').termsDays === 45);

/* ------------------------------------------------------------------ done --- */

rmSync(work, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
