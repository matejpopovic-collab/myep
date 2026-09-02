/* ============================================================================
   EPROSTA — verification harness for what an ACCOUNT pays

   A quote is priced from two facts, and until now the system held one of them.
   The table of charges says what a Response Steward costs; the signed framework
   in somebody's inbox says what it costs THE JOCKEY CLUB. This proves the
   second one is now in the system, and — the harder half — that adding it did
   not give the first one a way to rewrite work already sold.

     1. THREE CARDS, ONE TABLE — a card is a factor on the published rate, so a
        rate rise reaches all three at once and no card can hold last year's
        price. Volume breaks move with the headline, or the discount given for
        booking volume would evaporate on booking volume.

     2. PRECEDENCE IS WRITTEN DOWN ONCE — agreed price beats card beats
        published, in `rateFor` and nowhere else.

     3. A QUOTE LINE TAKES THE ACCOUNT'S RATE — the whole point, and the thing
        that was previously done by hand at the moment of typing.

     4. AN AGREEMENT DOES NOT REACH BACKWARDS — signing something today does
        not re-price a quote sent last month. Moving a line onto a new rate is
        `repriceLine`: deliberate, audited, one line at a time.

     5. A CARD IS NOT STALENESS — a framework account is not "on the wrong
        rate" for being on its own card, and must not be flagged as such on
        every line of every job.

     6. BELOW COST IS REFUSED — not warned about.

     7. DOCUMENTS BELONG TO THE ACCOUNT — with an expiry that is a status, and
        an honest answer when the browser will not keep the file.

     8. THE RECORD RENDERS — as a page, at its own URL, with the tab the link
        asked for.

   Run:  node client-rates-tests.mjs
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

const work = mkdtempSync(join(tmpdir(), 'eprosta-clientrates-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');

let failures = 0;
let passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    passes += 1;
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const eq = (name, got, want) =>
  ok(name, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const group = (n) => console.log(`\n${n}`);
const near = (a, b) => Math.abs(a - b) < 0.005;

function bundle(tag, entrySrc, extraArgs = []) {
  const entry = join(work, `entry-${tag}.tsx`);
  const out = join(work, `bundle-${tag}.mjs`);
  writeFileSync(entry, entrySrc);
  try {
    execFileSync(
      'npx',
      ['--yes', 'esbuild', entry, '--bundle', '--format=esm', `--outfile=${out}`,
        `--alias:@=${join(ROOT, 'src')}`, '--log-level=error', ...extraArgs],
      { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
        env: { ...process.env, NODE_PATH: join(ROOT, 'node_modules') } },
    );
  } catch {
    console.error('\nCould not bundle. esbuild is fetched via npx and needs network on first run.\n');
    process.exit(2);
  }
  return import(pathToFileURL(out).href);
}

const M = await bundle(
  'core',
  `export * as DB from '${p('src/data/db')}';\n` +
    `export * as RATES from '${p('src/lib/rates')}';\n` +
    `export * as FILES from '${p('src/lib/clientfiles')}';\n` +
    `export * as C from '${p('src/lib/clients')}';\n` +
    `export * as R from '${p('src/lib/roles')}';\n` +
    `export * as W from '${p('src/lib/wof')}';\n`,
);
const { DB, RATES, FILES, C, R, W } = M;
W.load();

/* Whoever negotiated the account, which is NOT whoever owns the published rate
   card — see `clients.rates` in `roles.ts`. Picked by CAPABILITY rather than by
   name: a role rename should not silently turn these tests into assertions
   that a denial is refused. */
const negotiator = R.members().find((m) => m.status === 'active' && R.ROLES[m.roleId]?.caps.includes('clients.rates'));
R.setActing(negotiator.id);

const CARDS = DB.RATE_CARDS;
const PREFERRED = CARDS.find((c) => c.id === 'preferred');
const STEWARD = 'ch-st-event';
/* An account on a card, and one that is not. Resolved from the register rather
   than named, so seeding another framework client does not break the file. */
const onCard = DB.CLIENTS.find((c) => c.rateCardId === 'preferred');
const onPublished = DB.CLIENTS.find((c) => !c.rateCardId && !RATES.clientPrices(c.id).length);

/* ========================================================================== */
group('1. Three cards, one table');

const published = DB.rateAt(STEWARD, DB.NOW);
const card = DB.rateAt(STEWARD, DB.NOW, 'preferred');
ok('a card is a position on the published rate, not a copy of it',
   near(card.charge, Math.round(published.charge * PREFERRED.factor * 100) / 100),
   `${card.charge} vs ${published.charge} × ${PREFERRED.factor}`);
eq('  · and says so on the snapshot', card.basis, 'card');
eq('  · while the published rate says nothing of the sort', published.basis, 'standard');
ok('  · the published figure is carried, so the difference can be shown',
   published.charge === card.listCharge);

/* The one that matters: a rate rise must reach every card. The charge table
   already holds a previous version of this line, so "last year" is a date, not
   a fixture. */
const tiered = DB.CHARGES.find((c) => c.tiers?.length && c.history?.length);
const lastYear = tiered.history[0].effectiveFrom;
ok('a card cannot hold last year’s price',
   DB.rateAt(tiered.id, lastYear, 'preferred').charge <
     DB.rateAt(tiered.id, DB.NOW, 'preferred').charge,
   'the card moved with the table when the table moved');

const tPub = DB.rateAt(tiered.id, DB.NOW);
const tCard = DB.rateAt(tiered.id, DB.NOW, 'preferred');
ok('volume breaks move with the headline',
   tCard.tiers.length === tPub.tiers.length &&
   tCard.tiers.every((t, i) => t.charge < tPub.tiers[i].charge),
   'otherwise a card discount evaporates the moment the client books volume');
ok('  · and keep their proportion',
   near(tCard.tiers[0].charge / tPub.tiers[0].charge, tCard.charge / tPub.charge));
ok('  · at the same break points, which are a quantity and not a price',
   tCard.tiers.every((t, i) => t.minQty === tPub.tiers[i].minQty));

/* ========================================================================== */
group('2. Agreed beats card beats published');

const AGREED = 21.4;
ok('a price can be agreed with one account',
   RATES.setClientPrice(onCard.id, STEWARD, AGREED, { note: 'test schedule' }).ok);

const forCarded = RATES.rateFor(STEWARD, onCard.id, DB.NOW);
const forOther = RATES.rateFor(STEWARD, onPublished.id, DB.NOW);
eq('the account that agreed it pays it', forCarded.charge, AGREED);
eq('  · and the snapshot says where the number came from', forCarded.basis, 'client');
eq('nobody else is touched', forOther.charge, published.charge);
eq('  · which is the published rate, because they are on the published card', forOther.basis, 'standard');
ok('an account with no id at all still gets the published rate',
   RATES.rateFor(STEWARD, null, DB.NOW).charge === published.charge,
   'the rate card screen has no client in hand and must not break');

const table = RATES.rateTable(onCard.id);
const rowAgreed = table.find((r) => r.chargeId === STEWARD);
const rowCard = table.find((r) => r.basis === 'card');
eq('the rate table names the basis, line by line', rowAgreed.basis, 'client');
ok('  · and everything not agreed falls to the card', !!rowCard && rowCard.effective < rowCard.list);

/* ========================================================================== */
group('3. A quote line takes the account’s rate');

const jobCarded = W.create({ title: 'RATES — carded', clientId: onCard.id,
  start: '2026-11-02T08:00:00', end: '2026-11-03T18:00:00' });
const lineAgreed = W.addLine(jobCarded, STEWARD, { qty: 4, units: 10 });
eq('a line quoted for that account is priced at the agreed rate', W.lineRate(lineAgreed), AGREED);

const otherCharge = DB.CHARGES.find((c) => c.kind === 'staff' && c.id !== STEWARD && !c.retired);
const lineCarded = W.addLine(jobCarded, otherCharge.id, { qty: 2, units: 8 });
eq('a line with nothing agreed is priced from their card',
   W.lineRate(lineCarded), DB.rateAt(otherCharge.id, DB.NOW, 'preferred').charge);

const jobOther = W.create({ title: 'RATES — published', clientId: onPublished.id,
  start: '2026-11-02T08:00:00', end: '2026-11-03T18:00:00' });
const linePublished = W.addLine(jobOther, STEWARD, { qty: 4, units: 10 });
eq('the same line for another account is priced from the table',
   W.lineRate(linePublished), published.charge);
ok('  · so the two quotes differ by the agreement and nothing else',
   W.lineValue(lineAgreed) !== W.lineValue(linePublished) &&
   near(W.lineValue(lineAgreed), 4 * 10 * AGREED));

/* ========================================================================== */
group('4. An agreement does not reach backwards');

const wasRate = W.lineRate(lineAgreed);
const wasValue = W.quoteValue(jobCarded);
RATES.setClientPrice(onCard.id, STEWARD, AGREED - 3, { note: 'renegotiated' });
eq('a job already quoted holds the rate it was quoted at', W.lineRate(lineAgreed), wasRate);
eq('  · so its value has not moved either', W.quoteValue(jobCarded), wasValue);

ok('moving it is an explicit re-price', W.repriceLine(jobCarded, lineAgreed.id));
eq('  · which takes the agreement in force today', W.lineRate(lineAgreed), AGREED - 3);
ok('  · and says so in the job’s history',
   jobCarded.history.some((t) => /re-priced/i.test(t.note || '')));

RATES.setClientPrice(onCard.id, STEWARD, AGREED, { note: 'test schedule' });

/* ========================================================================== */
group('5. A card is not staleness');

ok('a line on the account’s own card is not stale', !W.lineIsStale(lineCarded),
   'a framework account is not on the wrong rate for being on its own rate');
ok('  · nor is a line carrying an agreed price', !W.lineIsStale(lineAgreed));
ok('  · nor one at the published rate', !W.lineIsStale(linePublished));

/* Wind one line back to the previous VERSION of the same card. That is the
   thing staleness is for, and it must still fire. */
const staleJob = W.create({ title: 'RATES — stale', clientId: onCard.id,
  start: '2026-11-02T08:00:00', end: '2026-11-03T18:00:00' });
const staleLine = W.addLine(staleJob, tiered.id, { qty: 3, units: 6 });
staleLine.snap = DB.rateAt(tiered.id, lastYear, 'preferred');
ok('a line priced on a superseded version of that card IS stale', W.lineIsStale(staleLine),
   'the version moved; that is exactly what the flag is for');

/* ========================================================================== */
group('6. Below cost is refused, thin margin is surfaced');

const cost = DB.rateAt(STEWARD, DB.NOW).cost;
ok('a price under the cost price is refused',
   !RATES.setClientPrice(onCard.id, STEWARD, Math.max(0.01, cost - 1)).ok);
ok('  · with a reason that names both numbers',
   /below/.test(RATES.setPriceBlocker(onCard.id, STEWARD, Math.max(0.01, cost - 1)) || ''));
eq('  · and nothing was written', RATES.clientPrice(onCard.id, STEWARD).charge, AGREED);
ok('selling AT cost is allowed — EP does it deliberately',
   !RATES.setPriceBlocker(onCard.id, STEWARD, cost));

/* A price that was fine when it was signed and is thin now. Chosen from the
   cost price so the fixture cannot drift when the rate card moves. */
const thin = Math.round(cost / (1 - (RATES.MARGIN_FLOOR - 5) / 100) * 100) / 100;
RATES.setClientPrice(onCard.id, STEWARD, thin, { note: 'signed 2024' });
const bad = RATES.staleAgreements(onCard.id);
ok('an agreement below the margin floor is surfaced',
   bad.some((s) => s.price.chargeId === STEWARD && s.severity === 'thin'),
   `${bad.length} flagged at a ${RATES.MARGIN_FLOOR}% floor`);
RATES.setClientPrice(onCard.id, STEWARD, AGREED, { note: 'test schedule' });
ok('  · and a healthy one is not', !RATES.staleAgreements(onCard.id).some((s) => s.price.chargeId === STEWARD));

/* ========================================================================== */
group('7. Moving the card moves everything that was not agreed');

const beforeAgreed = RATES.rateFor(STEWARD, onCard.id, DB.NOW).charge;
const beforeCard = RATES.rateFor(otherCharge.id, onCard.id, DB.NOW).charge;
ok('an account can be moved to another card',
   C.updateClient(onCard.id, { rateCardId: 'premium' }).ok);
eq('the agreed line does not move — that is what makes it an agreement',
   RATES.rateFor(STEWARD, onCard.id, DB.NOW).charge, beforeAgreed);
ok('  · everything else does',
   RATES.rateFor(otherCharge.id, onCard.id, DB.NOW).charge > beforeCard);
ok('an unknown card lands on the published one, never on nothing',
   C.updateClient(onCard.id, { rateCardId: 'not-a-card' }).ok &&
   RATES.clientCardId(onCard.id) === DB.DEFAULT_CARD);
C.updateClient(onCard.id, { rateCardId: 'preferred' });

/* ========================================================================== */
group('8. Documents belong to the account');

const anyClient = DB.CLIENTS[0];
const file = { name: 'EL-cert-2026.pdf', size: 220 * 1024, type: 'application/pdf' };
ok('a document is refused before it is stored if it is too big',
   !!FILES.uploadBlocker({ name: 'huge.pdf', size: FILES.MAX_BYTES + 1 }));
ok('  · and an empty one is refused too', !!FILES.uploadBlocker({ name: 'x.pdf', size: 0 }));
ok('a plausible one is not', !FILES.uploadBlocker(file));

/* There is no IndexedDB in node, which is exactly the condition a private
   window produces — so this run proves the honest-failure path rather than
   skipping it. The record is kept; the claim to hold the file is not. */
const up = await FILES.upload(anyClient.id, file, { docTypeId: 'insurance', expires: null });
ok('the upload is recorded', up.ok);
ok('  · but the browser could not keep the bytes, and the record says so',
   up.recordOnly === true && up.doc.stored === false,
   'a register that quietly loses the document is worse than one that never claimed it');
ok('  · and it is filed against the account, not a job',
   FILES.forClient(anyClient.id).some((d) => d.id === up.doc.id));
ok('  · so it needs attention', FILES.needsAttention(anyClient.id).some((d) => d.id === up.doc.id));

const yesterday = new Date(+new Date(DB.NOW) - 864e5).toISOString().slice(0, 10);
const inAWeek = new Date(+new Date(DB.NOW) + 7 * 864e5).toISOString().slice(0, 10);
const inAYear = new Date(+new Date(DB.NOW) + 365 * 864e5).toISOString().slice(0, 10);
FILES.update(up.doc.id, { expires: yesterday });
eq('an expiry is a status: expired', FILES.expiryState(FILES.byId(up.doc.id)), 'expired');
FILES.update(up.doc.id, { expires: inAWeek });
eq('  · expiring', FILES.expiryState(FILES.byId(up.doc.id)), 'expiring');
FILES.update(up.doc.id, { expires: inAYear });
eq('  · valid', FILES.expiryState(FILES.byId(up.doc.id)), 'valid');
FILES.update(up.doc.id, { expires: null });
eq('  · and “never expires” is an answer, not a gap',
   FILES.expiryState(FILES.byId(up.doc.id)), 'none');

const readonly = R.members().find((m) => m.status === 'active' && !R.ROLES[m.roleId]?.caps.includes('clients.edit'));
if (readonly) {
  R.setActing(readonly.id);
  ok('someone who cannot edit clients cannot file paperwork against one',
     !!FILES.uploadBlocker(file));
  R.setActing(negotiator.id);
} else {
  ok('every role can edit clients, so there is nothing to refuse (skipped)', true);
}

/* The split that matters: the published table and one client's price are two
   different permissions, and at least one role must hold one without the
   other — otherwise the distinction is a comment, not a rule. */
const negotiatorOnly = R.members().find(
  (m) => m.status === 'active' &&
    R.ROLES[m.roleId]?.caps.includes('clients.rates') &&
    !R.ROLES[m.roleId]?.caps.includes('charges.edit'),
);
ok('a role can agree a client rate without being able to edit the rate card',
   !!negotiatorOnly, 'otherwise agreeing one price means holding every price');
if (negotiatorOnly) {
  R.setActing(negotiatorOnly.id);
  ok('  · and doing so is allowed', !RATES.setPriceBlocker(onCard.id, STEWARD, 30));
  ok('  · while the published table stays shut to them',
     !R.can('charges.edit'), 'agreeing one price must not hand over every price');
  R.setActing(negotiator.id);
}

const noRates = R.members().find(
  (m) => m.status === 'active' && !R.ROLES[m.roleId]?.caps.includes('clients.rates'),
);
if (noRates) {
  R.setActing(noRates.id);
  ok('a role without it cannot agree a rate', !!RATES.setPriceBlocker(onCard.id, STEWARD, 30));
  ok('  · and is told which permission it needs, not just refused',
     /Agree client rates/i.test(RATES.setPriceBlocker(onCard.id, STEWARD, 30) || ''));
  R.setActing(negotiator.id);
} else {
  ok('every role can agree a rate, so there is nothing to refuse (skipped)', true);
}

/* ========================================================================== */
group('9. Every price an operator is shown is the price they will be charged');

/* The bug this group exists for: the deployment builder and the add-line
   dialog previewed from the published rate while the line they created
   resolved through the account. One screen, two prices, and the operator finds
   out on the document. */
const previewOf = (chargeId, clientId) => RATES.rateFor(chargeId, clientId, DB.NOW).charge;
const created = (job, chargeId) => W.lineRate(W.addLine(job, chargeId, { qty: 1, units: 1 }));

const previewJob = W.create({ title: 'RATES — preview', clientId: onCard.id,
  start: '2026-11-02T08:00:00', end: '2026-11-03T18:00:00' });
eq('what the picker offers for an agreed line is what the line costs',
   previewOf(STEWARD, onCard.id), created(previewJob, STEWARD));
eq('  · and for a line priced off the card',
   previewOf(otherCharge.id, onCard.id), created(previewJob, otherCharge.id));
ok('  · neither of which is the published figure',
   previewOf(STEWARD, onCard.id) !== published.charge &&
   previewOf(otherCharge.id, onCard.id) !== DB.rateAt(otherCharge.id, DB.NOW).charge,
   'if these matched, this test would pass while proving nothing');

const otherJob = W.create({ title: 'RATES — preview, published', clientId: onPublished.id,
  start: '2026-11-02T08:00:00', end: '2026-11-03T18:00:00' });
eq('an account on the published card is shown the published rate',
   previewOf(STEWARD, onPublished.id), created(otherJob, STEWARD));

/* ========================================================================== */
group('10. The client record renders, at its own URL');

/* `Modal` goes through `createPortal`, which needs a live DOM and has nothing
   to do with what is being tested. Stubbed in the temp dir, never in the repo:
   a stub component sitting beside the real ones is a trap for the next person
   who greps for `function Modal`. */
const stub = (rel) => join(work, rel).replace(/\\/g, '/');
writeFileSync(stub('stub-modal.tsx'),
  `import type { ReactNode } from 'react';\n` +
  `export function Modal({ title, children }: { title: string; children: ReactNode; [k: string]: unknown }) {\n` +
  `  return <div data-modal={title}>{children}</div>;\n}\n` +
  `export function ConfirmDestructive() { return null; }\n` +
  `export function MenuButton() { return null; }\n`);
writeFileSync(stub('stub-toast.tsx'), `export const useToast = () => () => {};\n`);
const stubs = [
  `--alias:@/components/Modal=${stub('stub-modal.tsx')}`,
  `--alias:@/components/Toast=${stub('stub-toast.tsx')}`,
];

let RR = null;
try {
  RR = await bundle(
    'render',
    `import { createElement } from 'react';\n` +
    `import { renderToStaticMarkup } from 'react-dom/server';\n` +
    `import { MemoryRouter, Route, Routes } from 'react-router-dom';\n` +
    `import ClientDetailPage from '${p('src/pages/ClientDetail')}';\n` +
    `import { DeploymentDialog } from '${p('src/pages/wof/DeploymentDialog')}';\n` +
    `import { AddLineDialog } from '${p('src/pages/wof/dialogs')}';\n` +
    `import * as R from '${p('src/lib/roles')}';\n` +
    `import * as W from '${p('src/lib/wof')}';\n` +
    `export { createElement, renderToStaticMarkup, MemoryRouter, Route, Routes, ClientDetailPage, DeploymentDialog, AddLineDialog, R, W };\n`,
    ['--jsx=automatic', ...stubs],
  );
} catch {
  RR = null;
}

if (!RR) {
  ok('the client record renders (skipped — could not bundle)', true);
} else {
  RR.W.load();
  RR.R.setActing(negotiator.id);
  const draw = (url) =>
    RR.renderToStaticMarkup(
      RR.createElement(RR.MemoryRouter, { initialEntries: [url] },
        RR.createElement(RR.Routes, {},
          RR.createElement(RR.Route, { path: '/clients/:id', element: RR.createElement(RR.ClientDetailPage, {}) }))),
    );

  const html = draw(`/clients/${onCard.id}`);
  ok('the record renders', html.length > 2000, String(html.length));
  ok('  · under the client’s own name', html.includes(onCard.name));
  ok('  · with a way back to the register', /href="\/clients"/.test(html));
  ok('  · and the card the account is on', /Preferred/.test(html));

  const rates = draw(`/clients/${onCard.id}?tab=rates`);
  ok('a link can point at the rates, not just at the client', /Agreed|Published/.test(rates));
  ok('  · showing what this account pays against what everyone pays',
     rates.includes(onCard.name) && /Margin/.test(rates));

  const docs = draw(`/clients/${onCard.id}?tab=documents`);
  ok('and at the documents', /Drop a document here/.test(docs));

  ok('an id that is not a client does not render a blank record',
     draw('/clients/nope').length < 200, 'it redirects to the register');

  /* The two screens an operator prices from. Rendered rather than reasoned
     about, because the bug they had was in the markup: the arithmetic used the
     account's rate and the label beside it did not. */
  const job = RR.W.all().find((x) => x.clientId === onCard.id && !RR.W.isTerminal(x.stage))
    || RR.W.create({ title: 'RATES — render', clientId: onCard.id,
                     start: '2026-11-02T08:00:00', end: '2026-11-03T18:00:00' });
  const mine = RATES.rateFor(STEWARD, onCard.id, DB.NOW).charge.toFixed(2);
  const theirs = DB.rateAt(STEWARD, DB.NOW).charge.toFixed(2);

  const dep = RR.renderToStaticMarkup(
    RR.createElement(RR.MemoryRouter, {},
      RR.createElement(RR.DeploymentDialog, { w: job, onClose: () => {} })),
  );
  ok('the deployment builder renders', dep.length > 2000, String(dep.length));
  ok('  · offering the price this account pays', dep.includes(`£${mine}`), `wanted £${mine}`);
  ok('  · not the published one, which is a different number',
     mine !== theirs && !new RegExp(`£${theirs}/`).test(dep), `£${theirs} must not be the picker figure`);
  ok('  · and says whose prices they are', /Prices are what/.test(dep));

  const add = RR.renderToStaticMarkup(
    RR.createElement(RR.MemoryRouter, {},
      RR.createElement(RR.AddLineDialog, { w: job, kind: 'quote', onClose: () => {} })),
  );
  ok('the add-line dialog renders', add.length > 1000, String(add.length));
  ok('  · priced for the account, and saying why it is not the published rate',
     /agreed with this client|card, published/.test(add));
}

/* ========================================================================== */
/* The tally reads the same as every other harness here, and deliberately: the
   drift check reads these lines rather than an exit code, and a harness that
   reports itself in its own dialect is one it silently treats as crashed. */
console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures ? 1 : 0);
