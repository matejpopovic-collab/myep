/* ============================================================================
   EPROSTA — verification harness for wage frameworks
   ----------------------------------------------------------------------------
   NLW, real Living Wage and London Living Wage, set up per client and chosen
   per job. Proves:

     1. The floors are dated — the rate in force on a day, and the announced
        rate waiting behind it.
     2. A client is set up for a SET of frameworks, NLW always among them.
     3. A framework prices staff lines (cost + the extra wage, margin held) and
        leaves kit alone; agreed prices are per framework and do not leak.
     4. A job starts on the client's default, can be moved before signature
        (staff re-priced, audited, flagged as an unsent change) and not after.
     5. Every timesheet on a framework job is paid at least its floor.
     6. Lines priced under a framework are not reported stale for it.
     7. It all survives a reload, and an old journal still loads.

   Run:  node wages-tests.mjs
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

const work = mkdtempSync(join(tmpdir(), 'eprosta-wages-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');
let generation = 0;
async function boot() {
  generation += 1;
  const entry = join(work, `entry-${generation}.ts`);
  const out = join(work, `bundle-${generation}.mjs`);
  writeFileSync(
    entry,
    `export * as WG from '${p('src/lib/wages')}';\n` +
      `export * as RT from '${p('src/lib/rates')}';\n` +
      `export * as W from '${p('src/lib/wof')}';\n` +
      `export * as R from '${p('src/lib/roles')}';\n` +
      `export * as PR from '${p('src/lib/payrates')}';\n` +
      `export * as DB from '${p('src/data/db')}';\n`,
  );
  try {
    execFileSync('npx', ['--yes', 'esbuild', entry, '--bundle', '--format=esm', `--outfile=${out}`,
      `--alias:@=${join(ROOT, 'src')}`, '--log-level=error'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  } catch {
    console.error('\nCould not bundle. esbuild is fetched via npx and needs network on first run.\n');
    process.exit(2);
  }
  const mod = await import(pathToFileURL(out).href);
  mod.W.load();
  mod.R.setActing(mod.R.superAdmins()[0].id);
  return mod;
}

let { WG, RT, W, R, PR, DB } = await boot();

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
};
const group = (t) => console.log(`\n${t}`);
const r2 = (n) => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ 1 --- */
group('The floors are dated');
ok('NLW is £12.71 from 1 April 2026', WG.floorOn('nlw', '2026-04-01') === 12.71);
ok('NLW was £12.21 the day before', WG.floorOn('nlw', '2026-03-31') === 12.21);
ok('RLW is £13.45 in November 2026', WG.floorOn('rlw', '2026-11-04') === 13.45);
ok('RLW is £14.10 from 1 May 2027', WG.floorOn('rlw', '2027-05-01') === 14.1);
ok('LLW is £14.80 in November 2026', WG.floorOn('llw', '2026-11-04') === 14.8);
ok('LLW is £15.45 from 1 May 2027', WG.floorOn('llw', '2027-05-01') === 15.45);
ok('the announced LLW rate shows as next', WG.nextRate('llw', '2026-11-04')?.rate === 15.45);
ok('premium is the gap over NLW', WG.premiumOn('rlw', '2026-11-04') === r2(13.45 - 12.71));
ok('NLW has no premium over itself', WG.premiumOn('nlw', '2026-11-04') === 0);

/* ------------------------------------------------------------------ 2 --- */
group('A client is set up for a set of frameworks');
ok('an untouched account is NLW only', RT.clientFrameworks('c-12').join() === 'nlw');
ok('the All England Club is NLW + LLW, defaulting to LLW',
   RT.clientFrameworks('c-6').join() === 'nlw,llw' && RT.defaultFramework('c-6') === 'llw');
ok('Festival Republic holds all three', RT.clientFrameworks('c-19').join() === 'nlw,rlw,llw');
RT.setClientFrameworks('c-12', ['rlw'], 'rlw');
ok('NLW cannot be switched off', RT.clientFrameworks('c-12').join() === 'nlw,rlw');
ok('the default can be RLW', RT.defaultFramework('c-12') === 'rlw');
RT.setClientFrameworks('c-12', ['nlw'], 'rlw');
ok('a default that is not set up falls back to NLW', RT.defaultFramework('c-12') === 'nlw');
const actAsNoRates = () => {
  const boss = R.superAdmins()[0];
  const victim = R.members().find((m) => m.id !== boss.id && m.status === 'active');
  R.setActing(boss.id);
  R.assignRole(victim.id, 'scheduling');
  R.setActing(victim.id);
};
actAsNoRates();
ok('setting frameworks needs clients.rates', RT.setClientFrameworks('c-12', ['nlw', 'llw'], 'nlw').ok === false);
R.setActing(R.superAdmins()[0].id);

/* ------------------------------------------------------------------ 3 --- */
group('A framework prices staff, not kit');
const when = DB.NOW;
const nlw = RT.rateFor('ch-st-event', 'c-19', when, 'nlw');
const rlw = RT.rateFor('ch-st-event', 'c-19', when, 'rlw');
const llw = RT.rateFor('ch-st-event', 'c-19', when, 'llw');
ok('RLW steward costs NLW cost + the premium', rlw.cost === r2(nlw.cost + WG.premiumOn('rlw', when)), `${rlw.cost}`);
ok('RLW charges more than NLW, LLW more than RLW', rlw.charge > nlw.charge && llw.charge > rlw.charge);
const m = (x) => (x.charge - x.cost) / x.charge;
ok('the margin is held (within a penny of rounding)', Math.abs(m(rlw) - m(nlw)) < 0.002, `${m(nlw)} vs ${m(rlw)}`);
ok('the snap records its framework and premium', rlw.framework === 'rlw' && rlw.wagePremium > 0);
ok('volume tiers move with it', (rlw.tiers[0]?.charge ?? 0) > (nlw.tiers[0]?.charge ?? 0));
const kitN = RT.rateFor('ch-kit-barrier', 'c-19', when, 'nlw');
const kitL = RT.rateFor('ch-kit-barrier', 'c-19', when, 'llw');
ok('a kit price agreed with the account holds under every framework',
   RT.rateFor('ch-kit-radio', 'c-19', when, 'llw').charge === RT.rateFor('ch-kit-radio', 'c-19', when, 'nlw').charge && RT.rateFor('ch-kit-radio', 'c-19', when, 'llw').basis === 'client');
ok('kit does not move', kitN.charge === kitL.charge && kitN.cost === kitL.cost);
ok('omitting the framework is NLW', RT.rateFor('ch-st-event', 'c-19', when).charge === nlw.charge);
ok('worked-on date reads that day’s floor',
   RT.rateFor('ch-st-event', 'c-19', when, 'rlw', '2027-06-01').cost === r2(nlw.cost + r2(14.1 - WG.floorOn('nlw', '2027-06-01'))));

ok('an RLW price cannot be agreed with an account not set up for it',
   !!RT.setPriceBlocker('c-12', 'ch-st-event', 25, 'rlw'));
ok('a price below the framework cost is refused',
   !!RT.setPriceBlocker('c-19', 'ch-st-event', r2(llw.cost - 0.01), 'llw'));
const set = RT.setClientPrice('c-19', 'ch-st-event', 21.75, { framework: 'rlw', note: 'Parks framework' });
ok('an RLW price can be agreed', set.ok, set.reason);
ok('it applies under RLW', RT.rateFor('ch-st-event', 'c-19', when, 'rlw').charge === 21.75);
ok('and not under NLW', RT.rateFor('ch-st-event', 'c-19', when, 'nlw').charge === nlw.charge);
ok('nor under LLW', RT.rateFor('ch-st-event', 'c-19', when, 'llw').charge === llw.charge);
ok('the rate table for RLW shows it as agreed',
   RT.rateTable('c-19', 'rlw').find((r) => r.chargeId === 'ch-st-event').basis === 'client');
ok('the NLW rate table does not', !RT.rateTable('c-19', 'nlw').find((r) => r.chargeId === 'ch-st-event').agreed);
ok('clientPrices filters by framework',
   RT.clientPrices('c-19', 'rlw').length === 1 && RT.clientPrices('c-19').length >= 2);

/* ------------------------------------------------------------------ 4 --- */
group('A job picks one, and can move until the client signs');
const job = W.create({ clientId: 'c-6', title: 'AELTC — Queue marshals' });
ok('a new job starts on the client’s default (LLW)', W.wageFramework(job) === 'llw');
const st = W.addLine(job, 'ch-st-event', { qty: 10, units: 8 });
const kt = W.addLine(job, 'ch-kit-radio', { qty: 10, units: 1 });
ok('a staff line is priced for LLW', st.snap.framework === 'llw' && st.snap.wagePremium > 0);
ok('...at what the rate table offers for the event date',
   st.snap.charge === RT.rateFor('ch-st-event', 'c-6', DB.NOW, 'llw', job.start).charge);
ok('a framework line is not reported stale', !W.lineIsStale(st));
ok('the kit line is not stale either', !W.lineIsStale(kt));
ok('RLW is refused — not set up for this client', !!W.wageFrameworkBlock(job, 'rlw'));
const before = W.lineValue(st);
const kitBefore = W.lineValue(kt);
const pending0 = (job.quotePending || []).length;
const moved = W.setWageFramework(job, 'nlw');
ok('moving to NLW works', moved.ok && W.wageFramework(job) === 'nlw', moved.reason);
ok('the staff line is re-priced down', W.lineValue(st) < before);
ok('the kit line does not move', W.lineValue(kt) === kitBefore);
ok('the delta is reported', moved.delta === r2(W.lineValue(st) - before));
ok('it is in the job history', job.history.some((h) => /Wage framework changed/.test(h.note)));
ok('it is flagged as an unsent change', (job.quotePending || []).length === pending0 + 1);
ok('a refused move changes nothing', W.setWageFramework(job, 'rlw').ok === false && W.wageFramework(job) === 'nlw');
const other = W.create({ clientId: 'c-12' });
ok('a client with only NLW has one option', W.wageFrameworkOptions(other).join() === 'nlw');
const asked = W.create({ clientId: 'c-19', wageFramework: 'llw' });
ok('a job can be raised on a named framework the client holds', W.wageFramework(asked) === 'llw');
const bogus = W.create({ clientId: 'c-12', wageFramework: 'llw' });
ok('...and not on one it does not', W.wageFramework(bogus) === 'nlw');
job.signoff = { signedBy: 'Test', signedByRole: 'Ops', signedAt: new Date().toISOString() };
ok('after signature it is fixed', !!W.wageFrameworkBlock(job, 'llw') && W.setWageFramework(job, 'llw').ok === false);

/* ------------------------------------------------------------------ 5 --- */
group('Timesheets are paid at least the floor');
const withSheets = W.all().find((w) => W.timesheets(w).some((t) => t.hours > 0));
ok('fixture: a job with worked timesheets', !!withSheets);
withSheets.wageFramework = 'llw';
const sheets = W.timesheets(withSheets).filter((t) => t.hours > 0);
ok('every hour is paid at least the LLW on its day', sheets.every((t) => {
  const emp = DB.employee(t.employeeId);
  return t.payRate >= r2(WG.floorOn('llw', t.date) + (emp.payUplift || 0)) - 0.001;
}), sheets.map((t) => t.payRate).join());
ok('gross follows it', sheets.every((t) => t.gross === r2(t.hours * t.payRate)));
const emp = DB.employee(sheets[0].employeeId);
PR.set(emp.id, { rate: 40, from: '2000-01-01', note: 'test', by: 'T' });
ok('a custom rate above the floor still wins',
   W.timesheets(withSheets).find((t) => t.employeeId === emp.id && t.hours > 0).payRate === r2(40 + (emp.payUplift || 0)));
PR.reset();
withSheets.wageFramework = null;
ok('every job is held to the NLW, too', W.allTimesheets().every((t) =>
  t.hours === 0 || t.payRate >= r2(WG.floorOn('nlw', t.date)) - 0.001));
ok('the event-screen floor reads the job', W.payFloorFor(null, DB.NOW) === WG.floorOn('nlw', DB.NOW));

/* ------------------------------------------------------------------ 7 --- */
group('Survives a reload');
({ WG, RT, W, R, PR, DB } = await boot());
ok('client frameworks persist', RT.clientFrameworks('c-12').join() === 'nlw');
ok('framework prices persist', RT.clientPrice('c-19', 'ch-st-event', 'rlw')?.charge === 21.75);
const reloaded = W.byId ? W.byId(asked.id) : W.all().find((w) => w.id === asked.id);
ok('the job’s framework persists', reloaded && W.wageFramework(reloaded) === 'llw');

store.set('eprosta.rates.v1', JSON.stringify({ v: 1, prices: { 'c-12': {} } }));
({ WG, RT, W, R, PR, DB } = await boot());
ok('a journal from before frameworks still loads', RT.clientFrameworks('c-6').join() === 'nlw,llw');

/* ------------------------------------------------------------------ 8 --- */
group('The 2027 labour rate card');
({ WG, RT, W, R, PR, DB } = await boot());
const LB = (name) => DB.CHARGES.find((c) => c.labour && c.name === name);
const eq = (name, got, want) => ok(name, got === want, `got ${got}, wanted ${want}`);
eq('the real Living Wage card lists 33 roles', RT.labourRoles('rlw').length, 33);
eq('the NLW card 32', RT.labourRoles('nlw').length, 32);
eq('the London card 27', RT.labourRoles('llw').length, 27);
eq('the Ireland card 27', RT.labourRoles('ilw').length, 27);
ok('in category order', RT.labourRoles('rlw').every((r, i, a) => !i || a[i - 1].rate.category <= r.rate.category));
ok('the eleven old demo roles are retired', DB.CHARGES.filter((c) => c.id.startsWith('ch-st-')).length === 11 &&
   DB.CHARGES.filter((c) => c.id.startsWith('ch-st-')).every((c) => c.retired));
ok('  · but still resolve for the work that used them', DB.rateAt('ch-st-event', DB.NOW).charge === 18.5);
ok('every staff role on offer is a labour-card role',
   DB.CHARGES.filter((c) => c.kind === 'staff' && !c.retired).every((c) => !!c.labour));

const cps = LB('Car Park Steward');
const onRlw = RT.frameworkRate(cps.id, DB.NOW, 'standard', 'rlw');
eq('Car Park Steward on RLW is category 7', onRlw.payCategory, 7);
eq('  · RLW applied £0.65', onRlw.payUplift, 0.65);
eq('  · paid £14.20', onRlw.payRate, 14.2);
eq('  · costs £20.88', onRlw.cost, 20.88);
eq('  · Standard card is Rate B', onRlw.charge, 22.97);
eq('  · Preferred card is Rate A, read off the sheet', RT.frameworkRate(cps.id, DB.NOW, 'preferred', 'rlw').charge, 21.93);
eq('  · Premium card is Rate C', RT.frameworkRate(cps.id, DB.NOW, 'premium', 'rlw').charge, 25.06);
eq('on NLW the same role is paid £13.30', RT.frameworkRate(cps.id, DB.NOW, 'standard', 'nlw').payRate, 13.3);
eq('  · and charged £21.52', RT.frameworkRate(cps.id, DB.NOW, 'standard', 'nlw').charge, 21.52);
eq('on LLW it is category 9', RT.frameworkRate(cps.id, DB.NOW, 'standard', 'llw').payCategory, 9);
eq('a role the sheet marks "/" has no uplift', RT.frameworkRate(LB('Fan Zone Manager').id, DB.NOW, 'standard', 'rlw').payUplift, null);
ok('Fan Zone Manager is on the RLW card', RT.offeredUnder(LB('Fan Zone Manager').id, 'rlw'));
ok('  · and not on the NLW card', !RT.offeredUnder(LB('Fan Zone Manager').id, 'nlw'));
ok('  · so the NLW rate table does not list it', !RT.rateTable('c-12', 'nlw').some((r) => r.name === 'Fan Zone Manager'));
ok('kit is on every card', RT.offeredUnder('ch-kit-radio', 'ilw'));

group('The Ireland Living Wage');
ok('it is a framework', WG.isFramework('ilw') && WG.framework('ilw').label === 'Ireland Living Wage');
eq('€14.20 in 2026', WG.floorOn('ilw', '2026-11-12'), 14.2);
eq('€14.95 in 2027', WG.floorOn('ilw', '2027-01-01'), 14.95);
eq('in euros', WG.currencyOf('ilw'), 'EUR');
eq('  · and says so', WG.fmt('ilw', 14.95), '€14.95');
eq('the others are pounds', WG.fmt('rlw', 14.1), '£14.10');
eq('no sterling premium is taken off a euro floor', WG.premiumOn('ilw', '2026-11-12'), 0);
const bank = RT.frameworkRate(LB('Banksmen').id, DB.NOW, 'standard', 'ilw');
eq('Banksmen in Ireland are paid €14.82', bank.payRate, 14.82);
eq('  · the rate carries its currency', bank.currency, 'EUR');
ok('  · a sterling rate carries none', onRlw.currency === undefined);
eq('NLW is £13.21 from 1 April 2027', WG.floorOn('nlw', '2027-04-01'), 13.21);

group('A job quoted from the card');
RT.setClientFrameworks('c-21', ['rlw', 'ilw'], 'rlw');
const lj = W.create({ title: 'WAGES — labour card', clientId: 'c-21', start: '2026-11-20T08:00:00', end: '2026-11-21T18:00:00' });
eq('fixture: the job starts on RLW', W.wageFramework(lj), 'rlw');
const tm = W.addLine(lj, LB('Traffic Manager').id, { qty: 2, units: 10 });
eq('a Premium account is charged Rate C', W.lineRate(tm), 29.3);
eq('  · the line remembers the pay rate', tm.snap.payRate, 16.6);
ok('  · and is not stale for being off the published rate', !W.lineIsStale(tm));
eq('the role is paid its card rate, not just the floor', W.payFloor(lj, '2026-11-20', 'Traffic Manager'), 16.6);
eq('  · a role the job never quoted gets the floor', W.payFloor(lj, '2026-11-20', 'Car Park Steward'), 13.45);
const fz = W.addLine(lj, LB('Fan Zone Manager').id, { qty: 1, units: 10 });
ok('it cannot move to a framework whose card lacks a role on it',
   (W.wageFrameworkBlock(lj, 'nlw') || '').includes('Fan Zone Manager'));
W.removeLine ? W.removeLine(lj, fz.id) : (lj.lines = lj.lines.filter((l) => l.id !== fz.id));
ok('  · and can once that role is off the quote', W.setWageFramework(lj, 'nlw').ok === true);
eq('  · re-priced to the NLW card at Rate C', W.lineRate(lj.lines.find((l) => l.id === tm.id)), 25.34);
eq('  · and to the NLW pay rate', lj.lines.find((l) => l.id === tm.id).snap.payRate, 14.36);
ok('Ireland is refused while a role on the quote is not on its card — none here, so it moves',
   W.setWageFramework(lj, 'ilw').ok === true);
eq('  · the line is now a euro line', lj.lines.find((l) => l.id === tm.id).snap.currency, 'EUR');
eq('  · at the Ireland Rate C', W.lineRate(lj.lines.find((l) => l.id === tm.id)), 30.87);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
