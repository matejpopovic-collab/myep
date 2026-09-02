/* ============================================================================
   EPROSTA — verification harness for availability
   ----------------------------------------------------------------------------
   EP Team runs two workbooks. One holds the jobs and who is assigned to them.
   The other holds, in twelve monthly tabs of free text, where each of 68 people
   is on each day. Nothing joins them, so a person can be booked onto a Saturday
   in one file and booked off in the other, and the first anyone knows is when
   they do not turn up.

   `src/lib/availability.ts` exists to make that a query. This proves the claims
   it makes:

     1. ONE ENTRY PER PERSON PER DAY — the invariant is the storage key, so a
        second entry for the same day is not rejected, it is unrepresentable.

     2. THREE DEGREES OF UNAVAILABLE, NOT ONE — approved leave refuses a
        booking; a pending request warns; a warehouse day informs. The workbook
        has one colour for all three, which is why reading it needs a phone
        call.

     3. LEAVE IS BOOKED IN BLOCKS — and a block skips the weekend, because
        nobody books Saturday off work they were not doing.

     4. AN APPROVAL HAS AN APPROVER — `Sheet25` shows the team reconstructing
        this months later from memory. A decision with no actor is a rumour.

     5. THE CONFLICT QUERY IS THE WHOLE POINT — booked and booked off, found by
        derivation, which neither workbook can express.

     6. NOTHING IS STORED THAT CAN BE DERIVED — the leave balance is counted
        from the days, so it cannot disagree with them.

     7. CLEARING IS NOT THE SAME AS OFF — and it survives a reload, which is the
        hard half.

   Run: npm run test:availability
   ========================================================================== */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
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

const AVAIL_KEY = 'eprosta.availability.v1';

/* ---------------------------------------------------------------- bundle --- */

const work = mkdtempSync(join(tmpdir(), 'eprosta-avail-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');

let generation = 0;

async function boot() {
  generation += 1;
  const entry = join(work, `entry-${generation}.ts`);
  const out = join(work, `bundle-${generation}.mjs`);
  writeFileSync(
    entry,
    `export * as DB from '${p('src/data/db')}';\n` +
      `export * as AV from '${p('src/lib/availability')}';\n` +
      `export * as EV from '${p('src/lib/events')}';\n` +
      `export * as COV from '${p('src/lib/coverage')}';\n`,
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

const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => {
  const o = new Date(d);
  o.setDate(o.getDate() + n);
  return o;
};
/** A date `n` days out that is a Monday, so weekend rules are never in play. */
function mondayFromNow(n) {
  const d = addDays(new Date(), n);
  while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
  return iso(d);
}

let { DB, AV, EV, COV } = await boot();

const ME = DB.TEAM[0].id;
const APPROVER = DB.TEAM.find((t) => t.band === 'Staffing and Compliance').id;

/* ============================================= 1. the register and the seed = */

group('1. The register is the workbook, minus the things that are not people');

ok('the permanent team is 68 people', DB.TEAM.length === 68, `got ${DB.TEAM.length}`);
ok('  · across the twelve bands the workbook groups them into',
   DB.TEAM_BANDS.length === 12);
ok('  · with no duplicate ids', new Set(DB.TEAM.map((t) => t.id)).size === DB.TEAM.length);
ok('  · the robots are not staff', !DB.TEAM.some((t) => /robot/i.test(t.name)));
ok('  · and neither is "Additional Cover"',
   !DB.TEAM.some((t) => /additional cover|duty phone/i.test(t.name)));
ok('the six MANAGERS records are carried through, not orphaned',
   ['m-colin', 'm-gracie', 'm-pete', 'm-jenny', 'm-jake', 'm-fd']
     .every((id) => !!DB.teamForManager(id)));

ok('a seeded day never has two entries',
   (() => {
     const seen = new Set();
     return DB.DAY_ENTRIES.every((e) => {
       const k = `${e.personId}|${e.date}`;
       if (seen.has(k)) return false;
       seen.add(k);
       return true;
     });
   })());

/* ================================== 2. one entry per person per day ========= */

group('2. One entry per person per day — by construction, not by validation');

{
  const day = mondayFromNow(3);
  AV.set(ME, day, 'annual-leave', { approvedBy: APPROVER });
  ok('setting a day writes it', AV.stateFor(ME, day)?.kind === 'annual-leave');

  AV.set(ME, day, 'training');
  ok('setting the same day again REPLACES rather than duplicating',
     AV.all().filter((e) => e.personId === ME && e.date === day).length === 1);
  ok('  · and the second value is the one that stuck',
     AV.stateFor(ME, day)?.kind === 'training');

  ok('an unknown day state is refused', !AV.set(ME, day, 'on-the-moon').ok);
  ok('a malformed date is refused', !AV.set(ME, 'next tuesday', 'off').ok);
  ok('  · and neither left a mark',
     AV.all().filter((e) => e.personId === ME && e.date === day).length === 1);
}

/* ============================ 3. three degrees of unavailable ============== */

group('3. Three degrees of unavailable, not one');

{
  const a = mondayFromNow(10);
  const b = mondayFromNow(17);
  const c = mondayFromNow(24);

  AV.set(ME, a, 'annual-leave', { approvedBy: APPROVER });
  AV.set(ME, b, 'annual-leave', { status: 'requested' });
  AV.set(ME, c, 'warehouse', { hours: '08:00-17:00' });

  ok('approved leave BLOCKS', AV.isBlocked(ME, a));
  ok('  · so they are not available that day', !AV.availableOn(ME, a));
  ok('  · and the reason is in words, not a code',
     /annual leave/i.test(AV.blockReason(ME, a) ?? ''), AV.blockReason(ME, a));

  ok('a request that has not been granted does NOT block', !AV.isBlocked(ME, b));
  ok('  · but it is pending, so it can be warned about', AV.isPending(ME, b));
  ok('  · and they are still bookable today', AV.availableOn(ME, b));

  ok('a warehouse day does not block either', !AV.isBlocked(ME, c));
  ok('  · it is a commitment, which is a different thing', AV.isCommitted(ME, c));
  ok('  · and it has no block reason to give', AV.blockReason(ME, c) === null);

  ok('freeOn() leaves out only the blocked one',
     !AV.freeOn(a, [ME]).includes(ME) &&
     AV.freeOn(b, [ME]).includes(ME) &&
     AV.freeOn(c, [ME]).includes(ME));
}

/* ================================ 4. leave is booked in blocks ============= */

group('4. Leave is booked in blocks, and a block knows about weekends');

{
  const from = mondayFromNow(31);
  const to = iso(addDays(new Date(`${from}T00:00:00`), 6)); // Mon → Sun
  const sat = iso(addDays(new Date(`${from}T00:00:00`), 5));

  /* Captured BEFORE the write, because the seed is generated relative to today
     and can legitimately already hold something on that Saturday — a rostered
     day off, in the run that caught this. The claim `skipWeekends` makes is
     that setRange did not TOUCH the weekend, not that the register happened to
     be empty there, and asserting the second one made the test pass or fail on
     where in the week the calendar had drifted to. */
  const satBefore = JSON.stringify(AV.stateFor(ME, sat));

  const r = AV.setRange(ME, from, to, 'annual-leave', {
    approvedBy: APPROVER,
    skipWeekends: true,
  });
  ok('a Monday-to-Sunday range writes five days, not seven',
     r.ok && r.written === 5, `wrote ${r.written}`);
  ok('  · the Saturday was left exactly as it was',
     JSON.stringify(AV.stateFor(ME, sat)) === satBefore,
     `${sat}: ${satBefore} → ${JSON.stringify(AV.stateFor(ME, sat))}`);
  ok('  · and it is certainly not annual leave',
     (AV.stateFor(ME, sat) || {}).kind !== 'annual-leave');
  ok('  · and every weekday in it is blocked',
     AV.datesBetween(from, to)
       .filter((d) => ![0, 6].includes(new Date(`${d}T00:00:00`).getDay()))
       .every((d) => AV.isBlocked(ME, d)));

  ok('datesBetween is inclusive at both ends',
     AV.datesBetween(from, to).length === 7);
  ok('  · and does not care which way round it is given',
     AV.datesBetween(to, from).length === 7);

  const req = AV.request(ME, mondayFromNow(45), iso(addDays(new Date(`${mondayFromNow(45)}T00:00:00`), 2)), 'toil', 'Long weekend');
  ok('a request writes days that are pending, not granted',
     req.ok && AV.isPending(ME, mondayFromNow(45)));
}

/* ================================ 5. an approval has an approver =========== */

group('5. An approval has an approver');

{
  const day = mondayFromNow(52);
  AV.set(ME, day, 'annual-leave', { status: 'requested' });

  ok('approving with nobody named is refused', !AV.approve(ME, day, '').ok);
  ok('  · so it is still pending', AV.isPending(ME, day));

  const done = AV.approve(ME, day, APPROVER);
  ok('approving records who did it', done.ok && done.entry.approvedBy === APPROVER);
  ok('  · and it now blocks', AV.isBlocked(ME, day));

  const day2 = mondayFromNow(59);
  AV.set(ME, day2, 'annual-leave', { status: 'requested' });
  const no = AV.decline(ME, day2, APPROVER, 'Peak week — embargo');
  ok('declining records who did it too', no.ok && no.entry.approvedBy === APPROVER);
  ok('  · a declined request does not block', !AV.isBlocked(ME, day2));
  ok('  · and it is no longer pending either', !AV.isPending(ME, day2));

  ok('a bank holiday carries no approver, because nobody decided it',
     (() => {
       const d = mondayFromNow(66);
       AV.set(ME, d, 'bank-holiday', { approvedBy: APPROVER });
       return AV.stateFor(ME, d).approvedBy === null;
     })());

  ok('the pending queue holds what is actually outstanding',
     AV.pendingRequests().every((e) => e.status === 'requested'));
}

/* ============================ 6. the conflict query ======================== */

group('6. Booked and booked off — the query neither workbook can express');

{
  const ev = DB.EVENTS.find((e) => e.shifts.length && e.shifts[0].splits.length);
  const shift = ev.shifts[0];
  const split = shift.splits[0];
  const date = shift.start.slice(0, 10);

  // Book somebody who is free, then put them on leave behind the booking —
  // which is exactly how it happens: the two files are edited by two people.
  const victim = DB.EMPLOYEES.map((e) => e.id).find((id) => AV.availableOn(id, date));
  EV.assign(ev.id, split.id, [victim]);
  ok('a free worker is booked without complaint',
     split.assignments.some((a) => a.employeeId === victim));

  AV.set(victim, date, 'annual-leave', { approvedBy: APPROVER });

  const found = AV.conflicts(date, date);
  const mine = found.find((c) => c.personId === victim && c.eventId === ev.id);
  ok('the clash is found by derivation, with nothing stored to say so', !!mine);
  ok('  · at blocking severity', mine?.severity === 'blocking');
  ok('  · naming the person, the job and the reason',
     !!mine && mine.reason.includes(mine.personName) && mine.reason.includes(ev.name));
  ok('  · and the badge count sees it', AV.conflictCount() > 0);

  ok('worst first, so the refusals are at the top',
     (() => {
       const order = { blocking: 0, pending: 1, committed: 2 };
       return found.every((c, i) => i === 0 || order[found[i - 1].severity] <= order[c.severity]);
     })());

  // A declined assignment is not a booking, so it cannot clash with anything.
  const before = AV.conflicts(date, date).length;
  const a = split.assignments.find((x) => x.employeeId === victim);
  a.confirmation = 'declined';
  ok('a declined assignment is not a clash', AV.conflicts(date, date).length === before - 1);
  a.confirmation = 'awaiting';

  // And the refusal path, from the other side.
  const r = EV.assign(ev.id, split.id, [victim]);
  ok('re-booking somebody now on leave is refused by name',
     r.assigned === 0 && r.refused[0]?.employeeId === victim);
}

/* ============================ 7. nothing stored that can be derived ======== */

group('7. The leave balance is counted, never stored');

{
  const year = new Date().getFullYear();
  const counted = AV.all().filter(
    (e) => e.personId === ME && e.kind === 'annual-leave' &&
      e.status !== 'declined' && Number(e.date.slice(0, 4)) === year,
  ).length;
  const b = AV.leaveBalance(ME, year);
  ok('taken + booked + requested equals the days themselves',
     b.taken + b.booked + b.requested === counted,
     `${b.taken}+${b.booked}+${b.requested} vs ${counted}`);

  /* The balance is a count PER YEAR, so it has to be read for the year the
     booked day actually falls in. Reading this year's while booking a day 73
     days out is the same assertion for ten months and a broken one from the
     middle of October, when that day lands in January. */
  const day = mondayFromNow(73);
  const bookedYear = Number(day.slice(0, 4));
  const was = AV.leaveBalance(ME, bookedYear);
  AV.set(ME, day, 'annual-leave', { approvedBy: APPROVER });
  const now = AV.leaveBalance(ME, bookedYear);
  ok('booking one more day moves the balance by exactly one',
     now.taken + now.booked + now.requested ===
       was.taken + was.booked + was.requested + 1,
     `${day}: ${was.taken}+${was.booked}+${was.requested} → ${now.taken}+${now.booked}+${now.requested}`);
}

/* ============================ 8. clearing, and the reload ================== */

group('8. Clearing is not the same as being off, and it survives a reload');

{
  const seeded = DB.DAY_ENTRIES.find((e) => e.personId.startsWith('tm-'));
  ok('a seeded entry is there to begin with',
     AV.stateFor(seeded.personId, seeded.date) !== null);

  ok('clearing it removes it', AV.clear(seeded.personId, seeded.date).ok);
  ok('  · so the day says nothing, rather than saying "off"',
     AV.stateFor(seeded.personId, seeded.date) === null);
  ok('  · which is not the same as being unavailable',
     AV.availableOn(seeded.personId, seeded.date));
  ok('clearing a day with nothing on it is refused',
     !AV.clear(seeded.personId, seeded.date).ok);

  const keptDay = mondayFromNow(10);
  const stored = JSON.parse(store.get(AVAIL_KEY));
  ok('the journal is keyed on person and date, not a record id',
     Object.keys(stored.set).every((k) => k.includes('|')));

  ({ DB, AV, EV, COV } = await boot());

  ok('the leave booked before the reload is still booked',
     AV.isBlocked(ME, keptDay));
  ok('  · the cleared seed entry is still cleared',
     AV.stateFor(seeded.personId, seeded.date) === null);
  ok('  · and the approver survived',
     AV.stateFor(ME, mondayFromNow(52))?.approvedBy === APPROVER);
}

/* ============================ 9. a corrupt journal cannot lie ============== */

group('9. A journal entry whose payload disagrees with its key is corrected');

{
  const day = mondayFromNow(80);
  store.set(
    AVAIL_KEY,
    JSON.stringify({
      v: 1,
      set: {
        [`${ME}|${day}`]: {
          // Payload claims a different person and a different day.
          personId: 'tm-nobody', date: '1999-01-01',
          kind: 'annual-leave', status: 'approved', note: '', hours: null,
          approvedBy: APPROVER, at: '2026-01-01T00:00:00Z', id: 'de-x',
        },
        [`${ME}|${mondayFromNow(87)}`]: { kind: 'not-a-state' },
      },
      cleared: [],
    }),
  );

  ({ DB, AV, EV, COV } = await boot());

  ok('the key wins — the entry lands on the right person and day',
     AV.stateFor(ME, day)?.kind === 'annual-leave');
  ok('  · and the payload\'s claimed identity is nowhere',
     AV.stateFor('tm-nobody', '1999-01-01') === null);
  ok('an entry with an unknown state is dropped, not rendered',
     AV.stateFor(ME, mondayFromNow(87)) === null);
}

/* -------------------------------------------------------------------------- */

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
