/* ============================================================================
   EPROSTA — verification harness for journal normalisation
   ----------------------------------------------------------------------------
   `src/lib/events.ts` journals WHOLE events. That is the right call — an event
   is four levels deep and a field-level journal over it cannot be reconciled
   against seed changes — but it has a cost that only arrives later: a record
   written today is replayed verbatim tomorrow, against whatever `EpEvent` has
   become in the meantime.

   Add a field to `EpEvent` and every event a user has already touched replays
   without it. Not as an `undefined` the compiler would catch, but as a hole in
   a value TypeScript has been told is complete, reached through a cast at the
   `JSON.parse` boundary. The screens then read the new field, get `undefined`,
   and call `.length` on it. It never fails in CI, because the seed always has
   every field. It fails in the browser, on the user's data only.

   `normaliseEvent()` is the gate that stops that. This harness proves the
   claims it makes:

     1. A LEGACY RECORD IS REPAIRED, NOT DISCARDED — the whole point. Missing
        fields are defaulted and the user's assignments survive. Bumping the
        storage key would have been easier and would have thrown their work
        away.

     2. WHAT CANNOT BE REPAIRED IS DROPPED, AND COUNTED — an event with no id
        cannot be indexed; one with no span produces NaN durations that
        propagate silently through coverage. Those go, and say so.

     3. NESTED JUNK IS STRIPPED WITHOUT LOSING THE EVENT — one bad assignment
        must not cost the operator the other fourteen.

     4. COVERAGE STAYS A NUMBER — `required: "twelve"` must not become NaN and
        poison every ratio on the screen.

     5. THE `declinedFrom` INVARIANT HOLDS — present only on declined records,
        defaulted to the documented conservative reading.

     6. THE JOURNAL KEY IS THE ID — `apply()` splices on the key, so a payload
        that disagrees is reconciled rather than allowed to corrupt.

     7. IT ALL SURVIVES A RELOAD — which is the only reason any of it matters.

   Run: npm run test:normalise
   ========================================================================== */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

/* --------------------------------------------------------- localStorage --- */

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

/* Pin the clock to the seed anchor so SHIFT_DAYS is 0 and the journals written
   below are in the same time frame the module will read them in. Without this
   the harness would have to guess the offset, and `read()` would — correctly —
   throw every fixture away as belonging to another frame. */
const CLOCK_KEY = 'eprosta.clock.v1';
const EVENTS_KEY = 'eprosta.events.v1';
const SEED_ANCHOR = '2026-07-31';

/* ---------------------------------------------------------------- bundle --- */

const work = mkdtempSync(join(tmpdir(), 'eprosta-normalise-'));
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
      `export * as EV from '${p('src/lib/events')}';\n`,
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

/** Reset storage, install a journal, and reload. */
async function bootWith(journal) {
  store.clear();
  store.set(CLOCK_KEY, SEED_ANCHOR);
  if (journal !== undefined) store.set(EVENTS_KEY, JSON.stringify(journal));
  return boot();
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

/* ------------------------------------------------------------- fixtures --- */

const shiftOf = (over = {}) => ({
  id: 'sh-x',
  label: 'Day 1',
  day: 0,
  start: '2026-08-01T08:00',
  end: '2026-08-01T18:00',
  splits: [
    {
      id: 'sp-x',
      role: 'Car Park Steward',
      required: 4,
      pickupTime: '07:00',
      office: 'London',
      uniform: 'Hi-vis',
      travel: 'Own transport',
      tags: [],
      assignments: [
        { employeeId: 'e-1', status: 'accepted', confirmation: 'confirmed', checkIn: null, note: '' },
        { employeeId: 'e-2', status: 'invited', confirmation: 'awaiting', checkIn: null, note: '' },
      ],
    },
  ],
  ...over,
});

/** An event as an OLD build would have journalled it: several fields absent. */
const legacyEvent = (over = {}) => ({
  id: 'ev-legacy',
  name: 'Wilderness Festival',
  clientId: 'c-1',
  office: 'London',
  start: '2026-08-01T08:00',
  end: '2026-08-01T18:00',
  shifts: [shiftOf()],
  // Deliberately absent: allDay, requiresAccreditation, accreditationExportReady,
  // accreditationBlockedReason, locations, additionalInfo.
  ...over,
});

const journalOf = (over = {}) => ({
  v: 1,
  shift: 0,
  added: [],
  edited: {},
  removed: [],
  ...over,
});

const find = (DB, id) => DB.EVENTS.find((e) => e.id === id);

/* ================================ 1. a legacy record is repaired, not lost == */

let { DB, EV, COV } = await bootWith(journalOf({ added: [legacyEvent()] }));

group('1. A legacy record is repaired, not discarded');

{
  const ev = find(DB, 'ev-legacy');
  ok('the event written by the old build is still here', !!ev);
  ok('  · nothing was dropped', EV.droppedOnLoad() === 0, `dropped ${EV.droppedOnLoad()}`);
  ok('  · its name survived', ev?.name === 'Wilderness Festival');

  ok('  · the missing boolean defaulted rather than staying undefined',
     ev?.allDay === false, `allDay is ${JSON.stringify(ev?.allDay)}`);
  ok('  · the missing array defaulted to an array, not undefined',
     Array.isArray(ev?.locations) && ev.locations.length === 0);
  ok('  · the missing string defaulted to a string',
     ev?.additionalInfo === '');
  ok('  · every key the current type declares is now present',
     ['id', 'name', 'clientId', 'office', 'start', 'end', 'allDay',
      'requiresAccreditation', 'accreditationExportReady',
      'accreditationBlockedReason', 'locations', 'additionalInfo', 'shifts']
       .every((k) => k in (ev ?? {})));

  ok('  · and the assignments the operator made are untouched',
     ev?.shifts[0].splits[0].assignments.length === 2);
  ok('  · including who was confirmed',
     ev?.shifts[0].splits[0].assignments[0].confirmation === 'confirmed');
}

{
  // The reason repairing beats discarding: the alternative was a storage-key
  // bump, which would have silently thrown this event away.
  const ev = find(DB, 'ev-legacy');
  const cov = COV.eventCoverage(ev);
  ok('coverage over the repaired record is a real number',
     Number.isFinite(cov.filled) && Number.isFinite(cov.required),
     `${cov.filled}/${cov.required}`);
  ok('  · and reads 1 of 4, which is what the record actually says',
     cov.filled === 1 && cov.required === 4, `${cov.filled}/${cov.required}`);
}

/* ============================ 2. what cannot be repaired is dropped, loudly == */

({ DB, EV, COV } = await bootWith(journalOf({
  added: [
    legacyEvent(),                                   // fine
    legacyEvent({ id: '', name: 'No identity' }),    // cannot be indexed
    legacyEvent({ id: 'ev-nospan', start: '' }),     // NaN durations downstream
    'not an object',                                 // junk
    null,                                            // junk
  ],
})));

group('2. What cannot be repaired is dropped, and counted');

ok('the salvageable event came through', !!find(DB, 'ev-legacy'));
ok('the event with no id did not', !DB.EVENTS.some((e) => e.name === 'No identity'));
ok('the event with no start did not', !find(DB, 'ev-nospan'));
ok('four records were dropped, and the module says so',
   EV.droppedOnLoad() === 4, `dropped ${EV.droppedOnLoad()}`);

/* ================== 3. nested junk is stripped without losing the event ===== */

({ DB, EV, COV } = await bootWith(journalOf({
  added: [
    legacyEvent({
      id: 'ev-junk',
      shifts: [
        shiftOf({
          id: 'sh-good',
          splits: [
            {
              id: 'sp-junk',
              role: 'Event Steward',
              required: 'twelve',      // string where a count belongs
              pickupTime: 0,           // must not become "00:00"
              tags: ['sia', 7, null],  // mixed junk
              assignments: [
                { employeeId: 'e-9', status: 'nonsense', confirmation: 'nonsense', note: 5 },
                { status: 'accepted', confirmation: 'confirmed' },  // nobody named
                null,
              ],
            },
            { id: '', role: 'Ghost', required: 3 },   // no id
            'rubbish',
          ],
        }),
        shiftOf({ id: 'sh-noend', end: '' }),         // no span
        { label: 'no id at all' },
      ],
    }),
  ],
})));

group('3. Nested junk is stripped without losing the event');

{
  const ev = find(DB, 'ev-junk');
  ok('the event survived its bad children', !!ev);
  ok('  · the whole event was not counted as a drop', EV.droppedOnLoad() === 0);
  ok('  · the shift with no span was removed', ev?.shifts.length === 1);
  ok('  · the surviving shift is the good one', ev?.shifts[0].id === 'sh-good');
  ok('  · the split with no id was removed', ev?.shifts[0].splits.length === 1);

  const sp = ev?.shifts[0].splits[0];
  ok('  · a non-numeric `required` became 0, not NaN',
     sp?.required === 0, `required is ${JSON.stringify(sp?.required)}`);
  ok('  · a non-string pickupTime became null, never "00:00"',
     sp?.pickupTime === null, `pickupTime is ${JSON.stringify(sp?.pickupTime)}`);
  ok('  · non-string tags were dropped, the real one kept',
     sp?.tags.length === 1 && sp.tags[0] === 'sia');
  ok('  · the assignment naming nobody was removed',
     sp?.assignments.length === 1);
  ok('  · the one naming somebody was kept', sp?.assignments[0].employeeId === 'e-9');
  ok('  · its bogus status fell back to invited',
     sp?.assignments[0].status === 'invited');
  ok('  · its bogus confirmation fell back to awaiting',
     sp?.assignments[0].confirmation === 'awaiting');
  ok('  · its non-string note became a string',
     sp?.assignments[0].note === '');
  ok('  · missing checkIn is null, which is a real state here',
     sp?.assignments[0].checkIn === null);
}

{
  // Point 4: this is what the guard on `required` is actually protecting.
  const cov = COV.eventCoverage(find(DB, 'ev-junk'));
  ok('coverage is still a number after all that',
     Number.isFinite(cov.filled) && Number.isFinite(cov.required),
     `${cov.filled}/${cov.required}`);
}

/* ============================== 4. the `declinedFrom` invariant holds ======= */

({ DB, EV, COV } = await bootWith(journalOf({
  added: [
    legacyEvent({
      id: 'ev-declines',
      shifts: [
        shiftOf({
          splits: [
            {
              id: 'sp-d',
              role: 'Event Steward',
              required: 3,
              tags: [],
              assignments: [
                // Declined before the field existed — reads as the confirmed case.
                { employeeId: 'e-old', status: 'declined', confirmation: 'declined' },
                // Declined from awaiting — cost nobody any coverage.
                { employeeId: 'e-aw', status: 'declined', confirmation: 'declined', declinedFrom: 'awaiting' },
                // Not declined, but carrying a stale field.
                { employeeId: 'e-ok', status: 'accepted', confirmation: 'confirmed', declinedFrom: 'confirmed' },
              ],
            },
          ],
        }),
      ],
    }),
  ],
})));

group('4. The `declinedFrom` invariant holds');

{
  const as = find(DB, 'ev-declines').shifts[0].splits[0].assignments;
  const by = (id) => as.find((a) => a.employeeId === id);

  ok('a record declined before the field existed reads as the confirmed case',
     by('e-old').declinedFrom === 'confirmed');
  ok('  · materialised, so it no longer depends on every reader remembering `?? \'confirmed\'`',
     'declinedFrom' in by('e-old'));
  ok('a decline from awaiting keeps that, so it is not charged as a drop-out',
     by('e-aw').declinedFrom === 'awaiting');
  ok('a record that is not declined carries no `declinedFrom` at all',
     !('declinedFrom' in by('e-ok')),
     `got ${JSON.stringify(by('e-ok').declinedFrom)}`);
}

/* ============================= 5. the journal key is the id ================= */

({ DB, EV, COV } = await bootWith(journalOf({
  edited: {
    // `apply()` splices into EVENTS on the KEY. A payload that disagrees would
    // put an event with the wrong id in the right slot.
    'ev-1': legacyEvent({ id: 'ev-999', name: 'Payload disagrees' }),
  },
})));

group('5. The journal key wins over a payload that disagrees');

{
  const ev = find(DB, 'ev-1');
  ok('the record landed under the key', !!ev);
  ok('  · and its id was reconciled to it', ev?.id === 'ev-1');
  ok('  · so the stale id is nowhere in EVENTS', !find(DB, 'ev-999'));
  ok('  · while the edit itself was kept', ev?.name === 'Payload disagrees');
}

/* ============================= 6. version handling ========================= */

({ DB, EV, COV } = await bootWith(journalOf({ v: 99, added: [legacyEvent()] })));

group('6. A journal from the future is not guessed at');

ok('a version this build does not understand is ignored',
   !find(DB, 'ev-legacy'));
ok('  · and the seed is still intact behind it', DB.EVENTS.length > 0);

({ DB, EV, COV } = await bootWith(journalOf({ v: 2, added: [legacyEvent({ id: 'ev-v2' })] })));
ok('the current version reads back', !!find(DB, 'ev-v2'));

/* ============================= 7. it survives a reload ===================== */

group('7. It survives a reload');

{
  // Start from a v1 journal, touch the event so the module rewrites it, reload.
  ({ DB, EV, COV } = await bootWith(journalOf({ added: [legacyEvent()] })));

  const before = find(DB, 'ev-legacy');
  EV.assign(before.id, before.shifts[0].splits[0].id, ['e-3']);

  const stored = JSON.parse(store.get(EVENTS_KEY));
  ok('the journal was rewritten at the current version', stored.v === 2,
     `v is ${stored.v}`);

  ({ DB, EV, COV } = await boot());
  const after = find(DB, 'ev-legacy');

  ok('the event is still there after the reload', !!after);
  ok('  · with the repair still applied', Array.isArray(after?.locations));
  ok('  · the original assignments intact',
     after?.shifts[0].splits[0].assignments.some((a) => a.employeeId === 'e-1'));
  ok('  · and the new one too',
     after?.shifts[0].splits[0].assignments.some((a) => a.employeeId === 'e-3'));
  ok('  · nothing was dropped on the way through', EV.droppedOnLoad() === 0);
}

/* -------------------------------------------------------------------------- */

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
