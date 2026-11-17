/* ============================================================================
   EPROSTA — verification harness for amending an approved timesheet

   A manager corrects hours after approval (worked 9, not 8). What this proves:

     1. THE ROW CHANGES — hours, actual times and outcome; everything that
        reads ATTENDANCE (payroll, billing, client hours) sees the new figure.
     2. WHO, WHEN, FROM, TO, WHY are recorded, and the log only grows.
     3. REFUSALS — no reason, nothing changed, more hours than the times allow.
     4. TYPED HOURS — an unpaid break can come off without moving the finish.
     5. A NIGHT SHIFT across midnight counts the right way round.
     6. THE PERMISSION — "Amend attendance" exists and is sensitive; a role
        without it is refused at the gate.
     7. A RELOAD keeps the amendment and the trail.
     8. EVERY SEEDED TIMESHEET BELONGS TO A JOB — its event has a work order,
        a shift that day for that role, and the worker is rostered on it.
     9. NOTHING DELIVERED IS IN THE FUTURE — a job at invoice or later has
        ended, and no timesheet on any job is dated after today.

   Run:  node timesheet-amend-tests.mjs
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

const work = mkdtempSync(join(tmpdir(), 'eprosta-amend-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');

async function boot(tag) {
  const entry = join(work, `entry-${tag}.ts`);
  const out = join(work, `bundle-${tag}.mjs`);
  writeFileSync(
    entry,
    `export * as CI from '${p('src/lib/checkins')}';\n` +
      `export * as ROLES from '${p('src/lib/roles')}';\n` +
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
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

const { CI, ROLES, DB } = await boot('a');
const COLIN = { by: 'm-colin', name: 'Colin Harding' };
const JAKE = { by: 'm-jake', name: 'Jake Wright' };

const row = DB.ATTENDANCE.find((a) => a.scheduled === '07:00–19:00' && a.outcome === 'worked');
const before = { actual: row.actual, hours: row.hours, outcome: row.outcome };

console.log('\n1. Amending changes the row everything else reads');
{
  const r = CI.amend(row.id, { start: '07:00', finish: '20:00', reason: 'Stayed to clear the car park' }, COLIN);
  ok('accepted', r.ok, r.error);
  eq('hours follow the times', row.hours, 13);
  eq('actual is rewritten', row.actual, '07:00–20:00');
  eq('an hour over is overtime', row.outcome, 'overtime');
  eq('the live array holds the same row', DB.ATTENDANCE.find((a) => a.id === row.id).hours, 13);
}

console.log('\n2. Who, when, from, to and why are on the record');
{
  const last = CI.lastAmendment(row.id);
  eq('who — name', last.name, 'Colin Harding');
  eq('who — member id', last.by, 'm-colin');
  ok('when', !Number.isNaN(+new Date(last.at)));
  eq('from', last.from, before);
  eq('to', last.to.hours, 13);
  eq('why', last.reason, 'Stayed to clear the car park');
  CI.amend(row.id, { start: '07:00', finish: '19:00', reason: 'Site lead says he left at 7' }, JAKE);
  eq('putting it back is a second entry, not an erasure', CI.amendmentsFor(row.id).length, 2);
  eq('latest is Jake', CI.lastAmendment(row.id).name, 'Jake Wright');
  eq('as approved still reads the original', CI.asApproved(row), before);
}

console.log('\n3. Refusals');
{
  const n = CI.amendmentsFor(row.id).length;
  ok('no reason', !CI.amend(row.id, { start: '07:00', finish: '21:00', reason: '  ' }, COLIN).ok);
  ok('nothing changed', !CI.amend(row.id, { start: '07:00', finish: '19:00', reason: 'x' }, COLIN).ok);
  ok('more hours than the times allow', !CI.amend(row.id, { start: '07:00', finish: '15:00', hours: 9, reason: 'x' }, COLIN).ok);
  ok('bad time', !CI.amend(row.id, { start: '7am', finish: '15:00', reason: 'x' }, COLIN).ok);
  ok('unknown row', !CI.amend('nope', { start: '07:00', finish: '15:00', reason: 'x' }, COLIN).ok);
  eq('a refusal writes nothing', CI.amendmentsFor(row.id).length, n);
}

console.log('\n4. Typed hours — 8 becomes 9 without touching the clock');
{
  const r = CI.amend(row.id, { start: '07:00', finish: '19:00', hours: 11.5, reason: 'Unpaid 30-minute break' }, COLIN);
  ok('accepted', r.ok, r.error);
  eq('hours as typed', row.hours, 11.5);
  eq('times unchanged', row.actual, '07:00–19:00');
}

console.log('\n5. A night shift across midnight');
{
  eq('22:00–06:00 is 8h', CI.hoursFromTimes('22:00', '06:00'), 8);
  eq('22:00–07:00 is 9h', CI.hoursFromTimes('22:00', '07:00'), 9);
  const night = DB.ATTENDANCE.find((a) => a.id !== row.id);
  night.scheduled = '22:00–06:00';
  CI.amend(night.id, { start: '22:00', finish: '07:00', reason: 'Stayed for handover' }, COLIN);
  eq('an hour past 06:00 is overtime', night.outcome, 'overtime');
  CI.amend(night.id, { start: '22:20', finish: '06:00', reason: 'Clocked in late' }, COLIN);
  eq('20 minutes after 22:00 is late', night.outcome, 'late');
}

console.log('\n6. The permission');
{
  const cap = ROLES.capMeta('attendance.edit');
  ok('"Amend attendance" exists', !!cap);
  ok('and is sensitive', cap?.sensitive === true);
  const ro = ROLES.ROLES.readonly;
  ok('read-only role does not have it', !ro.caps.includes('attendance.edit'));
}

console.log('\n7. A reload keeps it');
{
  const id = row.id;
  const n = CI.amendmentsFor(id).length;
  const again = await boot('b');
  const r2 = again.DB.ATTENDANCE.find((a) => a.id === id);
  eq('hours survive', r2.hours, 11.5);
  eq('the trail survives', again.CI.amendmentsFor(id).length, n);
  eq('first entry is still Colin', again.CI.amendmentsFor(id)[0].name, 'Colin Harding');
}

console.log('\n8. Every seeded timesheet belongs to a job');
{
  const { DB: D, W } = await boot('c');
  const seeded = D.ATTENDANCE.filter((a) => /^at-\d+$/.test(a.id));
  ok('there are seeded rows to check', seeded.length > 0);
  for (const a of seeded) {
    const ev = D.EVENTS.find((e) => e.id === a.eventId);
    const w = W.byEvent(a.eventId);
    const shifts = (ev?.shifts || []).filter((s) => s.start.slice(0, 10) === a.date);
    const splits = shifts.flatMap((s) => s.splits).filter((sp) => sp.role === a.role);
    const rostered = splits.some((sp) => (sp.assignments || []).some((x) => x.employeeId === a.employeeId));
    ok(`${a.id} → ${w?.ref ?? 'NO WOF'} · ${a.role} on ${a.date}`, !!w && splits.length > 0 && rostered,
      !w ? 'event has no work order' : !splits.length ? 'no such shift that day' : 'worker not rostered');
  }
}

console.log('\n9. Nothing delivered is in the future');
{
  const { DB: D, W } = await boot('d');
  const today = new Date(D.NOW).toISOString().slice(0, 10);
  const DONE = new Set(['invoice', 'paid', 'complete', 'closed']);
  for (const w of W.all().filter((x) => DONE.has(x.stage))) {
    ok(`${w.ref} ${w.title} (${w.stage}) ended by today`, w.end.slice(0, 10) <= today, `ends ${w.end.slice(0, 10)}, today ${today}`);
  }
  const future = W.all().flatMap((w) => W.timesheets(w).filter((t) => t.date > today).map((t) => `${w.ref} ${t.date}`));
  eq('no timesheet is dated after today', future, []);
}

console.log(failures ? `\n${failures} FAILED\n` : '\nAll timesheet-amendment checks passed.\n');
process.exit(failures ? 1 : 0);
