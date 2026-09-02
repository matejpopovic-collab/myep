/* ============================================================================
   EPROSTA — verification harness for event-level roles and applications
   ----------------------------------------------------------------------------
   A worker looking at a six-day job wanting two roles was offered it 24 times:
   once per role group per day. They apply day by day, or they give up.

   Two causes were stacked. `openRoles()` emitted one row per split — a role
   group on ONE day — because the split is the unit everything else is keyed on.
   And `seedShifts()` made one role group per quote LINE, so three Event Steward
   lines became three Event Steward groups on every day.

   The split stays the unit of truth: check-in, attendance and payroll are all
   per-day, and a single short day is a real state that has to stay visible. So
   an event role is a roll-up over splits, and applying fans out to one row per
   day sharing a `groupId`.

   Run:  node event-roles-tests.mjs
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

const work = mkdtempSync(join(tmpdir(), 'eprosta-event-roles-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');

let generation = 0;

/** Bundle and import a fresh copy of the modules — i.e. reload the tab. */
async function boot() {
  generation += 1;
  const entry = join(work, `entry-${generation}.ts`);
  const out = join(work, `bundle-${generation}.mjs`);
  writeFileSync(
    entry,
    `export * as DB from '${p('src/data/db')}';\n` +
      `export * as W from '${p('src/lib/wof')}';\n` +
      `export * as COV from '${p('src/lib/coverage')}';\n` +
      `export * as EV from '${p('src/lib/events')}';\n` +
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
  const mod = await import(pathToFileURL(out).href);
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

const { DB, W, COV, PORTAL } = await boot();

/* ========================================================================== */
section('1. Staff lines sharing a role become one role group per day');

const job = W.create({
  title: 'ROLE MERGE TESTER',
  start: '2026-09-01T09:00:00',
  end: '2026-09-06T18:00:00',
});
W.addLine(job, 'ch-st-event', { qty: 5, units: 9 });
W.addLine(job, 'ch-st-event', { qty: 10, units: 9 });
W.addLine(job, 'ch-st-event', { qty: 10, units: 9 });
W.addLine(job, 'ch-st-response', { qty: 5, units: 9 });

const ev = W.seedEvent(job);
const day1 = ev.shifts[0];

ok('six days of shifts', ev.shifts.length === 6, String(ev.shifts.length));
ok('two role groups a day, not four', day1.splits.length === 2, String(day1.splits.length));
ok('  · the three Event Steward lines merged into one group of 25',
  day1.splits.find((s) => s.role === 'Event Steward')?.required === 25,
  String(day1.splits.find((s) => s.role === 'Event Steward')?.required));
ok('  · Response Steward is untouched at 5',
  day1.splits.find((s) => s.role === 'Response Steward')?.required === 5);
ok('  · and the daily total is unchanged at 30',
  day1.splits.reduce((n, s) => n + s.required, 0) === 30,
  String(day1.splits.reduce((n, s) => n + s.required, 0)));

/* ========================================================================== */
section('2. A line pinned to one day does not merge into the every-day group');

const pinned = W.create({
  title: 'ROLE MERGE DAY PIN',
  start: '2026-09-01T09:00:00',
  end: '2026-09-03T18:00:00',
});
W.addLine(pinned, 'ch-st-event', { qty: 4, units: 9 });
W.addLine(pinned, 'ch-st-event', { qty: 6, units: 9, description: 'Event Steward day 2 breakdown' });

const pev = W.seedEvent(pinned);
ok('day 1 has the every-day line only',
  pev.shifts[0].splits.reduce((n, s) => n + s.required, 0) === 4,
  String(pev.shifts[0].splits.reduce((n, s) => n + s.required, 0)));
ok('day 2 carries both, merged into one group of 10',
  pev.shifts[1].splits.length === 1 && pev.shifts[1].splits[0].required === 10,
  JSON.stringify(pev.shifts[1].splits.map((s) => [s.role, s.required])));
ok('day 3 is back to the every-day line',
  pev.shifts[2].splits.reduce((n, s) => n + s.required, 0) === 4);

/* ========================================================================== */
section('3. An event role sums coverage across every day it runs');

const roles = COV.eventRoles(ev);
ok('two roles across the event', roles.length === 2, String(roles.length));

const steward = roles.find((r) => r.role === 'Event Steward');
ok('Event Steward needs 150 across six days', steward.required === 150, String(steward.required));
ok('  · and knows it runs six days', steward.days === 6);
ok('  · with a part for each day', steward.parts.length === 6);
ok('  · nothing filled yet', steward.filled === 0 && steward.gap === 150);
ok('  · spanning the run',
  steward.start === ev.shifts[0].start && steward.end === ev.shifts[5].end);

const resp = roles.find((r) => r.role === 'Response Steward');
ok('Response Steward needs 30', resp.required === 30, String(resp.required));
ok('the two roles still total the event', steward.required + resp.required === 180);

/* ========================================================================== */
section('4. Events already saved with duplicate role groups are merged on load');

const blank = (id, role, required, assignments = []) => ({
  id, role, required, pickupTime: null, office: 'EP Event Services',
  uniform: 'White Shirt', travel: 'Own transport', tags: [], assignments,
});

// Forge the pre-fix shape: two Event Steward groups on one day.
const legacy = JSON.parse(globalThis.localStorage.getItem('eprosta.wof.v1'));
const target = legacy.events.find((e) => e.id === ev.id);
target.shifts[0].splits = [
  blank('x-d1-sp-1', 'Event Steward', 5),
  blank('x-d1-sp-2', 'Event Steward', 20),
  blank('x-d1-sp-3', 'Response Steward', 5),
];
globalThis.localStorage.setItem('eprosta.wof.v1', JSON.stringify(legacy));

const { DB: DB2 } = await boot();
const healed = DB2.EVENTS.find((e) => e.id === ev.id);
ok('the duplicate groups merged', healed.shifts[0].splits.length === 2,
  String(healed.shifts[0].splits.length));
ok('  · into one group of 25',
  healed.shifts[0].splits.find((s) => s.role === 'Event Steward').required === 25,
  String(healed.shifts[0].splits.find((s) => s.role === 'Event Steward').required));
ok('  · and the day still totals 30',
  healed.shifts[0].splits.reduce((n, s) => n + s.required, 0) === 30);

/* ========================================================================== */
section('5. An event with people on it is left alone and reported');

const busy = JSON.parse(globalThis.localStorage.getItem('eprosta.wof.v1'));
const bt = busy.events.find((e) => e.id === ev.id);
bt.shifts[0].splits = [
  blank('y-d1-sp-1', 'Event Steward', 5, [
    { employeeId: 'e-9', confirmation: 'confirmed', respondedAt: null, declinedFrom: null },
  ]),
  blank('y-d1-sp-2', 'Event Steward', 20),
];
globalThis.localStorage.setItem('eprosta.wof.v1', JSON.stringify(busy));

const { DB: DB3, W: W3 } = await boot();
const untouched = DB3.EVENTS.find((e) => e.id === ev.id);
ok('the groups are NOT merged, because somebody is on one',
  untouched.shifts[0].splits.length === 2, String(untouched.shifts[0].splits.length));
ok('  · and the rostered worker is still there',
  untouched.shifts[0].splits[0].assignments.length === 1);
ok('  · and the skip is reported rather than silent',
  W3.unmergedRoleGroups() >= 1, String(W3.unmergedRoleGroups()));

/* ========================================================================== */
section('6. A worker is offered one card per role, not one per day');

// A fresh store and a job of its own: sections 4 and 5 deliberately forged
// broken shapes, and a card test inheriting them would be measuring the
// fixture rather than the feature.
globalThis.localStorage.removeItem('epteam.applications');
const { W: W6, PORTAL: P6, EV: EV6, DB: DB6 } = await boot();

/* Relative to today, not a fixed week in September. The app's clock is real,
   so a job on a hard date walks into the past as the repo ages — and a job in
   the past is not offered to a worker, so this section would have started
   reporting zero cards for a feature that had not changed. Ten days out, six
   calendar days long. */
const dayOut = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const job6 = W6.create({
  title: 'WORKER CARD TESTER',
  start: `${dayOut(10)}T09:00:00`,
  end: `${dayOut(15)}T18:00:00`,
});
W6.addLine(job6, 'ch-st-event', { qty: 5, units: 9 });
W6.addLine(job6, 'ch-st-event', { qty: 20, units: 9 });
W6.addLine(job6, 'ch-st-response', { qty: 5, units: 9 });
const ev6 = W6.seedEvent(job6);

// A job only reaches a worker once it is a confirmed order — which any job
// that has seeded an event has been. The fixture has to say so.
job6.stage = 'order';

const rows = P6.openEventRoles().filter((r) => r.event.id === ev6.id);
ok('two cards for a six-day, two-role job', rows.length === 2, String(rows.length));
ok('  · each carrying the whole run', rows.every((r) => r.role.days === 6));
ok('  · rather than one card per day', rows.length !== 12);

/* ========================================================================== */
section('7. Applying once covers every day, and withdraws as one');

const card = rows.find((r) => r.role.role === 'Event Steward');
const made = P6.apply(card);
ok('one click writes a row per day', made.length === 6, String(made.length));
ok('  · all sharing one group', new Set(made.map((a) => a.groupId)).size === 1);
ok('  · and the role is findable as one application',
  !!P6.applicationForRole(ev6.id, 'Event Steward'));

P6.withdrawGroup(made[0].groupId);
ok('withdrawing removes all six, not one',
  P6.myApplications().filter((a) => a.eventId === ev6.id && a.role === 'Event Steward').length === 0);

/* ========================================================================== */
section('8. assignRole assigns workers across all days of a role in one operation');

const emp1 = DB6.EMPLOYEES[0].id;
const emp2 = DB6.EMPLOYEES[1].id;

const res8 = EV6.assignRole(ev6.id, 'Response Steward', [emp1, emp2]);
/* Twelve ATTEMPTS — two workers across six days — not twelve assignments.
   Now the fixture runs on real near-future dates, the seeded roster can
   legitimately have one of these two off or sick on a day of it, and a test
   demanding twelve placements would be asserting the roster rather than the
   thing this section is named for: that one call covers every day of the role.
   The refusals are the product working, so they are checked rather than
   avoided. */
ok('assignRole covers every day of the role in one call',
  res8.assigned + res8.refused.length === 12,
  `${res8.assigned} assigned, ${res8.refused.length} refused`);
ok('  · and anybody it could not place is refused with a reason, not dropped',
  res8.refused.every((r) => !!r.employeeId && /\S/.test(r.reason || '')),
  JSON.stringify(res8.refused));

/* ========================================================================== */
section('9. An application saved before groups existed still withdraws as one');

const legacyApps = [1, 2, 3].map((n) => ({
  id: `old-${n}`,
  employeeId: P6.actingEmployee().id,
  eventId: ev6.id,
  shiftId: ev6.shifts[n - 1].id,
  splitId: ev6.shifts[n - 1].splits[0].id,
  role: 'Event Steward',
  start: ev6.shifts[n - 1].start,
  end: ev6.shifts[n - 1].end,
  note: '',
  appliedAt: new Date().toISOString(),
  status: 'applied',
}));
globalThis.localStorage.setItem('epteam.applications', JSON.stringify(legacyApps));

const revived = P6.myApplications().filter((a) => a.eventId === ev6.id);
ok('rows without a group get one on read',
  revived.length === 3 && revived.every((a) => !!a.groupId), String(revived.length));
ok('  · and the three share it', new Set(revived.map((a) => a.groupId)).size === 1,
  [...new Set(revived.map((a) => a.groupId))].join(', '));

P6.withdrawGroup(revived[0].groupId);
ok('  · so withdrawing takes all three',
  P6.myApplications().filter((a) => a.eventId === ev6.id).length === 0);

/* ========================================================================== */
section('10. Days and role groups are counted separately');

/* The bug this pins: `days` was `parts.length`, so a role deployed to two car
   parks across two windows reported one seventeen-day job as sixty-two days
   long. Both numbers are real — the calendar commitment and the number of rows
   staffing has to fill — and neither one may stand in for the other. */

const multi = W.create({
  title: 'DAYS VS GROUPS',
  start: '2026-10-01T08:00:00',
  end: '2026-10-03T18:00:00',
});
const placeA = W.addPlace(multi, 'North Car Park');
const placeB = W.addPlace(multi, 'South Car Park');
const early = multi.shiftPatterns.find((s) => s.id === 'sp-early');
const nights = multi.shiftPatterns.find((s) => s.id === 'sp-nights');

// Same role, two places, two windows — four groups on each of three days.
[placeA, placeB].forEach((place) =>
  W.addDeployment(multi, {
    area: place.name,
    placeId: place.id,
    columns: [
      { shiftPatternId: early.id, days: [1, 2, 3] },
      { shiftPatternId: nights.id, days: [1, 2, 3] },
    ],
    cells: [
      { shiftPatternId: early.id, chargeId: 'ch-st-carpark', perDay: [2, 2, 2] },
      { shiftPatternId: nights.id, chargeId: 'ch-st-carpark', perDay: [3, 3, 3] },
    ],
  }),
);

const mev = W.seedEvent(multi);
const mrole = COV.eventRoles(mev).find((r) => r.role === 'Car Park Steward');

ok('the run is three days of shifts', mev.shifts.length === 3, String(mev.shifts.length));
ok('the role reports three DAYS, not twelve', mrole.days === 3, String(mrole.days));
ok('  · and twelve role GROUPS', mrole.groups === 12, String(mrole.groups));
ok('  · groups match the parts they are counted from',
  mrole.groups === mrole.parts.length, String(mrole.parts.length));
ok('  · required follows the groups, not the days',
  mrole.required === 30, String(mrole.required));
ok('the event day count ignores how many groups sit on a day',
  COV.eventDayCount(mev) === 3, String(COV.eventDayCount(mev)));
ok('a role with one group a day has days === groups',
  steward.days === steward.groups && steward.days === 6,
  `${steward.days} / ${steward.groups}`);

/* ========================================================================== */
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
