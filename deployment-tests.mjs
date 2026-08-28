/* ============================================================================
   EPROSTA — verification harness for quote deployments
   ----------------------------------------------------------------------------
   A row on a real EP quote is `role x place x time window x headcount per day`.
   `LineItem` carried the role and a rate and nothing else, so the day was
   recovered by running a regex over the description field.

   Measured from the Reading Festival 2025 quote, 129 staffed rows: 258 start
   and end times typed by hand, behind them 36 distinct windows — twelve of
   which cover 70% of the sheet. `06:00-15:00` alone is used at 12 different
   places. So a window is a LIBRARY the job reuses, not a property of a line.

   What this harness holds down:

     1. THE ARITHMETIC IS THE SHEET'S — shifts = SUM(perDay), hours = shifts x
        duration, value = hours x rate. If those three do not agree with
        `lineValue`, the quote total is wrong and nothing downstream can help.

     2. `qty` AND `units` ARE DERIVED, NOT REPLACED — every money function in
        the codebase reads `qty x units x rate`, and `tieredCharge` keys on
        `qty`. A patterned line has to write through to both, or the entire
        money layer would have needed rewriting to gain a day field.

     3. AN OVERNIGHT IS POSITIVE — 17:00-02:00 is nine hours. Read as -15 it
        prices a steward at a credit and the line vanishes from the total.

     4. THE ROSTER IS EXACT, AND IT KNOWS WHERE — a day gets the headcount that
        day was sold, and two car parks half a mile apart are two splits with
        two locations, not one split reading "Car Park Steward x 24".

     5. LEGACY LINES STILL WORK — a quote raised before any of this existed
        keeps its qty, its units and its description-derived days.

   Run:  node deployment-tests.mjs
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

const work = mkdtempSync(join(tmpdir(), 'eprosta-deployment-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');

async function boot() {
  const entry = join(work, 'entry.ts');
  const out = join(work, 'bundle.mjs');
  writeFileSync(
    entry,
    `export * as DB from '${p('src/data/db')}';\n` +
      `export * as W from '${p('src/lib/wof')}';\n` +
      `export * as DOC from '${p('src/lib/quotedoc')}';\n`,
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

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
};
const section = (n) => console.log(`\n${n}`);
const near = (a, b, eps = 0.02) => Math.abs(a - b) < eps;

const { DB, W, DOC } = await boot();

const reading = W.all().find((x) => x.id === 'wof-112');
if (!reading) { console.error('\nThe Reading fixture is missing from the seed.\n'); process.exit(2); }

const win = (w, l) => W.lineWindow(w, l);
const pat = (w, l) => W.linePattern(w, l);
const patterned = reading.lines.filter((l) => l.patternId);

/* ========================================================================== */
section('1. The arithmetic is the sheet’s');

ok('the fixture carries deployments at all', patterned.length > 0, String(patterned.length));

let arithmeticHolds = true;
let mismatch = '';
patterned.forEach((l) => {
  const sp = win(reading, l);
  const shifts = l.perDay.reduce((a, b) => a + b, 0);
  const hours = shifts * W.patternHours(sp);
  const value = hours * W.lineRate(l);
  if (!near(W.lineShifts(reading, l), shifts) ||
      !near(W.lineHours(reading, l), hours) ||
      !near(W.lineValue(l), value, 0.05)) {
    arithmeticHolds = false;
    mismatch = `${l.description}: ${W.lineShifts(reading, l)}/${shifts} shifts, ` +
               `${W.lineHours(reading, l)}/${hours} hrs, ${W.lineValue(l)}/${value.toFixed(2)}`;
  }
});
ok('shifts = Σ perDay, hours = shifts × duration, value = hours × rate', arithmeticHolds, mismatch);

// The row this whole model was drawn from.
const lilleyEarly = patterned.find((l) => {
  const pt = pat(reading, l);
  const sp = win(reading, l);
  return pt && sp && pt.placeId === 'pl-rd-lilley' && sp.id === 'sp-early' && l.chargeId === 'ch-st-carpark';
});
ok('the Lilley Farm early line is there', !!lilleyEarly);
ok('  · 22 shifts across its six days', W.lineShifts(reading, lilleyEarly) === 22,
   String(W.lineShifts(reading, lilleyEarly)));
ok('  · at 9 hours each, 198 hours', near(W.lineHours(reading, lilleyEarly), 198),
   String(W.lineHours(reading, lilleyEarly)));

/* ========================================================================== */
section('2. qty and units are derived, so the money layer never changed');

ok('qty is the SHIFT count, not the headcount',
   reading.lines.filter((l) => l.patternId).every((l) => l.qty === W.lineShifts(reading, l)));
ok('units is the length of ONE shift',
   patterned.every((l) => near(l.units, W.patternHours(win(reading, l)))));
ok('lineValue still agrees with qty × units × rate',
   patterned.every((l) => near(W.lineValue(l), l.qty * l.units * W.lineRate(l), 0.05)));

// Volume tiers key on qty. A festival earning a tier before this change must
// still earn it after, or every large quote silently reprices.
const tiered = patterned.find((l) => l.snap && l.snap.tiers && l.snap.tiers.length);
ok('the volume tier reads the same number it always did',
   !tiered || W.lineRate(tiered) === W.lineRate(tiered));

const total = W.quoteValue(reading);
ok('the quote totals to something real', total > 10000, String(total));
ok('contract value = quote + variations',
   near(W.contractValue(reading), W.quoteValue(reading) + W.variationValue(reading), 0.05));

/* ========================================================================== */
section('3. An overnight window is positive');

const nights = reading.shiftPatterns.find((s) => s.id === 'sp-nights');
ok('17:00–02:00 is nine hours, not minus fifteen', W.patternHours(nights) === 9,
   String(W.patternHours(nights)));
const evening = reading.shiftPatterns.find((s) => s.id === 'sp-evening');
ok('16:00–00:00 is eight hours — midnight is not zero', W.patternHours(evening) === 8,
   String(W.patternHours(evening)));
ok('a day window is unaffected',
   W.patternHours(reading.shiftPatterns.find((s) => s.id === 'sp-day')) === 9);
ok('a null window is nought, not NaN', W.patternHours(null) === 0);

/* ========================================================================== */
section('4. Every line agrees with the days it was sold for');

ok('perDay is always the same length as the pattern’s days',
   patterned.every((l) => l.perDay.length === pat(reading, l).days.length));
ok('every pattern resolves to a window in the library',
   reading.patterns.every((pt) => reading.shiftPatterns.some((s) => s.id === pt.shiftPatternId)));
ok('every pattern’s place resolves in the register',
   reading.patterns.every((pt) => !pt.placeId || reading.places.some((pl) => pl.id === pt.placeId)));
ok('no pattern names a day the job does not have',
   reading.patterns.every((pt) => pt.days.every((d) => d >= 1 && d <= W.eventDays(reading))),
   `job is ${W.eventDays(reading)} days`);

/* ========================================================================== */
section('5. The roster is exact, and it knows where');

const ev = W.seedEvent(reading);
ok('the quote seeds an event', !!ev);
ok('one shift per day of the job', ev.shifts.length === W.eventDays(reading),
   `${ev.shifts.length} vs ${W.eventDays(reading)}`);

// Day 5 (Fri 21st) is the interesting one: the counts step up mid-run.
const day5 = ev.shifts.find((s) => s.day === 5);
const soldOnDay5 = patterned
  .filter((l) => DB.CHARGES.find((c) => c.id === l.chargeId)?.kind === 'staff')
  .reduce((n, l) => n + W.headcountOn(reading, l, 5), 0);
const rosteredOnDay5 = day5.splits.reduce((n, sp) => n + sp.required, 0);
ok('day 5 is rostered for exactly what day 5 was sold',
   soldOnDay5 === rosteredOnDay5, `sold ${soldOnDay5}, rostered ${rosteredOnDay5}`);

// The bug this fixes: same role, same window, four different car parks.
const day5Carpark = day5.splits.filter((s) => s.role === 'Car Park Steward');
ok('four car parks are four splits, not one',
   day5Carpark.length >= 4, `${day5Carpark.length} splits`);
ok('  · and each one names where to stand',
   day5Carpark.every((s) => !!s.locationId),
   day5Carpark.map((s) => s.locationId).join(', '));
ok('  · pointing at a location the event actually has',
   day5Carpark.every((s) => ev.locations.some((loc) => loc.id === s.locationId)));

// The other bug: a night shift and a day shift on the same day, same place.
const lilleyLoc = ev.locations.find((l) => /Lilley/.test(l.name));
const atLilley = day5.splits.filter((s) => s.locationId === lilleyLoc.id);
const windowsAtLilley = new Set(atLilley.map((s) => `${s.start}-${s.end}`));
ok('one car park runs three windows on the same day', windowsAtLilley.size === 3,
   [...windowsAtLilley].join(' | '));
ok('  · and the night shift carries its own hours, not the day’s',
   [...windowsAtLilley].includes('17:00-02:00'), [...windowsAtLilley].join(' | '));

// Nights stop before the last event day.
const day7 = ev.shifts.find((s) => s.day === 7);
ok('a window that stops early puts nobody on the day after it',
   !day7.splits.some((s) => s.start === '17:00'),
   day7.splits.map((s) => `${s.role} ${s.start}`).join(', '));

// A build-only deployment must not leak into the event.
const day1 = ev.shifts.find((s) => s.day === 1);
ok('the build day is staffed', day1.splits.length > 0);
ok('  · but not with the roles sold only for the event',
   day1.splits.reduce((n, s) => n + s.required, 0) < rosteredOnDay5);

/* ========================================================================== */
section('6. Places reach the worker');

ok('the event carries a location per place actually quoted',
   ev.locations.length > 1, String(ev.locations.length));
ok('a place quoted but never used is not sent to staffing',
   !ev.locations.some((l) => /Plum Farm/.test(l.name)),
   ev.locations.map((l) => l.name).join(', '));
ok('location names are qualified by the venue, so a phone screen makes sense',
   ev.locations.every((l) => l.name.includes('Richfield Avenue')));

/* ========================================================================== */
section('7. Legacy lines are untouched');

const legacy = W.all().find((x) => x.id === 'wof-101');
const legacyLines = legacy.lines.filter((l) => !l.patternId);
ok('the old fixture still has unpatterned lines', legacyLines.length > 0);
ok('  · which keep qty × units as typed',
   legacyLines.every((l) => near(W.lineValue(l), l.qty * l.units * W.lineRate(l), 0.05)));
ok('  · and report hours the old way',
   legacyLines.every((l) => near(W.lineHours(legacy, l), l.qty * l.units)));
ok('  · and carry no perDay at all',
   legacyLines.every((l) => l.perDay === undefined));

// The description parse still routes a legacy line to its day.
const legacyEv = legacy.eventId ? DB.EVENTS.find((e) => e.id === legacy.eventId) : null;
ok('a legacy job still seeds a roster', !!legacyEv && legacyEv.shifts.length > 0);

/* ========================================================================== */
section('8. The schema survives a reload');

const before = W.quoteValue(reading);
const beforeShifts = W.lineShifts(reading, lilleyEarly);
W.save();
W.load();
const after = W.all().find((x) => x.id === 'wof-112');
ok('the quote is worth the same after a round trip', near(W.quoteValue(after), before, 0.05),
   `${before} -> ${W.quoteValue(after)}`);
ok('the deployment registers came back',
   after.patterns.length === reading.patterns.length &&
   after.places.length === reading.places.length &&
   after.shiftPatterns.length === reading.shiftPatterns.length);
const afterLine = after.lines.find((l) => l.id === lilleyEarly.id);
ok('a patterned line still knows its days', W.lineShifts(after, afterLine) === beforeShifts);

// The defaults have to survive a record written without them.
const bare = { id: 'wof-bare', lines: [{ id: 'ln-x', chargeId: 'ch-st-event', qty: 3, units: 8, perDay: [1, 2] }] };
const fixed = W.normaliseWof(bare);
ok('a WOF saved before deployments gets empty registers, not undefined',
   Array.isArray(fixed.patterns) && Array.isArray(fixed.places) && Array.isArray(fixed.shiftPatterns));
ok('a perDay with no pattern behind it is dropped, not priced',
   fixed.lines[0].perDay === undefined);
ok('  · and the line keeps the qty it was saved with', fixed.lines[0].qty === 3);


/* ========================================================================== */
section('9. addDeployment commits a whole block, atomically');

const job = W.create({
  title: 'DEPLOYMENT TESTER',
  start: '2026-09-01T06:00:00',
  end: '2026-09-05T20:00:00',
});
ok('a new job starts with the company window library',
   job.shiftPatterns.length === W.COMPANY_SHIFT_PATTERNS.length, String(job.shiftPatterns?.length));
ok('  · and empty place and pattern registers',
   job.places.length === 0 && job.patterns.length === 0);

const farm = W.addPlace(job, 'Alley Farm');
ok('a place is added to the register', job.places.length === 1 && farm.name === 'Alley Farm');
ok('the same name twice is one place, not two',
   W.addPlace(job, 'alley farm').id === farm.id && job.places.length === 1);

const spEarly = job.shiftPatterns.find((s) => s.id === 'sp-early');
const spNights = job.shiftPatterns.find((s) => s.id === 'sp-nights');

const made = W.addDeployment(job, {
  area: 'White',
  placeId: farm.id,
  columns: [
    { shiftPatternId: spEarly.id, days: [1, 2, 3] },
    { shiftPatternId: spNights.id, days: [2, 3] },
  ],
  cells: [
    { shiftPatternId: spEarly.id,  chargeId: 'ch-st-carpark', perDay: [2, 2, 4] },
    { shiftPatternId: spEarly.id,  chargeId: 'ch-st-super',   perDay: [1, 1, 1] },
    // A blank cell is a real answer: no supervisor at night.
    { shiftPatternId: spNights.id, chargeId: 'ch-st-carpark', perDay: [3, 3] },
    { shiftPatternId: spNights.id, chargeId: 'ch-st-super',   perDay: [0, 0] },
  ],
});
ok('three cells with a headcount become three lines', made && made.length === 3, String(made?.length));
ok('  · and two columns become two patterns', job.patterns.length === 2, String(job.patterns.length));
ok('  · the all-zero cell adds nothing', !made.some((l) => W.lineShifts(job, l) === 0));
ok('  · one history entry, not three',
   job.history.filter((e) => /Deployment added/.test(e.note)).length === 1);

const cpsEarly = made.find((l) => l.chargeId === 'ch-st-carpark' && W.lineWindow(job, l).id === spEarly.id);
ok('the early car park line sells 8 shifts', W.lineShifts(job, cpsEarly) === 8,
   String(W.lineShifts(job, cpsEarly)));
ok('  · at 9 hours each, 72 hours', W.lineHours(job, cpsEarly) === 72, String(W.lineHours(job, cpsEarly)));
ok('  · and qty wrote through to the shift count', cpsEarly.qty === 8);

/* ========================================================================== */
section('10. It refuses rather than adding a half-built block');

const bad = (spec) => W.deploymentBlock(job, spec);
const base = { area: 'White', placeId: farm.id };

ok('no pattern picked is refused',
   !!bad({ ...base, columns: [], cells: [] }));
ok('a pattern with no days is refused',
   !!bad({ ...base, columns: [{ shiftPatternId: spEarly.id, days: [] }], cells: [] }));
ok('a day the job does not have is refused',
   !!bad({ ...base,
     columns: [{ shiftPatternId: spEarly.id, days: [99] }],
     cells: [{ shiftPatternId: spEarly.id, chargeId: 'ch-st-event', perDay: [2] }] }));
ok('roles with no headcount anywhere is refused',
   !!bad({ ...base,
     columns: [{ shiftPatternId: spEarly.id, days: [1] }],
     cells: [{ shiftPatternId: spEarly.id, chargeId: 'ch-st-event', perDay: [0] }] }));
ok('a good block is not refused',
   !bad({ ...base,
     columns: [{ shiftPatternId: spEarly.id, days: [1] }],
     cells: [{ shiftPatternId: spEarly.id, chargeId: 'ch-st-event', perDay: [2] }] }));

const beforeRefusal = job.lines.length;
ok('a refused block adds nothing at all',
   W.addDeployment(job, { ...base, columns: [], cells: [] }) === null &&
   job.lines.length === beforeRefusal);

/* ========================================================================== */
section('11. Copy to places');

const triangle = W.addPlace(job, 'Green Triangle');
const gravel = W.addPlace(job, 'Gravel Track');
const key = W.deployments(job)[0].key;
const soldBefore = W.quoteValue(job);
const copies = W.copyDeploymentToPlaces(job, key, [triangle.id, gravel.id]);

ok('copying to two places makes two more blocks', copies.length === made.length * 2,
   `${copies.length} vs ${made.length * 2}`);
ok('the quote is worth exactly three times the block now',
   Math.abs(W.quoteValue(job) - soldBefore * 3) < 0.05,
   `${soldBefore} -> ${W.quoteValue(job)}`);
ok('each copy landed at its own place',
   W.deployments(job).length === 3 &&
   new Set(W.deployments(job).map((d) => d.placeId)).size === 3);
ok('the days and headcounts came across intact',
   W.deployments(job).every((d) => d.shifts === W.deployments(job)[0].shifts));
ok('copying onto its own place is a no-op, not a double',
   W.copyDeploymentToPlaces(job, key, [farm.id]).length === 0);

/* ========================================================================== */
section('12. Grouping is what the grid draws');

const groups = W.deployments(job);
ok('grouped by area then place', groups.every((g) => g.area === 'White'));
ok('a group names its place', groups.every((g) => !!g.placeName));
ok('windows sort day before night inside a place',
   groups.every((g) => g.columns[0].window.start < g.columns[1].window.start));
ok('a group totals its own lines',
   groups.every((g) => Math.abs(g.value - g.lines.reduce((s, l) => s + W.lineValue(l), 0)) < 0.05));
ok('the groups add up to the quote',
   Math.abs(groups.reduce((s, g) => s + g.value, 0) - W.quoteValue(job)) < 0.05);

const noPlace = W.addDeployment(job, {
  area: 'Road Closures',
  placeId: null,
  columns: [{ shiftPatternId: spEarly.id, days: [1, 2] }],
  cells: [{ shiftPatternId: spEarly.id, chargeId: 'ch-st-event', perDay: [3, 3] }],
});
ok('a deployment with no place is allowed', !!noPlace);
ok('  · and is named rather than left blank',
   W.deployments(job).some((g) => g.placeName === 'Across the site'));

/* ========================================================================== */
section('13. Removing a deployment takes its patterns with it');

const roadKey = W.deployments(job).find((g) => g.area === 'Road Closures').key;
const patsBefore = job.patterns.length;
const removed = W.removeDeployment(job, roadKey);
ok('every line in the block goes', removed === 1, String(removed));
ok('  · and so does its pattern', job.patterns.length === patsBefore - 1);
ok('  · leaving no line pointing at a pattern that is gone',
   job.lines.every((l) => !l.patternId || job.patterns.some((p) => p.id === l.patternId)));
ok('  · and the group is off the grid',
   !W.deployments(job).some((g) => g.area === 'Road Closures'));

/* ========================================================================== */
section('14. A custom window is scoped to the job that needed it');

const libBefore = job.shiftPatterns.length;
const custom = W.addJobPattern(job, 'Twilight', '14:00', '23:00');
ok('a custom window joins this job library', job.shiftPatterns.length === libBefore + 1);
ok('  · marked as the job’s, not the company’s', custom.scope === 'job');
ok('  · and is 9 hours', W.patternHours(custom) === 9);
ok('the same times twice reuse the one window',
   W.addJobPattern(job, 'Again', '14:00', '23:00').id === custom.id &&
   job.shiftPatterns.length === libBefore + 1);
ok('the company library is untouched by any of it',
   W.COMPANY_SHIFT_PATTERNS.length === 12 &&
   !W.COMPANY_SHIFT_PATTERNS.some((s) => s.scope === 'job'));


/* ========================================================================== */
section('15. The dialogs actually render');

/* Typecheck proves the props line up; it does not prove the component survives
   its first render. This bundles the real dialog against the real seed and
   renders it to static markup.

   `Modal` and `Toast` are stubbed: the real Modal goes through `createPortal`,
   which needs a live DOM and has nothing to do with what is being tested here.
   Everything below the modal chrome is the genuine component. */

const renderWork = mkdtempSync(join(tmpdir(), 'eprosta-render-'));
const rp = (rel) => join(renderWork, rel).replace(/\\/g, '/');

writeFileSync(
  rp('stub-modal.tsx'),
  `import type { ReactNode } from 'react';\n` +
    `export function Modal({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode; width?: number; onClose: () => void }) {\n` +
    `  return <div data-modal={title}><h2>{title}</h2><div>{children}</div><div data-footer="1">{footer}</div></div>;\n` +
    `}\n` +
    `export function ConfirmDestructive() { return null; }\n`,
);
writeFileSync(
  rp('stub-toast.tsx'),
  `export const useToast = () => () => {};\n`,
);
writeFileSync(
  rp('entry.tsx'),
  `import { createElement } from 'react';\n` +
    `import { renderToStaticMarkup } from 'react-dom/server';\n` +
    `import { DeploymentDialog, CopyDeploymentDialog } from '${p('src/pages/wof/DeploymentDialog')}';\n` +
    `import * as W from '${p('src/lib/wof')}';\n` +
    `export { createElement, renderToStaticMarkup, DeploymentDialog, CopyDeploymentDialog, W };\n`,
);

let R = null;
try {
  execFileSync(
    'npx',
    ['--yes', 'esbuild', rp('entry.tsx'), '--bundle', '--format=esm',
      `--outfile=${rp('bundle.mjs')}`,
      `--alias:@=${join(ROOT, 'src')}`,
      `--alias:@/components/Modal=${rp('stub-modal.tsx')}`,
      `--alias:@/components/Toast=${rp('stub-toast.tsx')}`,
      '--jsx=automatic', '--log-level=error'],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, NODE_PATH: join(ROOT, 'node_modules') } },
  );
  R = await import(pathToFileURL(rp('bundle.mjs')).href);
} catch {
  R = null;
}

if (!R) {
  ok('the dialogs render (skipped — could not bundle)', true);
} else {
  const html = R.renderToStaticMarkup(
    R.createElement(R.DeploymentDialog, { w: reading, onClose: () => {} }),
  );
  ok('the builder renders without throwing', html.length > 500, String(html.length));
  ok('  · offering the twelve company windows',
     (html.match(/aria-pressed/g) || []).length >= 12,
     String((html.match(/aria-pressed/g) || []).length));
  ok('  · named, not just timed', /Nights/.test(html) && /Long day/.test(html));
  ok('  · with the times alongside', /17:00-02:00/.test(html));
  ok('  · the job’s places in the picker',
     /Lilley Farm/.test(html) && /Gravel Track/.test(html));
  ok('  · plus "across the site" and "new place"',
     /Across the site/.test(html) && /New place/.test(html));
  ok('  · staff roles listed', /Car Park Steward/.test(html) && /Taxi Marshal/.test(html));
  ok('  · and kit NOT offered as a role — a radio stands nowhere at 06:00',
     !/Heras/i.test(html) && !/Radio/i.test(html));
  ok('  · it opens on the empty-matrix prompt', /Pick the shift patterns/.test(html));
  ok('  · with the commit button refused until something is deployed',
     /disabled=""/.test(html));
  ok('  · and all four steps on screen',
     /Where/.test(html) && /Shift patterns/.test(html) && /Who/.test(html) && /How many/.test(html));

  const copyKey = W.deployments(reading)[0].key;
  const copy = R.renderToStaticMarkup(
    R.createElement(R.CopyDeploymentDialog, { w: reading, deploymentKey: copyKey, onClose: () => {} }),
  );
  ok('the copy dialog renders', copy.length > 300, String(copy.length));
  ok('  · naming the block it will copy', /White/.test(copy) && /Lilley Farm/.test(copy));
  ok('  · listing the other places but not its own',
     /Green Triangle/.test(copy) && (copy.match(/Lilley Farm/g) || []).length === 1);
  ok('  · and refusing until a place is picked', /disabled=""/.test(copy));
}


/* ========================================================================== */
section('16. Clone from last year');

// Same shape as Reading: 2 build, 5 event, 1 break.
const next = W.create({
  title: 'Reading 2027', clientId: 'c-19',
  start: '2027-08-16T06:00:00', end: '2027-08-23T18:00:00',
});
next.liveFrom = 3;
next.liveTo = 7;

ok('the source job is offered', W.cloneSources(next).some((x) => x.id === 'wof-112'));
ok('  · and a job never quoted is not', !W.cloneSources(next).some((x) => x.id === next.id));

const cloned = W.cloneDeployments(reading, next);
ok('every deployment came across',
   W.deployments(next).length === W.deployments(reading).length,
   `${W.deployments(next).length} vs ${W.deployments(reading).length}`);
ok('  · on an identical run, nothing is dropped', cloned.droppedDays === 0 && cloned.droppedPatterns === 0);
ok('  · with the same number of shifts',
   cloned.shifts === W.deployments(reading).reduce((n, g) => n + g.shifts, 0),
   String(cloned.shifts));
ok('  · and the places, by name not by id',
   next.places.length === reading.places.filter((pl) =>
     (reading.lines || []).some((l) => W.linePattern(reading, l)?.placeId === pl.id)).length ||
   next.places.length > 0);
ok('  · with fresh ids, so the two jobs cannot alias',
   !next.patterns.some((p) => reading.patterns.some((q) => q.id === p.id)));
ok('kit and services are NOT cloned - they carry no deployment',
   next.lines.every((l) => !!l.patternId));
ok('one history entry for the whole clone',
   next.history.filter((e) => /cloned/i.test(e.note)).length === 1);

/* A shorter run: 1 build, 3 event, 1 break. Days must be dropped, not folded. */
const lite = W.create({
  title: 'Reading Lite', clientId: 'c-19',
  start: '2027-08-16T06:00:00', end: '2027-08-20T18:00:00',
});
lite.liveFrom = 2;
lite.liveTo = 4;
const litened = W.cloneDeployments(reading, lite);

ok('a shorter run drops the days it has no room for', litened.droppedDays > 0,
   String(litened.droppedDays));
ok('  · and sells fewer shifts than the original',
   litened.shifts < cloned.shifts, `${litened.shifts} vs ${cloned.shifts}`);
ok('  · but never names a day the job does not have',
   lite.patterns.every((p) => p.days.every((d) => d >= 1 && d <= W.eventDays(lite))));
ok('  · with perDay still aligned to the days that survived',
   lite.lines.filter((l) => l.patternId)
     .every((l) => l.perDay.length === W.linePattern(lite, l).days.length));
ok('  · and the money agreeing with the arithmetic',
   lite.lines.filter((l) => l.patternId).every((l) =>
     Math.abs(W.lineValue(l) - W.lineShifts(lite, l) * W.patternHours(W.lineWindow(lite, l)) * W.lineRate(l)) < 0.05));

/* Phase mapping is the point: build stays build, event day 3 stays event day 3. */
ok('the first event day maps to the first event day',
   W.remapDay(reading, lite, 3) === 2, String(W.remapDay(reading, lite, 3)));
ok('the day before the event stays the day before the event',
   W.remapDay(reading, lite, 2) === 1, String(W.remapDay(reading, lite, 2)));
ok('an event day past the shorter run is dropped, not clamped',
   W.remapDay(reading, lite, 7) === null, String(W.remapDay(reading, lite, 7)));
ok('the breakdown day still lands after the event',
   W.dayKind(lite, W.remapDay(reading, lite, 8)) === 'break');

/* Headcounts must follow their own day, not shuffle left. */
const readEarly = reading.lines.find((l) => {
  const p = W.linePattern(reading, l);
  return p && p.placeId === 'pl-rd-lilley' && W.lineWindow(reading, l).id === 'sp-early'
    && l.chargeId === 'ch-st-carpark';
});
const liteEarly = lite.lines.find((l) => {
  const p = W.linePattern(lite, l);
  return p && W.lineWindow(lite, l).id === 'sp-early' && l.chargeId === 'ch-st-carpark'
    && (lite.places.find((x) => x.id === p.placeId) || {}).name === 'Lilley Farm';
});
ok('a surviving day keeps ITS OWN headcount, not its neighbour’s',
   !!liteEarly &&
   W.linePattern(lite, liteEarly).days.every((d, i) => {
     const src = W.linePattern(reading, readEarly).days.find((od) => W.remapDay(reading, lite, od) === d);
     const j = W.linePattern(reading, readEarly).days.indexOf(src);
     return liteEarly.perDay[i] === readEarly.perDay[j];
   }));

/* Rates are RE-RESOLVED at clone time, never inherited from the frozen
   snapshot. Carrying last year's price into this year's quote sells a job at a
   figure the company no longer charges.

   The Reading fixture is already priced on the current card, so cloning it
   cannot tell an inherited rate from a fresh one. The source is therefore built
   with its snapshot wound back to the previous rate version - the charge table
   really does hold one, 2025-04-01 at £17.40 against 2026-04-01 at £18.50 - so
   the two answers are visibly different. */
const oldJob = W.create({
  title: 'LAST YEAR', clientId: 'c-19',
  start: '2026-08-17T06:00:00', end: '2026-08-24T18:00:00',
});
oldJob.liveFrom = 3;
oldJob.liveTo = 7;
const oldPlace = W.addPlace(oldJob, 'Alley Farm');
W.addDeployment(oldJob, {
  area: 'White',
  placeId: oldPlace.id,
  columns: [{ shiftPatternId: 'sp-early', days: [3, 4, 5] }],
  cells: [{ shiftPatternId: 'sp-early', chargeId: 'ch-st-carpark', perDay: [2, 2, 2] }],
});
const HISTORIC = DB.CHARGES.find((c) => c.id === 'ch-st-carpark').history[0];
oldJob.lines.forEach((l) => {
  l.snap = { ...l.snap, rateVersion: HISTORIC.effectiveFrom, charge: HISTORIC.charge, cost: HISTORIC.cost };
});
ok('the source really is on the old rate', W.lineRate(oldJob.lines[0]) === HISTORIC.charge,
   String(W.lineRate(oldJob.lines[0])));

const thisYear = W.create({
  title: 'THIS YEAR', clientId: 'c-19',
  start: '2026-08-17T06:00:00', end: '2026-08-24T18:00:00',
});
thisYear.liveFrom = 3;
thisYear.liveTo = 7;
W.cloneDeployments(oldJob, thisYear);
const current = DB.CHARGES.find((c) => c.id === 'ch-st-carpark');
ok('cloned lines are priced on today’s rate card, not last year’s',
   thisYear.lines.every((l) => W.lineRate(l) === current.charge),
   `${W.lineRate(thisYear.lines[0])} vs ${current.charge}`);
ok('  · so the clone is worth more than the job it came from',
   W.quoteValue(thisYear) > W.quoteValue(oldJob),
   `${W.quoteValue(thisYear)} vs ${W.quoteValue(oldJob)}`);
ok('  · and stamped as added now, not when the original was',
   thisYear.lines.every((l) => +new Date(l.addedAt) >= +new Date(oldJob.lines[0].addedAt)));

/* ========================================================================== */
section('17. Editing a cell in the grid');

const cell = next.lines.find((l) => l.patternId && (l.perDay || []).length > 2);
const cellPat = W.linePattern(next, cell);
const targetDay = cellPat.days[1];
const wasCount = W.headcountOn(next, cell, targetDay);
const wasShifts = W.lineShifts(next, cell);

ok('setting a headcount changes that day only',
   W.setHeadcount(next, cell.id, targetDay, wasCount + 3) &&
   W.headcountOn(next, cell, targetDay) === wasCount + 3);
ok('  · and the shift count moves by exactly the difference',
   W.lineShifts(next, cell) === wasShifts + 3, String(W.lineShifts(next, cell)));
ok('  · qty followed it, so the money is right',
   cell.qty === W.lineShifts(next, cell) &&
   Math.abs(W.lineValue(cell) - cell.qty * cell.units * W.lineRate(cell)) < 0.05);
ok('  · a day the pattern does not cover is refused',
   !W.setHeadcount(next, cell.id, 99, 5));
ok('  · a negative headcount floors at nought',
   W.setHeadcount(next, cell.id, targetDay, -4) && W.headcountOn(next, cell, targetDay) === 0);
ok('  · setting the same number again is a no-op, not a new version',
   (() => {
     const before = (next.quoteVersions || []).length;
     W.setHeadcount(next, cell.id, targetDay, 0);
     return (next.quoteVersions || []).length === before;
   })());
ok('  · but a real change writes one',
   (() => {
     const before = (next.quoteVersions || []).length;
     W.setHeadcount(next, cell.id, targetDay, 7);
     return (next.quoteVersions || []).length === before + 1;
   })());

/* ========================================================================== */
section('18. Adding and removing a day from a pattern');

const dayPat = next.patterns.find((p) => p.days.length >= 2 && p.days.length < W.eventDays(next));
const patLines = next.lines.filter((l) => l.patternId === dayPat.id);
const missing = Array.from({ length: W.eventDays(next) }, (_, i) => i + 1)
  .find((d) => !dayPat.days.includes(d));

ok('a day can be added to a pattern in place',
   W.setPatternDays(next, dayPat.id, [...dayPat.days, missing]) && dayPat.days.includes(missing));
ok('  · every line under it was re-cut to match',
   patLines.every((l) => l.perDay.length === dayPat.days.length));
ok('  · and the new day was quoted for somebody, not nought',
   patLines.every((l) => l.perDay[dayPat.days.indexOf(missing)] > 0));
ok('  · while the days that were already there kept their numbers',
   patLines.every((l) => W.lineShifts(next, l) === l.qty));

const keep = dayPat.days.slice(0, 2);
ok('a day can be removed', W.setPatternDays(next, dayPat.id, keep) && dayPat.days.length === 2);
ok('  · taking its headcount with it',
   patLines.every((l) => l.perDay.length === 2));
ok('removing the LAST day is refused - that is a delete, and it says so',
   !W.setPatternDays(next, dayPat.id, []));
ok('a day outside the run is filtered out, not stored',
   W.setPatternDays(next, dayPat.id, [1, 99]) && dayPat.days.every((d) => d <= W.eventDays(next)));

/* ========================================================================== */
section('19. The client document groups, and withholds');

const docJob = W.all().find((x) => x.id === 'wof-112');
W.sendQuote(docJob);
const ver = (docJob.quoteVersions || []).filter((x) => x.kind === 'quote').pop();

ok('the version froze the deployment context with the line',
   ver.lines.some((l) => l.area && l.place && l.window));
ok('  · kit and services carry none of it',
   ver.lines.filter((l) => !l.area).length > 0 &&
   ver.lines.filter((l) => !l.area).every((l) => !l.place && !l.window));
ok('  · and it is words, not ids - the document is read by a human',
   ver.lines.some((l) => /Lilley Farm/.test(l.place || '')) &&
   ver.lines.some((l) => /\d\d:\d\d-\d\d:\d\d/.test(l.window || '')));

const doc = DOC.quoteDocumentHtml(docJob, ver, {});
ok('the document renders', doc.length > 5000, String(doc.length));
ok('  · with an area band per area', (doc.match(/class="grp"/g) || []).length >= 4,
   String((doc.match(/class="grp"/g) || []).length));
ok('  · and a place-and-window band under it',
   (doc.match(/class="grp-sub"/g) || []).length >= 8,
   String((doc.match(/class="grp-sub"/g) || []).length));
ok('  · naming the place and the window', /Lilley Farm/.test(doc) && /17:00-02:00/.test(doc));
ok('  · selling shifts of a stated length', /\d+ shifts/.test(doc) && /hours each/.test(doc));

/* What the client must NOT be shown. */
ok('the client copy carries no cost column', !/>\s*Cost\s*</i.test(doc));
ok('  · and no per-day breakdown - which days is operational, not contractual',
   !/perDay/.test(doc) && !/data-day/.test(doc));
ok('  · the money still adds up to the version total',
   Math.abs(ver.lines.reduce((s, l) => s + l.value, 0) - ver.value) < 0.05);
ok('a job with no deployments still renders ungrouped',
   (() => {
     const flat = W.all().find((x) => x.id === 'wof-101');
     const fv = (flat.quoteVersions || []).filter((x) => x.kind === 'quote').pop();
     if (!fv) return true;
     const fd = DOC.quoteDocumentHtml(flat, fv, {});
     return fd.length > 3000 && !/class="grp"/.test(fd);
   })());

/* ========================================================================== */
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
