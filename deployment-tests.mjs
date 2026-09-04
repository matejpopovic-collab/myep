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
      `export * as DOC from '${p('src/lib/quotedoc')}';\n` +
      `export * as RATES from '${p('src/lib/rates')}';\n`,
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

const { DB, W, DOC, RATES } = await boot();

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
    `export function ConfirmDestructive() { return null; }\n` +
    // WofDetail's header uses it; nothing under test is inside it.
    `export function MenuButton({ label }: { label: string; className?: string; items?: unknown }) {\n` +
    `  return <button type="button">{label}</button>;\n` +
    `}\n`,
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
  // The area is the client document's grouping key. Free text banded the same
  // car park twice when an operator typed it twice, so it is a picker of the
  // job's own bands - and the datalist that used to accept anything is gone.
  ok('  · the job’s areas offered the same way, not typed',
     /Road Closures/.test(html) && /New area/.test(html) && !/<datalist/.test(html));
  ok('  · staff roles listed', /Car Park Steward/.test(html) && /Taxi Marshal/.test(html));
  ok('  · under three tabs, so kit and services are one dialog away',
     (html.match(/role="tab"/g) || []).length === 3 &&
     />Staff</.test(html) && />Kit</.test(html) && />Services</.test(html),
     String((html.match(/role="tab"/g) || []).length));
  ok('  · opening on Staff, with kit NOT mixed into the role list',
     /aria-selected="true"[^>]*>Staff/.test(html) &&
     !/Heras/i.test(html) && !/Motorola/i.test(html));
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
/* Wound back ON THE ACCOUNT'S OWN CARD, so the only difference between the two
   jobs is the year. Winding it back to last year's PUBLISHED rate would leave
   c-19's Preferred position as a second variable and the test would be
   measuring two things at once. */
const THEN = RATES.rateFor('ch-st-carpark', 'c-19', HISTORIC.effectiveFrom);
oldJob.lines.forEach((l) => { l.snap = { ...THEN }; });
ok('the source really is on the old rate', W.lineRate(oldJob.lines[0]) === THEN.charge,
   String(W.lineRate(oldJob.lines[0])));

const thisYear = W.create({
  title: 'THIS YEAR', clientId: 'c-19',
  start: '2026-08-17T06:00:00', end: '2026-08-24T18:00:00',
});
thisYear.liveFrom = 3;
thisYear.liveTo = 7;
W.cloneDeployments(oldJob, thisYear);
/* "Today's rate" means today's rate FOR THIS ACCOUNT, not the published one.
   c-19 is priced from the Preferred card, so naming the published figure here
   would be asserting that cloning ignores the account — the opposite of what
   the rest of this file proves. Resolved rather than typed, for the same
   reason every date in these fixtures is computed rather than typed. */
const current = RATES.rateFor('ch-st-carpark', 'c-19', DB.NOW);
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
// A cell edit is not a document — it is a note on what the next one will say,
// and no version exists until somebody sends the quote.
ok('  · setting the same number again is a no-op, not even a note',
   (() => {
     const before = W.pendingChanges(next).length;
     W.setHeadcount(next, cell.id, targetDay, 0);
     return W.pendingChanges(next).length === before;
   })());
ok('  · but a real change is noted for the next document',
   (() => {
     const before = W.pendingChanges(next).length;
     W.setHeadcount(next, cell.id, targetDay, 7);
     return W.pendingChanges(next).length === before + 1;
   })());
ok('  · and writes nothing the client can open',
   (() => {
     const before = (next.quoteVersions || []).length;
     W.setHeadcount(next, cell.id, targetDay, 9);
     return (next.quoteVersions || []).length === before;
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
// A version is a document that was sent, so the document has to be sent to
// exist — and this one is over the threshold, so a senior manager clears it
// first. Both steps are the point: nothing here is written by pricing alone.
W.approveQuote(docJob, '', { by: 'm-dawn', name: 'Dawn Cartwright' });
ok('the quote could be sent', W.sendQuote(docJob), W.quoteSendBlock(docJob) || '');
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
section('20. The chain from a sold hour to a paid one');

const done = W.all().find((x) => x.id === 'wof-113');
ok('the delivered fixture is there', !!done && W.deployments(done).length > 0);

const sheets = W.timesheets(done);
ok('it has timesheets', sheets.length === 10, String(sheets.length));
ok('every one resolves to the lines that sold it',
   sheets.every((t) => t.lineIds.length >= 1),
   `${sheets.filter((t) => !t.lineIds.length).length} unattributed`);
ok('  · the early window was sold twice, so its hours resolve to both lines',
   sheets.filter((t) => t.hours === 9).every((t) => t.lineIds.length === 2));

/* The window is what makes the resolution safe. Two shifts of the same role at
   the same place on the same date differ only by when they start. */
const nightSheets = sheets.filter((t) => t.hours > 10);
const daySheets = sheets.filter((t) => t.hours === 9);
ok('day and night on the same date land on DIFFERENT lines',
   nightSheets.length > 0 && daySheets.length > 0 &&
   nightSheets[0].lineIds[0] !== daySheets[0].lineIds[0]);
ok('  · and every night row lands on the same one',
   new Set(nightSheets.map((t) => t.lineIds[0])).size === 1);

/* Without a window it must refuse rather than guess. */
ok('an hour with no window and two candidates is left unattributed',
   W.linesForWork(done, { date: sheets.find((t) => t.hours > 10).date, role: 'Car Park Steward' })
     .length === 0);
ok('  · and a day with several windows always needs one',
   W.linesForWork(done, { date: sheets.find((t) => t.hours === 9).date, role: 'Car Park Steward' })
     .length === 0);
ok('a role nobody was sold for resolves to nothing',
   W.linesForWork(done, { date: sheets[0].date, role: 'Pit Steward', scheduled: '06:00–15:00' })
     .length === 0);
ok('a date outside the run resolves to nothing',
   W.linesForWork(done, { date: '2001-01-01', role: 'Car Park Steward', scheduled: '06:00–15:00' })
     .length === 0);

/* ========================================================================== */
section('21. Sold against worked');

const lv = W.lineVariance(done);
ok('one row per deployed line', lv.length === done.lines.filter((l) => l.patternId).length);

const earlies = lv.filter((r) => /Early/.test(r.window));
const night = lv.find((r) => /Nights/.test(r.window));

/* The early window was sold on two lines - 6 shifts and 3 shifts - and worked
   by two people a day. Attributing those 54 hours whole to each line would
   invent 54 against 54 sold on one and 54 against 27 on the other; apportioned
   by what each SOLD, they land 36 and 18, and both read as the underrun the
   job actually had. */
ok('two lines sold the same window', earlies.length === 2);
ok('  · 81 hours sold between them',
   earlies.reduce((s, r) => s + r.soldHours, 0) === 81);
ok('  · and the 54 worked are apportioned, not counted twice',
   Math.abs(earlies.reduce((s, r) => s + r.workedHours, 0) - 54) < 0.05,
   String(earlies.reduce((s, r) => s + r.workedHours, 0)));
ok('  · pro rata by what each line sold — 36 and 18, not 54 and 54',
   earlies.some((r) => Math.abs(r.workedHours - 36) < 0.05) &&
   earlies.some((r) => Math.abs(r.workedHours - 18) < 0.05),
   earlies.map((r) => r.workedHours).join(' / '));
ok('  · so both read as the underrun they were', earlies.every((r) => r.hoursDelta < 0));
ok('the night gate ran over', night.hoursDelta === 6,
   `sold ${night.soldHours}, worked ${night.workedHours}`);
ok('  · 4 shifts, 1.5h over each', night.soldHours === 36 && night.workedHours === 42);
ok('worked cost is real money, not a repeat of the sold value',
   night.workedCost > 0 && night.workedCost !== night.soldValue);

const dv = W.deploymentVariance(done);
ok('rolled up to the place', dv.length === 1 && dv[0].place === 'Ground Yard');
ok('  · the rollup is the sum of its lines',
   dv[0].hoursDelta === lv.reduce((s, r) => s + r.hoursDelta, 0));
ok('  · and the hours agree with the timesheets',
   Math.abs(dv[0].workedHours - sheets.reduce((s, t) => s + t.hours, 0)) < 0.05,
   `${dv[0].workedHours} vs ${sheets.reduce((s, t) => s + t.hours, 0)}`);

/* A quote with no deployments must not invent a variance report. */
ok('a legacy job reports no line variance', W.lineVariance(legacy).length === 0);
ok('  · and Reading, which is quoted but never worked, reports nothing worked',
   W.lineVariance(reading).every((r) => r.workedHours === 0));

/* ========================================================================== */
section('22. Overtime becomes a variation, not a retype');

const claims = W.overtimeClaims(done);
ok('only the overrun is claimed, not the shift that came in on time',
   claims.length === 1 && /Nights/.test(claims[0].window));
ok('  · for the hours actually over', claims[0].extraHours === 6);
ok('  · priced at the rate already agreed on that line',
   claims[0].value === Math.round(6 * W.lineRate(claims[0].line) * 100) / 100,
   String(claims[0].value));
ok('  · carrying named evidence, so it can be justified',
   claims[0].workers.length >= 2 && claims[0].workers.every((x) => x.name && x.hours > 0));
ok('an underrun is never claimed - a cheap job is not a bill',
   !claims.some((c) => c.extraHours <= 0) &&
   !claims.some((c) => /Early/.test(c.window)),
   `${lv.filter((r) => r.hoursDelta < 0).length} underruns exist and none was claimed`);
ok('the threshold keeps trivia out', W.overtimeClaims(done, 100).length === 0);

const varsBefore = W.variationValue(done);
const linesBefore = done.lines.length;
const raised = W.raiseOvertimeVariation(done, claims[0]);

ok('raising it puts a real line on the job', !!raised && done.lines.length === linesBefore + 1);
ok('  · as a VARIATION, because the client already signed', raised.source === 'variation');
ok('  · worth the claim', Math.abs(W.lineValue(raised) - claims[0].value) < 0.05,
   `${W.lineValue(raised)} vs ${claims[0].value}`);
ok('  · so the contract value moved by exactly that',
   Math.abs(W.variationValue(done) - (varsBefore + claims[0].value)) < 0.05);
ok('  · billed as hours, not rounded up to a shift', raised.units === 6 && raised.qty === 1);
ok('  · naming the place in the description', /Ground Yard/.test(raised.description));
ok('  · and carrying the evidence in the note',
   /worked beyond/.test(raised.note) && /17:00-02:00/.test(raised.note));
ok('the variation is not itself a deployment - it has no pattern', !raised.patternId);
ok('  · so it cannot be double-counted in the next variance run',
   W.lineVariance(done).length === lv.length);
/* The claim PERSISTS after raising, and that is deliberate: the variation is a
   separate line, so the hours sold against the original are unchanged and the
   overrun is still true. What must never happen is the claim doubling, which is
   what would occur if the variation were itself counted as sold cover. */
ok('raising it does not change the overrun it was raised for',
   (() => {
     const after = W.overtimeClaims(done);
     return after.length === 1 && after[0].extraHours === 6;
   })());

/* ========================================================================== */
section('23. Kit and services stand at a place too');

/* The builder used to ask one question - who stands here - and kit was bought
   somewhere else entirely, in a dialog that knew nothing about the car park.
   The picker now has three tabs, and this is what the other two must do:
   price per DAY (or once), carry the place, and never pretend to be a shift. */

const kitJob = W.create({
  title: 'KIT TESTER',
  start: job.start,
  end: job.end,
});
const blue = W.addPlace(kitJob, 'Blue Car Park');
const kEarly = kitJob.shiftPatterns.find((s) => s.id === 'sp-early');
const dayRate = (id) => DB.rateAt(id, DB.NOW).charge;

const withKit = W.addDeployment(kitJob, {
  area: 'Blue',
  placeId: blue.id,
  columns: [{ shiftPatternId: kEarly.id, days: [2, 3] }],
  cells: [{ shiftPatternId: kEarly.id, chargeId: 'ch-st-carpark', perDay: [4, 4] }],
  items: [
    { chargeId: 'ch-kit-radio', qty: 6 },
    { chargeId: 'ch-sv-tmplan', qty: 1 },
    { chargeId: 'ch-sv-pm', qty: 1 },
  ],
});
ok('one deployment carries the people and the things', withKit && withKit.length === 4,
   String(withKit?.length));

const radios = withKit.find((l) => l.chargeId === 'ch-kit-radio');
ok('the radios are not a shift - no pattern, no perDay', !radios.patternId && !radios.perDay);
ok('  · they are at the car park all the same', !!radios.placement &&
   radios.placement.placeId === blue.id && radios.placement.area === 'Blue');
ok('  · on hire for the days that place is worked', !!radios.hire &&
   radios.hire.from === 2 && radios.hire.to === 3, JSON.stringify(radios.hire));
ok('  · billed six items x two days, not by the hour',
   radios.qty === 6 && radios.units === 2,
   `${radios.qty} x ${radios.units}`);
ok('  · which is what the money layer already computes',
   near(W.lineValue(radios), 6 * 2 * dayRate('ch-kit-radio'), 0.05),
   String(W.lineValue(radios)));

const plan = withKit.find((l) => l.chargeId === 'ch-sv-tmplan');
ok('an `each` service bills ONCE, however long the job runs', plan.units === 1,
   String(plan.units));
ok('  · and takes no hire window - it is not out of the yard', !plan.hire);
const pm = withKit.find((l) => l.chargeId === 'ch-sv-pm');
ok('a per-day service takes the same day count as the kit', pm.units === 2, String(pm.units));
ok('  · without a hire window either', !pm.hire);

ok('the history counts shifts, not barriers',
   /8 shifts/.test((kitJob.history.find((e) => /Deployment added/.test(e.note)) || {}).note || ''),
   (kitJob.history.find((e) => /Deployment added/.test(e.note)) || {}).note);

ok('the deployment is worth its people plus its things',
   near(W.deployments(kitJob).find((g) => g.placeId === blue.id).value,
        withKit.reduce((t, l) => t + W.lineValue(l), 0), 0.05));

/* ------------------------------------------------- each item, its own days ---
   The radios go out with the build crew and the signage comes off at
   breakdown. One window per deployment could not say that, and the warehouse
   was never told. */
const phased = W.create({ title: 'PHASED KIT', start: job.start, end: job.end });
phased.liveFrom = 2;
phased.liveTo = 4;
const pit = W.addPlace(phased, 'Pit');
const pEarly = phased.shiftPatterns.find((s) => s.id === 'sp-early');
const build = W.phaseWindow(phased, 'build');
const brk = W.phaseWindow(phased, 'break');
ok('the job has a build and a breakdown to aim at',
   build.from === 1 && build.to === 1 && brk.from === 5,
   `${JSON.stringify(build)} ${JSON.stringify(brk)}`);
ok('a phase the job does not have is not invented',
   W.phaseWindow(W.create({ title: 'ONE DAYER', start: job.start, end: job.start }), 'build') === null);

const mixed = W.addDeployment(phased, {
  area: 'Arena',
  placeId: pit.id,
  columns: [{ shiftPatternId: pEarly.id, days: [2, 3, 4] }],
  cells: [{ shiftPatternId: pEarly.id, chargeId: 'ch-st-event', perDay: [6, 6, 6] }],
  items: [
    { chargeId: 'ch-kit-radio', qty: 10, hire: build },
    { chargeId: 'ch-kit-signage', qty: 4, hire: brk },
    { chargeId: 'ch-kit-barrier', qty: 30 },
  ],
});
const byId = (id) => mixed.find((l) => l.chargeId === id);
ok('each item keeps its own window',
   byId('ch-kit-radio').hire.to === build.to && byId('ch-kit-signage').hire.from === brk.from,
   `${JSON.stringify(byId('ch-kit-radio').hire)} ${JSON.stringify(byId('ch-kit-signage').hire)}`);
ok('  · and is billed for its own days, not the deployment\u2019s',
   byId('ch-kit-radio').units === 1 && byId('ch-kit-signage').units === 1,
   `${byId('ch-kit-radio').units} / ${byId('ch-kit-signage').units}`);
ok('  · while an item that says nothing follows the shifts',
   byId('ch-kit-barrier').hire.from === 2 && byId('ch-kit-barrier').units === 3,
   `${JSON.stringify(byId('ch-kit-barrier').hire)} / ${byId('ch-kit-barrier').units}`);

const whole = W.addDeployment(phased, {
  area: 'Arena',
  placeId: pit.id,
  columns: [{ shiftPatternId: pEarly.id, days: [3] }],
  cells: [],
  items: [{ chargeId: 'ch-kit-cone', qty: 50, hire: { from: 1, to: W.eventDays(phased) } }],
});
ok('an explicit "whole job" beats the deployment\u2019s one day',
   whole.length === 1 && !whole[0].hire && whole[0].units === W.eventDays(phased),
   `${JSON.stringify(whole[0].hire)} / ${whole[0].units}`);

/* ---------------------------------------------------------------------- */
const kitOnly = W.create({ title: 'KIT ONLY', start: job.start, end: job.end });
const yard = W.addPlace(kitOnly, 'Ground Yard');
const alone = W.addDeployment(kitOnly, {
  area: 'Perimeter',
  placeId: yard.id,
  columns: [],
  cells: [],
  items: [{ chargeId: 'ch-kit-heras', qty: 40 }],
});
ok('kit with nobody rostered to it is a real deployment', alone && alone.length === 1);
ok('  · out for the whole span, which is what no hire window means',
   !alone[0].hire && alone[0].units === W.eventDays(kitOnly),
   `${alone[0].units} vs ${W.eventDays(kitOnly)}`);
ok('  · and it opens a group of its own on the grid',
   W.deployments(kitOnly).length === 1 && W.deployments(kitOnly)[0].items.length === 1);

ok('a role in the kit list is refused, by name',
   /Car Park Steward/.test(W.deploymentBlock(kitOnly, {
     area: 'Perimeter', placeId: yard.id, columns: [], cells: [],
     items: [{ chargeId: 'ch-st-carpark', qty: 4 }],
   }) || ''),
   String(W.deploymentBlock(kitOnly, {
     area: 'Perimeter', placeId: yard.id, columns: [], cells: [],
     items: [{ chargeId: 'ch-st-carpark', qty: 4 }],
   })));
ok('an empty picker is still refused',
   !!W.deploymentBlock(kitOnly, { area: 'x', placeId: null, columns: [], cells: [], items: [] }));
ok('  · and so is a quantity of nought',
   !!W.deploymentBlock(kitOnly, {
     area: 'x', placeId: null, columns: [], cells: [],
     items: [{ chargeId: 'ch-kit-heras', qty: 0 }],
   }));

/* ========================================================================== */
section('24. The kit goes where the deployment goes');

const grid = W.deployments(kitJob).find((g) => g.placeId === blue.id);
ok('the view still keeps the kit with the place it was ordered for',
   grid.lines.length === 1 && grid.items.length === 3,
   `${grid.lines.length} lines, ${grid.items.length} items`);
ok('  · the place total is people AND things',
   near(grid.value,
        grid.lines.reduce((t, l) => t + W.lineValue(l), 0) +
        grid.items.reduce((t, l) => t + W.lineValue(l), 0), 0.05),
   String(grid.value));
/* The grid DRAWS the staff half, so the subtotal it prints is the staff half.
   A block whose rows add up to one number and whose footer says another is
   worse than a block with no footer at all. */
ok('  · but it is split, because the grid only draws one half of it',
   near(grid.staffValue, grid.lines.reduce((t, l) => t + W.lineValue(l), 0), 0.05) &&
   near(grid.itemValue, grid.items.reduce((t, l) => t + W.lineValue(l), 0), 0.05) &&
   near(grid.staffValue + grid.itemValue, grid.value, 0.05),
   `${grid.staffValue} staff + ${grid.itemValue} kit = ${grid.value}`);
ok('  · and the kit half is not nothing, so the split is worth making',
   grid.itemValue > 0, String(grid.itemValue));
ok('  · but the shift count is people only - a radio works no shift',
   grid.shifts === 8, String(grid.shifts));
ok('  · and the groups still add up to the quote',
   near(W.deployments(kitJob).reduce((t, g) => t + g.value, 0), W.quoteValue(kitJob), 0.05));

const green = W.addPlace(kitJob, 'Green Car Park');
const kitValueBefore = W.quoteValue(kitJob);
const copied = W.copyDeploymentToPlaces(kitJob, grid.key, [green.id]);
ok('copying a place takes its kit with it', copied.length === 4, String(copied.length));
ok('  · so the second car park is worth the same as the first',
   near(W.quoteValue(kitJob), kitValueBefore * 2, 0.05),
   `${kitValueBefore} -> ${W.quoteValue(kitJob)}`);
const copiedRadio = copied.find((l) => l.chargeId === 'ch-kit-radio');
ok('  · with the quantity and the hire window intact',
   copiedRadio.qty === 6 && copiedRadio.hire.from === 2 && copiedRadio.hire.to === 3);
ok('  · and pointing at the NEW place', copiedRadio.placement.placeId === green.id);

const kitLinesBefore = kitJob.lines.length;
const gone = W.removeDeployment(kitJob, grid.key);
ok('removing a place takes its kit too, not just its people', gone === 4, String(gone));
ok('  · leaving nothing behind on a car park that is no longer there',
   kitJob.lines.length === kitLinesBefore - 4 &&
   !kitJob.lines.some((l) => l.placement && l.placement.placeId === blue.id));

/* Every line is on exactly ONE of the two tables the quote screen draws: the
   deployment grid, or the list under it. In neither and it is charged for but
   invisible; in both and the operator reads it twice and thinks the job is
   dearer than it is.

   The grid draws STAFF and only staff. Kit is bought across the whole event,
   so a radio ordered for the Blue car park is listed once below with the car
   park as a caption, not four times inside four blocks. */
ok('the grid and the list under it partition the job between them',
   (() => {
     const drawn = new Set(W.deployments(kitJob).flatMap((g) => g.lines).map((l) => l.id));
     return kitJob.lines.every((l) => drawn.has(l.id) !== W.isFlatLine(l));
   })());
ok('  · placed kit is in the list, not on the grid',
   W.isFlatLine(radios) && W.isFlatLine({ id: 'x', chargeId: 'ch-kit-cone', qty: 1 }));
ok('  · and it says which place asked for it',
   W.placementLabel(kitJob, radios) === `${radios.placement.area} · ${blue.name}`,
   String(W.placementLabel(kitJob, radios)));
ok('  · a staff line carries no such caption - the grid already said where',
   W.placementLabel(kitJob, kitJob.lines.find((l) => l.patternId)) === null);
ok('  · nor does kit nobody placed',
   W.placementLabel(kitJob, { id: 'y', chargeId: 'ch-kit-cone', qty: 1 }) === null);
ok('  · a placement onto no place reads as across the site, never as blank',
   (() => {
     const anywhere = W.create({ title: 'ANYWHERE', start: job.start, end: job.end });
     W.addDeployment(anywhere, {
       area: 'Roads', placeId: null, columns: [], cells: [],
       items: [{ chargeId: 'ch-kit-cone', qty: 20 }],
     });
     const l = anywhere.lines.find((x) => x.chargeId === 'ch-kit-cone');
     return W.placementLabel(anywhere, l) === 'Roads · across the site';
   })());

/* ---------------------------------------------------------------------- */
ok('a line cannot be in two places at once',
   !W.normaliseLine({ ...radios, patternId: 'pat-x', perDay: [1] }).placement);
ok('a placement pointing at a deleted place degrades, it does not vanish',
   (() => {
     const orphan = W.create({ title: 'ORPHAN', start: job.start, end: job.end });
     const pl = W.addPlace(orphan, 'Gone Soon');
     W.addDeployment(orphan, {
       area: 'x', placeId: pl.id, columns: [], cells: [],
       items: [{ chargeId: 'ch-kit-cone', qty: 20 }],
     });
     orphan.places = [];
     W.normaliseWof(orphan);
     const l = orphan.lines.find((x) => x.chargeId === 'ch-kit-cone');
     return !!l && !!l.placement && l.placement.placeId === null && l.qty === 20;
   })());

/* ---------------------------------------------------------------------- */
W.sendQuote(kitOnly);
const kitVer = (kitOnly.quoteVersions || []).filter((x) => x.kind === 'quote').pop();
const kitLine = kitVer.lines.find((l) => l.description === 'Heras fence panel + feet');
ok('the frozen version stamps the place on placed kit',
   kitLine.area === 'Perimeter' && kitLine.place === 'Ground Yard');
ok('  · and no window, because kit has none', !kitLine.window);
const kitDoc = DOC.quoteDocumentHtml(kitOnly, kitVer, {});
ok('the client document groups it under the place', /Ground Yard/.test(kitDoc));
ok('  · and sells it by the day, not as shifts of nine hours',
   /40<\/td>/.test(kitDoc) && /5 days/.test(kitDoc) &&
   !/40 shifts/.test(kitDoc) && !/hours each/.test(kitDoc),
   (kitDoc.match(/<td class="r tnum">[^<]*<\/td>/g) || []).slice(0, 4).join(' '));


section('25. The client sees the same breakdown, minus EP Team’s business');
/* The operator's grid answers "is this quote right"; the client's answers "is
   this plan right". Same shape, same numbers, no editing and nothing behind the
   charge. Rendered from the real page component against the real fixture. */

writeFileSync(
  rp('entry-client.tsx'),
  `import { createElement } from 'react';\n` +
    `import { renderToStaticMarkup } from 'react-dom/server';\n` +
    `import { ClientDeploymentTable } from '${p('src/pages/ClientJobDetail')}';\n` +
    `export { createElement, renderToStaticMarkup, ClientDeploymentTable };\n`,
);

let C = null;
try {
  execFileSync(
    'npx',
    ['--yes', 'esbuild', rp('entry-client.tsx'), '--bundle', '--format=esm',
      `--outfile=${rp('client.mjs')}`,
      `--alias:@=${join(ROOT, 'src')}`,
      `--alias:@/components/Modal=${rp('stub-modal.tsx')}`,
      `--alias:@/components/Toast=${rp('stub-toast.tsx')}`,
      '--jsx=automatic', '--log-level=error'],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, NODE_PATH: join(ROOT, 'node_modules') } },
  );
  C = await import(pathToFileURL(rp('client.mjs')).href);
} catch {
  C = null;
}

if (!C) {
  ok('the client grid renders (skipped — could not bundle)', true);
} else {
  const cGroups = W.deployments(reading, 'quote');
  const cHtml = C.renderToStaticMarkup(
    C.createElement(C.ClientDeploymentTable, { w: reading, groups: cGroups }),
  );
  ok('the client grid renders', cHtml.length > 2000, String(cHtml.length));
  // React escapes as it renders, and a real place is called King's Meadow.
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  const banded = (g) => cHtml.includes(esc(g.area)) && cHtml.includes(esc(g.placeName));
  ok('  · banded by area, then by place and window',
     cGroups.every(banded),
     cGroups.filter((g) => !banded(g)).map((g) => `${g.area}/${g.placeName}`).join(', '));
  ok('  · one dated column for every day of the job',
     (cHtml.match(/ day"/g) || []).length === W.eventDays(reading),
     `${(cHtml.match(/ day"/g) || []).length} of ${W.eventDays(reading)}`);
  // The headcounts are the sold ones, day by day - not a total divided out.
  const probe = cGroups[0].columns[0].lines[0];
  const probePat = W.linePattern(reading, probe);
  const cells = Array.from({ length: W.eventDays(reading) }, (_, i) => i + 1).map((d) => {
    const on = probePat.days.includes(d) ? W.headcountOn(reading, probe, d) : 0;
    return on ? `${on} on ` : 'None on ';
  });
  ok('  · every cell is the headcount that day was sold',
     cells.every((c) => cHtml.includes(`title="${c}`)),
     `${probe.description}: ${cells.join('|')}`);
  ok('  · a day nobody works reads as a dot, not a zero',
     cHtml.includes('>·<') && !/>0</.test(cHtml));
  ok('  · shifts, hours and value totalled per place',
     cGroups.every((g) => cHtml.includes(`>${g.shifts}<`) && cHtml.includes(`>${g.hours}<`)));
  ok('  · charge rates yes, cost and margin never',
     /Rate/.test(cHtml) && !/margin/i.test(cHtml) && !/cost/i.test(cHtml) && !/pay rate/i.test(cHtml));
  ok('  · and nothing on it is editable',
     !/<input/.test(cHtml) && !/aria-pressed/.test(cHtml) && !/Remove/.test(cHtml));
  const anyItems = cGroups.some((g) => g.items.length);
  ok('  · equipment reads as dates on site, never as shifts',
     !anyItems || (/on site/.test(cHtml) && !/on site throughout · /.test(cHtml)));
  ok('  · the day spread is stated as the plan, not as a promise per day',
     /does not change what you pay/.test(cHtml) && /not raised as a variation/.test(cHtml));
}

/* ========================================================================== */
section('26. The number of pieces is editable where it is read');

/* The grid has had an editable headcount cell since the day it shipped. The
   kit standing next to those people did not: forty barriers became thirty-eight
   by deleting the line and adding it again, which throws away the hire window,
   the sub-hire flag and the place along with it - three facts nobody asked to
   change, lost to changing a fourth. */

const placedAgain = W.addDeployment(kitJob, {
  area: 'Blue',
  placeId: blue.id,
  columns: [],
  cells: [],
  items: [
    { chargeId: 'ch-kit-cone', qty: 100, hire: { from: 2, to: 3 } },
    { chargeId: 'ch-sv-pm', qty: 1 },
  ],
});
const coneLine = placedAgain.find((l) => l.chargeId === 'ch-kit-cone');
const pmLine = placedAgain.find((l) => l.chargeId === 'ch-sv-pm');
const coneUnits = coneLine.units;

ok('a kit line takes a new quantity in place',
   W.setQty(kitJob, coneLine.id, 120) && coneLine.qty === 120, String(coneLine.qty));
ok('  · and the money follows it',
   near(W.lineValue(coneLine), 120 * coneUnits * W.lineRate(coneLine), 0.05),
   String(W.lineValue(coneLine)));
ok('  · while the days, the place and the window are left alone',
   coneLine.units === coneUnits &&
   coneLine.placement.placeId === blue.id &&
   coneLine.hire.from === 2 && coneLine.hire.to === 3);
ok('  · it can go down as well as up',
   W.setQty(kitJob, coneLine.id, 40) && coneLine.qty === 40);

// Cones break at 200. The point of putting money in the note.
ok('a volume break applies itself on the way past',
   W.setQty(kitJob, coneLine.id, 250) && W.lineRate(coneLine) === 0.65,
   String(W.lineRate(coneLine)));
ok('  · and the history says so in money, not just in count',
   /tier/.test(kitJob.history.at(-1).note) && /250/.test(kitJob.history.at(-1).note),
   kitJob.history.at(-1).note);

ok('a services line is editable too - it is a quantity like any other',
   W.setQty(kitJob, pmLine.id, 2) && pmLine.qty === 2);

ok('a STAFF line is refused - its qty is the shift count, and the cell is the way in',
   !W.setQty(next, cell.id, 5) && cell.qty === W.lineShifts(next, cell));
ok('nought is refused - a line quoted at nothing is a removal, and says so',
   !W.setQty(kitJob, coneLine.id, 0) && coneLine.qty === 250);
ok('a fraction is rounded, not stored',
   W.setQty(kitJob, coneLine.id, 12.6) && coneLine.qty === 13);

ok('setting the same number again is a no-op, not even a note',
   (() => {
     const before = W.pendingChanges(kitJob).length;
     W.setQty(kitJob, coneLine.id, 13);
     return W.pendingChanges(kitJob).length === before;
   })());
ok('  · but a real change is noted for the next document',
   (() => {
     const before = W.pendingChanges(kitJob).length;
     W.setQty(kitJob, coneLine.id, 60);
     return W.pendingChanges(kitJob).length === before + 1;
   })());
ok('  · and writes nothing the client can open',
   (() => {
     const before = (kitJob.quoteVersions || []).length;
     W.setQty(kitJob, coneLine.id, 61);
     return (kitJob.quoteVersions || []).length === before;
   })());
ok('  · an edit on a signed job is noted against the VARIATION, not the quote',
   (() => {
     const signed = W.create({ title: 'SIGNED KIT', start: job.start, end: job.end });
     signed.signoff = { signedBy: 'x', signedByRole: 'x', signedAt: signed.start,
                        method: 'x', ref: 'x', ip: '-' };
     signed.stage = 'order';
     const v = W.addLine(signed, 'ch-kit-cone', { qty: 10 });
     const before = W.pendingChanges(signed, 'variation').length;
     return v.source === 'variation' &&
            W.setQty(signed, v.id, 20) &&
            W.pendingChanges(signed, 'variation').length === before + 1 &&
            W.pendingChanges(signed, 'quote').length === 0;
   })());

ok('a line that is not there is refused, not created',
   !W.setQty(kitJob, 'no-such-line', 5));


/* ========================================================================== */
section('27. Kit is listed once, across the whole event');
/* An operator looked at two radios banded under Cross Roads and said what is
   obviously true: the radios are for the event, not for that car park. The
   place is still the reason they were ordered, so it survives as a caption on
   the line. What it no longer does is BAND anything.

   Rendered against a real fixture with real deployments, because the failure
   this guards against is visual: the same kit repeated inside four car parks,
   or a place subtotal that does not add up to the rows above it. */

const sep = W.create({
  title: 'SEPARATION', clientId: 'c-19',
  start: reading.start, end: reading.end,
});
const sepPlace = W.addPlace(sep, 'Cross Roads');
const sepOther = W.addPlace(sep, 'Gravel Track');
W.ensureShiftPatterns(sep);
const sepWin = sep.shiftPatterns[0].id;
W.addDeployment(sep, {
  area: 'White', placeId: sepPlace.id,
  columns: [{ shiftPatternId: sepWin, days: [3, 4, 5] }],
  cells: [{ shiftPatternId: sepWin, chargeId: 'ch-st-carpark', perDay: [2, 2, 2] }],
  items: [{ chargeId: 'ch-kit-radio', qty: 6 }, { chargeId: 'ch-kit-charger', qty: 1 }],
});
// A place with kit and NOBODY on it. It used to open a block of its own in the
// grid; with the kit gone there is nothing left in that block to draw.
W.addDeployment(sep, {
  area: 'White', placeId: sepOther.id, columns: [], cells: [],
  items: [{ chargeId: 'ch-kit-cone', qty: 40 }],
});

const sepGroups = W.deployments(sep);
ok('a place with kit and no people is still a group in the data',
   sepGroups.length === 2 && sepGroups.some((g) => !g.columns.length && g.items.length),
   String(sepGroups.length));
ok('  · but the grid draws only the one with people in it',
   sepGroups.filter((g) => g.columns.length).length === 1);
ok('  · and every kit line is in the flat list, whichever place asked for it',
   sep.lines.filter((l) => l.kind !== 'staff').length === 3 &&
   sep.lines.filter((l) => l.kind !== 'staff').every(W.isFlatLine));


/* --- The screens. Both tables of the operator's quote tab, and the client's
       "what you are paying for", bundled and rendered for real. ---------- */
writeFileSync(
  rp('entry-sep.tsx'),
  `import { createElement } from 'react';\n` +
    `import { renderToStaticMarkup } from 'react-dom/server';\n` +
    `import { DeploymentTable, LineTable } from '${p('src/pages/WofDetail')}';\n` +
    `import { QuoteBreakdown } from '${p('src/pages/ClientJobDetail')}';\n` +
    // `DataTable` links its rows, so anything containing one needs a router.
    `import { MemoryRouter } from 'react-router-dom';\n` +
    `export { createElement, renderToStaticMarkup, MemoryRouter };\n` +
    `import { ClientDeploymentTable } from '${p('src/pages/ClientJobDetail')}';\n` +
    `export { DeploymentTable, LineTable, QuoteBreakdown, ClientDeploymentTable };\n`,
);

let S = null;
try {
  execFileSync(
    'npx',
    ['--yes', 'esbuild', rp('entry-sep.tsx'), '--bundle', '--format=esm',
      `--outfile=${rp('sep.mjs')}`,
      `--alias:@=${join(ROOT, 'src')}`,
      `--alias:@/components/Modal=${rp('stub-modal.tsx')}`,
      `--alias:@/components/Toast=${rp('stub-toast.tsx')}`,
      '--jsx=automatic', '--log-level=error'],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, NODE_PATH: join(ROOT, 'node_modules') } },
  );
  S = await import(pathToFileURL(rp('sep.mjs')).href);
} catch {
  S = null;
}

if (!S) {
  ok('the quote screens render (skipped — could not bundle)', true);
} else {
  const draw = (el) => S.renderToStaticMarkup(S.createElement(S.MemoryRouter, null, el));
  const gridHtml = draw(
    S.createElement(S.DeploymentTable, { w: sep, source: 'quote', onDialog: () => {} }),
  );
  const flat = W.quoteLines(sep).filter(W.isFlatLine);
  const listHtml = draw(
    S.createElement(S.LineTable, {
      w: sep, lines: flat, locked: false, caption: 'Across the whole event',
      emptyMsg: '', onDialog: () => {},
    }),
  );
  ok('the operator grid renders', gridHtml.length > 800, String(gridHtml.length));
  ok('  · with no kit in it at all',
     !/Motorola/i.test(gridHtml) && !/charge bank/i.test(gridHtml) && !/cone/i.test(gridHtml));
  ok('  · so the place with only kit on it is not a band with nothing under it',
     !gridHtml.includes('Gravel Track'));
  const staffed = sepGroups.find((g) => g.columns.length);
  // The two figures differ by the kit, so the subtotal is unambiguous proof of
  // which one was drawn.
  const gbp = (n) => `£${Math.round(n).toLocaleString('en-GB')}`;
  ok('  · and the place subtotal is the staff above it, not staff plus kit',
     staffed.staffValue !== staffed.value &&
     gridHtml.includes(gbp(staffed.staffValue)) && !gridHtml.includes(gbp(staffed.value)),
     `${gbp(staffed.staffValue)} drawn, ${gbp(staffed.value)} would be the old figure`);
  ok('  · the footer counts shifts, and no longer counts kit lines',
     /shift/.test(gridHtml) && !/kit or service line/.test(gridHtml));

  ok('the list under it renders', listHtml.length > 500, String(listHtml.length));
  ok('  · headed as the event-wide half of the quote',
     /Across the whole event/.test(listHtml));
  /* Named ONCE. Four car parks ordering six radios each used to read as four
     separate lines of radios inside four separate blocks; the whole point of
     the move is that the event's kit is one list. Counted on the description
     cell rather than on the word, because the remove button repeats the name
     in its label. */
  const named = (t) => (listHtml.match(new RegExp(`>${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<`, 'g')) || []).length;
  ok('  · with every kit line on it, each named once',
     named('Two-way radio (Motorola DP2400)') === 1 &&
     named('Radio 6-way charge bank') === 1 &&
     named('Traffic cone (750mm)') === 1,
     `radio x${named('Two-way radio (Motorola DP2400)')}, ` +
     `bank x${named('Radio 6-way charge bank')}, cone x${named('Traffic cone (750mm)')}`);
  ok('  · captioned with the place that asked for it',
     listHtml.includes(`for White · ${sepPlace.name}`) &&
     listHtml.includes(`for White · ${sepOther.name}`),
     listHtml.includes('for White') ? 'one caption only' : 'no caption');
  ok('  · and the two tables add up to the quote',
     near(sepGroups.reduce((t, g) => t + g.staffValue, 0) +
          flat.reduce((t, l) => t + W.lineValue(l), 0),
          W.quoteValue(sep), 0.05));
  /* The client sees the same separation, in their own words. */
  const cli = draw(S.createElement(S.QuoteBreakdown, { w: sep }));
  ok('the client breakdown renders', cli.length > 1500, String(cli.length));
  ok('  · with the equipment out of the day grid',
     !/·<\/td>[\s\S]{0,400}Motorola/.test(cli) && /Across the whole event/.test(cli));
  ok('  · saying where each item is wanted, in their words not ours',
     cli.includes(`for White · ${sepPlace.name}`) && !/placement/i.test(cli));
  ok('  · and the dates it is on site, which the place used to say for it',
     /on site/.test(cli));
  ok('  · still no cost and nothing editable',
     !/cost/i.test(cli) && !/<input/.test(cli));

  /* A job whose only deployment is kit has no grid left to draw. It must fall
     all the way through to the plain table, not render a heading over nothing
     or an "Across the whole event" caption with no whole-event grid above it
     to be across. */
  const kitAlone = W.create({ title: 'KIT ALONE', clientId: 'c-19', start: reading.start, end: reading.end });
  const kaPlace = W.addPlace(kitAlone, 'Ground Yard');
  W.addDeployment(kitAlone, {
    area: 'Perimeter', placeId: kaPlace.id, columns: [], cells: [],
    items: [{ chargeId: 'ch-kit-cone', qty: 40 }],
  });
  const kaHtml = draw(S.createElement(S.QuoteBreakdown, { w: kitAlone }));
  ok('a quote whose only deployment is kit falls through to the plain table',
     /Traffic cone/.test(kaHtml) && !/Across the whole event/.test(kaHtml) &&
     !/Shaded columns are event days/.test(kaHtml),
     kaHtml.slice(0, 120));
  ok('  · and still says which place asked for it',
     kaHtml.includes(`for Perimeter · ${kaPlace.name}`));
  // The grid guards itself as well as being guarded. Handed nothing but kit it
  // draws nothing at all, rather than a header row over an empty body.
  ok('  · the grid handed only kit draws nothing, not an empty header',
     draw(S.createElement(S.ClientDeploymentTable, {
       w: kitAlone, groups: W.deployments(kitAlone, 'quote'),
     })).replace(/<[^>]*>/g, '').trim() === '');
}

/* --- The printed document. The one that gets signed. ------------------- */
W.approveQuote(sep, '', { by: 'm-dawn', name: 'Dawn Cartwright' });
ok('the quote can be sent', W.sendQuote(sep), W.quoteSendBlock(sep) || '');
const sepVer = (sep.quoteVersions || []).filter((x) => x.kind === 'quote').pop();
ok('the version freezes what each line SOLD, not just where it stood',
   sepVer.lines.every((l) => !!l.kind) &&
   sepVer.lines.some((l) => l.kind === 'staff') &&
   sepVer.lines.some((l) => l.kind === 'kit'));
const sepDoc = DOC.quoteDocumentHtml(sep, sepVer, {});
ok('the document bands the equipment on its own, once',
   (sepDoc.match(/across the whole event/gi) || []).length === 1, 
   String((sepDoc.match(/across the whole event/gi) || []).length));
ok('  · after the places, not among them',
   sepDoc.indexOf('Cross Roads') < sepDoc.search(/across the whole event/i));
const subHeads = (sepDoc.match(/class="grp-sub"><td colspan="5">[^<]*/g) || [])
  .map((h) => h.replace(/^[^>]*>[^>]*>/, ''));
ok('  · with the place kept as a sub-heading inside it, not thrown away',
   subHeads.includes(`White · ${sepOther.name}`) && subHeads.includes(`White · ${sepPlace.name}`),
   subHeads.join(' | '));
ok('  · and no equipment left up in a place band',
   sepDoc.indexOf('Motorola') > sepDoc.search(/across the whole event/i));
/* Kit is bought by the day. Sold as "6 shifts of 9 hours each" it would be
   telling the client the radios work a shift - which is what keying the
   wording on the window rather than on the area is there to prevent. The staff
   above the band still read that way, so the check is on the band alone. */
// The band alone: from its heading to the end of the priced table. Past that
// the version log quotes "6 shifts" back at the reader, which is the staff.
const sepItems = sepDoc
  .slice(sepDoc.search(/across the whole event/i))
  .split('</tbody>')[0];
ok('  · sold by the day, never as shifts of so many hours each',
   !/shifts/.test(sepItems) && !/hours each/.test(sepItems) && /days/.test(sepItems),
   (sepItems.match(/<td class="r tnum">[^<]*/g) || []).slice(0, 6).join(' | '));


/* ---------------------------------------------------------------------- */
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
