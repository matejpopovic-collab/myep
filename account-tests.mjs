/* ============================================================================
   EPROSTA — verification harness for account settings
   ----------------------------------------------------------------------------
   The Account settings page claims there is not one decorative control on it.
   That claim is only worth making if it is checked, so this file checks it —
   and checks the two places where a settings screen usually goes wrong:

     1. PROFILE EDITS ARE REAL AND SURVIVE A RELOAD — the name, email and job
        title write through to `MEMBERS`, the initials follow the name, and the
        journal replays them over the seed on the next boot. A settings form
        that forgets on refresh is the canonical broken settings form.

     2. THE EMAIL IS STILL THE ACCOUNT IDENTIFIER — editing your own profile
        must not become a back door around the uniqueness rule that
        `inviteMember` enforces. Same validator, same answer, and your OWN
        address must not count as a clash with yourself.

     3. EDITING SOMEONE ELSE NEEDS A PERMISSION, EDITING YOURSELF DOES NOT —
        needing an administrator to fix the spelling of your own name is the
        rule that gets worked around; changing the name and address on someone
        else's account is impersonation.

     4. PREFERENCES PERSIST AND ARE SANITISED — a theme or a muted type read
        back from storage has to be one the product still has, or it survives
        as a string nothing understands.

     5. MUTING HIDES WITHOUT UNSENDING — this is the one that matters. A muted
        type must leave the list and the unread count, and every one of those
        records must come back, unchanged, the moment it is unmuted. The
        console is the system of record for messages EP sent; a preference
        about your own attention must not edit that history.

   Run:  node account-tests.mjs
   ========================================================================== */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

/* --------------------------------------------------------- localStorage --- */

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

/* ---------------------------------------------------------------- bundle --- */

const work = mkdtempSync(join(tmpdir(), 'eprosta-account-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');

let generation = 0;

async function boot() {
  generation += 1;
  const entry = join(work, `entry-${generation}.ts`);
  const out = join(work, `bundle-${generation}.mjs`);
  writeFileSync(
    entry,
    `export * as ROLES from '${p('src/lib/roles')}';\n` +
      `export * as PREFS from '${p('src/lib/prefs')}';\n` +
      `export * as NT from '${p('src/lib/notifications')}';\n` +
      `export * as PORTAL from '${p('src/lib/portal')}';\n`,
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
const section = (n) => console.log(`\n${n}`);

let { ROLES, PREFS, NT, PORTAL } = await boot();

/* ========================================================================== */
section('1. Editing your own profile writes through, and lasts');

const me = ROLES.acting();
ok('the acting member is the seeded Super Admin', me.id === 'm-colin');

const r1 = ROLES.updateProfile(me.id, {
  name: 'Colin R. Harding',
  email: 'colin.harding@epteam.co.uk',
  jobTitle: 'Managing Director',
});
ok('the edit is accepted', r1.ok === true, r1.reason);
ok('  · the name is on the member record', ROLES.acting().name === 'Colin R. Harding');
ok('  · the job title too', ROLES.acting().jobTitle === 'Managing Director');
ok('  · and the initials follow the name', ROLES.acting().initials === 'CR');
ok('  · but the colour does not, so people who know it still do', ROLES.acting().hue === me.hue);

({ ROLES, PREFS, NT, PORTAL } = await boot());
ok('all of it survives a reload', ROLES.acting().name === 'Colin R. Harding');
ok('  · including the derived initials', ROLES.acting().initials === 'CR');
ok('  · and the rest of the team is untouched',
  ROLES.member('m-gracie').name === 'Gracie Mullen');

/* ========================================================================== */
section('2. The email is still the account identifier');

const clash = ROLES.updateProfile('m-colin', {
  name: 'Colin R. Harding',
  email: ROLES.member('m-gracie').email,
  jobTitle: 'Managing Director',
});
ok('taking somebody else\'s address is refused', clash.ok === false);
ok('  · with the error on the email field', !!clash.errors?.email, JSON.stringify(clash.errors));
ok('  · and nothing was written', ROLES.acting().email === 'colin.harding@epteam.co.uk');

const same = ROLES.updateProfile('m-colin', {
  name: 'Colin R. Harding',
  email: 'colin.harding@epteam.co.uk',
  jobTitle: 'Managing Director',
});
ok('keeping your own address is not a clash with yourself', same.ok === true, same.errors?.email);

const bad = ROLES.updateProfile('m-colin', {
  name: 'Colin R. Harding', email: 'not-an-address', jobTitle: 'MD',
});
ok('a malformed address is refused', bad.ok === false && !!bad.errors?.email);

const noName = ROLES.updateProfile('m-colin', {
  name: '   ', email: 'colin.harding@epteam.co.uk', jobTitle: 'MD',
});
ok('an empty name is refused', noName.ok === false && !!noName.errors?.name);

const blankTitle = ROLES.updateProfile('m-colin', {
  name: 'Colin R. Harding', email: 'colin.harding@epteam.co.uk', jobTitle: '  ',
});
ok('a blank job title falls back to the role label',
  blankTitle.ok === true && ROLES.acting().jobTitle === ROLES.role('owner').label,
  ROLES.acting().jobTitle);

/* ========================================================================== */
section('3. Editing yourself is yours; editing others is the Super Admin\'s');

ok('no blocker on your own profile', ROLES.profileBlocker('m-colin') === null);
ok('a Super Admin may edit anyone', ROLES.profileBlocker('m-gracie') === null);

// Act as the payroll clerk, who has no team.manage.
ROLES.setActing('m-jenny');
ok('now acting as the payroll clerk', ROLES.acting().id === 'm-jenny');
ok('  · who may still edit herself', ROLES.profileBlocker('m-jenny') === null);
ok('  · but not somebody else', typeof ROLES.profileBlocker('m-colin') === 'string');

const denied = ROLES.updateProfile('m-colin', {
  name: 'Hacked', email: 'x@y.co.uk', jobTitle: 'x',
});
ok('  · and the write is refused with a reason', denied.ok === false && !!denied.reason);
ok('  · leaving the record alone', ROLES.member('m-colin').name === 'Colin R. Harding');

const own = ROLES.updateProfile('m-jenny', {
  name: 'Jenny Okonkwo', email: ROLES.member('m-jenny').email, jobTitle: 'Payroll Clerk',
});
ok('her own edit goes through', own.ok === true, own.reason);
ROLES.setActing('m-colin');

/* ========================================================================== */
section('4. Preferences persist, and are sanitised on the way in');

ok('the default theme follows the system', PREFS.theme() === 'system');
ok('  · which resolves to light with no matchMedia', PREFS.resolvedTheme() === 'light');
ok('nothing is muted by default', PREFS.get().mutedTypes.length === 0);
ok('tables are not dense by default', PREFS.denseTables() === false);

PREFS.setTheme('dark');
PREFS.setDenseTables(true);
PREFS.setMuted('staffing', true);

({ ROLES, PREFS, NT, PORTAL } = await boot());
ok('the theme survives a reload', PREFS.theme() === 'dark');
ok('  · and resolves to itself, not to the system', PREFS.resolvedTheme() === 'dark');
ok('the density preference survives', PREFS.denseTables() === true);
ok('the mute survives', PREFS.isMuted('staffing') === true);

// A preference written by a future version, or corrupted.
localStorage.setItem(
  'eprosta.prefs.v1',
  JSON.stringify({ theme: 'neon', mutedTypes: ['staffing', 'not-a-type', 7], denseTables: 'yes' }),
);
({ ROLES, PREFS, NT, PORTAL } = await boot());
ok('an unknown theme falls back to system', PREFS.theme() === 'system');
ok('an unknown notification type is dropped', PREFS.get().mutedTypes.length === 1);
ok('  · keeping the one that is real', PREFS.isMuted('staffing') === true);
ok('a non-boolean density is not truthy-cast', PREFS.denseTables() === false);

PREFS.reset();
ok('reset puts everything back', PREFS.theme() === 'system' && !PREFS.get().mutedTypes.length);

/* ========================================================================== */
section('5. Muting hides without unsending');

const before = NT.all().length;
const staffingBefore = NT.all().filter((n) => n.type === 'staffing').length;
ok('there are staffing notifications to mute', staffingBefore > 0);

const raised = NT.callout({
  eventId: 'ev-1', eventName: 'Test event', role: 'Event Steward',
  gap: 3, audience: 'all available', recipients: 12,
});
ok('a callout is recorded', NT.all().some((n) => n.id === raised.id));
const withCallout = NT.all().length;

PREFS.setMuted('staffing', true);
ok('the muted type leaves the list',
  NT.all().filter((n) => n.type === 'staffing').length === 0);
ok('  · including the one just raised', !NT.all().some((n) => n.id === raised.id));
ok('  · and the list is shorter by exactly that many',
  NT.all().length === withCallout - (staffingBefore + 1),
  `${NT.all().length} vs ${withCallout - (staffingBefore + 1)}`);
ok('  · the unread count follows',
  NT.unreadCount() === NT.all().filter((n) => n.unread).length);

// Read state taken while muted must not swallow what is hidden.
NT.markAllRead();
ok('mark-all-read only touches what is visible',
  NT.all().every((n) => !n.unread));

PREFS.setMuted('staffing', false);
ok('unmuting brings everything back', NT.all().length === withCallout);
ok('  · the raised callout included', NT.all().some((n) => n.id === raised.id));
ok('  · still unread, because mark-all-read could not see it',
  NT.all().find((n) => n.id === raised.id).unread === true);
ok('  · with its text intact',
  NT.all().find((n) => n.id === raised.id).body.includes('12 workers'));
ok('  · and nothing was duplicated', NT.all().length === before + 1);

({ ROLES, PREFS, NT, PORTAL } = await boot());
ok('the unmute survived the reload too', NT.all().some((n) => n.type === 'staffing'));

/* ========================================================================== */
section('6. Every tier can reach the page');

ok('an operator can', PORTAL.canAccess('/settings/account'));
PORTAL.setTier('client');
ok('a client contact can', PORTAL.canAccess('/settings/account'));
ok('  · but still not the WOF pipeline', !PORTAL.canAccess('/wofs'));
PORTAL.setTier('staff');
ok('a worker can', PORTAL.canAccess('/settings/account'));
ok('  · but still not Team & roles', !PORTAL.canAccess('/settings/team'));
PORTAL.setTier('admin');

/* ================================================================ summary == */

rmSync(work, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
