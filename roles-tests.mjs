/* ============================================================================
   EPROSTA — verification harness for roles and permissions
   ----------------------------------------------------------------------------
   A permission system that has not been run against its own edge cases is a
   comment, not a control. This proves the three claims `src/lib/roles.ts` makes
   in its header, plus the one `portal.ts` makes about the route guard:

     1. CAPABILITIES ARE REAL — the seeded roles genuinely withhold what they
        say they withhold. Recruitment cannot see pay. Payroll cannot cancel a
        job. Read-only can change nothing.

     2. NOBODY CAN WIDEN THEIR OWN ACCESS — a member without `team.manage` is
        refused by every mutation, not merely hidden from the button.

     3. THE COMPANY CANNOT BE LOCKED OUT — Super Admin is immutable, the last
        Super Admin cannot be demoted, suspended or removed, and nobody can
        change their own role.

     4. THE RAIL AND THE GUARD NEVER DISAGREE — for every role, every item in
        the sidebar is reachable, and no gated route is reachable without its
        capability. This is the invariant that stops a "hidden" page from being
        one typed URL away.

   Run:  node roles-tests.mjs
   ----------------------------------------------------------------------------
   The modules are framework-free but browser-flavoured (localStorage), and use
   the `@/` alias, so the harness bundles them with esbuild and shims storage.
   Both modules must come from ONE bundle: two bundles means two copies of the
   member list, and the tests then pass or fail for reasons that have nothing to
   do with the product.
   ========================================================================== */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

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

const work = mkdtempSync(join(tmpdir(), 'eprosta-roles-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');

let generation = 0;

/**
 * Bundle and import a fresh copy of the modules — i.e. reload the tab.
 *
 * `localStorage` above is deliberately kept across boots, which is what makes
 * them reloads rather than restarts. The events store is included because a
 * worker answering an invitation writes through it, and "the answer survives a
 * reload" is the claim that matters most about that path.
 */
async function boot() {
  generation += 1;
  const entry = join(work, `entry-${generation}.ts`);
  const out = join(work, `bundle-${generation}.mjs`);
  writeFileSync(
    entry,
    `export * as P from '${p('src/lib/portal')}';\n` +
      `export * as R from '${p('src/lib/roles')}';\n` +
      `export * as EV from '${p('src/lib/events')}';\n` +
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
  // `events.ts` applies its journal to EVENTS at import time, so there is no
  // load() to call — importing IS the load. `wof.ts` keeps an explicit one.
  const mod = await import(pathToFileURL(out).href);
  mod.W.load();
  return mod;
}

let { P, R, EV, DB } = await boot();

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

/** Put the acting session into a given role, via a Super Admin. Returns the id. */
function actAs(roleId) {
  const boss = R.superAdmins()[0];
  R.setActing(boss.id);
  if (roleId === 'owner') return boss.id;
  const victim = R.members().find((m) => m.id !== boss.id && m.status === 'active');
  R.assignRole(victim.id, roleId);
  R.setActing(victim.id);
  return victim.id;
}

/* ======================================================= 1. seeded roles === */

group('Seeded roles withhold what they claim to withhold');
ok('Super Admin holds every capability', R.ROLES.owner.caps.length === R.ALL_CAPS.length);
ok('Recruitment cannot see individual pay', !R.ROLES.recruitment.caps.includes('pay.view'));
ok('Recruitment cannot see cash flow', !R.ROLES.recruitment.caps.includes('report.cashflow'));
ok('Payroll cannot cancel a work order', !R.ROLES.payroll.caps.includes('wof.cancel'));
ok('Client Manager cannot run payroll', !R.ROLES['client-manager'].caps.includes('payroll.run'));
ok('Client Manager cannot see individual pay', !R.ROLES['client-manager'].caps.includes('pay.view'));
ok('Scheduling sees hours but not rates',
   R.ROLES.scheduling.caps.includes('attendance.view') && !R.ROLES.scheduling.caps.includes('pay.view'));
ok('Read only can change nothing',
   !R.ROLES.readonly.caps.some((c) => /edit|run|approve|assign|cancel|quote|confirm|manage/.test(c)));
ok('only Super Admin can manage the team by default',
   R.roleList().filter((r) => r.caps.includes('team.manage')).map((r) => r.id).join() === 'owner');

group('can() follows the acting member, and explains itself');
actAs('payroll');
ok('acting as Payroll: can run payroll', R.can('payroll.run'));
ok('acting as Payroll: cannot see cash flow', !R.can('report.cashflow'));
ok('denial() names the role', (R.denial('report.cashflow') || '').includes('Payroll'));
ok('gate() disables AND titles', (() => {
  const g = R.gate('report.cashflow');
  return g.disabled === true && typeof g.title === 'string' && g.title.length > 0;
})());
ok('gate() on a held capability is enabled and untitled', (() => {
  const g = R.gate('payroll.run');
  return g.disabled === false && g.title === undefined;
})());

/* ============================================ 2. no self-service widening === */

group('Nobody can widen their own access');
const beforeCaps = R.ROLES.payroll.caps.length;
ok('setRoleCaps refused', R.setRoleCaps('payroll', [...R.ALL_CAPS]).ok === false);
ok('…and changed nothing', R.ROLES.payroll.caps.length === beforeCaps);
ok('assignRole refused', R.assignRole(R.actingId(), 'owner').ok === false);
ok('inviteMember refused',
   R.inviteMember({ name: 'Mallory', email: 'm@x.com', jobTitle: '', roleId: 'owner' }, '2026-08-10').ok === false);
ok('setStatus refused', R.setStatus(R.superAdmins()[0].id, 'suspended').ok === false);

/* ================================================== 3. lockout guarantees === */

group('The company cannot be locked out');
const boss = R.superAdmins()[0];
R.setActing(boss.id);
ok('a Super Admin cannot change their own role', R.assignRole(boss.id, 'readonly').ok === false);
ok('…and is told why', (R.assignBlocker(boss.id, 'readonly') || '').includes('your own role'));
ok('a Super Admin cannot suspend themselves', R.setStatus(boss.id, 'suspended').ok === false);
ok('a Super Admin cannot remove themselves', R.removeMember(boss.id).ok === false);

const second = R.members().find((m) => m.id !== boss.id && m.status === 'active');
ok('a second Super Admin can be promoted', R.assignRole(second.id, 'owner').ok === true);
ok('…and then demoted again', R.assignRole(second.id, 'ops').ok === true);
ok('exactly one Super Admin remains', R.superAdmins().length === 1);

R.assignRole(second.id, 'owner');
R.setActing(second.id);
ok('with two, either can demote the other', R.assignRole(boss.id, 'ops').ok === true);
ok('the last one cannot demote themselves', R.assignRole(second.id, 'readonly').ok === false);
R.setActing(boss.id);
ok('and a demoted ex-admin cannot demote them either', R.assignRole(second.id, 'readonly').ok === false);

R.setActing(second.id);
ok('Super Admin permissions cannot be edited', R.setRoleCaps('owner', ['wof.view']).ok === false);
ok('…and are still complete', R.ROLES.owner.caps.length === R.ALL_CAPS.length);

group('Editing a role');
ok('an edit is accepted', R.setRoleCaps('recruitment', ['staff.view', 'team.manage']).ok === true);
ok('“manage” implies “view”', R.ROLES.recruitment.caps.includes('team.view'));
ok('the role is marked as edited', R.isRoleEdited('recruitment') === true);
ok('capabilities the product does not have are dropped',
   R.setRoleCaps('finance', ['staff.view', 'not.a.real.cap']).ok && R.ROLES.finance.caps.join() === 'staff.view');
ok('reset restores the shipped default',
   R.resetRoleCaps('finance').ok && R.ROLES.finance.caps.length === R.defaultCaps('finance').length);
ok('…and clears the edited flag', R.isRoleEdited('finance') === false);

group('Invites');
const inv = R.inviteMember(
  { name: 'Sam Patel', email: 'sam@epteam.co.uk', jobTitle: 'Coordinator', roleId: 'scheduling' },
  '2026-08-10',
);
ok('an invite is accepted', inv.ok === true, inv.reason);
ok('it lands as invited, not active', inv.member.status === 'invited');
ok('an invited account cannot act', !R.selectableMembers().some((m) => m.id === inv.member.id));
ok('a duplicate address is rejected, case-insensitively',
   R.inviteMember({ name: 'Sam Two', email: 'SAM@epteam.co.uk', jobTitle: '', roleId: 'readonly' }, '2026-08-10').ok === false);
ok('a malformed address is rejected',
   R.inviteMember({ name: 'X', email: 'not-an-email', jobTitle: '', roleId: 'readonly' }, '2026-08-10').ok === false);
ok('a blank name is rejected',
   R.inviteMember({ name: '   ', email: 'fresh@epteam.co.uk', jobTitle: '', roleId: 'readonly' }, '2026-08-10').ok === false);

/* ===================================================== 3b. custom roles === */

group('Custom roles are created by copying an existing one');
const beforeRoleCount = R.roleList().length;
const createRes = R.createRole({ label: 'Warehouse Supervisor', blurb: '', copyFrom: 'scheduling' });
ok('a role can be created by copying another', createRes.ok === true, createRes.reason);
const wh = createRes.role;
ok("it copies the source role's permissions",
   wh.caps.length === R.ROLES.scheduling.caps.length &&
   wh.caps.every((c) => R.ROLES.scheduling.caps.includes(c)));
ok('it is marked custom', wh.custom === true);
ok('it appears in the live role list', R.roleList().length === beforeRoleCount + 1);
ok('it is editable like any non-locked role',
   R.setRoleCaps(wh.id, ['staff.view']).ok === true && R.ROLES[wh.id].caps.join() === 'staff.view');
ok('a blank name is rejected', R.createRole({ label: '  ', blurb: '', copyFrom: 'readonly' }).ok === false);
ok('a duplicate name is rejected, case-insensitively',
   R.createRole({ label: 'warehouse supervisor', blurb: '', copyFrom: 'readonly' }).ok === false);
ok('an unknown source role is rejected',
   R.createRole({ label: 'Ghost Role', blurb: '', copyFrom: 'not-a-role' }).ok === false);

group('Custom roles cannot be created or deleted without team.manage');
actAs('ops');
ok('createRole refused', R.createRole({ label: 'Sneaky', blurb: '', copyFrom: 'readonly' }).ok === false);
ok('deleteRole refused', R.deleteRole(wh.id).ok === false);
R.setActing(second.id);

group('Deleting a custom role');
const holderInv = R.inviteMember(
  { name: 'Wh Holder', email: 'whholder@epteam.co.uk', jobTitle: '', roleId: wh.id }, '2026-08-11',
);
ok('someone can be invited straight into the new role', holderInv.ok === true, holderInv.reason);
ok('deletion is refused while someone holds it',
   (R.deleteRoleBlocker(wh.id) || '').includes('hold') && R.deleteRole(wh.id).ok === false);
ok('reassigning them clears the way', R.assignRole(holderInv.member.id, 'readonly').ok === true);
ok('now it can be deleted', R.deleteRole(wh.id).ok === true);
ok('it is gone from the live role list', !R.ROLES[wh.id]);
ok('the shipped roles cannot be deleted',
   (R.deleteRole('readonly').reason || '').includes('created here'));

group('Custom roles survive a reload, including deletion');
const wh2 = R.createRole({ label: 'Yard Lead', blurb: 'Custom test role.', copyFrom: 'ops' }).role;
R.setRoleCaps(wh2.id, ['staffing.view', 'staffing.assign']);
const whId = wh2.id;
const secondId = second.id;

({ P, R, EV, DB } = await boot());

ok('the custom role exists after reload', !!R.ROLES[whId]);
ok('…still marked custom', R.ROLES[whId]?.custom === true);
ok('…with the edited permission set, not the copied one',
   R.ROLES[whId]?.caps.slice().sort().join() === ['staffing.assign', 'staffing.view'].sort().join());
ok('…and its description survived too', R.ROLES[whId]?.blurb === 'Custom test role.');

R.setActing(secondId);
ok('it can be deleted in the new session', R.deleteRole(whId).ok === true);

({ P, R, EV, DB } = await boot());
ok('deletion survives a reload too', !R.ROLES[whId]);
ok('and nobody is left pointing at it', !R.members().some((m) => m.roleId === whId));

R.resetAll();

/* ================================================= 4. rail vs route guard === */

const GATED_ROUTES = [
  '/wofs', '/wofs/w-1', '/calendar', '/events', '/events/e-1', '/check-in-approvals',
  '/attendance', '/reports/cashflow', '/reports/costing', '/reports/payroll',
  '/reports/documents', '/charges', '/clients', '/schedules', '/staff', '/job-types',
  '/warehouse', '/warehouse/stock', '/notifications', '/settings/team',
];

group('The sidebar and the route guard never disagree');
for (const roleId of R.ROLE_ORDER) {
  actAs(roleId);

  const rail = P.nav().flatMap((g) => g.items.map((i) => i.href));
  const unreachable = rail.filter((h) => !P.canAccess(h));
  ok(`${roleId}: every item in the rail opens`, unreachable.length === 0, unreachable.join(' '));

  const leaked = GATED_ROUTES.filter((h) => {
    const cap = P.routeCap(h);
    return P.canAccess(h) && cap && !R.can(cap);
  });
  ok(`${roleId}: no gated route opens without its capability`, leaked.length === 0, leaked.join(' '));

  ok(`${roleId}: home() is somewhere they can open`, P.canAccess(P.home()), P.home());
  ok(`${roleId}: the rail is not empty`, rail.length > 0);
}
R.resetAll();

group('Typing the URL does not get you in');
actAs('recruitment');
ok('Recruitment is blocked from cash flow', !P.canAccess('/reports/cashflow'));
ok('Recruitment is blocked from payroll', !P.canAccess('/reports/payroll'));
ok('Recruitment is blocked from the rate card', !P.canAccess('/charges'));
ok('Recruitment is blocked from team settings', !P.canAccess('/settings/team'));
ok('a deep link to a work order is blocked too', !P.canAccess('/wofs/w-3'));
ok('Recruitment CAN reach the staff register', P.canAccess('/staff'));
ok('notifications stay open to every role', P.canAccess('/notifications'));

actAs('payroll');
ok('Payroll is blocked from the WOF pipeline', !P.canAccess('/wofs'));
ok('Payroll CAN reach the payroll report', P.canAccess('/reports/payroll'));
ok('longest prefix wins under /reports', P.routeCap('/reports/payroll') === 'report.payroll');
R.resetAll();

/* ------------------------------------------------- the warehouse boundary ---
   The Warehouse Manager used to hold `wof.view`, on the argument that a picker
   needs the venue and the dates. It also handed them the pricing, approval and
   invoicing screen. The capability is gone; these tests are what stops it
   coming back by accident, and what proves the calendar it keeps is not the
   pipeline in another coat.
   ------------------------------------------------------------------------- */

group('The warehouse cannot reach a work order');
actAs('warehouse');
ok('Warehouse does not hold wof.view', !R.can('wof.view'));
ok('…nor any other work-order capability',
   !['wof.edit', 'wof.quote', 'wof.approve', 'wof.confirm', 'wof.cancel'].some((c) => R.can(c)));
ok('the pipeline is blocked', !P.canAccess('/wofs'));
ok('a deep link to one work order is blocked', !P.canAccess('/wofs/w-1'));
ok('the WOF pipeline is not in their rail',
   !P.nav().flatMap((g) => g.items).some((i) => i.href === '/wofs'));
ok('the calendar is still theirs', R.can('calendar.view') && P.canAccess('/calendar'));
ok('the event calendar IS in their rail',
   P.nav().flatMap((g) => g.items).some((i) => i.href === '/calendar'));
ok('the paperwork-chase badge comes off it',
   !P.nav().flatMap((g) => g.items).find((i) => i.href === '/calendar')?.badgeKey);
ok('the warehouse queue is still theirs', P.canAccess('/warehouse') && P.canAccess('/warehouse/stock'));
ok('they land on a page they can open', P.canAccess(P.home()));
ok('…which is the calendar', P.home() === '/calendar');
ok('money stays out of reach',
   !R.can('report.costing') && !R.can('charges.view') && !R.can('pay.view'));

group('The warehouse routes are guarded, not merely hidden');
actAs('payroll');
ok('Payroll has no kit capability', !R.can('kit.view') && !R.can('kit.stock'));
ok('…and is blocked from the warehouse queue', !P.canAccess('/warehouse'));
ok('…and from the stock register', !P.canAccess('/warehouse/stock'));
actAs('warehouse');
ok('longest prefix wins under /warehouse', P.routeCap('/warehouse/stock') === 'kit.stock');
R.resetAll();

group('Tier is still checked before role');
P.setTier('client');
ok('a client cannot reach team settings', !P.canAccess('/settings/team'));
ok('a client cannot reach the staff register', !P.canAccess('/staff'));
ok('a client CAN reach their own jobs', P.canAccess('/client/jobs'));
P.setTier('staff');
ok('a worker cannot reach the payroll report', !P.canAccess('/reports/payroll'));
ok('a worker CAN reach their own pay', P.canAccess('/my/pay'));
P.setTier('admin');

/* ============================================================================
   ANSWERING AN INVITATION
   ----------------------------------------------------------------------------
   Open jobs and My shifts split the world between them: work you could apply
   for, and work with your name on it. An invitation belongs to the second, so
   it leaves the first — that part was always right.

   What was wrong is what happens when the worker says no. The decline dialog
   promised "this puts the role back on the open list", and `openRoles()`
   excluded every split the worker had ANY assignment on, declined or not. So
   the role left their open jobs permanently and sat in My shifts marked
   declined, and the one thing the dialog promised was the one thing that could
   not happen.

   The rule now has two halves, because declining is two different acts:

     · turned down an invitation they never accepted -> back on their open jobs
     · dropped out of a shift they had CONFIRMED     -> staffing must re-invite

   Both halves are tested here, along with the two bugs found underneath them:
   `assign()` silently refusing to re-invite anybody who had declined, which
   left the second half of that rule with no way to be carried out; and the
   worker's answer never being journalled, so it vanished on reload.
   ========================================================================== */

group('An invitation leaves Open jobs and appears in My shifts');

P.setTier('staff');
const meId = P.actingEmployee().id;

// A card now covers a role across the whole run, so "is it on the open list"
// asks whether any day of it is still being offered.
const onList = (id) =>
  P.openEventRoles().some((r) => r.role.parts.some((part) => part.split.id === id));
const mineNow = (id) => P.myAssignments().find((a) => a.split.id === id);

/* The first open role this worker can ACTUALLY be given.
   ------------------------------------------------------
   It used to be simply the first open role, which was the same thing right up
   until it was not: the seed rosters real days off and sick days, and the seed
   moves with the calendar, so on some dates the first open role falls on a day
   this worker is unavailable. `assign` then correctly refuses, and every
   assertion below it fails describing a product that is working.

   Refusal writes nothing, so trying the next candidate costs nothing. The
   before-state is captured inside the loop, because by the time we know which
   role took the invitation we have already sent it. */
const invitation = (() => {
  for (const r of P.openEventRoles().filter((x) => x.role.gap > 0)) {
    const id = r.role.parts[0].split.id;
    if (mineNow(id)) continue;
    const wasOffered = onList(id);
    const res = EV.assign(r.event.id, id, [meId]);
    if (res.assigned === 1) return { splitId: id, evId: r.event.id, wasOffered };
  }
  return null;
})();

ok('there is an open role this worker can be invited to', !!invitation);
const { splitId, evId } = invitation || { splitId: '', evId: '' };

ok('it started on their open jobs', invitation?.wasOffered === true);
ok('inviting them lands one assignment', !!invitation);
ok('  · it is now in my shifts', !!mineNow(splitId));
ok('  · as an invitation, never pre-confirmed', mineNow(splitId).assignment.confirmation === 'awaiting');
ok('  · and it has left their open jobs', !onList(splitId));
ok('inviting the same person again does nothing', EV.assign(evId, splitId, [meId]).assigned === 0);

group('Turning down an invitation puts it back, as the dialog promises');

const turnedDown = P.respondToInvite(splitId, 'declined');
ok('the answer was recorded', !!turnedDown && turnedDown.assignment.confirmation === 'declined');
ok('  · and remembers it was only an invitation',
  turnedDown.assignment.declinedFrom === 'awaiting');
ok('  · so the role is back on their open jobs', onList(splitId));

group('Dropping out of a confirmed shift does not');

EV.assign(evId, splitId, [meId]);
ok('a declined worker CAN be re-invited', !!mineNow(splitId));
ok('  · and the re-invite clears the old decline',
  mineNow(splitId).assignment.confirmation === 'awaiting' &&
    mineNow(splitId).assignment.declinedFrom === undefined);

P.respondToInvite(splitId, 'confirmed');
ok('confirming sticks', mineNow(splitId).assignment.confirmation === 'confirmed');
ok('  · and status moves with it, so the two cannot disagree',
  mineNow(splitId).assignment.status === 'accepted');
ok('  · a confirmed shift is not on the open list either', !onList(splitId));

const droppedOut = P.respondToInvite(splitId, 'declined');
ok('dropping out is recorded', droppedOut.assignment.confirmation === 'declined');
ok('  · and remembers what it cost', droppedOut.assignment.declinedFrom === 'confirmed');
ok('  · so the role does NOT come back to them', !onList(splitId));
ok('  · until staffing invites them again',
  EV.assign(evId, splitId, [meId]).assigned === 1 && !!mineNow(splitId));
ok('  · at which point it is a fresh invitation',
  mineNow(splitId).assignment.confirmation === 'awaiting');

group('The answer survives a reload');

P.respondToInvite(splitId, 'confirmed');
({ P, R, EV, DB } = await boot());
P.setTier('staff');

const after = P.myAssignments().find((a) => a.split.id === splitId);
ok('the assignment is still there', !!after);
ok('  · still confirmed, not back to awaiting', after.assignment.confirmation === 'confirmed');
ok('  · which is what the operator screen reads too',
  DB.event(evId).shifts
    .flatMap((s) => s.splits)
    .find((sp) => sp.id === splitId)
    .assignments.find((a) => a.employeeId === meId).confirmation === 'confirmed');

P.respondToInvite(splitId, 'declined');
({ P, R, EV, DB } = await boot());
P.setTier('staff');
const afterDecline = P.myAssignments().find((a) => a.split.id === splitId);
ok('a decline survives too', afterDecline.assignment.confirmation === 'declined');
ok('  · and so does what it cost, which is what the rule reads',
  afterDecline.assignment.declinedFrom === 'confirmed');
ok('  · so the role is still withheld after a reload',
  !P.openEventRoles().some((r) => r.role.parts.some((part) => part.split.id === splitId)));

P.setTier('admin');

/* ------------------------------------------------------------------ done --- */

rmSync(work, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
