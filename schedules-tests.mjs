/* ============================================================================
   EPROSTA — verification harness for the event schedule register
   ----------------------------------------------------------------------------
   "Add scheduled event" used to fire a toast and change nothing. Replacing that
   with a real write is only an improvement if the write is real, so this proves
   the four claims `src/lib/schedules.ts` makes:

     1. A NEW ENTRY IS A REAL RECORD — it lands in `EVENT_SCHEDULE`, it carries
        a trigger date, and it appears on the calendar with no WOF against it.
        That last part is the whole point of the register.

     2. IT SURVIVES A RELOAD — the journal replays over a freshly seeded
        register, so an entry added in this browser is still there tomorrow.
        This is the bug the client register was written to kill; a second
        reference dataset must not reintroduce it.

     3. THE JOURNAL IS A DIFF, NOT A SNAPSHOT — a seeded entry that is edited
        keeps whatever the seed later improves about the fields nobody touched,
        and an entry removed here does not come back on the next load.

     4. THE REGISTER AND THE WOF NEVER DISAGREE — a WOF raised against a new
        entry is still linked to it after a reload, in both directions, even
        though the back-pointer is deliberately not persisted.

   Run:  node schedules-tests.mjs
   ----------------------------------------------------------------------------
   Same bundling trick as `roles-tests.mjs`: the modules are framework-free but
   browser-flavoured and use the `@/` alias, so esbuild bundles them and we shim
   localStorage. Everything must come from ONE bundle — two bundles means two
   copies of `EVENT_SCHEDULE` and the tests then pass or fail for reasons that
   have nothing to do with the product.

   Reload is simulated by bundling to a fresh file and re-importing it, which
   re-runs every module's top-level code against the localStorage we kept.
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

const work = mkdtempSync(join(tmpdir(), 'eprosta-schedules-'));
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
      `export * as S from '${p('src/lib/schedules')}';\n`,
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
/**
 * `addDays` returns a UTC ISO stamp while the register stores naive-local, so a
 * literal string comparison here would pass in London and fail in Sydney.
 * Whole days between the two instants is the claim that actually matters.
 */
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / DAY);

/* The app's clock is real (`NOW = new Date()`), so a fixture on a fixed date
   is a test with an expiry stamped on it: this file's event was 2026-10-10
   with a 30-day lead time, and every assertion about the trigger NOT having
   elapsed was true only until 10 September. Dates here are computed from
   today, far enough out that the lead time cannot have passed however long
   this file sits in the repo. */
const dayOut = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const EV_DAY = dayOut(120);
const EV_NEXT_YEAR = dayOut(120 + 365);

/* ============================================================== 1. create == */

let { DB, W, S } = await boot();

group('1. A new entry is a real record');

const seededCount = DB.EVENT_SCHEDULE.length;

const bad = S.createSchedule({
  name: 'X', clientId: '', venue: '', type: 'sports', recurrence: 'One-off',
  start: '2026-10-02T09:00', end: '2026-10-01T09:00', leadDays: -1,
});
ok('a blank form is refused', !bad.ok);
ok('  · short name is caught', !!bad.errors?.name);
ok('  · missing client is caught', !!bad.errors?.clientId);
ok('  · missing venue is caught', !!bad.errors?.venue);
ok('  · end before start is caught', !!bad.errors?.end);
ok('  · negative lead time is caught', !!bad.errors?.leadDays);
ok('nothing was written by the refused save', DB.EVENT_SCHEDULE.length === seededCount,
  `register grew to ${DB.EVENT_SCHEDULE.length}`);

const made = S.createSchedule({
  name: 'NEW TEST EVENT',
  clientId: 'c-3',
  venue: 'Verulamium Park, St Albans',
  type: 'show',
  recurrence: 'One-off',
  start: `${EV_DAY}T09:00`,
  end: `${EV_DAY}T18:00`,
  leadDays: 30,
});
ok('a valid entry is accepted', made.ok, JSON.stringify(made.errors));
const NEW_ID = made.entry?.id;
ok('it is in the register', DB.EVENT_SCHEDULE.some((s) => s.id === NEW_ID));
ok('it did not land on a seeded id', seededCount + 1 === DB.EVENT_SCHEDULE.length);
ok('seconds are normalised onto the naive-local stamp', made.entry?.start === `${EV_DAY}T09:00:00`,
  made.entry?.start);
ok('a blank trigger rule is written from the lead time',
  made.entry?.triggerRule === 'Raise WOF 30 days before the event', made.entry?.triggerRule);
ok('it has no WOF, which is the point of the register', made.entry?.wofId === null);

const dup = S.createSchedule({
  name: 'new test event', clientId: 'c-3', venue: 'Anywhere', type: 'show',
  recurrence: 'One-off', start: `${EV_DAY}T14:00`, end: `${EV_DAY}T20:00`, leadDays: 30,
});
ok('same name on the same day is refused as a double-entry', !dup.ok && !!dup.errors?.name);

const twin = S.createSchedule({
  name: 'NEW TEST EVENT', clientId: 'c-3', venue: 'Anywhere', type: 'show',
  recurrence: 'Annual', start: `${EV_NEXT_YEAR}T09:00`, end: `${EV_NEXT_YEAR}T18:00`, leadDays: 30,
});
ok('the same name NEXT year is allowed', twin.ok, JSON.stringify(twin.errors));

/* ============================================================ 2. calendar == */

group('2. It reaches the calendar without a WOF');

let rows = W.calendarRows();
let row = rows.find((r) => r.scheduleId === NEW_ID);
ok('the calendar has a row for it', !!row);
ok('  · it is drawn as "No WOF"', row?.status.id === 'no-wof', row?.status.id);
ok('  · its trigger date is the lead time before the event',
  daysBetween(row?.wofDueBy, `${EV_DAY}T09:00:00`) === 30, row?.wofDueBy);
ok('  · the trigger has not elapsed yet, so it is not red', row?.wofOverdue === false);

const late = S.createSchedule({
  name: 'BACKDATED TEST EVENT', clientId: 'c-3', venue: 'Somewhere', type: 'show',
  recurrence: 'One-off', start: '2026-08-20T09:00', end: '2026-08-20T18:00', leadDays: 60,
});
const lateRow = W.calendarRows().find((r) => r.scheduleId === late.entry.id);
ok('an entry whose lead time has already elapsed is flagged red', lateRow?.wofOverdue === true);

/* ============================================================== 3. reload == */

group('3. It survives a reload');

({ DB, W, S } = await boot());

const after = DB.EVENT_SCHEDULE.find((s) => s.id === NEW_ID);
ok('the entry is still in the register after a reload', !!after);
ok('  · with its name', after?.name === 'NEW TEST EVENT');
ok('  · with its venue', after?.venue === 'Verulamium Park, St Albans');
ok('  · with its lead time', after?.leadDays === 30);
ok('  · and only once', DB.EVENT_SCHEDULE.filter((s) => s.id === NEW_ID).length === 1);
ok('the calendar still shows it', W.calendarRows().some((r) => r.scheduleId === NEW_ID));

/* ================================================================ 4. edit == */

group('4. Edits are a diff over the seed, not a snapshot');

const seededTarget = 'sch-10'; // Ascot Late Summer Raceday, no WOF
const beforeVenue = DB.schedule(seededTarget).venue;
// Captured, not hardcoded. The seed is re-dated at load by `data/clock.ts`, so
// a literal date here would be asserting the offset rather than the edit.
const beforeEnd = DB.schedule(seededTarget).end;
const upd = S.updateSchedule(seededTarget, { leadDays: 45 });
ok('a seeded entry can be edited', upd.ok, JSON.stringify(upd.errors));
ok('  · the change applies immediately', DB.schedule(seededTarget).leadDays === 45);

const badEdit = S.updateSchedule(seededTarget, { end: '2020-01-01T00:00' });
ok('an edit that ends before it starts is refused', !badEdit.ok && !!badEdit.errors?.end);
ok('  · and the entry is untouched', DB.schedule(seededTarget).end === beforeEnd,
  `end is now ${DB.schedule(seededTarget).end}, was ${beforeEnd}`);

({ DB, W, S } = await boot());
ok('the edit survives a reload', DB.schedule(seededTarget).leadDays === 45);
ok('fields nobody touched still come from the seed',
  DB.schedule(seededTarget).venue === beforeVenue, DB.schedule(seededTarget).venue);

const trig = W.calendarRows().find((r) => r.scheduleId === seededTarget)?.wofDueBy;
ok('the trigger date moved with the lead time — 30 days earlier than the seed',
  daysBetween(trig, DB.schedule(seededTarget).start) === 45, trig);

/* ============================================================== 5. remove == */

group('5. Removals stay removed');

ok('removing an entry works', S.removeSchedule(late.entry.id));
ok('  · it leaves the register', !DB.EVENT_SCHEDULE.some((s) => s.id === late.entry.id));
ok('  · and the calendar', !W.calendarRows().some((r) => r.scheduleId === late.entry.id));

ok('a seeded entry can be removed too', S.removeSchedule('sch-13'));
({ DB, W, S } = await boot());
ok('a removed seeded entry does not come back on reload', !DB.schedule('sch-13'));
ok('a removed local entry does not come back either', !DB.schedule(late.entry.id));

/* ================================================== 6. register <-> WOF ==== */

group('6. The register and the WOF agree, in both directions');

const s6 = DB.schedule(NEW_ID);
const w6 = W.create({
  scheduleId: s6.id, title: s6.name, clientId: s6.clientId, jobTypeId: s6.type,
  start: s6.start, end: s6.end, ownerId: s6.ownerId, venue: s6.venue,
});
ok('a WOF can be raised against a locally-added entry', !!w6);
ok('  · the register points at the WOF', DB.schedule(NEW_ID).wofId === w6.id);
ok('  · the WOF points at the register', w6.scheduleId === NEW_ID);
ok('  · the calendar row is no longer "No WOF"',
  W.calendarRows().find((r) => r.scheduleId === NEW_ID)?.status.id !== 'nowof');

({ DB, W, S } = await boot());
const s6b = DB.schedule(NEW_ID);
ok('after a reload the entry is still there', !!s6b);
ok('  · the back-pointer is rebuilt even though it is never persisted',
  s6b?.wofId === w6.id, String(s6b?.wofId));
ok('  · and resolving from the WOF side agrees', W.bySchedule(NEW_ID)?.id === w6.id);
ok('  · so the calendar does not claim the paperwork is missing',
  W.calendarRows().find((r) => r.scheduleId === NEW_ID)?.status.id !== 'nowof');

ok('the entry cannot be silently removed while a WOF points at it',
  S.scheduleCommitments(NEW_ID).wof?.id === w6.id);

/* ================================================================ 7. reset = */

group('7. Reset returns to the seeded register');

S.resetSchedules();
({ DB, W, S } = await boot());
ok('the local entry is gone', !DB.schedule(NEW_ID));
ok('the removed seeded entry is back', !!DB.schedule('sch-13'));
ok('the edited lead time is back to the seed', DB.schedule('sch-10').leadDays === 30,
  String(DB.schedule('sch-10').leadDays));

/* ------------------------------------------------------------------ done --- */

rmSync(work, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
