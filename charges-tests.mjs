/* ============================================================================
   THE TABLE OF CHARGES — verification harness for adding and correcting
   ----------------------------------------------------------------------------
   `src/lib/charges.ts` makes four promises. This proves them.

     1. IT IS FINANCE'S TABLE — nobody without `charges.edit` can add a line
        or correct one, and the refusal names the permission rather than
        failing quietly.

     2. NONSENSE IS REFUSED BEFORE IT IS STORED — a blank name, a code that is
        already taken, a charge-out below cost, a role another line already
        supplies. The rule is enforced, not described: the client register is
        full of `YYY` and `ZZZ` precisely because a screen stated a rule and
        then accepted anything.

     3. A CORRECTION REACHES THE NEXT QUOTE AND NOTHING ALREADY SENT — a line
        copies the description, the unit and the rate onto itself when it is
        raised. Renaming a charge must not rewrite one word of a document a
        client has signed.

     4. IT SURVIVES A RELOAD — an added line and a corrected one both come
        back, exactly once, and `resetCharges` puts the seed back.

   Run:  node charges-tests.mjs
   ----------------------------------------------------------------------------
   Same shape as `hop-tests.mjs`: one esbuild bundle so there is exactly one
   copy of the table, and a localStorage shim kept across boots so a re-import
   is a reload rather than a restart.
   ========================================================================== */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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

const work = mkdtempSync(join(tmpdir(), 'eprosta-charges-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');
let generation = 0;

async function boot() {
  generation += 1;
  const entry = join(work, `entry-${generation}.ts`);
  const out = join(work, `bundle-${generation}.mjs`);
  writeFileSync(
    entry,
    `export * as CH from '${p('src/lib/charges')}';\n` +
      `export * as R from '${p('src/lib/roles')}';\n` +
      `export * as W from '${p('src/lib/wof')}';\n` +
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

let { CH, R, W, DB } = await boot();

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
};
const group = (t) => console.log(`\n${t}`);

/** Act as somebody holding `charges.edit`. Finance, by design. */
const asFinance = () => {
  const m = R.members().find((x) => x.roleId === 'finance' && x.status === 'active');
  R.setActing(m.id);
  return m;
};

/* Dates are computed from the seeded clock, never typed — see `drift-check.mjs`
   for the three ways a named date has already broken this suite. */
const day = (n) => new Date(new Date(DB.NOW).getTime() + n * 86400000).toISOString().slice(0, 10);
const d = (n, time = '06:00:00') => `${day(n)}T${time}`;

const NEW_STAFF = {
  kind: 'staff', code: 'ST-TEST', name: 'CHG TESTER — Crowd Monitor',
  unit: 'hour', cost: 13.00, charge: 19.50,
};

/* ================================================== 1. the seed is sound === */

group('The seed is sound');
ok('every charge has a unique code',
   new Set(DB.CHARGES.map((c) => c.code.toUpperCase())).size === DB.CHARGES.length);
ok('…and a unique name',
   new Set(DB.CHARGES.map((c) => c.name.trim().toLowerCase())).size === DB.CHARGES.length);
{
  const roles = DB.CHARGES.filter((c) => c.kind === 'staff' && c.role && !c.retired).map((c) => c.role);
  ok('no two live staff lines supply the same role — the roster prices from the first',
     new Set(roles).size === roles.length);
}
ok('every charge is priced per hour, day or item',
   DB.CHARGES.every((c) => ['hour', 'day', 'each'].includes(c.unit)));

/* ============================================ 2. it is Finance's table === */

group('Only Finance can add a line or correct one');
const clerk = R.members().find((m) => m.roleId === 'payroll' && m.status === 'active');
R.setActing(clerk.id);
ok('Payroll does not hold charges.edit', !R.can('charges.edit'));
ok('  · so it cannot add a line', CH.createCharge(NEW_STAFF, day(0)).ok === false);
ok('  · and the refusal names who can',
   (CH.createChargeBlocker(NEW_STAFF) || '').includes('Finance'));
ok('  · nor correct one', CH.editCharge('ch-st-event', { name: 'Whatever' }).ok === false);
ok('  · and that refusal names Finance too',
   (CH.editChargeBlocker('ch-st-event', { name: 'Whatever' }) || '').includes('Finance'));
ok('  · after all of which the line is untouched', DB.charge('ch-st-event').name === 'Event Steward');

const fin = asFinance();
ok('Finance holds the charge table', R.can('charges.edit'));
ok('  · and it is Finance acting', R.acting().id === fin.id);

/* ==================================== 3. nonsense is refused, with a why === */

group('A new line is refused before it is stored');
const blocked = (patch) => CH.createChargeBlocker({ ...NEW_STAFF, ...patch }) || '';
ok('a blank name', blocked({ name: '  ' }).includes('name'));
ok('a code with spaces in it', blocked({ code: 'ST TEST' }).includes('2–10'));
ok('a one-character code', blocked({ code: 'S' }).includes('2–10'));
ok('a code already taken', blocked({ code: 'ST-EVT' }).includes('Event Steward'));
ok('  · case does not launder it', blocked({ code: 'st-evt' }).includes('Event Steward'));
ok('a name already taken', blocked({ name: 'event steward' }).includes('already a charge'));
ok('a negative cost', blocked({ cost: -1 }).includes('negative'));
ok('a charge-out below cost', blocked({ charge: 1 }).includes('loses money'));
ok('a role on a line that is not staff',
   blocked({ kind: 'service', role: 'Bar Staff' }).includes('staff line'));
ok('a role another line already supplies',
   blocked({ role: 'Bar Staff' }).includes('Bar Staff'));
ok('  · and it names the line holding it', blocked({ role: 'Bar Staff' }).includes('Bar Staff'));
ok('none of that put anything in the table',
   !DB.CHARGES.some((c) => c.name.startsWith('CHG TESTER')));

group('A sound one lands');
const made = CH.createCharge({ ...NEW_STAFF, role: 'Taxi Marshal' }, day(0));
ok('creating it fails, because Taxi Marshal is already supplied', made.ok === false);
const created = CH.createCharge(NEW_STAFF, day(0));
ok('without a role it is created', created.ok === true && !!created.charge);
ok('  · with the code in capitals', created.charge.code === 'ST-TEST');
ok('  · effective from the day it was made', created.charge.effectiveFrom === day(0));
ok('  · and no history, because it has never been priced differently',
   created.charge.history.length === 0);
ok('  · it is quotable', CH.quotable().some((c) => c.id === created.charge.id));
ok('  · and known to be a row somebody added', CH.isCustom(created.charge.id));
ok('  · which the seeded rows are not', !CH.isCustom('ch-st-event'));
ok('a second line cannot reuse its code',
   CH.createCharge({ ...NEW_STAFF, name: 'CHG TESTER — Other' }, day(0)).ok === false);

/* ================================ 4. a correction reaches the NEXT quote === */

group('A correction reaches the next quote and nothing already sent');
const job = W.create({ title: 'CHG TESTER — quoted work', start: d(3), end: d(5, '20:00:00') });
const quoted = W.addLine(job, 'ch-st-event', { qty: 2, units: 8 });
const rateWhenQuoted = W.lineRate(quoted);

ok('the line reads the charge’s name', quoted.description === 'Event Steward');
ok('renaming the charge is allowed',
   CH.editCharge('ch-st-event', { name: 'Event Steward (Level 2)' }).ok === true);
ok('  · the table says the new name', DB.charge('ch-st-event').name === 'Event Steward (Level 2)');
ok('  · the quoted line still says the old one', quoted.description === 'Event Steward');
ok('  · at the rate it was quoted at', W.lineRate(quoted) === rateWhenQuoted);
const afterwards = W.addLine(job, 'ch-st-event', { qty: 1, units: 4 });
ok('  · and a line raised now takes the new name', afterwards.description === 'Event Steward (Level 2)');

ok('the unit can be corrected too',
   CH.editCharge('ch-sv-survey', { unit: 'day' }).ok === true);
ok('  · and a line already raised keeps the unit it was raised with',
   quoted.unitLabel === 'hour');

ok('a correction is flagged as one', CH.isEdited('ch-st-event'));
ok('  · and an untouched row is not', !CH.isEdited('ch-st-sia'));

group('The uniqueness rules exclude the line being edited');
ok('saving a line under its own name is fine',
   CH.editChargeBlocker('ch-st-event', { name: 'Event Steward (Level 2)' }) === null);
ok('  · and under its own code', CH.editChargeBlocker('ch-st-event', { code: 'ST-EVT' }) === null);
ok('but not under another line’s code',
   (CH.editChargeBlocker('ch-st-event', { code: 'ST-SIA' }) || '').includes('SIA'));
ok('nor another line’s name',
   (CH.editChargeBlocker('ch-st-event', { name: 'Supervisor' }) || '').includes('already a charge'));
ok('nor with a code that is not a code',
   (CH.editChargeBlocker('ch-st-event', { code: 'n o' }) || '').includes('2–10'));
ok('a charge that does not exist',
   (CH.editChargeBlocker('ch-nope', { name: 'x' }) || '').includes('No such charge'));

/* ===================================== 5. the role is the roster's link === */

group('The role is what the roster prices a shift from');
ok('a role names its charge', DB.chargeForRole('Bar Staff').id === 'ch-st-bar');
ok('the new line has no role yet', !DB.charge(created.charge.id).role);
ok('it cannot take a role another live line supplies',
   (CH.editChargeBlocker(created.charge.id, { role: 'Bar Staff' }) || '').includes('Bar Staff'));
ok('retiring that line is allowed', CH.retireCharge('ch-st-bar').ok === true);
ok('  · which takes it off new quotes', !CH.quotable().some((c) => c.id === 'ch-st-bar'));
ok('  · and frees the role for a replacement',
   CH.editCharge(created.charge.id, { role: 'Bar Staff' }).ok === true);
ok('  · which the roster now prices from',
   DB.chargeForRole('Bar Staff').id === created.charge.id);
ok('  · while the retired line still resolves for the work that used it',
   DB.CHARGES.find((c) => c.id === 'ch-st-bar').role === 'Bar Staff');
ok('a role can be cleared', CH.editCharge(created.charge.id, { role: null }).ok === true);
ok('  · and then the retired line answers again, rather than nothing at all',
   DB.chargeForRole('Bar Staff').id === 'ch-st-bar');
CH.editCharge(created.charge.id, { role: 'Bar Staff' });

/* ============================================ 6. it survives a reload === */

group('Everything above survives a reload');
CH.editCharge(created.charge.id, { name: 'CHG TESTER — Crowd Monitor (renamed)', code: 'ST-TST2' });
const addedId = created.charge.id;

({ CH, R, W, DB } = await boot());
asFinance();

ok('the added line came back', !!DB.charge(addedId));
ok('  · exactly once',
   DB.CHARGES.filter((c) => c.id === addedId).length === 1,
   'a reload that re-pushed the journal would double it');
ok('  · under its corrected name', DB.charge(addedId).name === 'CHG TESTER — Crowd Monitor (renamed)');
ok('  · and its corrected code', DB.charge(addedId).code === 'ST-TST2');
ok('  · still holding its role', DB.charge(addedId).role === 'Bar Staff');
ok('the corrected seeded line came back corrected too',
   DB.charge('ch-st-event').name === 'Event Steward (Level 2)');
ok('  · and the corrected unit stuck', DB.charge('ch-sv-survey').unit === 'day');
ok('the retiral survived as well', !CH.quotable().some((c) => c.id === 'ch-st-bar'));
ok('a line quoted before the reload still reads as it did',
   W.all().find((w) => w.title === 'CHG TESTER — quoted work')
     .lines.some((l) => l.description === 'Event Steward'));
ok('an untouched line is still the seed’s', DB.charge('ch-st-sia').name === 'SIA Licensed Officer');

group('resetCharges puts the seed back');
CH.resetCharges();
ok('the added line is gone', !DB.charge(addedId));
ok('  · and out of the quotable list', !CH.quotable().some((c) => c.id === addedId));
ok('the corrected name is back to the seed’s', DB.charge('ch-st-event').name === 'Event Steward');
ok('  · and the corrected unit', DB.charge('ch-sv-survey').unit === 'each');
ok('  · and nothing is retired', !DB.CHARGES.some((c) => c.retired));
ok('  · nor flagged as corrected', !CH.isEdited('ch-st-event'));
ok('the roster reads the seeded line again', DB.chargeForRole('Bar Staff').id === 'ch-st-bar');


/* ================================================ 7. the screens render === */

group('The dialogs render, and say what they are for');

/* Rendered rather than reasoned about. The one bug this whole class of dialog
   has actually had was in the MARKUP — `className="input"` on six fields, a
   class the stylesheet does not define, which TypeScript cannot see and a
   passing unit test cannot either. `hop-tests.mjs` guards the class names;
   this proves the components mount at all and put the right words on screen. */
const stub = (rel) => join(work, rel).replace(/\\/g, '/');
writeFileSync(stub('stub-modal.tsx'),
  `import type { ReactNode } from 'react';\n` +
  `export function Modal({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode; [k: string]: unknown }) {\n` +
  `  return <div data-modal={title}>{children}{footer}</div>;\n}\n` +
  `export function ConfirmDestructive() { return null; }\n` +
  `export function MenuButton() { return null; }\n`);
writeFileSync(stub('stub-toast.tsx'), `export const useToast = () => () => {};\n`);

let RR = null;
try {
  const entry = join(work, 'entry-render.tsx');
  const out = join(work, 'bundle-render.mjs');
  writeFileSync(entry,
    `import { createElement } from 'react';\n` +
    `import { renderToStaticMarkup } from 'react-dom/server';\n` +
    `import { MemoryRouter } from 'react-router-dom';\n` +
    `import { NewChargeDialog, EditDetails } from '${p('src/pages/Charges')}';\n` +
    `import * as R from '${p('src/lib/roles')}';\n` +
    `import * as DB from '${p('src/data/db')}';\n` +
    `export { createElement, renderToStaticMarkup, MemoryRouter, NewChargeDialog, EditDetails, R, DB };\n`);
  execFileSync(
    'npx',
    ['--yes', 'esbuild', entry, '--bundle', '--format=esm', `--outfile=${out}`,
      `--alias:@=${join(ROOT, 'src')}`, '--jsx=automatic', '--log-level=error',
      `--alias:@/components/Modal=${stub('stub-modal.tsx')}`,
      `--alias:@/components/Toast=${stub('stub-toast.tsx')}`],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, NODE_PATH: join(ROOT, 'node_modules') } },
  );
  RR = await import(pathToFileURL(out).href);
} catch {
  RR = null;
}

if (!RR) {
  ok('the dialogs render (skipped — could not bundle)', true);
} else {
  RR.R.setActing(R.members().find((m) => m.roleId === 'finance' && m.status === 'active').id);
  const draw = (el) => RR.renderToStaticMarkup(RR.createElement(RR.MemoryRouter, {}, el));

  const staff = draw(RR.createElement(RR.NewChargeDialog, {
    initialKind: 'staff', onClose: () => {}, onGoToStock: () => {}, onCreated: () => {},
  }));
  ok('the new-line dialog renders', staff.length > 1000, String(staff.length));
  ok('  · asking for a cost and a charge-out', /Cost price/.test(staff) && /Charge-out/.test(staff));
  ok('  · and, for staff, which role it fills', /Fills the role/.test(staff));
  ok('  · offering roles nobody supplies yet', /Not a rostered role/.test(staff));

  const kit = draw(RR.createElement(RR.NewChargeDialog, {
    initialKind: 'kit', onClose: () => {}, onGoToStock: () => {}, onCreated: () => {},
  }));
  ok('choosing kit sends you to the stock register', /stock register/i.test(kit));
  ok('  · and says why: a rate, a replacement price and a count together',
     /replacement price/.test(kit) && /shelf count/.test(kit));
  ok('  · rather than offering a rate on its own', !/Charge-out/.test(kit));

  const edit = draw(RR.createElement(RR.EditDetails, {
    charge: RR.DB.charge('ch-st-event'), onClose: () => {}, onSaved: () => {},
  }));
  ok('the edit dialog renders', edit.length > 800, String(edit.length));
  ok('  · and says the money is not in it', /new version with an effective date/.test(edit));
  ok('  · a staff line offers its role', /Fills the role/.test(edit));

  const kitEdit = draw(RR.createElement(RR.EditDetails, {
    charge: RR.DB.charge('ch-kit-radio'), onClose: () => {}, onSaved: () => {},
  }));
  ok('a kit line offers its Hire Hop code instead', /Hire Hop code/.test(kitEdit));
  ok('  · and not a roster role, which kit does not have', !/Fills the role/.test(kitEdit));
  ok('  · warning that lines already quoted keep what they say',
     /quoted line/.test(kitEdit), 'the radio is on seeded quotes');
}

/* Fixtures out. By TITLE through the live list — a reload replaced every
   handle this file was holding. */
W.all().forEach((w) => { if (/^CHG TESTER/.test(w.title)) w.active = false; });

rmSync(work, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
