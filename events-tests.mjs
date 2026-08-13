/* ============================================================================
   EPROSTA — verification harness for events, shifts, role groups, assignments
   ----------------------------------------------------------------------------
   "New Event" fired a toast and changed nothing. So did assigning a worker,
   adding a shift, adding a role group, marking somebody confirmed and approving
   a timesheet. Replacing all of that with real writes is only an improvement if
   the writes are real and the derived numbers move with them, so this proves
   the claims `src/lib/events.ts`, `src/lib/checkins.ts` and `src/data/clock.ts`
   make:

     1. THE CLOCK IS REAL AND THE SEED MOVES TO MEET IT — the offset is a whole
        number of weeks, so every seeded event keeps its weekday, and the seed
        sits within a few days of today however long after it was authored the
        app is opened.

     2. A NEW EVENT IS A REAL RECORD — it lands in `EVENTS`, it is refused if it
        is invalid, and it is created with no shifts rather than an invented one.

     3. COVERAGE MOVES WITH THE FACTS — this is the one that matters. Assigning
        somebody must not change `filled`, because assigned is not confirmed.
        Confirming them must. The four irreconcilable numbers the live app
        showed for one shift cannot come back.

     4. IT SURVIVES A RELOAD — the journal replays over a freshly seeded
        `EVENTS`, so an event created, staffed and confirmed in this browser is
        still there, still staffed, tomorrow.

     5. DELETES ARE RECOVERABLE — `restoreEvent` puts back exactly what was
        removed, assignments included, and the restore also survives a reload.

     6. APPROVING A TIMESHEET DOES ALL THREE THINGS — the row leaves the queue,
        an attendance row is written for payroll, and the assignment is marked
        confirmed and checked in. Doing only the first is what the live system
        did.

   Run:  node events-tests.mjs
   ----------------------------------------------------------------------------
   Same bundling trick as `schedules-tests.mjs`: framework-free but
   browser-flavoured modules using the `@/` alias, so esbuild bundles them and
   we shim localStorage. Everything must come from ONE bundle — two bundles
   means two copies of `EVENTS` and the tests then pass or fail for reasons that
   have nothing to do with the product.
   ========================================================================== */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

/* --------------------------------------------------------- localStorage --- */
/* Kept across "reloads" on purpose — that is what makes them reloads.        */

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

/* ---------------------------------------------------------------- bundle --- */

const work = mkdtempSync(join(tmpdir(), 'eprosta-events-'));
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
      `export * as CLOCK from '${p('src/data/clock')}';\n` +
      `export * as COV from '${p('src/lib/coverage')}';\n` +
      `export * as EV from '${p('src/lib/events')}';\n` +
      `export * as CI from '${p('src/lib/checkins')}';\n` +
      `export * as NT from '${p('src/lib/notifications')}';\n` +
      `export * as W from '${p('src/lib/wof')}';\n` +
      `export * as AV from '${p('src/lib/availability')}';\n`,
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

const DAY = 86400000;

/* ============================================================ 1. the clock == */

let { DB, CLOCK, COV, EV, CI, NT, W, AV } = await boot();

group('1. The clock is real and the seed moves to meet it');

ok('NOW is real wall-clock time, not a frozen constant',
   Math.abs(Date.now() - +DB.NOW) < 60_000,
   `NOW is ${DB.NOW.toISOString()}`);

ok('the shift is a whole number of weeks', CLOCK.SHIFT_DAYS % 7 === 0,
   `shift is ${CLOCK.SHIFT_DAYS} days`);

{
  // Weekday preservation is the whole reason for whole weeks: festivals run
  // Fri–Sun and race days are Saturdays.
  const anchor = new Date(2026, 6, 31); // Fri 31 Jul 2026, local
  const moved = new Date(+anchor + CLOCK.SHIFT_DAYS * DAY);
  ok('every seeded date keeps its weekday', moved.getDay() === anchor.getDay());

  const drift = Math.round((Date.now() - +moved) / DAY);
  ok('the seed lands within a few days of today', Math.abs(drift) <= 4,
     `drift is ${drift} days`);
}

ok('shifting preserves the shape of a bare date',
   /^\d{4}-\d{2}-\d{2}$/.test(CLOCK.shiftISO('2026-07-31')));
ok('shifting preserves the shape of a timestamp',
   /^\d{4}-\d{2}-\d{2}T09:20:00$/.test(CLOCK.shiftISO('2026-07-31T09:20:00')));
ok('a non-date string is left alone',
   CLOCK.shiftISO('WOF-2026-0101') === 'WOF-2026-0101');
ok('free text mentioning a date is left alone',
   CLOCK.shiftISO('Priced 2026-03-28 by Colin') === 'Priced 2026-03-28 by Colin');

{
  // The bug this guards: pricing a line in seed time against a charge table in
  // shifted time. Every line would read as stale the moment the offset moved.
  const staleLines = W.all()
    .flatMap((w) => w.lines)
    .filter((l) => l.source === 'quote' && W.lineIsStale(l));
  ok('quote lines are not all falsely stale after the shift',
     staleLines.length < W.all().flatMap((w) => w.lines).length,
     `${staleLines.length} lines report stale`);
}

/* =========================================================== 2. new event == */

group('2. A new event is a real record');

const seededEvents = DB.EVENTS.length;

const bad = EV.createEvent({
  name: 'X', clientId: '', office: 'London',
  start: '2026-10-02T09:00', end: '2026-10-01T09:00',
  allDay: false, requiresAccreditation: false,
});
ok('a blank form is refused', !bad.ok);
ok('  · short name is caught', !!bad.errors?.name);
ok('  · missing client is caught', !!bad.errors?.clientId);
ok('  · end before start is caught', !!bad.errors?.end);
ok('nothing was written by the refused save', DB.EVENTS.length === seededEvents,
   `EVENTS grew to ${DB.EVENTS.length}`);

const times = EV.defaultEventTimes();
const made = EV.createEvent({
  name: 'NEW TEST EVENT',
  clientId: 'c-3',
  office: 'London',
  start: times.start,
  end: times.end,
  allDay: false,
  requiresAccreditation: false,
});
ok('a valid form is accepted', made.ok);
ok('the event is in EVENTS', DB.EVENTS.some((e) => e.id === made.event.id));
ok('it is findable by id', !!DB.event(made.event.id));
ok('the default dates are in the future', +new Date(made.event.start) > Date.now());
ok('it is created with no shifts', made.event.shifts.length === 0);

{
  const c = COV.eventCoverage(made.event);
  ok('an event with no shifts requires nobody', c.required === 0 && c.gap === 0);
}

const dupe = EV.createEvent({
  name: 'NEW TEST EVENT', clientId: 'c-3', office: 'London',
  start: times.start, end: times.end, allDay: false, requiresAccreditation: false,
});
ok('a duplicate name is refused', !dupe.ok && !!dupe.errors?.name);

/* ============================================================ 3. coverage == */

group('3. Coverage moves with the facts');

const shiftRes = EV.addShift(made.event.id, {
  label: 'Day 1 — Day shift',
  start: times.start,
  end: times.end,
});
ok('a shift can be added', shiftRes.ok);
ok('the shift is on the event', made.event.shifts.length === 1);
ok('its day index is derived, not asked for', shiftRes.shift.day === 1);

ok('a shift ending before it starts is refused',
   !EV.addShift(made.event.id, { label: 'Bad', start: times.end, end: times.start }).ok);

const splitRes = EV.addSplit(made.event.id, shiftRes.shift.id, {
  role: 'Event Steward', required: 5, pickupTime: '06:30',
  office: 'London', uniform: 'White shirt', travel: 'Own transport', tags: [],
});
ok('a role group can be added', splitRes.ok);
ok('a role group needing nobody is refused',
   !EV.addSplit(made.event.id, shiftRes.shift.id, {
     role: 'Event Steward', required: 0, pickupTime: null,
     office: 'London', uniform: '', travel: '', tags: [],
   }).ok);

{
  const c = COV.eventCoverage(made.event);
  ok('the event now needs 5', c.required === 5, `required is ${c.required}`);
  ok('  · and has a gap of 5', c.gap === 5);
}

/* The pool is filtered by availability rather than taken off the top of the
   register. `assign()` now refuses anybody on approved leave, so "the first
   five employees" is no longer a set of five bookable people — and a test that
   assumed it was would fail for the right reason and read like a bug. */
const shiftDate = shiftRes.shift.start.slice(0, 10);
const pool = DB.EMPLOYEES.map((e) => e.id)
  .filter((id) => AV.availableOn(id, shiftDate))
  .slice(0, 5);
ok('five bookable workers were found', pool.length === 5, `found ${pool.length}`);

const res = EV.assign(made.event.id, splitRes.split.id, pool);
ok('five workers are assigned', res.assigned === 5, `assigned ${res.assigned}`);
ok('  · and nobody was refused', res.refused.length === 0);
ok('assigning the same people again adds nobody',
   EV.assign(made.event.id, splitRes.split.id, pool).assigned === 0);

{
  /* The join the two workbooks never had: booked in one file, booked off in
     the other, and nothing able to compare them. */
  const blocked = DB.EMPLOYEES.map((e) => e.id)
    .find((id) => !AV.availableOn(id, shiftDate));
  if (blocked) {
    const r = EV.assign(made.event.id, splitRes.split.id, [blocked]);
    ok('somebody on approved leave is refused, not quietly booked',
       r.assigned === 0 && r.refused.length === 1);
    ok('  · and the refusal says why, in words',
       /leave|sick|off|holiday/i.test(r.refused[0]?.reason ?? ''),
       r.refused[0]?.reason);
    ok('  · so they are not on the role group',
       !splitRes.split.assignments.some((a) => a.employeeId === blocked));
  }
}

{
  const c = COV.eventCoverage(made.event);
  // The single most important assertion in this file.
  ok('ASSIGNED IS NOT FILLED — the gap is still 5', c.gap === 5, `gap is ${c.gap}`);
  ok('  · all five are counted as assigned', c.assigned === 5);
  ok('  · all five are counted as awaiting', c.awaiting === 5);
  ok('  · filled is still zero', c.filled === 0);
}

EV.setConfirmation(made.event.id, shiftRes.shift.id, pool.slice(0, 3), 'confirmed');
{
  const c = COV.eventCoverage(made.event);
  ok('confirming three fills three', c.filled === 3, `filled is ${c.filled}`);
  ok('  · and the gap falls to 2', c.gap === 2);
  const a = made.event.shifts[0].splits[0].assignments.find((x) => x.employeeId === pool[0]);
  ok('  · status moves with confirmation', a.status === 'accepted');
}

EV.setConfirmation(made.event.id, shiftRes.shift.id, [pool[0]], 'declined');
{
  const c = COV.eventCoverage(made.event);
  ok('a decline reopens the gap', c.gap === 3, `gap is ${c.gap}`);
  const a = made.event.shifts[0].splits[0].assignments.find((x) => x.employeeId === pool[0]);
  ok('  · and marks the response declined', a.status === 'declined');
}

EV.unassign(made.event.id, splitRes.split.id, [pool[4]]);
ok('unassigning removes the row', made.event.shifts[0].splits[0].assignments.length === 4);

{
  // Reducing the requirement below the number assigned must not silently drop
  // anybody off a shift they have accepted.
  EV.updateSplit(made.event.id, shiftRes.shift.id, splitRes.split.id, {
    role: 'Event Steward', required: 2, pickupTime: '06:30',
    office: 'London', uniform: 'White shirt', travel: 'Own transport', tags: [],
  });
  ok('shrinking a role group unassigns nobody',
     made.event.shifts[0].splits[0].assignments.length === 4);
  EV.updateSplit(made.event.id, shiftRes.shift.id, splitRes.split.id, {
    role: 'Event Steward', required: 5, pickupTime: '06:30',
    office: 'London', uniform: 'White shirt', travel: 'Own transport', tags: [],
  });
}

{
  const copy = EV.duplicateSplit(made.event.id, shiftRes.shift.id, splitRes.split.id);
  ok('a duplicated role group copies the headcount', copy.required === 5);
  ok('  · but not the people', copy.assignments.length === 0);
  EV.removeSplit(made.event.id, shiftRes.shift.id, copy.id);
}

/* ============================================================= 4. reload === */

group('4. It survives a reload');

const madeId = made.event.id;
({ DB, CLOCK, COV, EV, CI, NT, W, AV } = await boot());

{
  const ev = DB.event(madeId);
  ok('the event is still there after a reload', !!ev);
  ok('  · with its shift', ev.shifts.length === 1);
  ok('  · with its role group', ev.shifts[0].splits.length === 1);
  ok('  · with its four assignments', ev.shifts[0].splits[0].assignments.length === 4);

  const c = COV.eventCoverage(ev);
  ok('  · and the same coverage: 2 of 5', c.filled === 2 && c.required === 5,
     `${c.filled}/${c.required}`);
  ok('the store knows it is a local record', EV.isLocal(madeId));
}

ok('the seeded events are still present too',
   DB.EVENTS.filter((e) => e.id.startsWith('ev-') && !e.id.startsWith('ev-new')).length > 0);

/* ============================================================ 5. recovery == */

group('5. Deletes are recoverable');

const snapshot = structuredClone(DB.event(madeId));
EV.removeEvent(madeId);
ok('a deleted event is gone', !DB.event(madeId));

EV.restoreEvent(snapshot);
{
  const back = DB.event(madeId);
  ok('restore puts the event back', !!back);
  ok('  · with its assignments intact', back.shifts[0].splits[0].assignments.length === 4);
  const c = COV.eventCoverage(back);
  ok('  · and the same coverage', c.filled === 2 && c.required === 5);
}

({ DB, CLOCK, COV, EV, CI, NT, W, AV } = await boot());
ok('the restore survives a reload', !!DB.event(madeId));

{
  // A seeded event that is deleted must stay deleted across a reload, or the
  // journal is not a journal.
  const victim = DB.EVENTS.find((e) => e.id === 'ev-2');
  if (victim) {
    EV.removeEvent('ev-2');
    ({ DB, CLOCK, COV, EV, CI, NT, W, AV } = await boot());
    ok('a deleted SEED event stays deleted after a reload', !DB.event('ev-2'));
    EV.restoreEvent(victim);
    ok('  · and can still be restored', !!DB.event('ev-2'));
  }
}

/* =========================================================== 6. approvals == */

group('6. Approving a timesheet does all three things');

{
  const queued = CI.pending();
  ok('there are check-ins waiting', queued.length > 0, `${queued.length} queued`);

  const c = queued.find((x) => !x.flag) || queued[0];
  const before = CI.pendingCount();
  const attBefore = DB.ATTENDANCE.length;

  const r = CI.approve(c.id);
  ok('the approval is accepted', r.ok);
  ok('1. the row leaves the queue', CI.pendingCount() === before - 1);
  ok('2. an attendance row is written for payroll', DB.ATTENDANCE.length === attBefore + 1);

  const row = DB.ATTENDANCE.find((a) => a.id === `att-${c.id}`);
  ok('  · with hours on it', !!row && row.hours > 0, row ? `hours ${row.hours}` : 'no row');
  ok('  · and an outcome derived from the times', !!row && !!row.outcome);

  const ev = DB.event(c.eventId);
  const a = ev?.shifts
    .flatMap((sh) => sh.splits)
    .flatMap((sp) => sp.assignments)
    .find((x) => x.employeeId === c.employeeId);
  ok('3. the assignment is marked checked in', !!a && a.checkIn === 'approved');
  ok('  · and confirmed, because they plainly worked it',
     !!a && a.confirmation === 'confirmed');

  ok('approving twice is refused', !CI.approve(c.id).ok);

  CI.reopen(c.id);
  ok('reopening puts the row back in the queue', CI.pendingCount() === before);
  ok('  · and takes the hours back out of payroll', DB.ATTENDANCE.length === attBefore);
}

{
  const queued = CI.pending();
  const c = queued[0];
  const attBefore = DB.ATTENDANCE.length;
  CI.reject(c.id, 'Did not attend.');
  ok('a rejection writes no attendance row', DB.ATTENDANCE.length === attBefore);
  ok('  · and takes the row out of the queue', !CI.pending().some((x) => x.id === c.id));
}

({ DB, CLOCK, COV, EV, CI, NT, W, AV } = await boot());
ok('approval decisions survive a reload', CI.pendingCount() < DB.CHECK_INS.length);

/* ======================================================== 7. notifications = */

group('7. Sent messages have somewhere to go');

{
  const before = NT.all().length;
  NT.callout({
    eventId: madeId, eventName: 'NEW TEST EVENT', role: 'Event Steward',
    gap: 3, audience: 'best-rated first', recipients: 40,
  });
  ok('a callout is recorded', NT.all().length === before + 1);
  ok('  · at the top of the list, newest first', NT.all()[0].title.includes('Callout sent'));
  ok('  · unread', NT.all()[0].unread);

  const id = NT.all()[0].id;
  NT.markRead(id);
  ok('marking read sticks', !NT.all().find((n) => n.id === id).unread);
}

({ DB, CLOCK, COV, EV, CI, NT, W, AV } = await boot());
ok('notifications survive a reload', NT.all().some((n) => n.title.includes('Callout sent')));
ok('  · and so does their read state', !NT.all().find((n) => n.title.includes('Callout sent')).unread);

/* ================================================================ summary == */

rmSync(work, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
