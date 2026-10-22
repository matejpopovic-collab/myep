/* ============================================================================
   EPROSTA — verification harness for client portal access
   ----------------------------------------------------------------------------
   Proves what `src/lib/portalusers.ts` claims in its header:

     1. Only someone with `clients.portal` can invite or change a login.
     2. An email belongs to one organisation, and junk is refused.
     3. Invites expire, and resending starts the clock again.
     4. Access follows the account: an inactive client blocks every login,
        and reactivating restores them as they were.
     5. In the portal, a viewer cannot sign or pay and is told who can; an
        approver can; a client with no logins keeps the old behaviour.

   Run:  node portal-access-tests.mjs
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

const work = mkdtempSync(join(tmpdir(), 'eprosta-portal-access-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');
const entry = join(work, 'entry.ts');
const out = join(work, 'bundle.mjs');
writeFileSync(
  entry,
  `export * as PU from '${p('src/lib/portalusers')}';\n` +
    `export * as P from '${p('src/lib/portal')}';\n` +
    `export * as R from '${p('src/lib/roles')}';\n` +
    `export * as C from '${p('src/lib/clients')}';\n` +
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
const { PU, P, R, C, DB } = await import(pathToFileURL(out).href);

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

function actAs(roleId) {
  const boss = R.superAdmins()[0];
  R.setActing(boss.id);
  if (roleId === 'owner') return;
  const victim = R.members().find((m) => m.id !== boss.id && m.status === 'active');
  R.assignRole(victim.id, roleId);
  R.setActing(victim.id);
}

const FR = 'c-19'; // Festival Republic — seeded with users
const other = DB.CLIENTS.find((c) => c.id !== FR && c.status === 'active' && c.email);

/* ------------------------------------------------------------------------ */
group('1. Only clients.portal can manage logins');

ok('Super Admin holds clients.portal', R.ROLES.owner.caps.includes('clients.portal'));
ok('Client Manager holds it', R.ROLES['client-manager'].caps.includes('clients.portal'));
ok('Operations does not — editing a client is not letting someone in', !R.ROLES.ops.caps.includes('clients.portal'));
ok('Read-only does not', !R.ROLES.readonly.caps.includes('clients.portal'));

actAs('readonly');
const refused = PU.invite(other.id, { name: 'Sam Test', email: 'sam@example.com', role: 'viewer' });
ok('a read-only member is refused, with a reason', !refused.ok && !!refused.error);
ok('…and nothing was written', !PU.forClient(other.id).some((u) => u.email === 'sam@example.com'));

actAs('owner');

/* ------------------------------------------------------------------------ */
group('2. Email checks');

ok('junk is refused', !PU.invite(other.id, { name: 'X', email: 'not-an-email', role: 'viewer' }).ok);
ok('a name is required', !PU.invite(other.id, { name: '  ', email: 'x@y.co.uk', role: 'viewer' }).ok);
const clash = PU.invite(other.id, { name: 'Dana', email: 'DANA.REILLY@festivalrepublic.com', role: 'viewer' });
ok('an email already at another client is refused, case-insensitively', !clash.ok && /Festival Republic/.test(clash.error));
const dom = other.email.split('@')[1];
ok('an off-domain address gets a soft warning', !!PU.domainMismatch(other.id, 'someone@gmail.com'));
ok('…and a matching one does not', PU.domainMismatch(other.id, `someone@${dom}`) === null);

const inv = PU.invite(other.id, { name: 'Sharon Price', email: ` Sharon@${dom} `, role: 'approver' });
ok('a clean invite goes through', inv.ok);
ok('…stored lower-case and trimmed', inv.ok && inv.user.email === `sharon@${dom}`);
ok('…and starts as invited, not active', inv.ok && PU.effectiveStatus(inv.user) === 'invited');
ok('…recording who sent it', inv.ok && inv.user.invitedBy === R.acting().name);

/* ------------------------------------------------------------------------ */
group('3. Invites expire');

const seededInvite = PU.user('pu-3');
ok('the seeded invite is still live', PU.effectiveStatus(seededInvite) === 'invited');
seededInvite.invitedAt = '2026-09-01T09:00:00';
ok('an invite older than the window reads as expired', PU.effectiveStatus(seededInvite) === 'expired');
PU.resend('pu-3');
ok('resending starts the clock again', PU.effectiveStatus(PU.user('pu-3')) === 'invited');

/* ------------------------------------------------------------------------ */
group('4. Access follows the account');

const before = PU.summary(FR).active;
ok('Festival Republic starts with active users', before >= 2);
C.updateClient(FR, { status: 'inactive' });
ok('deactivating the client blocks every login', PU.forClient(FR).every((u) => PU.effectiveStatus(u) === 'blocked'));
ok('…and nobody can be invited meanwhile', !PU.invite(FR, { name: 'Late', email: 'late@festivalrepublic.com', role: 'viewer' }).ok);
C.updateClient(FR, { status: 'active' });
ok('reactivating restores them exactly', PU.summary(FR).active === before);

PU.disable('pu-2');
ok('a disabled user cannot sign in', PU.effectiveStatus(PU.user('pu-2')) === 'disabled');
PU.enable('pu-2');
ok('re-enabling someone who had signed in makes them active again', PU.effectiveStatus(PU.user('pu-2')) === 'active');

PU.removeAllFor(other.id);
ok('deleting a client takes its logins with it', PU.forClient(other.id).length === 0);

/* ------------------------------------------------------------------------ */
group('5. The portal enforces the role');

P.setTier('client');
P.setActingClient(FR);
P.setActingPortalUser('pu-2'); // Tom Akers, viewer
ok('a viewer is acting', P.actingPortalUser()?.id === 'pu-2');
const block = P.clientApprovalBlock();
ok('a viewer is blocked from signing and paying', !!block);
ok('…and is told which approver to ask', !!block && /Dana Reilly/.test(block));
ok('history credits the person, not the company', P.clientActor().name.startsWith('Tom Akers'));

P.setActingPortalUser('pu-1'); // Dana Reilly, approver
ok('an approver is not blocked', P.clientApprovalBlock() === null);

PU.setRole('pu-1', 'viewer');
P.setActingPortalUser('pu-2');
ok('with no approver left, the message says to ask EP', /Ask EP Team/.test(P.clientApprovalBlock() || ''));
PU.setRole('pu-1', 'approver');

const noLogins = DB.CLIENTS.find((c) => c.id !== FR && c.status === 'active' && PU.forClient(c.id).length === 0);
P.setActingClient(noLogins.id);
ok('a client with no logins falls back to the record contact', P.actingPortalUser() === null);
ok('…who can still sign, as before', P.clientApprovalBlock() === null);

/* ------------------------------------------------------------------------ */
group('6. Invite links');

actAs('owner');
P.setTier('admin');
const ivc = DB.CLIENTS.find((c) => c.status === 'active' && c.email && PU.forClient(c.id).length === 0);
const d2 = ivc.email.split('@')[1];
const iv = PU.invite(ivc.id, { name: 'Morgan Lee', email: `morgan@${d2}`, role: 'approver' });
const tok = iv.user.inviteToken;
ok('an invite carries an unguessable token', typeof tok === 'string' && tok.length >= 32);
ok('the link reads as a live invite for that person', PU.linkInfo(tok).state === 'ok' && PU.linkInfo(tok).user.id === iv.user.id);
ok('a made-up token is invalid', PU.linkInfo('nope').state === 'invalid');

const weak = PU.acceptInvite(tok, 'short', 'short');
ok('a weak password is refused', !weak.ok);
ok('a password containing their name is refused', !PU.acceptInvite(tok, 'morganmorgan1!', 'morganmorgan1!').ok);
ok('a common password is refused', !PU.acceptInvite(tok, 'password12345', 'password12345').ok);
ok('mismatched confirmation is refused', !PU.acceptInvite(tok, 'Tangerine-Kite-42', 'Tangerine-Kite-43').ok);
ok('…and none of that spent the link', PU.linkInfo(tok).state === 'ok');

const acc = PU.acceptInvite(tok, 'Tangerine-Kite-42', 'Tangerine-Kite-42');
ok('a good password accepts the invite', acc.ok);
ok('…making them active, with the time recorded', PU.effectiveStatus(PU.user(iv.user.id)) === 'active' && !!PU.user(iv.user.id).passwordSetAt);
ok('…and the link is now spent', PU.linkInfo(tok).state === 'used');
ok('a spent link cannot be used twice', !PU.acceptInvite(tok, 'Another-Good-Pass-9', 'Another-Good-Pass-9').ok);
ok('no password is stored anywhere', !JSON.stringify([...store.values()]).includes('Tangerine-Kite-42'));

const iv2 = PU.invite(ivc.id, { name: 'Ash Grey', email: `ash@${d2}`, role: 'viewer' });
const old = iv2.user.inviteToken;
PU.resend(iv2.user.id);
ok('resending kills the old link', PU.linkInfo(old).state === 'used');
ok('…and issues a new live one', PU.linkInfo(PU.user(iv2.user.id).inviteToken).state === 'ok');
const t2 = PU.user(iv2.user.id).inviteToken;
PU.disable(iv2.user.id);
ok('withdrawing an invite makes its link say so', PU.linkInfo(t2).state === 'withdrawn');
PU.user('pu-3').invitedAt = '2026-01-01T09:00:00';
ok('an expired invite link reads as expired', PU.linkInfo(PU.user('pu-3').inviteToken).state === 'expired');
PU.resend('pu-3');

/* ------------------------------------------------------------------------ */
group('7. Sign-in');

const refusals = [
  PU.signIn('nobody@nowhere.com', 'x'),
  PU.signIn(`ash@${d2}`, 'x'), // disabled
  PU.signIn('ap@festivalrepublic.com', 'x'), // invite not accepted
  PU.signIn('dana.reilly@festivalrepublic.com', ''), // no password
];
ok('unknown, disabled, unaccepted and empty are all refused', refusals.every((r) => !r.ok));
ok('…with exactly the same message', new Set(refusals.map((r) => r.error)).size === 1 && refusals[0].error === PU.SIGN_IN_REFUSED);
const si = PU.signIn('  DANA.REILLY@festivalrepublic.com ', 'whatever');
ok('an active user signs in, email case and spaces ignored', si.ok && si.user.id === 'pu-1');
P.portalSignIn(si.user);
ok('signing in lands in the client portal as that person', P.current() === 'client' && P.actingClientId() === 'c-19' && P.actingPortalUser().id === 'pu-1');
C.updateClient(FR, { status: 'inactive' });
ok('an inactive client cannot sign in', !PU.signIn('dana.reilly@festivalrepublic.com', 'x').ok);
C.updateClient(FR, { status: 'active' });

/* ------------------------------------------------------------------------ */
group('8. Password reset');

ok('forgot-password for an unknown address issues nothing', PU.requestReset('ghost@nowhere.com') === null);
ok('…nor for someone not yet active', PU.requestReset('ap@festivalrepublic.com') === null);
const link = PU.requestReset('tom.akers@festivalrepublic.com');
const rt = link && link.split('/').pop();
ok('an active user gets a reset link', !!rt && PU.linkInfo(rt).kind === 'reset' && PU.linkInfo(rt).state === 'ok');
const again = PU.requestReset('tom.akers@festivalrepublic.com').split('/').pop();
ok('asking again kills the earlier link', PU.linkInfo(rt).state === 'used' && PU.linkInfo(again).state === 'ok');
ok('a reset needs a password that passes the rules', !PU.resetPassword(again, 'tom', 'tom').ok);
ok('a good one works', PU.resetPassword(again, 'Copper-Lantern-77', 'Copper-Lantern-77').ok);
ok('…once', PU.linkInfo(again).state === 'used' && !PU.resetPassword(again, 'Copper-Lantern-78', 'Copper-Lantern-78').ok);

const tu = PU.user('pu-2');
tu.reset = { token: 'stale-token', at: '2026-01-01T09:00:00', by: 'Self-service', expiresAt: '2026-01-01T10:00:00' };
ok('a reset link older than an hour reads as expired', PU.linkInfo('stale-token').state === 'expired');
tu.reset = null;

actAs('readonly');
ok('a read-only member cannot send a reset', !PU.sendReset('pu-2').ok);
actAs('owner');
ok('someone with clients.portal can', PU.sendReset('pu-2').ok && !!PU.liveReset(PU.user('pu-2')));
const live = PU.liveReset(PU.user('pu-2'));
PU.disable('pu-2');
ok('disabling someone kills their reset link', PU.linkInfo(live).state !== 'ok');
PU.enable('pu-2');

ok('changing password needs the current one', !PU.changePassword('pu-1', '', 'Silver-Harbour-31', 'Silver-Harbour-31').ok);
ok('…and a new one that differs', !PU.changePassword('pu-1', 'Silver-Harbour-31', 'Silver-Harbour-31', 'Silver-Harbour-31').ok);
ok('…and passes the rules', PU.changePassword('pu-1', 'old-one', 'Silver-Harbour-31', 'Silver-Harbour-31').ok);

rmSync(work, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
