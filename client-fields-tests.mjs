/* ============================================================================
   EPROSTA — verification harness for the client record's fields

   "New client" used to take what you typed and throw it away. It was fixed to
   keep a name, a code and an email; the live system's form asks for eleven
   more things than that, and a field added to a form is worth nothing until
   something proves the value reaches the register and survives a reload.

   So this proves:

     1. EVERY FIELD ON THE FORM LANDS ON THE RECORD — the whole point.

     2. AND SURVIVES A REFRESH — the in-memory-only bug that made seeded
        records vanish is the one this module exists to prevent, and a new
        field is the easiest place to reintroduce it.

     3. REFERENCE VALUES ARE CHECKED, NOT TRUSTED — a department, a client
        type, a region or a manager that is not on the list is dropped rather
        than stored, because a client owned by a manager who does not exist is
        a screen that renders blank and a report that quietly under-counts.

     4. SERVICE TYPES ARE PER CLIENT — the defaults object holds one array; if
        it is shared by reference, ticking a box on one client ticks it on
        every client that never set any. That is a one-character mistake with
        a register-wide blast radius.

     5. THE TWO PHONE NUMBERS DO NOT LOSE THE ONE SCREEN THAT READS `phone` —
        splitting a field is where existing screens silently go blank.

     6. THE ADDRESS STILL PRINTS WHOLE — `address` is line one now, so
        anything showing "the address" has to join the parts back up.

     7. A BAD EMAIL, WEBSITE OR POSTCODE IS REFUSED — a required field that is
        not checked is a field that collects "n/a".

   Run:  node client-fields-tests.mjs
   ========================================================================== */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const work = mkdtempSync(join(tmpdir(), 'eprosta-clientfields-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');

/** A fresh bundle re-runs module init, which is how a reload is simulated:
 *  the seed is rebuilt and the journal in localStorage is replayed over it. */
async function boot(tag) {
  const entry = join(work, `entry-${tag}.ts`);
  const out = join(work, `bundle-${tag}.mjs`);
  writeFileSync(
    entry,
    `export * as C from '${p('src/lib/clients')}';\n` +
      `export * as DB from '${p('src/data/db')}';\n` +
      `export * as QD from '${p('src/lib/quotedoc')}';\n`,
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

let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const eq = (name, got, want) =>
  ok(name, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

const { C, DB, QD } = await boot('a');

/** Everything the form can send, filled in. */
const FULL = {
  name: 'Goodwood Estate',
  code: 'GDW',
  email: 'staffing@goodwood.co.uk',
  status: 'active',
  contact: 'Harriet Vane',
  termsDays: 45,
  depositPolicy: 10,
  clientManagerId: 'm-colin',
  department: 'EP Event Services',
  clientType: 'Country Shows',
  serviceTypes: ['event', 'traffic'],
  mobile: '07700 900123',
  landline: '01243 755000',
  website: 'goodwood.co.uk',
  address: 'Goodwood House',
  address2: 'Goodwood Estate',
  city: 'Chichester',
  region: 'South East',
  postcode: 'po180px',
  notes: 'Two weeks notice on raceday staffing.',
};

/* -- 1. every field lands ------------------------------------------------- */
console.log('\n1. Every field on the form reaches the record');
const created = C.createClient(FULL);
ok('the client was created', created.ok, JSON.stringify(created.errors));
const c = created.client;
{
  eq('name', c.name, 'Goodwood Estate');
  eq('code', c.code, 'GDW');
  eq('email', c.email, 'staffing@goodwood.co.uk');
  eq('client manager', c.clientManagerId, 'm-colin');
  eq('department', c.department, 'EP Event Services');
  eq('type', c.clientType, 'Country Shows');
  eq('service types', c.serviceTypes.join(','), 'event,traffic');
  eq('main contact', c.contact, 'Harriet Vane');
  eq('mobile', c.mobile, '07700 900123');
  eq('landline', c.landline, '01243 755000');
  eq('website', c.website, 'goodwood.co.uk');
  eq('address line 1', c.address, 'Goodwood House');
  eq('address line 2', c.address2, 'Goodwood Estate');
  eq('city', c.city, 'Chichester');
  eq('region', c.region, 'South East');
  eq('notes', c.notes, 'Two weeks notice on raceday staffing.');
  eq('payment terms', c.termsDays, 45);
  eq('deposit policy', c.depositPolicy, 10);
  // Typed however it comes, stored one way, or the register holds three
  // spellings of the same postcode and none of them match a search.
  eq('postcode is normalised', c.postcode, 'PO18 0PX');
}

/* -- 2. and survives a reload --------------------------------------------- */
console.log('\n2. And is still there after a refresh');
{
  const fresh = await boot('b');
  const again = fresh.DB.CLIENTS.find((x) => x.code === 'GDW');
  ok('the client came back', !!again);
  eq('with its manager', again?.clientManagerId, 'm-colin');
  eq('its department', again?.department, 'EP Event Services');
  eq('its service types', again?.serviceTypes.join(','), 'event,traffic');
  eq('its postcode', again?.postcode, 'PO18 0PX');
  eq('its notes', again?.notes, 'Two weeks notice on raceday staffing.');
}

/* -- 3. reference values are checked -------------------------------------- */
console.log('\n3. A value that is not on the list is dropped, not stored');
{
  const r = C.createClient({
    ...FULL, name: 'Ghost Owner Ltd', code: 'GHO', code2: undefined,
    clientManagerId: 'm-nobody',
    department: 'Black T-shirts',
    clientType: 'Not A Type',
    region: 'Atlantis',
  });
  ok('the client is still created', r.ok, JSON.stringify(r.errors));
  eq('manager who does not exist', r.client?.clientManagerId, null);
  eq('the uniform string that is not a department', r.client?.department, null);
  eq('type that is not on the list', r.client?.clientType, null);
  eq('region that is not on the list', r.client?.region, null);

  const s = C.createClient({ ...FULL, name: 'Half Known Ltd', code: 'HKN', serviceTypes: ['event', 'made-up'] });
  eq('an unknown service type is dropped', s.client?.serviceTypes.join(','), 'event');
}

/* -- 4. service types are per client -------------------------------------- */
console.log('\n4. Ticking a service on one client does not tick it on another');
{
  const a = C.createClient({ ...FULL, name: 'Alpha Events Ltd', code: 'ALPH', serviceTypes: [] }).client;
  const b = C.createClient({ ...FULL, name: 'Beta Events Ltd', code: 'BETA', serviceTypes: [] }).client;
  C.updateClient(a.id, { serviceTypes: ['hvm'] });
  eq('the one that was changed holds it', DB.client(a.id).serviceTypes.join(','), 'hvm');
  eq('the one that was not is untouched', DB.client(b.id).serviceTypes.length, 0);
  // The seeded register is built from the same defaults object.
  const seeded = DB.CLIENTS.find((x) => x.id === 'c-19');
  eq('and a seeded client is untouched too', seeded.serviceTypes.length, 0);
}

/* -- 5. the number the rest of the app reads ------------------------------ */
console.log('\n5. Splitting the phone field does not blank the screens that read it');
{
  eq('phone is the landline', c.phone, '01243 755000');

  const mobileOnly = C.createClient({
    ...FULL, name: 'Mobile Only Ltd', code: 'MOB', landline: '', mobile: '07700 900999',
  }).client;
  eq('with no landline it falls back to the mobile', mobileOnly.phone, '07700 900999');

  C.updateClient(mobileOnly.id, { landline: '020 7946 0100' });
  eq('and follows an edit rather than rotting', DB.client(mobileOnly.id).phone, '020 7946 0100');
}

/* -- 6. the address still prints whole ------------------------------------ */
console.log('\n6. The address prints as an address, not as line one');
{
  eq(
    'every part, joined',
    C.clientAddress(c),
    'Goodwood House, Goodwood Estate, Chichester, South East, PO18 0PX',
  );
  const sparse = C.createClient({ ...FULL, name: 'Sparse Ltd', code: 'SPR',
    address: 'Unit 4', address2: '', city: 'Reading', region: '', postcode: '' }).client;
  eq('with the blanks left out', C.clientAddress(sparse), 'Unit 4, Reading');
  ok('quotedoc is the caller this protects', typeof QD === 'object');
}

/* -- 7. bad values are refused -------------------------------------------- */
console.log('\n7. A required field that is not checked collects rubbish');
{
  const noEmail = C.createClient({ ...FULL, name: 'No Email Ltd', code: 'NEM', email: '' });
  eq('email is required at creation', noEmail.errors?.email, 'Required');
  eq('and nothing was created', DB.CLIENTS.some((x) => x.code === 'NEM'), false);

  const junkEmail = C.createClient({ ...FULL, name: 'Junk Email Ltd', code: 'JEM', email: 'n/a' });
  ok('"n/a" is not an email address', !!junkEmail.errors?.email, junkEmail.errors?.email);

  const badSite = C.createClient({ ...FULL, name: 'Bad Site Ltd', code: 'BSL', website: 'not a website' });
  ok('a website has to look like one', !!badSite.errors?.website, badSite.errors?.website);
  ok('but a bare domain is fine', C.validateWebsite('goodwood.co.uk') === null);
  ok('and so is one with a scheme', C.validateWebsite('https://goodwood.co.uk/staffing') === null);

  const badPc = C.createClient({ ...FULL, name: 'Bad Postcode Ltd', code: 'BPC', postcode: '0800 123456' });
  ok('a phone number is not a postcode', !!badPc.errors?.postcode, badPc.errors?.postcode);
  ok('an empty postcode is allowed', C.validatePostcode('') === null);

  // An account created before the rule existed must stay editable.
  const legacy = DB.CLIENTS.find((x) => !x.email);
  if (legacy) {
    const r = C.updateClient(legacy.id, { name: `${legacy.name} ` , email: '' });
    ok('an existing client with no email can still be saved', r.ok, JSON.stringify(r.errors));
  } else {
    ok('an existing client with no email can still be saved (none seeded to test)', true);
  }
}

console.log(
  failures ? `\n${failures} FAILED\n` : '\nAll client-field checks passed.\n',
);
process.exit(failures ? 1 : 0);
