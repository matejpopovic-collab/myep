/* ============================================================================
   EPROSTA — verification harness for quote lines longer than the job
   ----------------------------------------------------------------------------
   A quote line carries a duration — days for kit, hours for staff — and nothing
   tied that duration to the job it was being quoted against. Ten days of Heras
   fence on a six-day event priced four days nobody is on site for, and the
   dialog said nothing.

   The check REFUSES the line. Billing time the job does not have over-quotes
   the client, and the fix — shorten the line, or correct the job dates — is
   always in front of the operator.

     1. THE DAY COUNT IS THE ONE THE ROTA USES — the refusal has to be measured
        against the same definition the shifts are built from, or an operator is
        told "6 days" by one screen and sold 7 shifts by another.

     2. HOURS ARE HOURS WORKED, NOT HOURS ELAPSED — a job running 09:00-18:00
        over six days is 54 hours of work. Measuring against the 129 hours
        between its first morning and its last evening counts five nights when
        nobody is on site, and let 100 hours a head look reasonable.

     3. IT COUNTS DURATION, NOT QUANTITY — 7 fence panels on a 6-day event is
        fine. 7 DAYS of fence on a 6-day event is not.

   Run:  node quote-span-tests.mjs
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

const work = mkdtempSync(join(tmpdir(), 'eprosta-quote-span-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');

async function boot() {
  const entry = join(work, 'entry.ts');
  const out = join(work, 'bundle.mjs');
  writeFileSync(
    entry,
    `export * as DB from '${p('src/data/db')}';\n` +
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

const { DB, W } = await boot();
const charge = (id) => DB.CHARGES.find((c) => c.id === id);

/* ========================================================================== */
section('1. The day count is the one the rota is built from');

// The reported job: Tue 1 Sep 09:00 -> Sun 6 Sep 18:00.
const job = W.create({
  title: 'SPAN TESTER',
  start: '2026-09-01T09:00:00',
  end: '2026-09-06T18:00:00',
});

ok('a job starting on six dates counts as six days', W.eventDays(job) === 6, String(W.eventDays(job)));

// The rule that motivated the count: a shift crossing midnight is ONE night's
// work, not two days. Counting calendar dates would sell a second shift.
const overnight = W.create({
  title: 'SPAN TESTER OVERNIGHT',
  start: '2026-07-31T18:00:00',
  end: '2026-08-01T03:00:00',
});
ok('an overnight is one day, not two', W.eventDays(overnight) === 1, String(W.eventDays(overnight)));

const sameDay = W.create({
  title: 'SPAN TESTER SINGLE',
  start: '2026-09-01T09:00:00',
  end: '2026-09-01T18:00:00',
});
ok('a single day is one day', W.eventDays(sameDay) === 1, String(W.eventDays(sameDay)));

/* ========================================================================== */
section('2. A hire longer than the job is refused');

const heras = charge('ch-kit-heras');   // day
const steward = charge('ch-st-event');  // hour
const hivis = charge('ch-kit-hivis');   // each

ok('10 days of kit on a 6-day job is refused', !!W.spanBlock(job, heras.id, 10));
ok('  · and the refusal names both numbers',
  /\b10\b/.test(W.spanBlock(job, heras.id, 10) || '') &&
  /\b6\b/.test(W.spanBlock(job, heras.id, 10) || ''),
  W.spanBlock(job, heras.id, 10));

ok('exactly the length of the job is silent', W.spanBlock(job, heras.id, 6) === null);
ok('shorter than the job is silent', W.spanBlock(job, heras.id, 5) === null);

/* ========================================================================== */
section('3. Hours are measured in hours, and quantity is left alone');

// 09:00-18:00 across six days is 54 hours of work. The 129 hours of wall clock
// between the first morning and the last evening are not hours anyone works.
ok('the job is 54 working hours long', W.eventHours(job) === 54, String(W.eventHours(job)));
ok('  · not the 129 hours of wall clock', W.eventHours(job) !== 129);
ok('100 hours a head on a 54-hour job is refused', !!W.spanBlock(job, steward.id, 100));
ok('  · and the refusal says what to do about it',
  /shorten|change the job dates/i.test(W.spanBlock(job, steward.id, 100) || ''),
  W.spanBlock(job, steward.id, 100));
ok('  · but a normal 10-hour shift is fine', W.spanBlock(job, steward.id, 10) === null);

// `each` is a count of things, not a duration. 20 hi-vis vests is a stock
// decision, and nothing about the length of the job bounds it.
ok('a per-item charge is never warned about', W.spanBlock(job, hivis.id, 20) === null);

/* ========================================================================== */
section('4. A line that fits is added, unaltered');

// The refusal is the dialog's job — `addLine` stays a dumb writer, the same way
// `advance()` trusts `gate()` rather than re-deciding. What matters here is that
// a legitimate line is untouched by any of the above.
const before = W.quoteLines(job).length;
W.addLine(job, heras.id, { qty: 7, units: 6 });
ok('a line the length of the job is added', W.quoteLines(job).length === before + 1);
ok('  · with the days the operator asked for, unaltered',
  W.quoteLines(job).some((l) => l.chargeId === heras.id && l.units === 6));

/* ========================================================================== */
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
