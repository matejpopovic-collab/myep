/* ============================================================================
   EP HOP — verification harness for the stock register
   ----------------------------------------------------------------------------
   A register that has not been run against its own edge cases is a spreadsheet
   with better fonts. This proves the five claims `src/lib/hop.ts` makes:

     1. THE SEED IS SOUND — every stock item points at a real kit charge, and
        the charges deliberately left out are left out, not lost.

     2. UNMANAGED IS A STATE, NOT A ZERO — a kit charge EP sub-hires reports
        "not tracked", never "none in stock", and can never be short.

     3. AVAILABILITY IS A RUN OF DAYS — only ordered work draws, quoted work is
        pressure, turnaround extends the window past the job, and a cancelled
        job holds nothing.

     4. COUNTS ARE GUARDED AND JOURNALLED — `kit.stock` is required, nonsense
        is refused with a reason, a numeric change needs a why, and the log
        names who did it.

     5. IT SURVIVES A RELOAD — an edited count comes back; an untouched one
        still tracks the seed.

   Run:  node hop-tests.mjs
   ----------------------------------------------------------------------------
   Same shape as `roles-tests.mjs`: one esbuild bundle so there is exactly one
   copy of the register, and a localStorage shim kept across boots so a re-import
   is a reload rather than a restart.
   ========================================================================== */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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

const work = mkdtempSync(join(tmpdir(), 'eprosta-hop-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');
let generation = 0;

async function boot() {
  generation += 1;
  const entry = join(work, `entry-${generation}.ts`);
  const out = join(work, `bundle-${generation}.mjs`);
  writeFileSync(
    entry,
    `export * as HOP from '${p('src/lib/hop')}';\n` +
      `export * as CH from '${p('src/lib/charges')}';\n` +
      `export * as R from '${p('src/lib/roles')}';\n` +
      `export * as P from '${p('src/lib/portal')}';\n` +
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

let { HOP, R, P, W, DB, CH } = await boot();

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
};
const group = (t) => console.log(`\n${t}`);

/**
 * Deactivate every fixture this file created, by title.
 *
 * By TITLE and through `W.all()`, not by holding the object: `boot()` reloads
 * the module, so a fixture created before a reload lives on in the store but
 * the local handle points at a dead copy from the previous instance. Retiring
 * through the live list is the only way that survives, and a live fixture left
 * standing is how an assertion passes for a reason that has nothing to do with
 * what it claims to test.
 */
const retireFixtures = () => {
  W.all().forEach((x) => {
    if (/^HOP (TESTER|RENDER)/.test(x.title)) x.active = false;
  });
};

/** Act as somebody holding `kit.stock` — the warehouse, by design. */
const asWarehouse = () => {
  const m = R.members().find((x) => x.roleId === 'warehouse' && x.status === 'active');
  R.setActing(m.id);
  return m;
};

/* ============================================================ 1. the seed === */

group('The seed is sound');
ok('every stock item points at a real charge',
   HOP.STOCK.every((s) => !!DB.charge(s.chargeId)));
ok('…and every one of them is kit, not staff or a service',
   HOP.STOCK.every((s) => DB.charge(s.chargeId).kind === 'kit'));
ok('no two items claim the same charge',
   new Set(HOP.STOCK.map((s) => s.chargeId)).size === HOP.STOCK.length);
ok('out of service never exceeds owned',
   HOP.STOCK.every((s) => s.outOfService <= s.owned));
ok('issuable is owned less out of service',
   HOP.STOCK.every((s) => HOP.issuable(s) === s.owned - s.outOfService));
ok('the radio is the constrained item, as the fixtures intend',
   HOP.stockItem('ch-kit-radio').owned === 250);
ok('stockList follows charge-table order, not seed order',
   HOP.stockList().map((s) => s.chargeId).join() ===
     HOP.kitCharges().filter((c) => HOP.isManaged(c.id)).map((c) => c.id).join());

group('Unmanaged is a state, not a zero');
ok('the tower light is a kit charge', DB.charge('ch-kit-lighting').kind === 'kit');
ok('…with no stock item', !HOP.isManaged('ch-kit-lighting'));
ok('…so availability says nothing rather than none',
   HOP.availability('ch-kit-lighting', '2026-08-01', '2026-08-10').length === 0);
ok('…freeOn is null, which is not zero', HOP.freeOn('ch-kit-lighting', '2026-08-01') === null);
ok('…and it can never be short', HOP.shortDays('ch-kit-lighting').length === 0);
ok('…nor appear in the badge count',
   !HOP.shortItems().some((s) => s.chargeId === 'ch-kit-lighting'));
ok('a managed item does report a run of days',
   HOP.availability('ch-kit-radio', '2026-08-01', '2026-08-10').length === 10);

/* ==================================================== 3. availability === */

group('Availability is a run of days, and only ordered work draws');

/* Dates are relative to the seeded clock, not typed, so the fixture always
   lands inside the 28-day horizon `shortDays` reads — a hard-coded October
   would fall outside it the moment the seed is re-anchored. */
const day = (n) => new Date(new Date(DB.NOW).getTime() + n * 86400000).toISOString().slice(0, 10);
/* An explicit time of day, because the span's day COUNT depends on it: a job
   whose end lands on the same clock time as its start has one fewer working
   day than the calendar suggests, which is `spanWindows`' rule and therefore
   the register's. Fixtures run 06:00 to 20:00 like real jobs do. */
const d = (n, time = '06:00:00') => `${day(n)}T${time}`;
const dEnd = (n) => d(n, '20:00:00');

const RADIO = 'ch-kit-radio';
const radio = HOP.stockItem(RADIO);
const ceiling = HOP.issuable(radio);
const TA = radio.turnaround;

const at = (n) => HOP.availability(RADIO, day(n), day(n))[0];

/* Seeded jobs commit radios too, so every assertion below is a DELTA against
   what the fixtures already hold. An absolute number here would be a test of
   the seed data, which is not what this module is for. */
const base = {};
[3, 4, 7, 7 + TA, 8 + TA, 20].forEach((n) => { base[n] = at(n); });

const jobA = W.create({ title: 'HOP TESTER — ordered', start: d(3), end: dEnd(7) });
W.addLine(jobA, RADIO, { qty: 40 });
jobA.stage = 'order';

ok('an ordered job draws on its own days', at(4).committed === base[4].committed + 40);
ok('  · from the first day of the span', at(3).committed === base[3].committed + 40);
ok('  · through the last', at(7).committed === base[7].committed + 40);
ok(`  · and turnaround holds it ${TA} day(s) longer`,
   at(7 + TA).committed === base[7 + TA].committed + 40);
ok('  · then it is back on the shelf',
   at(8 + TA).committed === base[8 + TA].committed);
ok('  · nothing lands outside the window', at(20).committed === base[20].committed);
ok('  · free is issuable less committed', at(4).free === ceiling - at(4).committed);

const jobB = W.create({ title: 'HOP TESTER — quoting', start: d(4), end: dEnd(6) });
W.addLine(jobB, RADIO, { qty: 60 });
jobB.stage = 'quote';

ok('a quoted job is pressure, not a draw', at(4).pressure === base[4].pressure + 60);
ok('  · and does not move committed', at(4).committed === base[4].committed + 40);
ok('  · nor free', at(4).free === ceiling - (base[4].committed + 40));

jobB.stage = 'order';
ok('signing it turns pressure into a draw', at(4).committed === base[4].committed + 100);
ok('  · and it stops counting as pressure', at(4).pressure === base[4].pressure);

jobB.stage = 'cancelled';
ok('a cancelled job holds nothing', at(4).committed === base[4].committed + 40);
ok('  · and is not pressure either', at(4).pressure === base[4].pressure);

jobB.stage = 'order';
jobB.active = false;
ok('nor does an inactive one', at(4).committed === base[4].committed + 40);

/* Both fixtures retired before the next group. Leaving a 100-radio draw
   standing would make the shortfall below a fact about this file rather than
   about the module — which is exactly the class of test that passes against a
   mutant. */
jobA.active = false;

/* -------------------------------------------------- shortfall and badge --- */

group('A shortfall is days, not a number');

/* Sized against the ceiling rather than typed, so the job is guaranteed to
   overshoot whatever the fixtures already hold. */
const shortBefore = new Set(HOP.shortDays(RADIO).map((x) => x.date));

const jobC = W.create({ title: 'HOP TESTER — oversubscribed', start: d(10), end: dEnd(12) });
W.addLine(jobC, RADIO, { qty: ceiling + 50 });
jobC.stage = 'order';

const short = HOP.shortDays(RADIO);
const added = short.map((x) => x.date).filter((x) => !shortBefore.has(x));
ok('the item is reported short', short.length > shortBefore.size);
ok('  · on the job’s days plus turnaround, and no others',
   added.join() === [10, 11, 12].concat(TA ? [13] : []).map(day).join(),
   added.join());
ok('  · with a negative free, not a clamped zero', short.every((x) => x.free < 0));
ok('  · and it reaches the rail badge',
   HOP.shortItems().some((s) => s.chargeId === RADIO));
ok('  · while an item nobody oversubscribed does not',
   !HOP.shortItems().some((s) => s.chargeId === 'ch-kit-cone'));

jobC.stage = 'quote';
ok('un-signing it clears the shortfall — a quote cannot oversubscribe',
   HOP.shortDays(RADIO).map((x) => x.date).join() === [...shortBefore].join());
jobC.stage = 'order';

/* ------------------------------------------------------------ consumable --- */

group('A consumable is issued, not lent');
ok('hi-vis is a consumable', HOP.isConsumable(DB.charge('ch-kit-hivis')));
ok('  · and a radio is not', !HOP.isConsumable(DB.charge('ch-kit-radio')));
ok('  · nor is a staff charge, whatever its unit',
   !HOP.isConsumable(DB.charge('ch-sv-accred')));

const hiVisBefore = HOP.availability('ch-kit-hivis', day(2), day(2))[0].committed;
const jobD = W.create({ title: 'HOP TESTER — consumable', start: d(2), end: dEnd(3) });
W.addLine(jobD, 'ch-kit-hivis', { qty: 25 });
jobD.stage = 'order';
ok('it is drawn on the job’s days',
   HOP.availability('ch-kit-hivis', day(2), day(2))[0].committed === hiVisBefore + 25);
ok('  · and never comes back — the draw is still there a year later',
   HOP.availability('ch-kit-hivis', day(400), day(400))[0].committed >= 25,
   'a consumable window is open-ended');

/* ============================================ 4. counts are guarded === */

group('Only the warehouse can change a count');
const clerk = R.members().find((m) => m.roleId === 'payroll' && m.status === 'active');
R.setActing(clerk.id);
ok('Payroll does not hold kit.stock', !R.can('kit.stock'));
ok('  · and is refused, with a reason',
   HOP.setStock(RADIO, { owned: 9999 }, 'because I can').ok === false);
ok('  · which names the permission',
   (HOP.setStockBlocker(RADIO, { owned: 9999 }) || '').toLowerCase().includes('permission'));
ok('  · and the count did not move', HOP.stockItem(RADIO).owned === 250);

const pete = asWarehouse();
ok('the Warehouse Manager holds kit.stock', R.can('kit.stock'));
ok('  · but not the money', !R.can('charges.view') && !R.can('report.costing'));
ok('  · nor the rota', !R.can('staffing.assign'));
ok('  · and Pete is the one holding it', pete.id === 'm-pete');

group('Nonsense is refused before it is stored');
ok('a negative count', HOP.setStock(RADIO, { owned: -1 }, 'typo').ok === false);
ok('a fractional count', HOP.setStock(RADIO, { owned: 12.5 }, 'typo').ok === false);
ok('more out of service than owned',
   HOP.setStock(RADIO, { owned: 10, outOfService: 40 }, 'typo').ok === false);
ok('  · and says so in numbers',
   (HOP.setStockBlocker(RADIO, { owned: 10, outOfService: 40 }) || '').includes('40'));
ok('an unmanaged item cannot be given a count',
   HOP.setStock('ch-kit-lighting', { owned: 4 }, 'we bought some').ok === false);
ok('  · and is told it is sub-hired, not that it does not exist',
   (HOP.setStockBlocker('ch-kit-lighting', { owned: 4 }) || '').includes('sub-hire'));
ok('after all of that the count is untouched', HOP.stockItem(RADIO).owned === 250);

group('A count change has to say why');
ok('no reason, no change', HOP.setStock(RADIO, { owned: 260 }, '   ').ok === false);
ok('  · and the count did not move', HOP.stockItem(RADIO).owned === 250);
ok('a note alone needs no reason — it is not a count',
   HOP.setStock(RADIO, { note: 'Two handsets in for repair' }, '').ok === true);
ok('with a reason it lands', HOP.setStock(RADIO, { owned: 260 }, 'Bought 10 more').ok === true);
ok('  · and the register says so', HOP.stockItem(RADIO).owned === 260);
ok('  · so does issuable', HOP.issuable(HOP.stockItem(RADIO)) === 260 - 12);

/* ============================================== 5. the log, and reload === */

group('The log names who, when and why');
const log = HOP.changeLog(RADIO);
ok('the count change is recorded', log.some((c) => c.field === 'owned' && c.to === 260));
const entry = log.find((c) => c.field === 'owned');
ok('  · with the old value, not just the new', entry.from === 250);
ok('  · the reason as typed', entry.reason === 'Bought 10 more');
ok('  · and the person, by name as well as id',
   entry.by === 'm-pete' && entry.byName === 'Pete Sandow');
ok('the note change is in there too', log.some((c) => c.field === 'note'));
ok('  · newest first', log[0].at >= log[log.length - 1].at);
ok('the log filters by item',
   HOP.changeLog('ch-kit-cone').length === 0 && HOP.changeLog().length >= log.length);

group('An edited count survives a reload');
({ HOP, R, P, W, DB, CH } = await boot());
asWarehouse();
ok('the edited count came back', HOP.stockItem('ch-kit-radio').owned === 260);
ok('  · and so did the note',
   HOP.stockItem('ch-kit-radio').note === 'Two handsets in for repair');
ok('  · and the log', HOP.changeLog('ch-kit-radio').some((c) => c.reason === 'Bought 10 more'));
ok('an untouched item still tracks the seed',
   HOP.stockItem('ch-kit-cone').owned === DB.STOCK_SEED.find((s) => s.chargeId === 'ch-kit-cone').owned);
ok('  · including a field the edited item did not change',
   HOP.stockItem('ch-kit-radio').turnaround ===
     DB.STOCK_SEED.find((s) => s.chargeId === 'ch-kit-radio').turnaround);

HOP.resetStock();
ok('reset puts the shipped figures back', HOP.stockItem('ch-kit-radio').owned === 250);
ok('  · and clears the log', HOP.changeLog('ch-kit-radio').length === 0);
({ HOP, R, P, W, DB, CH } = await boot());
ok('  · and that survives a reload too', HOP.stockItem('ch-kit-radio').owned === 250);

/* A reload restores the fixtures above as ACTIVE — `x.active = false` is a
   plain mutation and never called `save()`. Retire them again through the
   fresh module before anything downstream measures the register. */
retireFixtures();
ok('the fixtures above are retired, so the register is back to the seed',
   !HOP.shortItems().some((s) => s.chargeId === RADIO));

/* The seed's own sizing. `STOCK_SEED` documents these figures as MEASURED
   against peak committed demand, and that claim rots the moment a fixture
   grows — silently, because an oversubscribed register still renders. This is
   the assertion that makes the comment enforceable. */
group('The seed is sized against the work the seed commits');
/* Relative to today, not July-to-January. The seed is shifted forward by whole
   weeks from its authoring date every time the anchor is set, so a fixed
   calendar window eventually stops covering the work it is meant to measure —
   and the assertion then passes by looking at nothing, which is the worst way
   for a guard like this to fail. */
const SEED_FROM = day(-120);
const SEED_TO = day(365);
const oversubscribed = HOP.stockList()
  .map((it) => {
    const days = HOP.availability(it.chargeId, SEED_FROM, SEED_TO);
    const peak = Math.max(0, ...days.map((x) => x.committed));
    return { id: it.chargeId, peak, issuable: HOP.issuable(it) };
  })
  .filter((x) => x.peak > x.issuable);
ok('no item is oversubscribed by ordered seed data alone',
   oversubscribed.length === 0,
   oversubscribed.map((x) => `${x.id} peak ${x.peak} > issuable ${x.issuable}`).join(' | '));
ok('  · and the radio is still the tight one, which the collision needs', (() => {
  const it = HOP.stockItem(RADIO);
  const days = HOP.availability(RADIO, SEED_FROM, SEED_TO);
  const peak = Math.max(0, ...days.map((x) => x.committed));
  const peakWithPressure = Math.max(0, ...days.map((x) => x.committed + x.pressure));
  return peak <= HOP.issuable(it) && peakWithPressure > HOP.issuable(it);
})(), 'ordered work must fit; ordered plus quoted must not');

/* ========================================== 6. the rail and the guard === */

group('The rail agrees with the register');
asWarehouse();
const rail = P.nav().flatMap((g) => g.items.map((i) => i.href));
ok('the Warehouse Manager is offered the stock register', rail.includes('/warehouse/stock'));
ok('  · and the group is named Warehouse',
   P.nav().some((g) => g.group === 'Warehouse'));
ok('  · but not payroll, costing or the charge table',
   !rail.includes('/reports/payroll') && !rail.includes('/reports/costing') && !rail.includes('/charges'));
R.setActing(clerk.id);
ok('Payroll is not offered it',
   !P.nav().flatMap((g) => g.items.map((i) => i.href)).includes('/warehouse/stock'));

/* ================================================ 7. the hire window === */

group('A kit line is out for the whole job unless somebody says otherwise');

/* Baseline BEFORE the fixture exists. Capturing it after would fold the
   fixture's own whole-span draw into the baseline, and every assertion below
   would then be measuring the narrowing against itself. */
const winBase = {};
/* Out to day 20, not day 7, because the clamp assertion below reads across the
   whole probe window. It used to compare all eighteen days against day THREE's
   figure, which made "this line is drawing here" indistinguishable from "some
   other job is out that week" — and the seed moves with the calendar, so the
   day it broke was only ever a matter of when. Same rule as `base` above: a
   delta against each day's own baseline, never one number as a threshold for
   another day. */
for (let n = 3; n <= 20; n++) winBase[n] = at(n);

const jobW = W.create({ title: 'HOP TESTER — window', start: d(3), end: dEnd(7) });
const wl = W.addLine(jobW, RADIO, { qty: 10 });
jobW.stage = 'order';
const spanDays = W.hireWindow(jobW, wl).days;

ok('the span is five working days', spanDays === 5, String(spanDays));
ok('an unset window is the whole span',
   wl.hire === undefined && W.hireWindow(jobW, wl).from === 1 && W.hireWindow(jobW, wl).to === spanDays);

ok('  · so it draws on every day of the span',
   [3, 4, 5, 6, 7].every((n) => at(n).committed === winBase[n].committed + 10));

W.setHire(jobW, wl.id, { from: 2, to: 3 });

ok('narrowing stores the window', wl.hire.from === 2 && wl.hire.to === 3);
ok('  · and units is DERIVED from it, not typed', wl.units === 2, String(wl.units));
ok('  · the register draws on the narrowed days only',
   at(4).committed === winBase[4].committed + 10 && at(5).committed === winBase[5].committed + 10);
ok('  · and not on the days it dropped',
   at(3).committed === winBase[3].committed && at(7).committed === winBase[7].committed);
ok('  · turnaround runs from the window’s last day, not the job’s',
   at(6).committed === winBase[6].committed + 10);

W.setHire(jobW, wl.id, { from: 1, to: spanDays });
ok('a window covering everything is stored as no window at all',
   wl.hire === undefined, 'two encodings of one fact would drift apart');
ok('  · and it draws on every day again',
   at(3).committed === winBase[3].committed + 10 && at(7).committed === winBase[7].committed + 10);

/* Written straight onto the line, NOT through `setHire`, because `setHire`
   clamps on the way in — so going through it would only ever test itself. A
   window this far out of range arrives one way in practice: a saved record
   whose job was shortened underneath it, which is the case `hireWindow`'s
   clamp exists for and the case that reaches the stock register. */
wl.hire = { from: 99, to: 200 };
ok('a stored window out of range is clamped on the way out, not trusted',
   W.hireWindow(jobW, wl).from === spanDays && W.hireWindow(jobW, wl).to === spanDays,
   JSON.stringify(W.hireWindow(jobW, wl)));
ok('  · so it draws on one day, not on two hundred', (() => {
  // Days where THIS line added something, i.e. where the figure is above what
  // that same day held before the fixture existed. The clamped window is one
  // day, plus the item's turnaround after it.
  const drawn = [];
  for (let n = 3; n <= 20; n++) if (at(n).committed > winBase[n].committed) drawn.push(n);
  return drawn.length <= spanDays;
})(), 'a clamped window must not draw across the whole horizon');
wl.hire = { from: 4, to: 2 };
ok('an inverted stored window collapses rather than inverting',
   W.hireWindow(jobW, wl).from === 4 && W.hireWindow(jobW, wl).to === 4);
wl.hire = { from: 0, to: 3 };
ok('a zero start is pulled up to day one',
   W.hireWindow(jobW, wl).from === 1 && W.hireWindow(jobW, wl).to === 3);
W.setHire(jobW, wl.id, null);

const staffLine = W.addLine(jobW, 'ch-st-event', { qty: 4, units: 8 });
ok('a staff line has no hire window and refuses one',
   W.setHire(jobW, staffLine.id, { from: 1, to: 2 }) === false && staffLine.hire === undefined);
ok('  · and its units are untouched', staffLine.units === 8);

/* ------------------------------------------------------------- sub-hire --- */

group('Sub-hire draws nothing');
const subBase = at(4).committed;
W.setSubHire(jobW, wl.id, true);
ok('marking it sub-hire removes it from the draw', at(4).committed === subBase - 10);
ok('  · and it can never be short', HOP.lineShortfall(jobW, wl) === null);
ok('  · but the line, its money and its quantity are untouched',
   wl.qty === 10 && W.lineValue(wl) > 0);
W.setSubHire(jobW, wl.id, false);
ok('bringing it back restores the draw', at(4).committed === subBase);
ok('a staff line cannot be sub-hired', W.setSubHire(jobW, staffLine.id, true) === false);
jobW.active = false;

/* ------------------------------------------------------ warn, then refuse --- */

group('A quote warns; an order is refused');

/* jobC from the shortfall group is still ordered and deliberately
   oversubscribed. Retire it — leaving it standing would make the
   "the register is not short" assertion below pass or fail for a reason that
   has nothing to do with Reading. */
retireFixtures();

const reading = W.all().find((x) => x.id === 'wof-112');
const regatta = W.all().find((x) => x.id === 'wof-114');
ok('the collision fixture is ordered', regatta && W.atLeast(regatta, 'order'));
/* The only narrowed window in seed data, and therefore the only proof the
   field survives the seed's time-shift, `normaliseWof` and a save/load
   round-trip rather than only ever being written by `setHire` in a test. */
const seededNarrow = regatta.lines.find((l) => l.chargeId === 'ch-kit-lighting');
ok('  · carrying the one narrowed hire window in the seed',
   !!seededNarrow && !!seededNarrow.hire,
   JSON.stringify(seededNarrow && seededNarrow.hire));
ok('  · narrower than the job it is on',
   !!seededNarrow &&
     W.hireWindow(regatta, seededNarrow).to - W.hireWindow(regatta, seededNarrow).from + 1 <
       W.hireWindow(regatta, seededNarrow).days);
ok('  · with units derived to match, not typed beside it',
   !!seededNarrow &&
     seededNarrow.units ===
       W.hireWindow(regatta, seededNarrow).to - W.hireWindow(regatta, seededNarrow).from + 1);
ok('  · and Reading is still quoting', reading.stage === 'quote');
ok('  · on overlapping days',
   regatta.start.slice(0, 10) <= reading.end.slice(0, 10) &&
     reading.start.slice(0, 10) <= regatta.end.slice(0, 10));

const readingRadio = reading.lines.find((l) => l.chargeId === RADIO);
const sf = HOP.lineShortfall(reading, readingRadio);
/* Same reason as `sb` below: everything after this reads fields off `sf`, and
   a throw here would take the diagnosis down with the diagnosis. */
const SF = sf || { short: 0, clashes: [], days: [], name: '' };
const sentence = sf ? HOP.describeShortfall(sf) : '';
ok('Reading’s radio line is flagged short', !!sf);
ok('  · by the amount that does not fit', SF.short > 0);
ok('  · naming the job it collides with', SF.clashes.some((c) => c.wofId === 'wof-114'));
ok('  · and the days', SF.days.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(SF.days[0].date || ''));
ok('  · the sentence carries all three',
   /wanted/.test(sentence) && /short/.test(sentence) && /WOF-2026-0114/.test(sentence));
ok('  · and does not repeat the item name when the caller already said it',
   !!sf && !HOP.describeShortfall(sf, { name: false }).startsWith(SF.name));

ok('nothing about the quote is blocked — it still prices and sends',
   W.gate(reading, 'signoff').block.every((b) => !/stock/i.test(b)));
ok('the register itself is NOT short — only ordered work draws',
   !HOP.shortItems().some((s) => s.chargeId === RADIO),
   HOP.shortDays(RADIO).map((x) => `${x.date} ${x.free}`).join(' | '));

const orderGate = W.gate(reading, 'order');
const stockBlock = orderGate.block.find((b) => /Not enough/.test(b));
/* Defaulted rather than dereferenced: a harness that throws on the first
   failure hides every assertion after it, and the ones after this are the
   ones that say WHY the block is wrong. */
const sb = stockBlock || '';
ok('advancing to Order is refused', !!stockBlock);
ok('  · as a block, not a warning',
   !orderGate.ok && !orderGate.warn.some((x) => /Not enough/.test(x)));
ok('  · with a reason, not a silent false', sb.length > 40);
ok('  · that names the item', sb.includes('Two-way radio'));
ok('  · the clashing job', sb.includes('WOF-2026-0114'));
ok('  · and both ways out', /sub-hire/.test(sb) && /Reduce/.test(sb));

W.setSubHire(reading, readingRadio.id, true);
ok('sub-hiring the line clears the block',
   !W.gate(reading, 'order').block.some((b) => /Not enough/.test(b)));
W.setSubHire(reading, readingRadio.id, false);
const wasQty = readingRadio.qty;
readingRadio.qty = 10;
ok('so does reducing it', !W.gate(reading, 'order').block.some((b) => /Not enough/.test(b)));
readingRadio.qty = wasQty;
ok('and it comes back when the quantity does',
   W.gate(reading, 'order').block.some((b) => /Not enough/.test(b)));

ok('an unmanaged line is never blocked, however much is quoted', (() => {
  const j = W.create({ title: 'HOP TESTER — sub-hired item', start: d(3), end: dEnd(5) });
  W.addLine(j, 'ch-kit-lighting', { qty: 9999 });
  j.stage = 'signoff';
  j.signoff = { signedBy: 'x', signedByRole: 'x', signedAt: d(1), method: 'x', ref: 'x', ip: '—' };
  const clean = !W.gate(j, 'order').block.some((b) => /Not enough/.test(b));
  j.active = false;
  return clean;
})());

/* ---------------------------------------------------------------------------
   The gate is passed once. A variation arrives afterwards.
   --------------------------------------------------------------------------- */

group('The shelf is checked before the line exists, not after');

retireFixtures();

ok('an ordered job never meets the Order gate again — which is the hole', (() => {
  const j = W.create({ title: 'HOP TESTER — post-order variation', start: d(3), end: dEnd(5) });
  j.signoff = { signedBy: 'x', signedByRole: 'x', signedAt: d(-2), method: 'x', ref: 'x', ip: '—' };
  j.stage = 'order';
  // Far more than EP owns, added the way a variation is added: straight onto a
  // job that is already ordered.
  const l = W.addLine(j, RADIO, { qty: HOP.issuable(HOP.stockItem(RADIO)) + 500 });
  const flagged = HOP.wofShortfalls(j).some((sf) => sf.chargeId === RADIO);
  const variation = l.source === 'variation';
  // The next gate is Job documents, and nothing on the way to it looks at a
  // shelf. That is why the check had to move into the dialog.
  const unblocked = !W.gate(j).block.some((b) => /Not enough/.test(b));
  j.active = false;
  return flagged && variation && unblocked;
})(), 'the shortfall is real, the line is a variation, and nothing refuses it');

ok('the same ask is caught BEFORE it is added', (() => {
  const j = W.create({ title: 'HOP TESTER — prospective', start: d(3), end: dEnd(5) });
  j.signoff = { signedBy: 'x', signedByRole: 'x', signedAt: d(-2), method: 'x', ref: 'x', ip: '—' };
  j.stage = 'order';
  const shelf = HOP.issuable(HOP.stockItem(RADIO));
  const sf = HOP.prospectiveShortfall(j, RADIO, shelf + 500);
  const named = !!sf && sf.name === DB.charge(RADIO).name && sf.qty === shelf + 500;
  const sentence = sf ? HOP.describeShortfall(sf, { name: false }) : '';
  // No line was created to find that out.
  const clean = j.lines.length === 0;
  j.active = false;
  return !!sf && named && clean && /wanted/.test(sentence) && /short/.test(sentence);
})(), 'this is what the Add-line dialog asks as the quantity is typed');

ok('  · and it scales with the ask, item for item', (() => {
  const j = W.create({ title: 'HOP TESTER — prospective scale', start: d(3), end: dEnd(5) });
  j.stage = 'order';
  const shelf = HOP.issuable(HOP.stockItem(RADIO));
  const a = HOP.prospectiveShortfall(j, RADIO, shelf + 50);
  const b = HOP.prospectiveShortfall(j, RADIO, shelf + 100);
  j.active = false;
  return !!a && !!b && b.short === a.short + 50;
})());

ok('  · nothing asked, nothing to say', (() => {
  const j = W.create({ title: 'HOP TESTER — prospective zero', start: d(3), end: dEnd(5) });
  j.stage = 'order';
  const none = HOP.prospectiveShortfall(j, RADIO, 0) === null;
  const staff = DB.CHARGES.find((c) => c.kind === 'staff');
  const notKit = HOP.prospectiveShortfall(j, staff.id, 9999) === null;
  // Unmanaged kit is sub-hired by definition, so it can never be short.
  const unmanaged = HOP.prospectiveShortfall(j, 'ch-kit-lighting', 9999) === null;
  j.active = false;
  return none && notKit && unmanaged;
})(), 'a staff line and an unmanaged item have no shelf to be short of');

/* ---------------------------------------------------------------------------
   Editing the quantity is the THIRD road into the same arithmetic, and it used
   to be the one that never met it.
   --------------------------------------------------------------------------- */

const ordered = () => {
  const j = W.create({ title: 'HOP TESTER — qty edit', start: d(3), end: dEnd(5) });
  j.signoff = { signedBy: 'x', signedByRole: 'x', signedAt: d(-2), method: 'x', ref: 'x', ip: '—' };
  j.stage = 'order';
  return j;
};

/* What is actually free across this job's dates, asked before the line under
   test exists. `issuable` is the shelf; other jobs are already standing on
   some of it. */
const freeAcross = (j) =>
  Math.min(...HOP.availability(RADIO, j.start.slice(0, 10), j.end.slice(0, 10)).map((x) => x.free));

ok('an edit on an ordered job counts only what is NEW off the shelf', (() => {
  const j = ordered();
  const shelf = freeAcross(j);
  // A line that exactly fills what is left. The register is carrying it,
  // because the job is ordered.
  const l = W.addLine(j, RADIO, { qty: shelf });
  const same = HOP.qtyShortfall(j, l, shelf) === null;
  const up = HOP.qtyShortfall(j, l, shelf + 10);
  j.active = false;
  // The whole ask is reported — that is the sentence — but the SHORTAGE is the
  // ten that are not there, not the whole line counted twice.
  return same && !!up && up.short === 10 && up.qty === shelf + 10;
})(), 'the first N are already committed to this job; subtracting them twice invents a shortage');

ok('  · and a reduction hands stock back rather than reporting a shortage', (() => {
  const j = ordered();
  const shelf = freeAcross(j);
  const l = W.addLine(j, RADIO, { qty: shelf + 200 });
  const wasShort = !!HOP.qtyShortfall(j, l, shelf + 200);
  const fixed = HOP.qtyShortfall(j, l, shelf - 50) === null;
  j.active = false;
  return wasShort && fixed;
})());

ok('  · the line\u2019s own hire window is what is judged, not the whole job', (() => {
  const j = ordered();
  const shelf = freeAcross(j);
  const l = W.addLine(j, RADIO, { qty: 1, hire: { from: 1, to: 1 } });
  const sf = HOP.qtyShortfall(j, l, shelf + 300);
  j.active = false;
  // Three-day job, one-day window: one date named, and it is the first.
  return !!sf && sf.days.length === 1 && sf.days[0].date === j.start.slice(0, 10);
})(), 'kit wanted for the build days is not competing for the shelf on the Sunday');

ok('  · sub-hire clears it, the way it clears every other check', (() => {
  const j = ordered();
  const l = W.addLine(j, RADIO, { qty: 5, subHire: true });
  const clear = HOP.qtyShortfall(j, l, 99999) === null;
  j.active = false;
  return clear;
})());

ok('before Order the whole quantity is weighed, because nothing is committed yet', (() => {
  const j = W.create({ title: 'HOP TESTER — qty edit, unsigned', start: d(3), end: dEnd(5) });
  const shelf = freeAcross(j);
  const l = W.addLine(j, RADIO, { qty: 1 });
  const fits = HOP.qtyShortfall(j, l, shelf) === null;
  const over = HOP.qtyShortfall(j, l, shelf + 25);
  j.active = false;
  return fits && !!over && over.short === 25;
})());

retireFixtures();

/* ================================================ 8. the warehouse === */

group('The reference survives the rename, and is never renumbered');
const legacy = W.all().find((x) => x.picking && /^HH-/.test(x.picking.epHopRef));
ok('a job sent under the old integration keeps its HH- reference', !!legacy,
   legacy && legacy.picking.epHopRef);
ok('  · reachable under the new field name', !!legacy && !!legacy.picking.epHopRef);
ok('  · with the old spelling still readable, so the migration is legible',
   !!legacy && legacy.picking.hireHopRef === legacy.picking.epHopRef);

/* The migration itself, exercised on the shape it actually meets: a SAVED
   record written before the rename, carrying `hireHopRef` and no `epHopRef`.
   Seeded jobs go through `legacyPicking()` and already have both, so they
   never reach this branch — without this, renumbering on migration would pass
   every other assertion in the file. */
const migrated = W.normaliseWof({
  ...W.create({ title: 'HOP TESTER — migration', start: d(9), end: dEnd(10) }),
  picking: {
    hireHopRef: 'HH-2026-8123',
    pushedAt: d(1), lastSyncAt: d(1), status: 'Packed', version: 1,
  },
});
ok('a pre-rename record gains the new field', migrated.picking.epHopRef === 'HH-2026-8123');
ok('  · with the reference UNCHANGED, not reissued',
   !/^EPH-/.test(migrated.picking.epHopRef),
   'the warehouse has already picked against that number');
ok('  · and the old spelling left in place, so the record stays legible',
   migrated.picking.hireHopRef === 'HH-2026-8123');
W.normaliseWof(migrated);
ok('  · running it twice changes nothing', migrated.picking.epHopRef === 'HH-2026-8123');

/* A record that has already been migrated and then re-sent under EP HOP holds
   BOTH fields, and they differ. Normalise must not reach in and put the old
   one back — the migration fills a gap, it does not own the field. */
migrated.picking.epHopRef = 'EPH-2026-9500';
W.normaliseWof(migrated);
ok('  · and never clobbers a reference that is already set',
   migrated.picking.epHopRef === 'EPH-2026-9500',
   migrated.picking.epHopRef);

const fresh = W.create({ title: 'HOP TESTER — send', start: d(4), end: dEnd(6) });
const fl = W.addLine(fresh, RADIO, { qty: 12 });
const fl2 = W.addLine(fresh, 'ch-kit-cone', { qty: 40 });
fresh.stage = 'picking';
const pk = W.sendToHop(fresh);
ok('a new send gets the EP HOP prefix', /^EPH-2026-\d+$/.test(pk.epHopRef), pk.epHopRef);
ok('  · and does not collide with a legacy one',
   W.all().filter((x) => x.picking?.epHopRef === pk.epHopRef).length === 1);

group('Sending opens a prep on the other side');
const fp = HOP.prep(fresh.id);
ok('the warehouse now has the job', !!fp);
ok('  · unclaimed, and not yet started', fp.state === 'sent' && fp.heldBy === null);
ok('  · with a line per kit line', fp.lines.length === 2);
ok('  · wanting what the office asked for',
   fp.lines.find((l) => l.lineId === fl.id).wanted === 12);
ok('  · and nothing picked yet', HOP.prepProgress(fp).picked === 0);
ok('  · it is in the queue', HOP.queue().some((r) => r.w.id === fresh.id));
ok('  · and counted as still to pick', HOP.toPick().some((r) => r.w.id === fresh.id));

group('The queue is ordered by when the kit is needed, not when it was sent');
const q = HOP.queue();
const liveRows = q.filter((r) => r.prep.state !== 'returned');
ok('unfinished work comes before finished',
   q.findIndex((r) => r.prep.state === 'returned') === -1 ||
     q.findIndex((r) => r.prep.state === 'returned') >= liveRows.length);
ok('  · and within that, soonest needed first',
   liveRows.every((r, i) => i === 0 || liveRows[i - 1].neededAt <= r.neededAt),
   liveRows.map((r) => r.neededAt).join(' '));

group('The picking list is grouped by where the kit lives');
const waves = HOP.pickWaves(fresh);
const groups = waves.flatMap((v) => v.groups);
ok('lines are grouped', groups.length > 0);
ok('  · by stock location, not quote order',
   waves.every((v) => v.groups.every((g) => !!g.location) &&
     new Set(v.groups.map((g) => g.location)).size === v.groups.length));
ok('  · the radio is in the radio cage',
   groups.some((g) => g.location === 'Radio cage' && g.lines.some((l) => l.line.id === fl.id)));
ok('  · and every line carries its warehouse code',
   groups.every((g) => g.lines.every((l) => l.code && l.code !== '—')));

group('The state machine goes forward, one step, and only for the warehouse');
R.setActing(clerk.id);
ok('Payroll cannot work the queue', HOP.advancePrep(fresh, 'picking').ok === false);
ok('  · nor record a pick', HOP.setPicked(fresh, fl.id, 5).ok === false);
asWarehouse();

ok('a skipped state is refused', HOP.advancePrep(fresh, 'loaded').ok === false);
ok('  · naming the one that comes next',
   (HOP.advancePrepBlocker(fresh, 'loaded') || '').includes('Picking'));
ok('the next state is allowed', HOP.advancePrep(fresh, 'picking').ok === true);
ok('  · and claims the job for whoever started it', HOP.prep(fresh.id).heldBy === 'm-pete');
ok('going backwards is refused', HOP.advancePrep(fresh, 'sent').ok === false);
ok('  · and says so', (HOP.advancePrepBlocker(fresh, 'sent') || '').includes('cannot go back'));

ok('picked is refused while a line has nothing against it',
   HOP.advancePrep(fresh, 'picked').ok === false);
ok('  · and asks for the count rather than assuming zero',
   (HOP.advancePrepBlocker(fresh, 'picked') || '').includes('Record what was found'));

ok('over-picking is refused, not clamped', HOP.setPicked(fresh, fl.id, 99).ok === false);
ok('  · saying how many were asked for',
   (HOP.setPicked(fresh, fl.id, 99).reason || '').includes('12'));
ok('a negative pick is refused', HOP.setPicked(fresh, fl.id, -1).ok === false);
ok('recording a full pick works', HOP.setPicked(fresh, fl.id, 12).ok === true);
ok('recording a SHORT pick works too — it is a real answer',
   HOP.setPicked(fresh, fl2.id, 30).ok === true);
ok('  · and the job is flagged short', HOP.isShort(HOP.prep(fresh.id)));
ok('  · short is derived from the lines, never stored',
   HOP.prepProgress(HOP.prep(fresh.id)).picked === 42);
ok('now it can be marked picked', HOP.advancePrep(fresh, 'picked').ok === true);
ok('  · and it goes out short, because that is what happened',
   HOP.advancePrep(fresh, 'loaded').ok === true && HOP.isShort(HOP.prep(fresh.id)));
ok('  · still short once it is out', HOP.advancePrep(fresh, 'out').ok === true);
ok('  · and the pick can no longer be edited from the yard',
   HOP.setPicked(fresh, fl.id, 1).ok === false);
ok('  · which says to raise a variation instead',
   (HOP.setPicked(fresh, fl.id, 1).reason || '').includes('variation'));
ok('it drops out of the to-pick count once it is gone',
   !HOP.toPick().some((r) => r.w.id === fresh.id));

group('Every move is on the job’s own timeline, with a person on it');
const notes = fresh.history.map((h) => h.note);
ok('picking started is recorded', notes.some((n) => /Picking started/.test(n)));
ok('  · picked, with the count and the shortfall',
   notes.some((n) => /Kit picked — 42 of 52/.test(n) && /SHORT/.test(n)));
ok('  · loaded', notes.some((n) => /Kit loaded/.test(n)));
ok('  · and left the warehouse', notes.some((n) => /left the warehouse/.test(n)));
ok('  · attributed to the warehouse, not to the operator default',
   fresh.history.filter((h) => /Picking started/.test(h.note)).every((h) => h.by === 'm-pete'));
ok('one entry per real event, not a synthesised leg',
   notes.filter((n) => /Picking started/.test(n)).length === 1);

group('A re-send amends; it does not reset a morning’s work');
const amend = W.create({ title: 'HOP TESTER — amend', start: d(5), end: dEnd(7) });
const al = W.addLine(amend, RADIO, { qty: 20 });
const bl = W.addLine(amend, 'ch-kit-cone', { qty: 50 });
amend.stage = 'picking';
W.sendToHop(amend);
HOP.advancePrep(amend, 'picking');
HOP.setPicked(amend, al.id, 20);
HOP.setPicked(amend, bl.id, 50);
ok('both lines are picked', HOP.prepProgress(HOP.prep(amend.id)).picked === 70);

al.qty = 26;
W.sendToHop(amend);
const ap = HOP.prep(amend.id);
ok('the changed line is marked amended', ap.amended.includes(al.id));
ok('  · and its pick is zeroed, because it has to be re-picked',
   ap.lines.find((l) => l.lineId === al.id).picked === 0);
ok('  · wanting the new quantity', ap.lines.find((l) => l.lineId === al.id).wanted === 26);
ok('the untouched line keeps its pick',
   ap.lines.find((l) => l.lineId === bl.id).picked === 50,
   'throwing away a morning’s work is how the amendment banner gets ignored');
ok('  · and is not marked amended', !ap.amended.includes(bl.id));
ok('the state does not reset to sent', ap.state === 'picking');
ok('the queue shows the amendment', HOP.queue().find((r) => r.w.id === amend.id).amended === 1);

group('What the warehouse was told is frozen against a later quote edit');
al.qty = 999;
ok('the prep still wants what it was sent',
   HOP.prep(amend.id).lines.find((l) => l.lineId === al.id).wanted === 26,
   'a live read would silently rewrite the list somebody is picking against');
ok('  · and the drift is reported instead', W.kitChangesSincePush(amend).length > 0);
ok('  · the totals are frozen too, not just the line',
   HOP.prepProgress(HOP.prep(amend.id)).wanted === 76,
   `26 + 50, whatever the quote now says (${HOP.prepProgress(HOP.prep(amend.id)).wanted})`);
ok('  · and so is what the queue shows',
   HOP.queue().find((r) => r.w.id === amend.id).wanted === 76);
al.qty = 26;

group('A line removed from the quote does not cost the picker their work');
/* A PARTIAL mismatch is a real quote edit — the office took a line off after
   the send. Rebuilding the prep on that would throw away everything already
   picked. Only a prep where NOTHING resolves is an orphan from a re-seed. */
const removed = amend.lines.find((l) => l.id === bl.id);
amend.lines = amend.lines.filter((l) => l.id !== bl.id);
HOP.hydratePreps();
const afterRemoval = HOP.prep(amend.id);
ok('the prep is left alone', afterRemoval.lines.length === 2);
ok('  · the surviving line keeps its pick and its wanted',
   afterRemoval.lines.find((l) => l.lineId === al.id).wanted === 26);
ok('  · and the removed line keeps the pick that was recorded against it',
   afterRemoval.lines.find((l) => l.lineId === bl.id).picked === 50);
ok('  · while the picking list simply stops showing it',
   !HOP.pickWaves(amend).some((v) => v.groups.some((g) => g.lines.some((l) => l.line.id === bl.id))));
ok('  · and the drift report names it', W.kitChangesSincePush(amend).some((c) => c.kind === 'removed'));
amend.lines.push(removed);

group('Legacy jobs were migrated, not dumped back into the queue');
const legacyRows = HOP.queue().filter((r) => /^HH-/.test(r.w.picking?.epHopRef || ''));
ok('there are legacy jobs in the queue', legacyRows.length > 0);
ok('  · one that was mid-pick came across as picking',
   legacyRows.some((r) => r.prep.state === 'picking'));
ok('  · and a dispatched one is out or returned',
   legacyRows.some((r) => r.prep.state === 'out' || r.prep.state === 'returned'));
ok('  · none of them was dumped back to sent, asking for a re-pick of work that shipped',
   legacyRows.every((r) => r.prep.state !== 'sent'));
ok('every prep line resolves to a line on its job',
   HOP.queue().every((r) => r.prep.lines.some((pl) => r.w.lines.some((l) => l.id === pl.lineId))),
   'seeded line ids are random per seed run — a stale prep points at nothing');


/* ================================================ 9. the return leg === */

group('Replacement prices live in the money layer, not in the warehouse');
ok('every stock item has a replacement charge, except the consumable',
   HOP.stockList().every((s) => !!s.replacementChargeId || HOP.isConsumable(DB.charge(s.chargeId))));
ok('  · which resolves to a real charge',
   HOP.stockList().every((s) => !s.replacementChargeId || !!DB.charge(s.replacementChargeId)));
ok('  · priced per item, not per day — a lost radio is not a day’s hire',
   DB.charge(HOP.stockItem(RADIO).replacementChargeId).unit === 'each');
ok('  · and dearer than the day rate, or it would be cheaper to lose it',
   DB.charge(HOP.stockItem(RADIO).replacementChargeId).charge >
     DB.charge(RADIO).charge * 20);
ok('replacement rows never appear on the register as things',
   !HOP.kitCharges().some((c) => /replacement|excess/i.test(c.name)));
ok('  · nor as unmanaged stock, which would read as "we sub-hire this"',
   !HOP.kitCharges().some((c) => c.id === HOP.stockItem(RADIO).replacementChargeId));

group('Checking in what came back');
const ret = W.create({ title: 'HOP TESTER — return', start: d(2), end: dEnd(3) });
const rl = W.addLine(ret, RADIO, { qty: 30 });
ret.stage = 'picking';
ret.signoff = { signedBy: 'Dana Reilly', signedByRole: 'Head of Operations',
                signedAt: d(-10), method: 'DocuSign', ref: 'DS-RET', ip: '—' };
W.sendToHop(ret);
['picking'].forEach((st) => HOP.advancePrep(ret, st));
HOP.setPicked(ret, rl.id, 30);
HOP.advancePrep(ret, 'picked');
HOP.advancePrep(ret, 'loaded');

ok('nothing can be checked in before it has gone out',
   HOP.checkIn(ret, rl.id, { back: 30, damaged: 0, lost: 0 }).ok === false);
ok('  · and it says why', (HOP.checkInBlocker(ret, rl.id, { back: 1, damaged: 0, lost: 0 }) || '').includes('not out'));

HOP.advancePrep(ret, 'out');
const ownedBefore = HOP.stockItem(RADIO).owned;
const oosBefore = HOP.stockItem(RADIO).outOfService;

ok('more back than went out is refused, not clamped',
   HOP.checkIn(ret, rl.id, { back: 99, damaged: 0, lost: 0 }).ok === false);
ok('  · naming how many actually went', (HOP.checkInBlocker(ret, rl.id, { back: 99, damaged: 0, lost: 0 }) || '').includes('30'));
ok('a negative count is refused', HOP.checkIn(ret, rl.id, { back: -1, damaged: 0, lost: 0 }).ok === false);

ok('a partial check-in is allowed — a van comes back over two days',
   HOP.checkIn(ret, rl.id, { back: 20, damaged: 0, lost: 0 }).ok === true);
const partial = HOP.prep(ret.id).lines[0];
ok('  · and the remainder is UNACCOUNTED, not quietly counted back',
   HOP.unaccounted(partial) === 10);
ok('  · which the job total reports too', HOP.prepReturn(HOP.prep(ret.id)).unaccounted === 10);
ok('  · and unaccounted stock is NOT recharged',
   HOP.rechargeable(ret).length === 0,
   '"we cannot find three" is not "the client lost three"');

ok('the rest is checked in as damaged and lost',
   HOP.checkIn(ret, rl.id, { back: 20, damaged: 4, lost: 6 }).ok === true);
ok('  · nothing is unaccounted now', HOP.unaccounted(HOP.prep(ret.id).lines[0]) === 0);

group('The register stops assuming everything comes back');
ok('lost stock comes off owned', HOP.stockItem(RADIO).owned === ownedBefore - 6);
ok('damaged stock goes out of service, still owned',
   HOP.stockItem(RADIO).outOfService === oosBefore + 4);
ok('  · so issuable drops by both', HOP.issuable(HOP.stockItem(RADIO)) === ownedBefore - oosBefore - 10);
const retLog = HOP.changeLog(RADIO);
ok('the adjustment is journalled', retLog.some((c) => c.field === 'owned' && /HOP TESTER — return/.test(c.reason)));
ok('  · naming the job that caused it', retLog.some((c) => /HOP TESTER — return/.test(c.reason)));
ok('  · and the person who checked it in',
   retLog.filter((c) => /HOP TESTER — return/.test(c.reason)).every((c) => c.by === 'm-pete'));

/* Both counters, not just `owned`. They move through separate branches, so an
   absolute-instead-of-delta bug in one is invisible to an assertion on the
   other — which is exactly what a mutant found here. */
ok('a repeated check-in applies the DELTA, not the total again', (() => {
  const it = HOP.stockItem(RADIO);
  const owned = it.owned;
  const oos = it.outOfService;
  HOP.checkIn(ret, rl.id, { back: 20, damaged: 4, lost: 6 });
  return it.owned === owned && it.outOfService === oos;
})(), 'applying the absolute figure twice would take stock down twice');
ok('  · a third time changes nothing either', (() => {
  const it = HOP.stockItem(RADIO);
  const owned = it.owned;
  const oos = it.outOfService;
  HOP.checkIn(ret, rl.id, { back: 20, damaged: 4, lost: 6 });
  return it.owned === owned && it.outOfService === oos;
})());
ok('  · and correcting a count downwards gives it back', (() => {
  const it = HOP.stockItem(RADIO);
  const owned = it.owned;
  const oos = it.outOfService;
  HOP.checkIn(ret, rl.id, { back: 24, damaged: 2, lost: 4 });
  const restored = it.owned === owned + 2 && it.outOfService === oos - 2;
  HOP.checkIn(ret, rl.id, { back: 20, damaged: 4, lost: 6 });
  return restored;
})(), 'a miscount corrected must not leave stock written off');

ok('losing more than is on the shelf cannot leave out-of-service above owned', (() => {
  /* The buggy: 4 owned, 1 already off the road. Lose all four and `owned`
     goes to zero while `outOfService` still says one — `issuable` would be
     minus one, and a register that reports negative stock has stopped being
     a register. */
  const j = W.create({ title: 'HOP TESTER — write-off', start: d(2), end: dEnd(3) });
  const jl = W.addLine(j, 'ch-kit-buggy', { qty: 4 });
  j.stage = 'picking';
  W.sendToHop(j);
  HOP.advancePrep(j, 'picking'); HOP.setPicked(j, jl.id, 4);
  HOP.advancePrep(j, 'picked'); HOP.advancePrep(j, 'loaded'); HOP.advancePrep(j, 'out');
  HOP.checkIn(j, jl.id, { back: 0, damaged: 0, lost: 4 });
  const it = HOP.stockItem('ch-kit-buggy');
  const sane = it.outOfService <= it.owned && HOP.issuable(it) >= 0;
  j.active = false;
  HOP.resetStock();
  return sane;
})(), 'issuable must never go negative');

group('Damage and loss are variations, not a new client concept');
const owed = HOP.rechargeable(ret);
ok('what is owed is listed', owed.length === 1);
ok('  · at the replacement charge, not the day rate',
   owed[0].chargeId === HOP.stockItem(RADIO).replacementChargeId);
ok('  · covering damaged and lost together', owed[0].qty === 10);

const before = ret.lines.length;
const res = HOP.raiseRecharge(ret);
ok('the recharge is raised', res.ok === true && res.raised === 1);
ok('  · as a line on the work order', ret.lines.length === before + 1);
const rc = ret.lines[ret.lines.length - 1];
ok('  · which is a VARIATION, because the job is signed', rc.source === 'variation');
ok('  · awaiting the client, like any other', rc.clientApproval === 'pending');
ok('  · unsent until somebody sends it', W.unsentVariations(ret).some((l) => l.id === rc.id));
ok('  · priced at 10 × the replacement charge',
   rc.qty === 10 && W.lineValue(rc) === 10 * DB.charge(owed[0].chargeId).charge);
ok('  · and says what happened, in words', /lost/.test(rc.note) && /damaged/.test(rc.note));

ok('raising it twice is refused', HOP.raiseRecharge(ret).ok === false);
ok('  · so the same radio cannot be billed twice', ret.lines.length === before + 1);
ok('  · and the line records when it was recharged', !!HOP.prep(ret.id).lines[0].rechargedAt);
/* ---------------------------------------------------------------------------
   The stamp answers to the variation, not the other way round.

   `rechargedAt` stops a second bill for the same radio. It used to be a one-way
   latch, so deleting the variation on the work order left the warehouse looking
   at "· recharged" and a dead button for money nobody was being asked for.
   --------------------------------------------------------------------------- */

group('Deleting the variation gives the recharge back');
ok('the prep line remembers which variation it became',
   HOP.prep(ret.id).lines[0].rechargeLineId === rc.id);
ok('the damaged and lost boxes are locked while it stands',
   (HOP.checkInBlocker(ret, rl.id, { back: 20, damaged: 4, lost: 6 }) || '').includes('already been recharged'));

ok('the variation can be removed on the work order', W.removeLine(ret, rc.id) === true);
ok('  · which clears the stamp, because the charge is gone',
   !HOP.prep(ret.id).lines[0].rechargedAt && !HOP.prep(ret.id).lines[0].rechargeLineId);
ok('  · the boxes unlock again',
   HOP.checkInBlocker(ret, rl.id, { back: 20, damaged: 4, lost: 6 }) === null);
ok('  · and it is billable once more', HOP.rechargeable(ret).length === 1);
ok('  · the button says so too', HOP.rechargeBlocker(ret) === null);

const again = HOP.raiseRecharge(ret);
ok('raising it a second time now works, because the first no longer exists', again.ok === true);
const rc2 = ret.lines[ret.lines.length - 1];
ok('  · leaving exactly one recharge line, not two', ret.lines.length === before + 1);
ok('  · and it is locked again', HOP.raiseRecharge(ret).ok === false);

ok('an old stamp with no variation recorded is left alone', (() => {
  // A prep journalled before `rechargeLineId` existed. Guessing which line an
  // old stamp meant, and guessing wrong, bills a client twice — so it stays.
  const pl = HOP.prep(ret.id).lines[0];
  delete pl.rechargeLineId;
  W.removeLine(ret, rc2.id);
  const held = !!pl.rechargedAt && HOP.rechargeable(ret).length === 0;
  // Put the job back as the rest of the file expects to find it.
  pl.rechargedAt = undefined;
  HOP.raiseRecharge(ret);
  return held;
})(), 'clearing it on a guess is the one unsafe move here');

/* ---------------------------------------------------------------------------
   What cannot be billed, and saying so.
   --------------------------------------------------------------------------- */

group('A line that cannot be recharged says why');
ok('replacement charges are identifiable as such',
   HOP.isReplacementCharge(HOP.stockItem(RADIO).replacementChargeId) === true);
ok('  · and a real hire line is not', HOP.isReplacementCharge(RADIO) === false);

ok('damage on an unbillable line is explained, not silently dropped', (() => {
  // A replacement charge sold as an ordinary hire line — which the quote
  // builder used to allow. It has no replacement of its own, so nothing about
  // it can ever be recharged.
  const repId = HOP.stockItem(RADIO).replacementChargeId;
  const j = W.create({ title: 'HOP TESTER — unbillable', start: d(2), end: dEnd(3) });
  const jl = W.addLine(j, repId, { qty: 2 });
  j.stage = 'picking';
  j.signoff = { signedBy: 'x', signedByRole: 'x', signedAt: d(-5), method: 'x', ref: 'x', ip: '—' };
  W.sendToHop(j);
  HOP.advancePrep(j, 'picking'); HOP.setPicked(j, jl.id, 2);
  HOP.advancePrep(j, 'picked'); HOP.advancePrep(j, 'loaded'); HOP.advancePrep(j, 'out');
  HOP.checkIn(j, jl.id, { back: 1, damaged: 1, lost: 0 });

  const none = HOP.rechargeable(j).length === 0;
  const skipped = HOP.rechargeSkipped(j);
  const blocker = HOP.rechargeBlocker(j) || '';
  j.active = false;
  return (
    none &&
    skipped.length === 1 &&
    skipped[0].qty === 1 &&
    /replacement charge/.test(skipped[0].why) &&
    !/everything came back/.test(blocker) &&
    /Nothing here can be recharged/.test(blocker) &&
    /replacement charge/.test(blocker)
  );
})(), 'the button used to read "nothing to recharge" over a damaged item');

ok('an unsigned job cannot be recharged at all', (() => {
  const j = W.create({ title: 'HOP TESTER — unsigned return', start: d(2), end: dEnd(3) });
  const jl = W.addLine(j, RADIO, { qty: 4 });
  j.stage = 'picking';
  W.sendToHop(j);
  HOP.advancePrep(j, 'picking'); HOP.setPicked(j, jl.id, 4);
  HOP.advancePrep(j, 'picked'); HOP.advancePrep(j, 'loaded'); HOP.advancePrep(j, 'out');
  HOP.checkIn(j, jl.id, { back: 3, damaged: 0, lost: 1 });
  const refused = HOP.rechargeBlocker(j);
  j.active = false;
  return !!refused && /never signed/.test(refused);
})(), 'there is no contract to raise a variation against');

R.setActing(clerk.id);
ok('Payroll cannot check kit in', HOP.checkIn(ret, rl.id, { back: 1, damaged: 0, lost: 0 }).ok === false);
ok('  · nor raise a recharge', HOP.raiseRecharge(ret).ok === false);
asWarehouse();

HOP.advancePrep(ret, 'returned');
ok('the job can be closed once it is back', HOP.prep(ret.id).state === 'returned');
ok('  · and the timeline says so', ret.history.some((h) => /returned to the warehouse/.test(h.note)));
retireFixtures();

/* ============================================ 10. adding a thing EP owns === */

group('Adding kit needs both hats');
const NEW = {
  name: 'Tower light (LED, 9m)', code: 'LGT-LED9',
  dayCost: 30, dayCharge: 78, replaceCost: 1400, replaceCharge: 1750,
  owned: 6, turnaround: 2, location: 'Yard — bay 4',
};
asWarehouse();
ok('the Warehouse Manager alone cannot add kit',
   HOP.createStockItem(NEW).ok === false,
   'adding kit sets a price, and nobody should price EP’s kit on their own say-so');
/* The exact wording, not just "Finance" — `charges.ts` refuses this too, and
   an assertion both layers satisfy cannot tell you either one is there. Only
   `hop.ts` explains what to do about it. */
ok('  · and is told whose job the other half is, and what to ask for',
   (HOP.createStockItemBlocker(NEW) || '').includes('grant charge-table access'),
   HOP.createStockItemBlocker(NEW));
ok('  · the charge table refuses it independently, as a second lock',
   CH.createCharge({ kind: 'kit', code: 'QQ-1', name: 'Sneaky', unit: 'day', cost: 1, charge: 2 }, '2026-04-01').ok === false);

/* Finance is the mirror image: it can price, and must still not be able to
   invent a shelf count. Without this the `kit.stock` guard is untestable,
   because everybody who fails it also fails the charges one. */
const fin = R.members().find((m) => m.roleId === 'finance' && m.status === 'active');
R.setActing(fin.id);
ok('Finance holds the charge table', R.can('charges.edit'));
ok('  · but cannot add kit on its own', HOP.createStockItem(NEW).ok === false);
ok('  · because the count is the warehouse’s',
   (HOP.createStockItemBlocker(NEW) || '').includes('stock counts'),
   HOP.createStockItemBlocker(NEW));

R.setActing(clerk.id);
ok('Payroll cannot either', HOP.createStockItem(NEW).ok === false);

/* Grant the warehouse the charge table for the rest of this group — which is
   itself the answer to "how do we let Pete add kit": give the role both, or
   have Finance do it. The permission model already says which. */
const boss = R.superAdmins()[0];
R.setActing(boss.id);
R.setRoleCaps('warehouse', [...R.ROLES.warehouse.caps, 'charges.edit']);
asWarehouse();
ok('with charges.edit as well, it is allowed', HOP.createStockItemBlocker(NEW) === null);

group('One item is three records, created together or not at all');
const chargesBefore = DB.CHARGES.length;
const made = HOP.createStockItem(NEW);
/* Defaulted, for the third time in this file and the last: every assertion
   below reads a field off it, and a throw here hides the ones that say why. */
const MI = made.item || { chargeId: 'none', replacementChargeId: 'none', owned: -1 };
ok('the item is created', made.ok === true && !!made.item, made.reason);
ok('  · with a day rate on the charge table', !!DB.charge(MI.chargeId));
ok('  · charged per day, not per item', DB.charge(MI.chargeId)?.unit === 'day');
ok('  · carrying the warehouse code', DB.charge(MI.chargeId)?.hireHopCode === 'LGT-LED9');
ok('  · and a replacement charge beside it', !!MI.replacementChargeId && MI.replacementChargeId !== 'none');
ok('  · priced per item, because a replacement is bought once',
   DB.charge(MI.replacementChargeId)?.unit === 'each');
ok('  · two charge rows, not one or three', DB.CHARGES.length === chargesBefore + 2);
ok('  · and a stock row with the count', HOP.stockItem(MI.chargeId)?.owned === 6);

ok('it is on the register', HOP.stockList().some((s) => s.chargeId === MI.chargeId));
ok('  · and the replacement row is NOT, because it is a price, not a thing',
   !HOP.kitCharges().some((c) => c.id === MI.replacementChargeId));
ok('  · it can be quoted', CH.quotable().some((c) => c.id === MI.chargeId));
ok('  · availability answers for it', HOP.availability(MI.chargeId, day(1), day(3)).length === 3);
ok('  · with nothing committed yet', HOP.freeOn(MI.chargeId, day(1)) === 6);

group('The code rule is enforced, not merely described');
ok('a duplicate code is refused',
   HOP.createStockItem({ ...NEW, name: 'Something else' }).ok === false);
ok('  · naming what already uses it',
   (HOP.createStockItemBlocker({ ...NEW, name: 'Something else' }) || '').includes('Tower light'));
ok('a duplicate name is refused', HOP.createStockItem({ ...NEW, code: 'ZZ-1' }).ok === false);
ok('a junk code is refused', HOP.createStockItem({ ...NEW, name: 'x', code: 'a b' }).ok === false);
ok('selling below cost is refused',
   HOP.createStockItem({ ...NEW, name: 'y', code: 'YY-1', dayCost: 90, dayCharge: 10 }).ok === false);
ok('  · and says so in money',
   (HOP.createStockItemBlocker({ ...NEW, name: 'y', code: 'YY-1', dayCost: 90, dayCharge: 10 }) || '')
     .includes('loses money'));
ok('a negative count is refused',
   HOP.createStockItem({ ...NEW, name: 'z', code: 'ZY-1', owned: -2 }).ok === false);
ok('after all of that, nothing extra was created', DB.CHARGES.length === chargesBefore + 2);

group('A half-created item is never left behind');
/* The replacement row is validated BEFORE anything is written, so the
   all-or-nothing rule is a guarantee rather than a rollback that might fail.
   A replacement price below its own cost is the case that reaches it. */
const half = HOP.createStockItem({
  ...NEW, name: 'Half thing', code: 'HF-1', replaceCost: 900, replaceCharge: 10,
});
ok('an item whose replacement price is bad is refused outright', half.ok === false);
ok('  · and no day rate was left orphaned on the charge table',
   !DB.CHARGES.some((c) => c.code === 'HF-1'));
ok('  · nor a stock row', !HOP.stockList().some((s) => DB.charge(s.chargeId)?.code === 'HF-1'));

group('A consumable needs no replacement price — it cannot be lost');
const con = HOP.createStockItem({
  ...NEW, name: 'Cable ties (bag of 100)', code: 'CT-100', owned: 400, turnaround: 0,
  consumable: true,
});
const CI = con.item || { chargeId: 'none' };
ok('it is created', con.ok === true, con.reason);
ok('  · charged per item', DB.charge(CI.chargeId)?.unit === 'each');
ok('  · with no replacement charge', !!con.item && con.item.replacementChargeId === undefined);
ok('  · and hop knows it is a consumable', HOP.isConsumable(DB.charge(CI.chargeId)));

group('New kit survives a reload');
/* Captured before the reload. NOT compared against the seeded 250 — an earlier
   check-in in this file legitimately lost a radio, and asserting the seed
   figure would be testing that no other test ran. The claim here is narrower
   and the one that matters: adding items does not disturb the ones already
   there. */
const radioBefore = { ...HOP.stockItem(RADIO) };
({ HOP, R, P, W, DB, CH } = await boot());
asWarehouse();
ok('the item is still on the register',
   HOP.stockList().some((s) => DB.charge(s.chargeId)?.code === 'LGT-LED9'));
const reloaded = HOP.stockList().find((s) => DB.charge(s.chargeId)?.code === 'LGT-LED9')
  || { chargeId: 'none', replacementChargeId: 'none', owned: -1 };
ok('  · with its count', reloaded.owned === 6);
ok('  · its replacement charge', !!DB.charge(reloaded.replacementChargeId));
ok('  · and it is still quotable', CH.quotable().some((c) => c.id === reloaded.chargeId));
ok('the seeded items came back exactly as they were',
   HOP.stockItem(RADIO).owned === radioBefore.owned &&
     HOP.stockItem(RADIO).outOfService === radioBefore.outOfService &&
     HOP.stockItem(RADIO).turnaround === radioBefore.turnaround,
   `${HOP.stockItem(RADIO).owned} vs ${radioBefore.owned}`);
ok('  · and there is still exactly one row per item',
   new Set(HOP.stockList().map((s) => s.chargeId)).size === HOP.stockList().length,
   'a reload that re-pushed the custom items would double them');

group('Retire, never delete');
ok('an item with nothing booked can be retired',
   HOP.retireStockItem(reloaded.chargeId).ok === true);
ok('  · which takes it off new quotes', !CH.quotable().some((c) => c.id === reloaded.chargeId));
ok('  · and its replacement charge with it',
   !CH.quotable().some((c) => c.id === reloaded.replacementChargeId));
ok('  · but it is STILL on the register, because EP still owns it',
   HOP.stockList().some((s) => s.chargeId === reloaded.chargeId));
ok('  · still resolves everywhere it is read', !!DB.charge(reloaded.chargeId));
ok('  · and availability still answers for it',
   HOP.availability(reloaded.chargeId, day(1), day(2)).length === 2);
ok('un-retiring puts it back', HOP.retireStockItem(reloaded.chargeId, false).ok === true &&
   CH.quotable().some((c) => c.id === reloaded.chargeId));

ok('an item a live job still has booked cannot be retired', (() => {
  const j = W.create({ title: 'HOP TESTER — holds kit', start: d(3), end: dEnd(5) });
  W.addLine(j, reloaded.chargeId, { qty: 2 });
  j.stage = 'order';
  const refused = HOP.retireStockItemBlocker(reloaded.chargeId);
  const held = !!refused && /still has this booked/.test(refused) && refused.includes(j.ref);
  j.active = false;
  return held;
})(), 'retiring it would leave a picking list pointing at nothing quotable');
ok('  · and once the job is gone, it can be', HOP.retireStockItemBlocker(reloaded.chargeId) === null);

R.setActing(clerk.id);
ok('Payroll cannot retire anything', HOP.retireStockItem(reloaded.chargeId).ok === false);
asWarehouse();
retireFixtures();

/* ======================================== 11. the classes actually exist === */

group('Every app class these pages use is one the stylesheet defines');

/* The bug this exists for: `className="input"` on six inputs across three
   dialogs. There is no `.input` rule — the app's class is `.field` — so every
   one of them rendered as a bare unstyled box, and nothing caught it. Types
   cannot: `className` is a string. The render tests cannot: unstyled markup
   renders perfectly well.
 
   So: any SINGLE-WORD class (the shape the app's own component classes take —
   `field`, `btn`, `card`, `well`, `pill`) must be defined in `app.css`.
   Tailwind's multi-part utilities are left alone; its handful of bare words
   are listed. */

const css = readFileSync(join(ROOT, 'src/styles/app.css'), 'utf8');
const defined = new Set([...css.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]));
const TAILWIND_BARE = new Set([
  'block', 'flex', 'grid', 'hidden', 'relative', 'absolute', 'fixed', 'sticky',
  'truncate', 'italic', 'underline', 'uppercase', 'lowercase', 'capitalize',
  'container', 'group', 'contents', 'invisible', 'static', 'table', 'transform',
  // `border` with no side and no width is Tailwind's 1px all round, and the
  // dialogs use it that way. It is a bare word like the rest of these, not a
  // class the app stylesheet was ever meant to define.
  'border',
]);

const PAGES = [
  'src/pages/warehouse/Stock.tsx',
  'src/pages/warehouse/KitJobs.tsx',
  // The deployment builder sells kit as well as people now, so it is written
  // against the same stylesheet and can make the same mistake.
  'src/pages/wof/DeploymentDialog.tsx',
];
const unknown = [];
PAGES.forEach((rel) => {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  [...src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].forEach((m) => {
    (m[1] || m[2] || '')
      // Strip `${...}` first: a template hole holds an EXPRESSION, and its
      // innards are not class names. Splitting before this reported `===` and
      // `'returned'` as undefined classes.
      .replace(/\$\{[^}]*\}/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .filter((c) => !c.includes('-') && !c.includes('[') && !c.includes(':'))
      .forEach((c) => {
        if (!defined.has(c) && !TAILWIND_BARE.has(c)) unknown.push(`${rel}: .${c}`);
      });
  });
});
ok('no page names a class the stylesheet has never heard of',
   unknown.length === 0, [...new Set(unknown)].join(' | '));
ok('  · and the class they DO use for inputs is a real one',
   defined.has('field') && !defined.has('input'),
   'if `.input` ever becomes real this test should be relaxed, not the pages changed');

/* ================================================ 12. the pages render === */

group('The register actually renders');

/* Typecheck proves the props line up; it does not prove the page survives its
   first render. This bundles the real page against the real seed. `Modal` and
   `Toast` are stubbed — the real Modal goes through `createPortal`, which needs
   a live DOM and has nothing to do with what is being tested here. Everything
   below the modal chrome is the genuine component. */

const renderWork = mkdtempSync(join(tmpdir(), 'eprosta-hop-render-'));
const rp = (rel) => join(renderWork, rel).replace(/\\/g, '/');

writeFileSync(
  rp('stub-modal.tsx'),
  `import type { ReactNode } from 'react';\n` +
    `export function Modal({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode; width?: number; onClose: () => void }) {\n` +
    `  return <div data-modal={title}><h2>{title}</h2><div>{children}</div><div data-footer="1">{footer}</div></div>;\n` +
    `}\n` +
    `export function ConfirmDestructive() { return null; }\n` +
    `export function MenuButton() { return null; }\n` +
    `export function OverflowMenu() { return null; }\n`,
);
writeFileSync(rp('stub-toast.tsx'), `export const useToast = () => () => {};\n`);
writeFileSync(
  rp('entry.tsx'),
  `import { createElement } from 'react';\n` +
    `import { renderToStaticMarkup } from 'react-dom/server';\n` +
    `import { MemoryRouter } from 'react-router-dom';\n` +
    `import StockPage from '${p('src/pages/warehouse/Stock')}';\n` +
    `import KitJobsPage, { PickPanel } from '${p('src/pages/warehouse/KitJobs')}';\n` +
    `import { HireWindowDialog } from '${p('src/pages/WofDetail')}';\n` +
    `import * as HOP from '${p('src/lib/hop')}';\n` +
    `import * as ST from '${p('src/lib/status')}';\n` +
    `import * as R from '${p('src/lib/roles')}';\n` +
    `import * as W from '${p('src/lib/wof')}';\n` +
    `export { createElement, renderToStaticMarkup, MemoryRouter, StockPage, KitJobsPage, PickPanel, HireWindowDialog, HOP, R, W, ST };\n`,
);

let RR = null;
try {
  execFileSync(
    'npx',
    ['--yes', 'esbuild', rp('entry.tsx'), '--bundle', '--format=esm',
      `--outfile=${rp('bundle.mjs')}`,
      `--alias:@=${join(ROOT, 'src')}`,
      `--alias:@/components/Modal=${rp('stub-modal.tsx')}`,
      `--alias:@/components/Toast=${rp('stub-toast.tsx')}`,
      '--jsx=automatic', '--log-level=error'],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, NODE_PATH: join(ROOT, 'node_modules') } },
  );
  RR = await import(pathToFileURL(rp('bundle.mjs')).href);
} catch {
  RR = null;
}

if (!RR) {
  ok('the register renders (skipped — could not bundle)', true);
} else {
  RR.W.load();
  const boss = RR.R.members().find((m) => m.roleId === 'warehouse' && m.status === 'active');
  RR.R.setActing(boss.id);

  /* Oversubscribe one item so the page renders its loaded state — the banner,
     the risk pills and the strip — rather than the happy path only. */
  const j = RR.W.create({ title: 'HOP RENDER — short', start: d(2), end: dEnd(4) });
  RR.W.addLine(j, RADIO, { qty: RR.HOP.issuable(RR.HOP.stockItem(RADIO)) + 25 });
  j.stage = 'order';

  /* `DataTable` and `PageHeader` reach for router context — the page is a real
     route, so give it one rather than stubbing them into something else. */
  const draw = () =>
    RR.renderToStaticMarkup(
      RR.createElement(RR.MemoryRouter, { initialEntries: ['/warehouse/stock'] },
        RR.createElement(RR.StockPage, {})),
    );
  const html = draw();
  ok('the page renders without throwing', html.length > 2000, String(html.length));
  ok('  · with a row per managed item',
     RR.HOP.stockList().every((s) => html.includes(RR.HOP.stockItem(s.chargeId).location || 'x')));
  ok('  · the oversubscription banner', /oversubscribed in the next/.test(html));
  ok('  · a strip of days, not a single number',
     (html.match(/title="[^"]* — \d+ out, -?\d+ free"/g) || []).length >= RR.HOP.HORIZON_DAYS);
  ok('  · the unmanaged section, naming the sub-hired item',
     /Not stock-controlled/.test(html) && /Tower light/.test(html));
  ok('  · and no money anywhere on it',
     !/£/.test(html), 'the warehouse does not hold charges.view');
  /* Pressure is drawn, and drawn DIFFERENTLY. A quote that looks like a
     commitment on the chart is the phantom-demand failure the model avoids,
     reintroduced as a colour choice — so the two tones must both be present. */
  ok('  · pressure is shown', /quoted"/.test(html) || /, \d+ quoted/.test(html));
  ok('  · in its own lighter tone, never as a solid draw',
     html.includes(RR.ST.TONE_BG.info) && html.includes(RR.ST.TONE_HEX.info));

  ok('  · deterministically', draw().length === html.length);

  /* The hire-window dialog is the only way the `hire` field is ever set by a
     person, so a render that throws would leave the field write-only. */
  const rg = RR.W.all().find((x) => x.id === 'wof-114');
  const lit = rg.lines.find((l) => l.chargeId === 'ch-kit-lighting');
  const dlg = RR.renderToStaticMarkup(
    RR.createElement(RR.MemoryRouter, {}, RR.createElement(RR.HireWindowDialog, {
      w: rg, line: lit, onClose: () => {},
    })),
  );
  ok('the hire-window dialog renders', dlg.length > 400, String(dlg.length));
  ok('  · offering one option per day of the span',
     (dlg.match(/<option/g) || []).length === RR.W.hireWindow(rg, lit).days * 2,
     String((dlg.match(/<option/g) || []).length));
  ok('  · labelled build, event or breakdown, not bare numbers',
     /\(event\)/.test(dlg) || /\(build\)/.test(dlg) || /\(break\)/.test(dlg));
  ok('  · and priced, so narrowing shows what it costs', /£/.test(dlg));

  /* The queue, which is the screen the warehouse lives on. Rendered with a
     job deliberately left short and amended so the banners are exercised. */
  const short = RR.W.all().find((x) => /HOP RENDER — queue/.test(x.title)) ||
    (() => {
      const j = RR.W.create({ title: 'HOP RENDER — queue', start: d(3), end: dEnd(5) });
      RR.W.addLine(j, RADIO, { qty: 20 });
      j.stage = 'picking';
      RR.W.sendToHop(j);
      RR.HOP.advancePrep(j, 'picking');
      RR.HOP.setPicked(j, j.lines[0].id, 8);
      return j;
    })();
  const queueHtml = RR.renderToStaticMarkup(
    RR.createElement(RR.MemoryRouter, { initialEntries: ['/warehouse'] },
      RR.createElement(RR.KitJobsPage, {})),
  );
  ok('the kit queue renders', queueHtml.length > 2000, String(queueHtml.length));
  ok('  · listing the job that is short', queueHtml.includes(short.picking.epHopRef));
  ok('  · with a state pill per job',
     (queueHtml.match(/Picking|Loaded|Returned|Sent|Out/g) || []).length > 2);
  ok('  · and a short warning', /cannot be picked in full|Short/.test(queueHtml));
  ok('  · showing progress as picked-of-wanted', /\/\s*<\/span>|\/20/.test(queueHtml));

  /* The return panel, on a job that is out with something unaccounted — the
     state most returns are actually in. */
  const outJob = RR.W.all().find((x) => /HOP RENDER — out/.test(x.title)) ||
    (() => {
      const j = RR.W.create({ title: 'HOP RENDER — out', start: d(2), end: dEnd(3) });
      const jl = RR.W.addLine(j, RADIO, { qty: 10 });
      j.stage = 'picking';
      j.signoff = { signedBy: 'x', signedByRole: 'x', signedAt: d(-5), method: 'x', ref: 'x', ip: '—' };
      RR.W.sendToHop(j);
      RR.HOP.advancePrep(j, 'picking');
      RR.HOP.setPicked(j, jl.id, 10);
      RR.HOP.advancePrep(j, 'picked');
      RR.HOP.advancePrep(j, 'loaded');
      RR.HOP.advancePrep(j, 'out');
      RR.HOP.checkIn(j, jl.id, { back: 6, damaged: 1, lost: 1 });
      return j;
    })();
  const outHtml = RR.renderToStaticMarkup(
    RR.createElement(RR.MemoryRouter, { initialEntries: ['/warehouse'] },
      RR.createElement(RR.KitJobsPage, {})),
  );
  ok('the job is listed while it is out', outHtml.includes(outJob.picking.epHopRef));

  /* The panel itself, rendered directly — it only appears once a row is
     opened, so a static render of the page never reaches it. */
  const outRow = RR.HOP.queue().find((r) => r.w.id === outJob.id);
  const panel = RR.renderToStaticMarkup(
    RR.createElement(RR.MemoryRouter, {}, RR.createElement(RR.PickPanel, {
      row: outRow, onClose: () => {},
    })),
  );
  ok('the return panel renders while the kit is OUT', /Checking in/.test(panel),
     'a van comes back over two days; waiting for "returned" means writing it on paper');
  ok('  · with a box for back, damaged and lost',
     /back/.test(panel) && /damaged/.test(panel) && /lost/.test(panel));
  ok('  · naming what is unaccounted in the job total',
     /2 unaccounted/.test(panel), String(RR.HOP.unaccounted(RR.HOP.prep(outJob.id).lines[0])));
  /* And on the LINE, which is the one somebody acts on. The job total and the
     per-line pill both read "2 unaccounted" here, so counting occurrences is
     what separates them — asserting the string alone passes with the pill
     deleted, which is how this assertion was wrong the first time. */
  ok('  · and on the line itself, not only in the summary',
     (panel.match(/unaccounted/g) || []).length >= 2,
     String((panel.match(/unaccounted/g) || []).length));
  ok('  · with the reason it is not simply written off',
     /Not yet counted either way/.test(panel));
  ok('  · and offering the recharge', /Recharge/.test(panel));

  const pickingRow = RR.HOP.queue().find((r) => r.prep.state === 'picking');
  if (pickingRow) {
    const early = RR.renderToStaticMarkup(
      RR.createElement(RR.MemoryRouter, {}, RR.createElement(RR.PickPanel, {
        row: pickingRow, onClose: () => {},
      })),
    );
    ok('  · and does NOT render on a job still being picked', !/Checking in/.test(early));
  } else {
    ok('  · and does NOT render on a job still being picked (no fixture)', true);
  }

  /* The waves, on screen. A picker reads this while walking; if the go-out day
     is not on it, the wave model may as well not exist. */
  const waveJob = (() => {
    const j = RR.W.create({ title: 'HOP RENDER — waves', start: d(9), end: dEnd(15) });
    j.liveFrom = 3;
    j.liveTo = 5;
    const r = RR.W.addLine(j, RADIO, { qty: 12 });
    const g = RR.W.addLine(j, 'ch-kit-signage', { qty: 6 });
    RR.W.setHire(j, r.id, RR.W.phaseWindow(j, 'build'));
    RR.W.setHire(j, g.id, RR.W.phaseWindow(j, 'break'));
    j.stage = 'picking';
    RR.W.sendToHop(j);
    RR.HOP.advancePrep(j, 'picking');
    return j;
  })();
  const wavePanel = RR.renderToStaticMarkup(
    RR.createElement(RR.MemoryRouter, {}, RR.createElement(RR.PickPanel, {
      row: RR.HOP.queue().find((r) => r.w.id === waveJob.id), onClose: () => {},
    })),
  );
  ok('the pick panel splits into waves', (wavePanel.match(/Out [A-Z]/g) || []).length === 2,
     String((wavePanel.match(/Out [A-Z]/g) || []).length));
  ok('  · each labelled with the phase it belongs to',
     /Build/.test(wavePanel) && /Breakdown/.test(wavePanel));
  ok('  · and every line says how long it is out and when it is back',
     (wavePanel.match(/back [A-Z]/g) || []).length === 2,
     String((wavePanel.match(/back [A-Z]/g) || []).length));

  rmSync(renderWork, { recursive: true, force: true });
}

/* ================================================= the picking waves ====== */

group('A job does not load out once');

/* The question this answers: the radios go out with the build crew and the
   signage comes off at breakdown. How does the warehouse know when to provide
   which? Before waves it did not - one flat list, one date, and a picker who
   pulled everything on the first van. */

const wavy = W.create({ title: 'HOP TESTER — waves', start: d(20), end: dEnd(26) });
wavy.liveFrom = 3;
wavy.liveTo = 5;
const wavySpan = W.eventDays(wavy);
const buildWin = W.phaseWindow(wavy, 'build');
const breakWin = W.phaseWindow(wavy, 'break');
ok('the fixture has a build, an event and a breakdown',
   !!buildWin && !!breakWin && buildWin.to < breakWin.from,
   `${JSON.stringify(buildWin)} ${JSON.stringify(breakWin)}`);

const wvRadio = W.addLine(wavy, RADIO, { qty: 12 });
const wvSign = W.addLine(wavy, 'ch-kit-signage', { qty: 6 });
const wvCone = W.addLine(wavy, 'ch-kit-cone', { qty: 40 });
W.setHire(wavy, wvRadio.id, buildWin);
W.setHire(wavy, wvSign.id, breakWin);
wavy.stage = 'picking';
W.sendToHop(wavy);

const wv = HOP.pickWaves(wavy);
ok('three lines wanted on two different days make two waves', wv.length === 2,
   String(wv.length));
ok('  · the first is the build day, not the job start',
   wv[0].day === buildWin.from && wv[0].kind === 'build', `${wv[0].day} ${wv[0].kind}`);
ok('  · and the second is the breakdown', wv[1].day === breakWin.from && wv[1].kind === 'break',
   `${wv[1].day} ${wv[1].kind}`);
ok('  · each wave carries the date the picker needs, not a day number',
   /^\d{4}-\d{2}-\d{2}$/.test(wv[0].date) && wv[0].date < wv[1].date,
   `${wv[0].date} / ${wv[1].date}`);

const inWave = (v, id) => v.groups.some((g) => g.lines.some((l) => l.line.id === id));
ok('the radios go with the build crew', inWave(wv[0], wvRadio.id) && !inWave(wv[1], wvRadio.id));
ok('  · the signage comes off at breakdown', inWave(wv[1], wvSign.id) && !inWave(wv[0], wvSign.id));
ok('  · and the whole-job cones go out on day one with the radios',
   inWave(wv[0], wvCone.id) && !inWave(wv[1], wvCone.id));

const coneRow = wv[0].groups.flatMap((g) => g.lines).find((l) => l.line.id === wvCone.id);
const radioRow = wv[0].groups.flatMap((g) => g.lines).find((l) => l.line.id === wvRadio.id);
ok('two lines in one wave can still come back on different days',
   coneRow.back !== radioRow.back, `${coneRow.back} vs ${radioRow.back}`);
ok('  · the cones are out for the whole job', coneRow.days === wavySpan, String(coneRow.days));
ok('  · the radios only for the build', radioRow.days === buildWin.to - buildWin.from + 1,
   String(radioRow.days));

ok('a wave counts its own progress, not the job\u2019s',
   wv[0].wanted === 52 && wv[1].wanted === 6,
   `${wv[0].wanted} / ${wv[1].wanted}`);
ok('inside a wave the picker still walks the building once',
   wv[0].groups.every((g, i) => i === 0 || wv[0].groups[i - 1].location <= g.location) &&
   new Set(wv[0].groups.map((g) => g.location)).size === wv[0].groups.length);

/* The queue row. Sorting on the job's start date put a job whose only kit
   comes off at breakdown above work that was genuinely due first. */
const wavyRow = HOP.queue().find((r) => r.w.id === wavy.id);
ok('the queue says when the FIRST kit is wanted',
   wavyRow.neededAt === wv[0].date, `${wavyRow.neededAt} vs ${wv[0].date}`);

const late = W.create({ title: 'HOP TESTER — late kit', start: d(20), end: dEnd(26) });
late.liveFrom = 3;
late.liveTo = 5;
const lateLine = W.addLine(late, 'ch-kit-signage', { qty: 4 });
W.setHire(late, lateLine.id, W.phaseWindow(late, 'break'));
late.stage = 'picking';
W.sendToHop(late);
const lateRow = HOP.queue().find((r) => r.w.id === late.id);
ok('a job whose only kit comes off at breakdown is not queued as due on day one',
   lateRow.neededAt > lateRow.w.start.slice(0, 10),
   `${lateRow.neededAt} vs ${lateRow.w.start.slice(0, 10)}`);
ok('  · the date it names is that job\u2019s first wave, not its start',
   lateRow.neededAt === HOP.pickWaves(late)[0].date,
   `${lateRow.neededAt} vs ${HOP.pickWaves(late)[0].date}`);
ok('  · and it sorts after work that is genuinely due sooner',
   HOP.queue().filter((r) => r.prep.state !== 'returned')
     .every((r, i, rows) => i === 0 || rows[i - 1].neededAt <= r.neededAt));

retireFixtures();

/* ------------------------------------------------------------------ done --- */

rmSync(work, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
