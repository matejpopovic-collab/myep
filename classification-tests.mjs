/* ============================================================================
   EPROSTA — verification harness for event scale (lib/classification.ts)
   ----------------------------------------------------------------------------
   Ported from the Master Calendar's Classification Key. A job's scale is read
   off its PEAK single day, not summed across the run — a 17-day job running 10
   people a day is not "Major" for lasting a long time, and a stadium job with
   real headcount for one day is not outranked by a long, light one.

   Run:  node classification-tests.mjs
   ========================================================================== */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleForTest } from './tsbundle.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const work = mkdtempSync(join(tmpdir(), 'eprosta-classification-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');

async function boot() {
  const entry = join(work, 'entry.ts');
  const out = join(work, 'bundle.mjs');
  writeFileSync(
    entry,
    `export * as DB from '${p('src/data/db')}';\n` +
      `export * as W from '${p('src/lib/wof')}';\n` +
      `export * as EVT from '${p('src/lib/events')}';\n` +
      `export * as C from '${p('src/lib/classification')}';\n`,
  );
  const url = await bundleForTest({
    entryFile: entry,
    srcRoot: join(ROOT, 'src'),
    outDir: work,
    root: ROOT,
  });
  const mod = await import(url);
  mod.W.load();
  return mod;
}

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

const { DB, W, EVT, C } = await boot();

/** A job carrying one deployment of `perDay` headcount, ordered straight away. */
function staffJob(title, perDay, role = 'ch-st-carpark') {
  const w = W.create({
    title,
    jobCode: `TEST-CLS-${Math.random().toString(36).slice(2, 7)}`,
    start: '2026-09-01T06:00:00',
    end: `2026-09-0${perDay.length}T20:00:00`,
  });
  const farm = W.addPlace(w, 'Test Field');
  const early = w.shiftPatterns.find((s) => s.id === 'sp-early');
  W.addDeployment(w, {
    area: 'White',
    placeId: farm.id,
    columns: [{ shiftPatternId: early.id, days: perDay.map((_, i) => i + 1) }],
    cells: [{ shiftPatternId: early.id, chargeId: role, perDay }],
  });
  W.advance(w, { to: 'order', force: true });
  return { w, ev: DB.event(w.eventId) };
}

/* ========================================================================== */
section('1. Bands follow the sheet\'s own Classification Key, on staff alone');

ok('under 5 staff reads Minimal', C.scaleForCounts(4, 0) === 'minimal');
ok('5 staff tips to Light (inclusive low edge)', C.scaleForCounts(5, 0) === 'light');
ok('20 staff is still Light', C.scaleForCounts(20, 0) === 'light');
ok('21 staff tips to Medium', C.scaleForCounts(21, 0) === 'medium');
ok('40 staff is still Medium', C.scaleForCounts(40, 0) === 'medium');
ok('41 staff tips to Significant', C.scaleForCounts(41, 0) === 'significant');
ok('75 staff is still Significant', C.scaleForCounts(75, 0) === 'significant');
ok('76 staff tips to Major', C.scaleForCounts(76, 0) === 'major');

/* ========================================================================== */
section('2. Kit volume can carry a job past what its staff count alone would');

ok('0 kit changes nothing', C.scaleForCounts(3, 0) === 'minimal');
ok('half a vehicle-equivalent tips Minimal to Light', C.scaleForCounts(3, 0.5) === 'light');
ok('one vehicle-equivalent is Light', C.scaleForCounts(3, 1) === 'light');
ok('two vehicle-equivalents is Medium', C.scaleForCounts(3, 2) === 'medium');
ok('five (or one artic) is Significant', C.scaleForCounts(3, 5) === 'significant');
ok('ten — "multiple artics" — is Major', C.scaleForCounts(3, 10) === 'major');
ok('the HIGHER of staff and kit wins, not staff alone',
   C.scaleForCounts(76, 0) === 'major' && C.scaleForCounts(3, 10) === 'major');

/* ========================================================================== */
section('3. assessScale reads the PEAK day, not the sum across the job');

// Five days, 4 people most days, 13 on the Saturday — a one-day stadium-style
// spike inside an otherwise light week.
const { ev: spike } = staffJob('PEAK SPIKE', [4, 4, 13, 4, 4]);
const spikeAssess = C.assessScale(spike);
ok('peak staff is the spike day\'s figure, not the five-day total',
   spikeAssess.peakStaff === 13, String(spikeAssess.peakStaff));
ok('  · which reads as Light (5–20), matching the Tottenham-style example',
   spikeAssess.auto === 'light', spikeAssess.auto);
ok('  · and names the day the peak fell on', spikeAssess.staffPeakDay === 3,
   String(spikeAssess.staffPeakDay));

// A long, evenly-light job never spikes — summing would have made this Medium
// or worse at 5 days x 8 people = 40.
const { ev: steady } = staffJob('STEADY LIGHT', [8, 8, 8, 8, 8]);
ok('a long steady job is judged by one day, not the total it adds up to',
   C.assessScale(steady).auto === 'light', C.assessScale(steady).auto);

/* ========================================================================== */
section('4. Kit lines feed the same peak, through their own hire window');

const { w: kitJob, ev: kitEv } = staffJob('KIT HEAVY', [3, 3, 3]);
// A cabin (weight 1) and two welfare units (weight 1 each) on days 1-2 only —
// three vehicle-equivalents on those two days, none on day 3.
const cabinLine = W.addLine(kitJob, 'ch-kit-cabin', { qty: 1, units: 1 });
W.setHire(kitJob, cabinLine.id, { from: 1, to: 2 });
const welfareLine = W.addLine(kitJob, 'ch-kit-welfare', { qty: 2, units: 1 });
W.setHire(kitJob, welfareLine.id, { from: 1, to: 2 });

const kitAssess = C.assessScale(kitEv);
ok('kit volume peaks at 3 vehicle-equivalents on the days the kit is out',
   kitAssess.peakKitVolume === 3, String(kitAssess.peakKitVolume));
ok('  · on day 1 or 2, never day 3', kitAssess.kitPeakDay === 1 || kitAssess.kitPeakDay === 2,
   String(kitAssess.kitPeakDay));
ok('  · which lifts a 3-staff job (Minimal) to Medium on kit alone',
   kitAssess.auto === 'medium', kitAssess.auto);

/* ========================================================================== */
section('5. Small kit does not move the classification');

const { w: lightKit, ev: lightKitEv } = staffJob('SMALL KIT ONLY', [3, 3]);
W.addLine(lightKit, 'ch-kit-radio', { qty: 40, units: 2 });
W.addLine(lightKit, 'ch-kit-hivis', { qty: 40, units: 1 });
ok('forty radios and forty hi-vis are zero-weighted — still Minimal',
   C.assessScale(lightKitEv).auto === 'minimal', C.assessScale(lightKitEv).auto);
ok('  · reported kit volume is exactly zero', C.assessScale(lightKitEv).peakKitVolume === 0);

/* ========================================================================== */
section('6. An event with nothing entered reads as Minimal, not an error');

const bare = W.create({ title: 'BARE', jobCode: 'TEST-CLS-BARE' });
// No staff lines at all — seedEvent refuses to create an event for a job with
// nobody to roster (see wof.ts:2224), so there is no EpEvent to assess.
W.advance(bare, { to: 'order', force: true });
ok('a kit-only / staffless job never gets a staffing event',
   bare.eventId === null || bare.eventId === undefined, String(bare.eventId));

/* ========================================================================== */
section('7. Manual override wins outright, including the two bands it alone can set');

const { ev: overridable } = staffJob('OVERRIDE ME', [13]);
ok('before any override, the computed figure shows through',
   C.eventScale(overridable) === 'light', C.eventScale(overridable));

EVT.setScaleOverride(overridable.id, 'major');
ok('an override beats the computed figure', C.eventScale(overridable) === 'major');

EVT.setScaleOverride(overridable.id, 'day-to-day');
ok('Day-to-Day — a band assessScale can never produce — reaches the event only via override',
   C.eventScale(overridable) === 'day-to-day');
ok('  · and assessScale itself never returns it',
   C.AUTO_SCALES.every((s) => s !== 'day-to-day'));
ok('  · Day to Day is the only hand-set band — the key has six tiers, not seven',
   C.MANUAL_ONLY_SCALES.length === 1 && C.MANUAL_ONLY_SCALES[0] === 'day-to-day'
   && Object.keys(C.SCALE_LABEL).length === 6);
EVT.setScaleOverride(overridable.id, 'lorry-only');
ok('  · a retired band left in the store falls back to the computed figure',
   C.eventScale(overridable) === 'light', C.eventScale(overridable));
ok('  · and does not read as manually set',
   C.manualScale(overridable) === null);

EVT.setScaleOverride(overridable.id, null);
ok('clearing the override falls back to the computed figure',
   C.eventScale(overridable) === 'light', C.eventScale(overridable));

/* ========================================================================== */
section('8. The same reading off the quote, before any event exists');

/** The same job as `staffJob`, left at quote stage — no event, no shifts. */
function quoteJob(title, perDay, role = 'ch-st-carpark') {
  const w = W.create({
    title,
    jobCode: `TEST-CLS-${Math.random().toString(36).slice(2, 7)}`,
    start: '2026-09-01T06:00:00',
    end: `2026-09-0${perDay.length}T20:00:00`,
  });
  const farm = W.addPlace(w, 'Test Field');
  const early = w.shiftPatterns.find((s) => s.id === 'sp-early');
  W.addDeployment(w, {
    area: 'White',
    placeId: farm.id,
    columns: [{ shiftPatternId: early.id, days: perDay.map((_, i) => i + 1) }],
    cells: [{ shiftPatternId: early.id, chargeId: role, perDay }],
  });
  return w;
}

const unquoted = W.create({ title: 'NOTHING QUOTED YET', jobCode: 'TEST-CLS-EMPTY' });
ok('a WOF with no lines has no tier at all — not Minimal',
   C.assessWofScale(unquoted) === null && C.wofScale(unquoted) === null);

const quoted = quoteJob('QUOTED NOT ORDERED', [4, 4, 30, 4]);
const qa = C.assessWofScale(quoted);
ok('a quote with deployments classifies with no event in existence',
   quoted.eventId == null && qa !== null, String(quoted.eventId));
ok('  · off the peak day, same as the event-side reading', qa.peakStaff === 30,
   String(qa.peakStaff));
ok('  · naming the day it peaked on', qa.staffPeakDay === 3, String(qa.staffPeakDay));
ok('  · 30 on one day is Medium', qa.auto === 'medium', qa.auto);
ok('  · and wofScale reports it as read from the quote',
   C.wofScale(quoted).source === 'quote' && C.wofScale(quoted).scale === 'medium');

// Kit alone, no staff: no event can ever exist for this job, and the quote is
// the only place a tier can come from.
const kitOnly = W.create({
  title: 'KIT ONLY',
  jobCode: 'TEST-CLS-KITONLY',
  start: '2026-09-01T06:00:00',
  end: '2026-09-02T20:00:00',
});
W.addLine(kitOnly, 'ch-kit-cabin', { qty: 2, units: 1 });
const kitOnlyView = C.wofScale(kitOnly);
ok('a kit-only job is classified from the quote, the only record it will ever have',
   kitOnlyView && kitOnlyView.scale === 'medium', kitOnlyView && kitOnlyView.scale);
ok('  · on zero staff', C.assessWofScale(kitOnly).peakStaff === 0);

/* ========================================================================== */
/* 9. A tier set by hand BEFORE the job is ordered                            */

const preOrder = quoteJob('HAND-SET BEFORE ORDER', [1]);
ok('a small job computes to Tier 5 — no size reaches Tier 6 on its own',
   C.wofScale(preOrder).scale === 'minimal', C.wofScale(preOrder).scale);

ok('the tier can be set by hand while the job has no event',
   W.setScaleOverride(preOrder, 'day-to-day'));
ok('  · and the pipeline row shows it', C.wofScale(preOrder).scale === 'day-to-day');
ok('  · with no figures behind it', C.wofScale(preOrder).assessment === null);
ok('  · and it is journalled as a decision somebody made',
   preOrder.history.at(-1).note.includes('Day to Day'));

W.setScaleOverride(preOrder, null);
ok('clearing it falls back to the computed reading from the quote',
   C.wofScale(preOrder).scale === 'minimal' && C.wofManualScale(preOrder) === null);

// The whole point: a hand-set tier must survive the order, or the job is
// silently reclassified at the moment it becomes real work.
const carried = quoteJob('CARRIES THROUGH THE ORDER', [2]);
W.setScaleOverride(carried, 'day-to-day');
W.advance(carried, { to: 'order', force: true });
ok('a hand-set tier survives the order, moving onto the event',
   C.wofScale(carried).scale === 'day-to-day', C.wofScale(carried).scale);
ok('  · the event is now the record that holds it',
   C.manualScale(DB.event(carried.eventId)) === 'day-to-day');
ok('  · and the WOF-side override stops answering, so the two cannot disagree',
   C.wofManualScale(carried) === null);
ok('  · the WOF-side setter refuses once the event exists',
   W.setScaleOverride(carried, 'major') === false
   && C.wofScale(carried).scale === 'day-to-day');

// An unquoted job has no band at all — but may still be classified by hand,
// because a day-to-day activity may never be priced.
const unpriced = W.create({
  title: 'NEVER PRICED', clientId: DB.CLIENTS[0].id, jobTypeId: 'venue',
  start: '2026-09-01T06:00:00', end: '2026-09-01T20:00:00',
});
ok('an unquoted job has no tier', C.wofScale(unpriced) === null);
W.setScaleOverride(unpriced, 'day-to-day');
ok('  · until one is set by hand', C.wofScale(unpriced).scale === 'day-to-day');

ok('a retired band on a WOF is not treated as an override',
   (W.setScaleOverride(unpriced, 'lorry-only'), C.wofManualScale(unpriced) === null));
ok('  · and the job reads as unquoted again rather than showing an empty pill',
   C.wofScale(unpriced) === null);

/* ========================================================================== */

// Once ordered, the event is the truth — both sides must agree, or the
// pipeline row and the event screen would show different tiers for one job.
const ordered = quoteJob('ORDERED, BOTH SIDES', [4, 4, 30, 4]);
W.advance(ordered, { to: 'order', force: true });
const orderedView = C.wofScale(ordered);
ok('after ordering, the tier is read from the event',
   orderedView.source === 'event', orderedView.source);
ok('  · and matches what the event screen shows',
   orderedView.scale === C.eventScale(DB.event(ordered.eventId)), orderedView.scale);

EVT.setScaleOverride(ordered.eventId, 'day-to-day');
ok('a manual override on the event carries through to the pipeline row',
   C.wofScale(ordered).scale === 'day-to-day');
ok('  · with no figures behind it to show', C.wofScale(ordered).assessment === null);
EVT.setScaleOverride(ordered.eventId, null);

ok('scaleRank orders the five bands low to high',
   C.scaleRank('minimal') < C.scaleRank('light')
   && C.scaleRank('light') < C.scaleRank('medium')
   && C.scaleRank('medium') < C.scaleRank('significant')
   && C.scaleRank('significant') < C.scaleRank('major'));
ok('  · and sorts an unquoted job below every band, including the manual one',
   C.scaleRank(null) < C.scaleRank('day-to-day')
   && C.scaleRank('day-to-day') < C.scaleRank('minimal'));

/* ========================================================================== */
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
