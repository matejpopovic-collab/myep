/* ============================================================================
   EPROSTA — verification harness for "Add staff"
   ----------------------------------------------------------------------------
   Proves the claims `src/lib/staff.ts` makes in its header:

     1. A new worker lands on the register as Pending, right to work pending,
        no shifts, no strikes, in the New rating band, paid from their band.
     2. Bad input is refused, and nothing is added when it is.
     3. Duplicate email or phone is refused, naming who already has it.
     4. The worker survives a reload — and the rating engine scores them there.
     5. Only a role holding staff.edit is offered the button.

   Run:  node add-staff-tests.mjs
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

const work = mkdtempSync(join(tmpdir(), 'eprosta-addstaff-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');
let generation = 0;

async function boot() {
  generation += 1;
  const entry = join(work, `entry-${generation}.ts`);
  const out = join(work, `bundle-${generation}.mjs`);
  writeFileSync(
    entry,
    `export * as S from '${p('src/lib/staff')}';\n` +
      `export * as RATING from '${p('src/lib/rating')}';\n` +
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
  return import(pathToFileURL(out).href);
}

let { S, RATING, R, DB } = await boot();

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
};
const group = (t) => console.log(`\n${t}`);

const good = {
  firstName: ' priya ', lastName: 'Shah', email: 'priya.shah@example.com', phone: '07700 900111',
  office: 'Wembley', department: 'Security', employmentType: 'PAYE', tags: ['sia', 'first-aid'],
};

/* ------------------------------------------------------------------ 1 */
group('1. A new starter arrives as a new starter');
const before = DB.EMPLOYEES.length;
const r = S.createStaff(good);
ok('created', r.ok, JSON.stringify(r.errors));
const e = r.employee;
ok('on the register', DB.EMPLOYEES.length === before + 1 && DB.employee(e.id) === e);
ok('id is numeric and new', /^e-\d+$/.test(e.id) && e.id === `e-${Math.max(...DB.EMPLOYEES.slice(0, -1).map((x) => +x.id.split('-')[1])) + 1}`, e.id);
ok('name trimmed', e.name === 'priya Shah', e.name);
ok('initials', e.initials === 'PS', e.initials);
ok('status Pending', e.status === 'pending');
ok('right to work pending', e.rtw === 'pending');
ok('no shifts, no strikes', e.shiftsWorked === 0 && e.strikes === 0);
ok('New rating band', RATING.score(e).band.id === 'new' && e.ratingBand === 'new');
ok('pay from the Security PAYE band', e.payRate === DB.PAY_BANDS.Security.paye, String(e.payRate));
ok('SIA uplift', e.payUplift === 1.75);
ok('requirements kept as tags and qualifications', e.tags.join() === 'sia,first-aid' && e.qualifications.join() === 'sia,first-aid');
ok('start date is today (real clock, not the seed)', e.startedAt === new Date(DB.NOW).toISOString().slice(0, 10), e.startedAt);
ok('available', e.available === true);

const se = S.createStaff({ ...good, email: 'x@example.com', phone: '07700 900222', employmentType: 'Self-employed', department: 'Bar', tags: ['supervisor'] });
ok('self-employed rate', se.ok && se.employee.payRate === DB.PAY_BANDS.Bar.se);
ok('supervisor uplift', se.ok && se.employee.payUplift === 2.5);

/* ------------------------------------------------------------------ 2 */
group('2. Bad input is refused and adds nothing');
const n = DB.EMPLOYEES.length;
const bad = S.createStaff({ ...good, firstName: '', lastName: ' ', email: 'nope', phone: 'call me', office: 'All Offices', department: 'Juggling' });
ok('refused', !bad.ok);
ok('every field named', bad.errors && ['firstName', 'lastName', 'email', 'phone', 'office', 'department'].every((k) => bad.errors[k]), JSON.stringify(bad.errors));
ok('"All Offices" is not an office', S.STAFF_OFFICES.indexOf('All Offices') === -1);
ok('short phone refused', !!S.validatePhone('07700'));
ok('+44 form accepted', S.validatePhone('+44 7700 900333') === null);
ok('register unchanged', DB.EMPLOYEES.length === n);

/* ------------------------------------------------------------------ 3 */
group('3. Duplicates are refused, naming who has it');
const dupEmail = S.validateEmail('PRIYA.SHAH@example.com');
ok('same email, different case', dupEmail && dupEmail.includes('priya Shah'), dupEmail);
const seeded = DB.EMPLOYEES[0];
const dupPhone = S.validatePhone(seeded.phone.replace(/\s/g, ''));
ok('seeded phone without spaces', dupPhone && dupPhone.includes(seeded.name), dupPhone);
const plus = S.validatePhone('+44 7700 900111');
ok('same number in +44 form', plus && plus.includes('priya Shah'), plus);

/* ------------------------------------------------------------------ 4 */
group('4. Survives a reload');
({ S, RATING, R, DB } = await boot());
const back = DB.employee(e.id);
ok('still on the register', !!back);
ok('same record', back && back.name === 'priya Shah' && back.status === 'pending' && back.department === 'Security');
ok('rating engine scored them on load', back && back.ratingBand === 'new' && back.ratedShifts === 0);
ok('both additions back, no duplicates', DB.EMPLOYEES.filter((x) => x.email === 'priya.shah@example.com').length === 1 && DB.EMPLOYEES.length === before + 2);
ok('start date not shifted by the seed clock', back && back.startedAt === e.startedAt, back && back.startedAt);
ok('no invented days off', !DB.DAY_ENTRIES.some((d) => d.personId === e.id));
const third = S.createStaff({ ...good, email: 'third@example.com', phone: '07700 900444' });
ok('next id continues after reload', third.ok && +third.employee.id.split('-')[1] === +se.employee.id.split('-')[1] + 1, third.ok && third.employee.id);

/* ------------------------------------------------------------------ 5 */
group('5. Only staff.edit is offered it');
ok('Super Admin can', R.can('staff.edit'));
R.setActing('m-ruth');
ok('Recruitment can', R.can('staff.edit'));
R.setActing('m-nadia');
ok('Client Manager cannot', !R.can('staff.edit'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
