/* ============================================================================
   EPROSTA — verification harness for individual pay rates
   ----------------------------------------------------------------------------
   Proves the claims `src/lib/payrates.ts` makes in its header:

     1. A custom rate is DATED — shifts before it keep the rate they were
        worked at, and shifts after it are priced at the new one.
     2. The supervisor / SIA uplift still applies on top of a custom rate.
     3. It cannot be dated into work that has already been paid.
     4. "Back to band" is an entry, so the custom period stays in the record.
     5. It survives a reload.
     6. Only a role with both pay.view and staff.edit is offered the control.

   Run:  node payrates-tests.mjs
   ========================================================================== */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const work = mkdtempSync(join(tmpdir(), 'eprosta-payrates-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');
let generation = 0;

async function boot() {
  generation += 1;
  const entry = join(work, `entry-${generation}.ts`);
  const out = join(work, `bundle-${generation}.mjs`);
  writeFileSync(
    entry,
    `export * as PR from '${p('src/lib/payrates')}';\n` +
      `export * as W from '${p('src/lib/wof')}';\n` +
      `export * as CK from '${p('src/lib/checkins')}';\n` +
      `export * as R from '${p('src/lib/roles')}';\n` +
      `export * as DB from '${p('src/data/db')}';\n`,
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

let { PR, W, CK, R, DB } = await boot();

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
};
const group = (t) => console.log(`\n${t}`);
const r2 = (n) => Math.round(n * 100) / 100;

/* Pick a worker with at least two timesheets on different days, so a date
   between them splits their history. */
const sheets = (id) => W.allTimesheets().filter((t) => t.employeeId === id && t.hours > 0);
const emp = DB.EMPLOYEES.find((e) => {
  const days = [...new Set(sheets(e.id).map((t) => PR.ymd(t.date)))];
  return days.length >= 2;
});
ok('fixture: a worker with shifts on two or more days exists', !!emp);
const days = [...new Set(sheets(emp.id).map((t) => PR.ymd(t.date)))].sort();
const early = days[0];
const late = days[days.length - 1];
const band = PR.bandRate(emp);
const uplift = emp.payUplift || 0;

/* ------------------------------------------------------------------ 1 --- */
group('A custom rate is dated, not overwritten');
ok('with no custom rate, a shift is paid at band + uplift', PR.rateOn(emp, early) === r2(band + uplift));
const custom = r2(band + 2.4);
const r = PR.set(emp.id, { rate: custom, from: late, note: 'Gate team lead', by: 'Test' });
ok('set() accepts a valid change', !!r);
ok('a shift BEFORE the date keeps the band rate', PR.rateOn(emp, early) === r2(band + uplift));
ok('a shift ON the date gets the custom rate', PR.rateOn(emp, late) === r2(custom + uplift));
const tsEarly = sheets(emp.id).find((t) => PR.ymd(t.date) === early);
const tsLate = sheets(emp.id).find((t) => PR.ymd(t.date) === late);
const floorAt = (d) => W.payFloorFor(tsEarly.wof.eventId, d);
ok('the timesheet before the date is priced at the old rate (never below the job\u2019s wage floor)',
   tsEarly.payRate === r2(Math.max(band, W.payFloorFor(tsEarly.wof.eventId, tsEarly.date)) + uplift), `${tsEarly.payRate}`);
ok('the timesheet on the date is priced at the new rate', tsLate.payRate === r2(custom + uplift), `${tsLate.payRate}`);
ok('gross follows the rate', tsLate.gross === r2(tsLate.hours * (custom + uplift)));

/* ------------------------------------------------------------------ 2 --- */
group('The uplift is kept on top');
const upliftEmp = DB.EMPLOYEES.find((e) => e.payUplift > 0 && e.id !== emp.id);
PR.set(upliftEmp.id, { rate: 20, from: '2020-01-01', note: 'x', by: 'Test' });
ok('custom base + uplift', PR.rateOn(upliftEmp, '2026-01-01') === r2(20 + upliftEmp.payUplift));
ok('emp.payRate tracks today’s base, for the screens that read it', upliftEmp.payRate === 20);
ok('the check-in approval prices from the same rule',
   CK.payFor({ employeeId: upliftEmp.id, actualIn: '2026-01-01T09:00:00', scheduledIn: '2026-01-01T09:00:00' }, 2)
     === r2(2 * (20 + upliftEmp.payUplift)));

/* ------------------------------------------------------------------ 3 --- */
group('Paid work cannot be re-priced');
const paidEmp = DB.EMPLOYEES.find((e) => W.paidThrough(e.id));
ok('fixture: someone has been paid', !!paidEmp);
const paid = W.paidThrough(paidEmp.id);
ok('dating a change ON the last paid day is refused',
   !!PR.problem(paidEmp, { rate: 15, from: paid, note: 'x', paidThrough: paid }));
ok('and set() refuses it too',
   PR.set(paidEmp.id, { rate: 15, from: paid, note: 'x', by: 'T', paidThrough: paid }) === null);
ok('a reason is required', !!PR.problem(paidEmp, { rate: 15, from: '2099-01-01', note: ' ', paidThrough: paid }));
ok('a zero rate is refused', !!PR.problem(paidEmp, { rate: 0, from: '2099-01-01', note: 'x', paidThrough: paid }));
ok('a day after the last paid day is fine',
   PR.problem(paidEmp, { rate: 15, from: '2099-01-01', note: 'x', paidThrough: paid }) === null);

/* ------------------------------------------------------------------ 4 --- */
group('"Back to band" is an entry, not a deletion');
const backFrom = '2099-06-01';
const fresh = DB.EMPLOYEES.find((e) => !PR.history(e.id).length);
ok('returning to band where they are already on band is refused',
   !!PR.problem(fresh, { rate: null, from: backFrom, note: 'x' }));
PR.set(emp.id, { rate: null, from: '2099-06-01', note: 'Lead role ended', by: 'Test' });
ok('the custom period is still in force between the two dates', PR.rateOn(emp, late) === r2(custom + uplift));
ok('band applies again from the return date', PR.rateOn(emp, '2099-06-02') === r2(band + uplift));
ok('history keeps both entries', PR.history(emp.id).length === 2);
ok('a future change shows as scheduled', PR.scheduled(emp.id)?.from === '2099-06-01');

/* ------------------------------------------------------------------ 5 --- */
group('Survives a reload');
({ PR, W, CK, R, DB } = await boot());
const again = DB.employee(emp.id);
ok('the dated rate is still applied after reload', PR.rateOn(again, late) === r2(custom + uplift));
ok('and the history is intact', PR.history(emp.id).length === 2);

/* ------------------------------------------------------------------ 6 --- */
group('Who may set it');
const hasBoth = (id) => R.ROLES[id].caps.includes('pay.view') && R.ROLES[id].caps.includes('staff.edit');
ok('Super Admin can', hasBoth('owner'));
ok('Finance can', hasBoth('finance'));
ok('Recruitment cannot (cannot see pay)', !hasBoth('recruitment'));
ok('Payroll cannot (runs the file, does not set its inputs)', !hasBoth('payroll'));

PR.reset();
ok('reset() puts everyone back on band', DB.EMPLOYEES.every((e) => e.payRate === PR.bandRate(e)));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
