/* ============================================================================
   EPROSTA — DOES THE SUITE STILL PASS NEXT MONTH?
   ----------------------------------------------------------------------------
   The app's clock is real (`clock.ts`: `NOW = new Date()`), and the seed is
   moved to meet it — shifted forward by a whole number of weeks from the date
   it was authored against. That is the right call for a demo that must never
   look like a museum, and it puts an expiry date on every test fixture written
   against a fixed calendar date.

   The failures it produced were not dramatic, which is the problem. A test
   asserting a Saturday was untouched passed until the seed's own rostered day
   off drifted onto it. A test measuring "did this line draw on one day" used
   one day's figure as the threshold for eighteen others, and held until an
   unrelated job moved into the window. A test booking leave 73 days out read
   this year's balance, and would have failed every October. None of them were
   product bugs, and all of them would have been read as one.

   So this harness asks the only question that catches them: does the suite
   still pass if today were a week from now, or a year?

   HOW
   ---
   It re-runs each `*-tests.mjs` in a child process with `Date` patched to
   report a date N days ahead. Nothing else changes: the seed anchors itself to
   that fake today exactly as it would on the day, so the fixtures land where
   they really will land.

     node drift-check.mjs                 # the default sweep, every harness
     node drift-check.mjs 45              # just "45 days from now"
     node drift-check.mjs 7 30 --only hop-tests.mjs

   A failure here is not necessarily a product bug. Read it as "this assertion
   is about the calendar and did not mean to be", and fix the fixture to
   compute its dates rather than name them.
   ========================================================================== */

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);

/* ------------------------------------------------------------ the child --- */

const runIndex = process.argv.indexOf('--run');
if (runIndex !== -1) {
  const offset = Number(process.argv[runIndex + 1]);
  const file = process.argv[runIndex + 2];
  const RealDate = Date;
  const shift = offset * 86400000;
  // Only the no-argument constructor and `now()` move. Everything that parses
  // or builds a specific date must behave exactly as it does today, or the
  // harness would be testing the shim.
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + shift);
      else super(...args);
    }
    static now() {
      return RealDate.now() + shift;
    }
  }
  globalThis.Date = FakeDate;
  await import(`./${file}`);
  // The harnesses print their own tally and set no exit code, so the parent
  // reads their output rather than their status.
} else {
  /* ----------------------------------------------------------- the parent -- */

  const args = process.argv.slice(2);
  const onlyAt = args.indexOf('--only');
  const only = onlyAt === -1 ? null : args[onlyAt + 1];
  const offsets = args
    .filter((a, i) => /^\d+$/.test(a) && (onlyAt === -1 || i < onlyAt))
    .map(Number);

  const OFFSETS = offsets.length ? offsets : [1, 7, 30, 100, 200, 400];
  const FILES = only
    ? [only]
    : readdirSync(ROOT).filter((f) => f.endsWith('-tests.mjs')).sort();

  const run = (offset, file) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [SELF, '--run', String(offset), file], { cwd: ROOT });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('close', () => {
        const fails = out.split('\n').filter((l) => /^\s*FAIL/.test(l) || /^FAIL /.test(l));
        resolve({ file, offset, fails, crashed: !/passed|checks passed/.test(out) });
      });
    });

  let bad = 0;
  for (const offset of OFFSETS) {
    console.log(`\n=== as if it were ${offset} day${offset === 1 ? '' : 's'} from now ===`);
    for (const file of FILES) {
      const r = await run(offset, file);
      if (r.crashed) {
        bad++;
        console.log(`  CRASH ${file}`);
      } else if (r.fails.length) {
        bad++;
        console.log(`  FAIL  ${file}`);
        r.fails.forEach((f) => console.log(`        ${f.trim()}`));
      }
    }
    console.log('  (nothing above means every harness passed at this offset)');
  }

  console.log(
    bad
      ? `\n${bad} harness/offset combination${bad === 1 ? '' : 's'} would fail. The fixture names a date it should compute.`
      : '\nThe suite holds at every offset checked. No fixture is counting on today being today.',
  );
  process.exit(bad ? 1 : 0);
}
