/* ============================================================================
   EPROSTA — verification harness for the build / event / break split

   A job's span is not all the same kind of day. A festival sold as 28 Aug ->
   3 Sep is two build days, three event days and two breakdown days. Before
   `liveFrom` / `liveTo` the only record of that was the wording of a quote
   line, read back by a regex that assumes build is day one and breakdown is
   the last day — wrong the moment a job has two build days.

   This proves the claims the field makes:

     1. ABSENT MEANS ALL EVENT — every WOF raised before the field existed, and
        every single-day job, still reads as wholly event. A default that
        invented a build day would rewrite the history of the seed.

     2. THE WINDOW IS CLAMPED TO THE SPAN — a window set against a longer job
        and then shortened must not label a day the job no longer has, and must
        not return a backwards range.

     3. EVERY DAY GETS EXACTLY ONE KIND — build before, event inside, break
        after, with no gap and no overlap at the boundaries.

     4. THE SUMMARY COUNTS WHAT IT SAYS — the words on the WOF screen add up to
        the length of the job, and stay silent when there is nothing to say.

     5. AN OVERNIGHT IS STILL ONE DAY — the split counts the same days the rota
        does, so a taxi marshal job running 18:00 -> 03:00 is one event day and
        not one event day plus a break day on the far side of midnight.

   Run:  node livewindow-tests.mjs

   Same bundling trick as `multiday-tests.mjs`: everything must come from ONE
   bundle, or there are two copies of the store and the results mean nothing.
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

const work = mkdtempSync(join(tmpdir(), 'eprosta-livewindow-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');

async function boot() {
  const entry = join(work, 'entry.ts');
  const out = join(work, 'bundle.mjs');
  writeFileSync(entry, `export * as W from '${p('src/lib/wof')}';\n`);
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

let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

const { W } = await boot();

/** A WOF-shaped object — only the fields the split reads. */
const job = (start, end, liveFrom, liveTo) => ({ start, end, liveFrom, liveTo });

/* -- 1. absent means all event ------------------------------------------- */
console.log('\n1. A job with no window set is wholly event');
{
  const week = job('2026-08-28T09:00:00', '2026-09-03T18:00:00');
  const lw = W.liveWindow(week);
  eq('seven-day job spans seven days', lw.days, 7);
  eq('window starts on day 1', lw.from, 1);
  eq('window ends on the last day', lw.to, 7);
  eq('day 1 is an event day, not a build day', W.dayKind(week, 1), 'event');
  eq('day 7 is an event day, not a breakdown', W.dayKind(week, 7), 'event');
  eq('nothing to say on the WOF screen', W.phaseSummary(week), null);

  const oneDay = job('2026-09-01T09:00:00', '2026-09-01T18:00:00');
  eq('single-day job is one day', W.liveWindow(oneDay).days, 1);
  eq('single-day job is an event day', W.dayKind(oneDay, 1), 'event');
  eq('single-day job says nothing', W.phaseSummary(oneDay), null);
}

/* -- 2. clamped to the span ---------------------------------------------- */
console.log('\n2. A window is clamped to the job it belongs to');
{
  // Set when the job ran seven days, then the job was shortened to three.
  const shortened = job('2026-08-28T09:00:00', '2026-08-30T18:00:00', 3, 5);
  const lw = W.liveWindow(shortened);
  eq('span is three days', lw.days, 3);
  ok('window ends inside the job', lw.to <= lw.days, `to=${lw.to} days=${lw.days}`);
  ok('window is not backwards', lw.from <= lw.to, `from=${lw.from} to=${lw.to}`);

  const past = job('2026-08-28T09:00:00', '2026-08-30T18:00:00', 9, 12);
  ok('a window entirely past the end still lands inside', W.liveWindow(past).to <= 3);

  const zero = job('2026-08-28T09:00:00', '2026-08-30T18:00:00', 0, 2);
  eq('day zero is not a day', W.liveWindow(zero).from, 1);

  const backwards = job('2026-08-28T09:00:00', '2026-08-31T18:00:00', 3, 2);
  const b = W.liveWindow(backwards);
  ok('an inverted window is not returned inverted', b.from <= b.to, `from=${b.from} to=${b.to}`);
}

/* -- 3. one kind per day, no gaps ---------------------------------------- */
console.log('\n3. Every day of the span gets exactly one kind');
{
  // 28 Aug -> 3 Sep, event on days 3-5: two build, three event, two break.
  const fest = job('2026-08-28T09:00:00', '2026-09-03T18:00:00', 3, 5);
  const kinds = [1, 2, 3, 4, 5, 6, 7].map((d) => W.dayKind(fest, d));
  eq('the run reads build, build, event, event, event, break, break',
     kinds.join(','), 'build,build,event,event,event,break,break');

  const counts = kinds.reduce((m, k) => ({ ...m, [k]: (m[k] || 0) + 1 }), {});
  eq('every day is accounted for', kinds.length, W.liveWindow(fest).days);
  eq('two build days', counts.build, 2);
  eq('three event days', counts.event, 3);
  eq('two break days', counts.break, 2);

  // The boundaries are where an off-by-one lives.
  eq('the day before the window is build', W.dayKind(fest, 2), 'build');
  eq('the first day of the window is event', W.dayKind(fest, 3), 'event');
  eq('the last day of the window is event', W.dayKind(fest, 5), 'event');
  eq('the day after the window is break', W.dayKind(fest, 6), 'break');

  const buildOnly = job('2026-08-28T09:00:00', '2026-09-03T18:00:00', 3, 7);
  eq('a job with no break days has none', [1,2,3,4,5,6,7].filter((d) => W.dayKind(buildOnly, d) === 'break').length, 0);
  const breakOnly = job('2026-08-28T09:00:00', '2026-09-03T18:00:00', 1, 4);
  eq('a job with no build days has none', [1,2,3,4,5,6,7].filter((d) => W.dayKind(breakOnly, d) === 'build').length, 0);
}

/* -- 4. the summary adds up ---------------------------------------------- */
console.log('\n4. The summary on the WOF screen counts what it says');
{
  const fest = job('2026-08-28T09:00:00', '2026-09-03T18:00:00', 3, 5);
  const text = W.phaseSummary(fest) || '';
  console.log(`        "${text}"`);
  const nums = (text.match(/\d+/g) || []).map(Number);
  eq('the parts sum to the length of the job', nums.reduce((a, b) => a + b, 0), 7);
  ok('it names build days', /build/.test(text), text);
  ok('it names event days', /event/.test(text), text);
  ok('it names break days', /break/.test(text), text);

  const noBuild = job('2026-08-28T09:00:00', '2026-09-03T18:00:00', 1, 5);
  ok('a job with no build days does not claim any', !/\bbuild/.test(W.phaseSummary(noBuild) || ''), W.phaseSummary(noBuild));

  const single = job('2026-08-28T09:00:00', '2026-09-03T18:00:00', 4, 4);
  ok('one event day is singular', /1 event day\b/.test(W.phaseSummary(single) || ''), W.phaseSummary(single));
}

/* -- 5. it counts the days the rota counts -------------------------------- */
console.log('\n5. The split counts the same days the rota does');
{
  // The overnight case multiday-tests guards: 18:00 -> 03:00 is ONE night's
  // work across two dates. If the split counted dates it would invent a second
  // day and call it breakdown.
  const night = job('2026-07-31T18:00:00', '2026-08-01T03:00:00');
  eq('an overnight is one day', W.liveWindow(night).days, 1);
  eq('an overnight is one event day', W.dayKind(night, 1), 'event');
  eq('an overnight claims no breakdown', W.phaseSummary(night), null);

  const fest = job('2026-08-28T09:00:00', '2026-09-03T18:00:00', 3, 5);
  eq('the split and the rota agree on length', W.liveWindow(fest).days, W.eventDays(fest));

  // Two ways of asking the same question must not disagree.
  const viaHelper = W.spanWindowsOf(fest.start, fest.end).length;
  eq('spanWindowsOf agrees with eventDays', viaHelper, W.eventDays(fest));
}

/* -- 6. the calendar asks by date ----------------------------------------- */
console.log('\n6. A calendar cell can ask what kind of day its date is');
{
  // 4 -> 10 Sep, event on days 3-6: two build days (4th, 5th), four event days
  // (6th-9th), one break day (10th).
  const party = job('2026-09-04T09:00:00', '2026-09-10T18:00:00', 3, 6);
  const on = (d) => W.dayKindOn(party, new Date(2026, 8, d));

  eq('4 Sep is a build day', on(4), 'build');
  eq('5 Sep is a build day', on(5), 'build');
  eq('6 Sep is the first event day', on(6), 'event');
  eq('9 Sep is the last event day', on(9), 'event');
  eq('10 Sep is a break day', on(10), 'break');

  eq('the day before the job is not the job', on(3), null);
  eq('the day after the job is not the job', on(11), null);

  // Asking by date and asking by day number must not disagree.
  const byNumber = [1, 2, 3, 4, 5, 6, 7].map((n) => W.dayKind(party, n));
  const byDate = [4, 5, 6, 7, 8, 9, 10].map(on);
  eq('by date agrees with by day number', byDate.join(','), byNumber.join(','));

  // A job with no window set answers 'event' for every date it covers, so the
  // calendar draws today's chips exactly as it did before the field existed.
  const plain = job('2026-09-04T09:00:00', '2026-09-10T18:00:00');
  eq('an unset job is event on its first day', W.dayKindOn(plain, new Date(2026, 8, 4)), 'event');
  eq('an unset job is event on its last day', W.dayKindOn(plain, new Date(2026, 8, 10)), 'event');

  // The overnight the rota counts as one day: the shift belongs to the 31st,
  // and the 1st must not come back as a second, later phase.
  const night = job('2026-07-31T18:00:00', '2026-08-01T03:00:00');
  eq('the night belongs to the date it starts', W.dayKindOn(night, new Date(2026, 6, 31)), 'event');
  eq('the morning after is the same day, not a break day', W.dayKindOn(night, new Date(2026, 7, 1)), 'event');
  eq('two days before is not the job', W.dayKindOn(night, new Date(2026, 6, 29)), null);

  // Time of day on the probe must not matter — a cell is a date.
  eq('a probe at midnight reads the same', W.dayKindOn(party, new Date(2026, 8, 5, 0, 0)), 'build');
  eq('a probe at 23:00 reads the same', W.dayKindOn(party, new Date(2026, 8, 5, 23, 0)), 'build');
}

/* -- report --------------------------------------------------------------- */
console.log(`\n${failures ? `${failures} FAILED` : 'All checks passed.'}\n`);
process.exit(failures ? 1 : 0);
