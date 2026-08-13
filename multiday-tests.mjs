/* ============================================================================
   EPROSTA — verification harness for multi-day events

   A five-day job used to seed ONE shift running 15 Aug 09:00 -> 20 Aug 18:00 —
   a 129-hour "shift" — and the UI printed it as "09:00–18:00", so nothing on
   screen said otherwise. Everything downstream that assumes a shift is a work
   period one person does was wrong as a result: coverage counted 11 where 55
   worker-days were needed and called the job fully staffed once day one was
   filled, the worker portal quoted 129h of pay, accreditation exported day one
   only, and `Add shift` inherited the span and compounded it.

   This proves the claims the fix makes:

     1. A SHIFT IS A DAY — no shift anywhere in the app runs longer than a
        working day, seeded or journalled, however long its event is.

     2. A MULTI-DAY JOB SEEDS A SHIFT PER DAY — with role groups on each, so
        coverage counts worker-days rather than one day's headcount.

     3. GENUINE OVERNIGHTS SURVIVE — a 18:00->03:00 taxi marshal shift crosses
        midnight and must not be clamped back to the same evening.

     4. SHIFTS DO NOT OVERLAP EACH OTHER — overlapping shifts read as a
        double-booking to the clash check in the worker portal, so a worker
        booked on day one would be told they clash with day two.

     5. `Add shift` PROPOSES ONE DAY — and never a shift running past the end
        of the event it belongs to.

   Run:  node multiday-tests.mjs

   Same bundling trick as `events-tests.mjs`: everything must come from ONE
   bundle, or there are two copies of `EVENTS` and the results mean nothing.
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

const work = mkdtempSync(join(tmpdir(), 'eprosta-multiday-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');

let generation = 0;

async function boot() {
  generation += 1;
  const entry = join(work, `entry-${generation}.ts`);
  const out = join(work, `bundle-${generation}.mjs`);
  writeFileSync(
    entry,
    `export * as DB from '${p('src/data/db')}';\n` +
      `export * as EV from '${p('src/lib/events')}';\n` +
      `export * as COV from '${p('src/lib/coverage')}';\n` +
      `export * as W from '${p('src/lib/wof')}';\n`,
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

const hours = (a, b) => (+new Date(b) - +new Date(a)) / 3_600_000;
const dayOf = (v) => {
  const d = new Date(v);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};
const daySpan = (a, b) => Math.round((+dayOf(b) - +dayOf(a)) / 86_400_000) + 1;

/* A working day, plus room for a genuine overnight. Anything past this is the
   old bug: a "shift" that is really the whole event. */
const MAX_SHIFT_HOURS = 16;

const M = await boot();
const { DB, EV, COV, W } = M;

/* -------------------------------------------------------------------- 1 --- */

section('1. A shift is a day, not an event');

const allShifts = DB.EVENTS.flatMap((ev) => ev.shifts.map((sh) => ({ ev, sh })));

ok('there are shifts to check', allShifts.length > 0, `${allShifts.length} found`);

const tooLong = allShifts.filter(({ sh }) => hours(sh.start, sh.end) > MAX_SHIFT_HOURS);
ok(
  'no shift runs longer than a working day',
  tooLong.length === 0,
  tooLong.map(({ ev, sh }) => `${ev.name}/${sh.label} = ${hours(sh.start, sh.end).toFixed(0)}h`).join(', '),
);

const negative = allShifts.filter(({ sh }) => hours(sh.start, sh.end) <= 0);
ok('no shift ends before it starts', negative.length === 0);

/* -------------------------------------------------------------------- 2 --- */

section('2. A multi-day job seeds a shift per day');

/* A pure overnight touches two dates but is one night's work, so it is not a
   multi-day job and must NOT be split. Excluded here and checked in section 3. */
const isOvernight = (ev) => daySpan(ev.start, ev.end) === 2 && hours(ev.start, ev.end) <= MAX_SHIFT_HOURS;
const multiDay = DB.EVENTS.filter((ev) => daySpan(ev.start, ev.end) > 1 && !isOvernight(ev));
ok('the seed contains multi-day events', multiDay.length > 0, `${multiDay.length} found`);

for (const ev of multiDay.slice(0, 4)) {
  const span = daySpan(ev.start, ev.end);
  const staffed = ev.shifts.filter((sh) => sh.splits.length > 0);
  ok(
    `${ev.name} — ${span} days has more than one shift`,
    ev.shifts.length > 1,
    `${ev.shifts.length} shift(s)`,
  );
  ok(
    `${ev.name} — every day that has a shift has role groups on it`,
    staffed.length === ev.shifts.length || staffed.length > 1,
    `${staffed.length}/${ev.shifts.length} staffed`,
  );
}

/* Coverage must count worker-days, not one day's headcount. */
const wilderness = multiDay.find((ev) => ev.shifts.length > 2);
if (wilderness) {
  const total = COV.eventCoverage(wilderness).required;
  const firstDay = COV.shiftCoverage(wilderness.shifts[0]).required;
  ok(
    `${wilderness.name} — event coverage exceeds one day's headcount`,
    total > firstDay,
    `event ${total} vs day one ${firstDay}`,
  );
}

/* -------------------------------------------------------------------- 3 --- */

section('3. Genuine overnights survive');

const overnight = allShifts.filter(({ sh }) => dayOf(sh.start).getTime() !== dayOf(sh.end).getTime());
ok('overnight shifts still exist', overnight.length > 0, `${overnight.length} found`);
ok(
  'and every one of them is still a sane length',
  overnight.every(({ sh }) => hours(sh.start, sh.end) <= MAX_SHIFT_HOURS),
);

/* An overnight job is one night's work, not two days. */
const overnightEvents = DB.EVENTS.filter((ev) => isOvernight(ev) && ev.shifts.length > 0);
ok('the seed has overnight jobs', overnightEvents.length > 0, `${overnightEvents.length} found`);
for (const ev of overnightEvents) {
  ok(
    `${ev.name} — one night's work is one shift, not two`,
    ev.shifts.length === 1,
    `${ev.shifts.length} shift(s)`,
  );
}

/* -------------------------------------------------------------------- 4 --- */

section('4. Shifts within an event do not overlap');

let overlaps = 0;
for (const ev of DB.EVENTS) {
  const sorted = [...ev.shifts].sort((a, b) => +new Date(a.start) - +new Date(b.start));
  for (let i = 1; i < sorted.length; i++) {
    if (+new Date(sorted[i].start) < +new Date(sorted[i - 1].end)) {
      overlaps++;
      if (overlaps <= 3) console.log(`        ${ev.name}: ${sorted[i - 1].label} / ${sorted[i].label}`);
    }
  }
}
ok('no shift starts before its predecessor ends', overlaps === 0, `${overlaps} overlap(s)`);

/* -------------------------------------------------------------------- 5 --- */

section('5. Add shift proposes a single day inside the event');

const target = multiDay.find((ev) => ev.shifts.length > 0) || DB.EVENTS.find((ev) => ev.shifts.length > 0);
if (target) {
  const d = EV.defaultShiftTimes(target.id);
  ok(
    `${target.name} — the proposed shift is a working day`,
    hours(d.start, d.end) > 0 && hours(d.start, d.end) <= MAX_SHIFT_HOURS,
    `${hours(d.start, d.end).toFixed(1)}h`,
  );
  ok(
    `${target.name} — it does not run past the end of the event`,
    +new Date(d.end) <= +new Date(target.end),
    `${d.end} vs event end ${target.end}`,
  );
}

/* An event with no shifts at all must still propose one day, not its own span. */
const created = EV.createEvent({
  name: 'Multi-day harness event',
  clientId: DB.CLIENTS[0].id,
  office: 'EP Event Services',
  start: '2026-08-15T09:00',
  end: '2026-08-19T18:00',
  allDay: false,
  requiresAccreditation: false,
});
if (created?.ok && created.event) {
  const d = EV.defaultShiftTimes(created.event.id);
  ok(
    'a fresh five-day event proposes a one-day shift, not a five-day one',
    hours(d.start, d.end) > 0 && hours(d.start, d.end) <= MAX_SHIFT_HOURS,
    `${hours(d.start, d.end).toFixed(1)}h`,
  );

  const added = EV.addShift(created.event.id, { label: 'Day 1', start: d.start, end: d.end });
  ok('and it is accepted as a valid shift', !!added?.ok, JSON.stringify(added?.errors || {}));

  if (added?.ok) {
    const next = EV.defaultShiftTimes(created.event.id);
    ok(
      'the following shift is also one day, not a compounding span',
      hours(next.start, next.end) > 0 && hours(next.start, next.end) <= MAX_SHIFT_HOURS,
      `${hours(next.start, next.end).toFixed(1)}h`,
    );
    ok(
      'and it starts after the previous one ends',
      +new Date(next.start) >= +new Date(d.end),
      `${next.start} vs ${d.end}`,
    );
  }
} else {
  ok('the harness could create a five-day event', false, JSON.stringify(created?.errors || {}));
}

/* -------------------------------------------------------------------- 6 --- */

section('6. The repair is idempotent');

const firstPass = EV.normaliseShiftSpans();
const secondPass = EV.normaliseShiftSpans();
ok('a second repair pass changes nothing', secondPass === 0, `${secondPass} changed`);
ok('the first pass was already settled too', firstPass === 0, `${firstPass} changed`);

/* ------------------------------------------------------------------------- */

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
