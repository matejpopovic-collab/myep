/* ============================================================================
   EPROSTA — verification harness for client history
   ----------------------------------------------------------------------------
   Proves what `src/lib/clienthistory.ts` claims:
     1. A save that changes nothing writes nothing.
     2. One entry per area per save, with field / before / after in the entry.
     3. Bank numbers are masked at write time and never stored in full.
     4. A bank change alerts the notification feed.
     5. Rates, documents and portal access are logged where they change.
     6. The log is read-only: no edit or delete, and reads hand back copies.

   Run:  node client-history-tests.mjs
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

const work = mkdtempSync(join(tmpdir(), 'eprosta-history-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');
const entry = join(work, 'entry.ts');
const out = join(work, 'bundle.mjs');
writeFileSync(
  entry,
  ['clienthistory:H', 'clients:C', 'rates:RT', 'clientfiles:F', 'portalusers:PU', 'notifications:N', 'roles:R']
    .map((x) => {
      const [m, n] = x.split(':');
      return `export * as ${n} from '${p(`src/lib/${m}`)}';`;
    })
    .join('\n') + `\nexport * as DB from '${p('src/data/db')}';\n`,
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
const { H, C, RT, F, PU, N, R, DB } = await import(pathToFileURL(out).href);

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

R.setActing(R.superAdmins()[0].id);
const me = R.acting().name;
const c = DB.CLIENTS.find((x) => x.id === 'c-1');
const n0 = () => H.forClient(c.id).length;

/* ------------------------------------------------------------------------ */
group('1. Nothing changed, nothing written');
const start = n0();
C.updateClient(c.id, { name: c.name, email: c.email, address: c.address, serviceTypes: [...(c.serviceTypes || [])] });
ok('saving the same values writes no entry', n0() === start);
C.updateClient(c.id, { website: c.website ? c.website : '' });
ok('empty and null count as the same', n0() === start);

/* ------------------------------------------------------------------------ */
group('2. One entry per area, with before and after');
const oldCity = c.city;
C.updateClient(c.id, { city: 'Leicester', bankSortCode: '40-11-22', bankAccountNumber: '12345678' });
const latest = H.forClient(c.id);
const details = latest.find((e) => e.area === 'details');
const bank = latest.find((e) => e.area === 'billing');
ok('a save touching two areas writes two entries', n0() === start + 2);
ok('the details entry names the field and both values', details?.changes.some((x) => x.label === 'Trading town' && x.to === 'Leicester' && x.from === (oldCity || '—')));
ok('it records who made the change', details?.by === me);
ok('the bank change is titled as one', bank?.title === 'Bank details changed');
ok('…and marked sensitive', bank?.sensitive === true);

/* ------------------------------------------------------------------------ */
group('3. Bank numbers are masked');
const sort = bank.changes.find((x) => x.label === 'Sort code');
const acct = bank.changes.find((x) => x.label === 'Account number');
ok('sort code keeps only its last two digits', sort?.to === '••-••-22');
ok('account number keeps only its last four', acct?.to === '••••5678');
ok('the full account number is nowhere in history storage', !store.get('eprosta.clienthistory.v1').includes('12345678'));
C.updateClient(c.id, { iban: 'GB82 WEST 1234 5698 7654 32' });
const iban = H.forClient(c.id, 'billing')[0].changes.find((x) => x.label === 'IBAN');
ok('IBAN keeps only its last four', iban?.to === '••••5432');

/* ------------------------------------------------------------------------ */
group('4. A bank change alerts the feed');
ok('the entry says an alert went out', bank.alerted === true);
const alert = N.all().find((x) => x.title === `Bank details changed — ${c.name}`);
ok('a notification was raised', !!alert);
ok('…linking to this client’s history', alert?.link === `/clients/${c.id}?tab=history`);
const before = N.all().length;
C.updateClient(c.id, { city: 'Derby' });
ok('a non-bank edit raises nothing', N.all().length === before);

/* ------------------------------------------------------------------------ */
group('5. Status, rate card, rates, documents and portal');
C.updateClient(c.id, { status: 'inactive' });
ok('deactivating reads as such', H.forClient(c.id, 'status')[0]?.title === 'Account made inactive');
C.updateClient(c.id, { status: 'active' });
C.updateClient(c.id, { rateCardId: 'preferred' });
ok('a rate card change lands under Rates', /Rate card changed to Preferred/.test(H.forClient(c.id, 'rates')[0]?.title || ''));

const ch = DB.CHARGES.find((x) => !x.retired && RT.rateFor(x.id, c.id, DB.NOW));
const cur = RT.rateFor(ch.id, c.id, DB.NOW);
const price = Math.max(cur.cost + 1, Math.round(cur.charge * 0.95 * 100) / 100);
const set = RT.setClientPrice(c.id, ch.id, price, { note: 'Agreed on the phone with Sharon' });
const pe = H.forClient(c.id, 'rates')[0];
ok('agreeing a price is logged', set.ok && pe.title.startsWith('Price agreed'));
ok('…with the price before and after', pe.changes[0].to.includes(String(Math.floor(price))) && pe.changes[0].from !== '—');
ok('…and the note', pe.note === 'Agreed on the phone with Sharon');
RT.clearClientPrice(c.id, ch.id);
ok('dropping it is logged too', H.forClient(c.id, 'rates')[0].title.startsWith('Agreed price dropped'));

const up = await F.upload(c.id, new File(['hello'], 'insurance-2026.pdf', { type: 'application/pdf' }), { docTypeId: 'insurance', expires: '2027-03-31' });
ok('filing a document is logged', up.ok && H.forClient(c.id, 'documents')[0].title === 'Document filed: insurance-2026.pdf');
F.update(up.doc.id, { expires: '2027-06-30' });
ok('amending its expiry is logged with before and after', H.forClient(c.id, 'documents')[0].changes.some((x) => x.label === 'Expires' && x.from === '2027-03-31' && x.to === '2027-06-30'));
await F.remove(up.doc.id);
ok('removing it is logged', H.forClient(c.id, 'documents')[0].title.startsWith('Document removed'));

const inv = PU.invite(c.id, { name: 'Sharon Price', email: 'sharonp2@1st-reaction.co.uk', role: 'viewer' });
ok('a viewer invite is logged, not flagged', H.forClient(c.id, 'portal')[0].title === 'Portal invite sent to Sharon Price' && !H.forClient(c.id, 'portal')[0].sensitive);
PU.setRole(inv.user.id, 'approver');
const promo = H.forClient(c.id, 'portal')[0];
ok('promoting to approver is logged and flagged', promo.title === 'Sharon Price made approver' && promo.sensitive);
PU.acceptInvite(inv.user.inviteToken, 'Tangerine-Kite-42', 'Tangerine-Kite-42');
ok('accepting is signed by the person, not EP', H.forClient(c.id, 'portal')[0].by === `Sharon Price (${c.name})`);
ok('no password ever reaches the log', !store.get('eprosta.clienthistory.v1').includes('Tangerine'));

/* ------------------------------------------------------------------------ */
group('6. Read-only');
ok('the module offers no way to edit or delete an entry', !('remove' in H) && !('update' in H) && !('edit' in H) && !('deleteEntry' in H));
const copy = H.forClient(c.id);
copy[0].title = 'tampered';
copy.length = 0;
ok('changing what a read returned changes nothing stored', H.forClient(c.id)[0].title !== 'tampered' && H.forClient(c.id).length > 0);
ok('counts add up across areas', (() => {
  const k = H.counts(c.id);
  return k.all === k.details + k.billing + k.rates + k.documents + k.portal + k.status;
})());
ok('Festival Republic opens with its portal story already logged', H.forClient('c-19', 'portal').length >= 5);

rmSync(work, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
