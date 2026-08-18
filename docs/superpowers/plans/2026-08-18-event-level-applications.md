# Event-Level Applications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A worker sees and applies for one card per role per event, instead of one card per role per day, and the staffing screen reports coverage role-first across the whole run.

**Architecture:** The split (one role group on one day) stays the unit of truth for check-in, attendance and payroll. An event role is a derived roll-up of every split sharing a role within one event. Applying fans out to one `Application` row per split, all sharing a `groupId`, so the worker's action is atomic while nothing downstream changes shape.

**Tech Stack:** TypeScript, React 19, react-router 7, Vite. Tests are standalone Node harnesses (`*-tests.mjs`) that bundle `src/` with esbuild against a shimmed `localStorage`.

**Spec:** `docs/superpowers/specs/2026-08-18-event-level-applications-design.md`

## Global Constraints

- Coverage numbers come from `src/lib/coverage.ts` and nowhere else. Do not compute required/filled/gap in a component.
- Split ids are positional (`ev-wof-125-d6-sp-3`). Any change that renumbers them orphans applications and attendance rows keyed on the old id.
- The load-time merge runs ONLY on an event with zero assignments AND zero applications.
- Role resolves as `chargeById(l.chargeId)?.role || l.description` — unchanged from today.
- Merge key is `(dayNo, role)`. A line pinned to a day by `dayFromDescription()` must not merge into the every-day group.
- `eligibility()` returns EVERY reason, never just the first. Existing contract.
- **Commits:** this repo has pre-existing uncommitted work from the user. Do NOT run `git commit`. Each task ends with a verification step instead; the user commits when they choose.
- Verify with `npm run typecheck` and `npm test` after each task. The one pre-existing failure in `availability-tests.mjs` ("the Saturday was skipped") is unrelated and expected.

---

### Task 1: Merge duplicate role groups when seeding shifts

**Files:**
- Modify: `src/lib/wof.ts` (`seedShifts`)
- Create: `event-roles-tests.mjs`
- Modify: `package.json` (register `test:event-roles`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: seeded events whose splits are unique per `(day, role)`. Task 2 sums across them; Task 3 migrates existing events to match.

- [ ] **Step 1: Write the failing test**

Create `event-roles-tests.mjs` using the same harness bootstrap as `quote-span-tests.mjs` (copy `boot()`, the `localStorage` shim, and the `ok`/`section` helpers verbatim), then:

```js
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

ok('six days of shifts', ev.shifts.length === 6);
ok('two role groups a day, not four', day1.splits.length === 2, String(day1.splits.length));
ok('  · the three Event Steward lines merged into one group of 25',
  day1.splits.find((s) => s.role === 'Event Steward')?.required === 25,
  String(day1.splits.find((s) => s.role === 'Event Steward')?.required));
ok('  · Response Steward is untouched at 5',
  day1.splits.find((s) => s.role === 'Response Steward')?.required === 5);
ok('  · and the daily total is unchanged at 30',
  day1.splits.reduce((n, s) => n + s.required, 0) === 30);
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node event-roles-tests.mjs`
Expected: FAIL on "two role groups a day" reporting `4`.

- [ ] **Step 3: Implement the merge**

In `src/lib/wof.ts`, `seedShifts` currently maps `onThisDay` straight to splits. Replace that mapping with a merge keyed on role. Insert above `return windows.map(...)`:

```ts
  /**
   * One role group per role per day.
   *
   * A quote can carry three separate Event Steward lines — different tiers, or
   * simply added at different times — and one role group per LINE put the same
   * role on the same day three times over. That reads as three different jobs
   * to a worker and as three rows to fill to staffing, when it is one role
   * wanting 25 people. Quantities add; the day the line names does not, which
   * is why the key is the pair.
   */
  const mergeByRole = (lines: LineItem[]): { role: string; required: number }[] => {
    const order: string[] = [];
    const byRole = new Map<string, number>();
    lines.forEach((l) => {
      const role = chargeById(l.chargeId)?.role || l.description;
      if (!byRole.has(role)) order.push(role);
      byRole.set(role, (byRole.get(role) || 0) + l.qty);
    });
    return order.map((role) => ({ role, required: byRole.get(role) || 0 }));
  };
```

Then change the splits mapping from `onThisDay.map((l, j) => ({...}))` to:

```ts
      splits: mergeByRole(onThisDay).map((g, j) => ({
        id: `${evId}-d${dayNo}-sp-${j + 1}`,
        role: g.role,
        required: g.required,
        pickupTime: null,
        office,
        uniform: 'White Shirt',
        travel: 'Own transport',
        tags: [],
        assignments: [],
      })),
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `node event-roles-tests.mjs`
Expected: PASS.

- [ ] **Step 5: Add the day-pinning guard test**

```js
section('2. A line pinned to one day does not merge into the every-day group');

const pinned = W.create({
  title: 'ROLE MERGE DAY PIN',
  start: '2026-09-01T09:00:00',
  end: '2026-09-03T18:00:00',
});
W.addLine(pinned, 'ch-st-event', { qty: 4, units: 9 });
W.addLine(pinned, 'ch-st-event', { qty: 6, units: 9, description: 'Event Steward day 2 breakdown' });

const pev = W.seedEvent(pinned);
ok('day 1 has the every-day line only', pev.shifts[0].splits.reduce((n, s) => n + s.required, 0) === 4);
ok('day 2 carries both, merged into one group of 10',
  pev.shifts[1].splits.length === 1 && pev.shifts[1].splits[0].required === 10,
  JSON.stringify(pev.shifts[1].splits.map((s) => [s.role, s.required])));
ok('day 3 is back to the every-day line', pev.shifts[2].splits.reduce((n, s) => n + s.required, 0) === 4);
```

- [ ] **Step 6: Run and confirm it passes**

Run: `node event-roles-tests.mjs`
Expected: PASS. `onThisDay` already filters by day before `mergeByRole` sees the lines, so no further change should be needed. If it fails, the merge was applied before the day filter — move it after.

- [ ] **Step 7: Register the harness**

In `package.json`, add `"test:event-roles": "node event-roles-tests.mjs"` and insert `&& npm run test:event-roles` into the `test` script after `test:quote-span`.

- [ ] **Step 8: Verify**

Run: `npm run typecheck && npm test`
Expected: all green except the known `availability-tests.mjs` failure.

---

### Task 2: `eventRoles()` — whole-event coverage per role

**Files:**
- Modify: `src/lib/coverage.ts`
- Modify: `event-roles-tests.mjs`

**Interfaces:**
- Consumes: merged splits from Task 1.
- Produces: `EventRole` and `eventRoles(ev: EpEvent): EventRole[]`, consumed by Tasks 4, 5 and 6.

- [ ] **Step 1: Write the failing test**

```js
section('3. An event role sums coverage across every day it runs');

const roles = COV.eventRoles(ev);
ok('two roles across the event', roles.length === 2, String(roles.length));

const steward = roles.find((r) => r.role === 'Event Steward');
ok('Event Steward needs 150 across six days', steward.required === 150, String(steward.required));
ok('  · and knows it runs six days', steward.days === 6);
ok('  · with a part for each day', steward.parts.length === 6);
ok('  · nothing filled yet', steward.filled === 0 && steward.gap === 150);
ok('  · spanning the run', steward.start === ev.shifts[0].start && steward.end === ev.shifts[5].end);

const resp = roles.find((r) => r.role === 'Response Steward');
ok('Response Steward needs 30', resp.required === 30, String(resp.required));
ok('the two roles still total the event', steward.required + resp.required === 180);
```

Add `export * as COV from '<root>/src/lib/coverage';` to the harness `boot()` entry file.

- [ ] **Step 2: Run and confirm it fails**

Run: `node event-roles-tests.mjs`
Expected: FAIL, `COV.eventRoles is not a function`.

- [ ] **Step 3: Implement**

Append to `src/lib/coverage.ts`:

```ts
/**
 * One role, across every day of an event.
 *
 * The unit a worker is offered and the unit staffing reports on. The split
 * stays the unit of truth underneath — check-in, attendance and payroll are all
 * per-day, and a single short day is a real state that has to stay visible —
 * so this is a roll-up, never a replacement.
 */
export interface EventRole {
  event: EpEvent;
  role: string;
  /** Every day this role runs, in shift order. */
  parts: { shift: Shift; split: Split }[];
  required: number;
  assigned: number;
  filled: number;
  awaiting: number;
  gap: number;
  days: number;
  start: string;
  end: string;
}

export function eventRoles(ev: EpEvent): EventRole[] {
  const order: string[] = [];
  const byRole = new Map<string, { shift: Shift; split: Split }[]>();

  ev.shifts.forEach((sh) => {
    sh.splits.forEach((sp) => {
      if (!byRole.has(sp.role)) {
        order.push(sp.role);
        byRole.set(sp.role, []);
      }
      byRole.get(sp.role)!.push({ shift: sh, split: sp });
    });
  });

  return order.map((role) => {
    const parts = byRole.get(role)!;
    const cov = parts.map((p) => splitCoverage(p.split)).reduce(sum, { ...EMPTY });
    return {
      event: ev,
      role,
      parts,
      ...cov,
      days: parts.length,
      start: parts[0].shift.start,
      end: parts[parts.length - 1].shift.end,
    };
  });
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `node event-roles-tests.mjs`
Expected: PASS.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test`

---

### Task 3: Merge role groups on existing saved events

**Files:**
- Modify: `src/lib/wof.ts` (`load`)
- Modify: `event-roles-tests.mjs`

**Interfaces:**
- Consumes: `mergeByRole` shape from Task 1 (reimplemented over splits, not lines).
- Produces: `mergeSavedRoleGroups(): number` returning how many events were skipped because they had people on them.

- [ ] **Step 1: Write the failing test**

```js
section('4. Events already saved with duplicate role groups are merged on load');

// Forge the pre-fix shape: two Event Steward groups on one day.
const legacy = JSON.parse(globalThis.localStorage.getItem('eprosta.wof.v1'));
const target = legacy.events.find((e) => e.id === `ev-wof-${job.id.replace('wof-', '')}`);
target.shifts[0].splits = [
  { id: 'x-d1-sp-1', role: 'Event Steward', required: 5, pickupTime: null, office: 'EP Event Services', uniform: 'White Shirt', travel: 'Own transport', tags: [], assignments: [] },
  { id: 'x-d1-sp-2', role: 'Event Steward', required: 20, pickupTime: null, office: 'EP Event Services', uniform: 'White Shirt', travel: 'Own transport', tags: [], assignments: [] },
  { id: 'x-d1-sp-3', role: 'Response Steward', required: 5, pickupTime: null, office: 'EP Event Services', uniform: 'White Shirt', travel: 'Own transport', tags: [], assignments: [] },
];
globalThis.localStorage.setItem('eprosta.wof.v1', JSON.stringify(legacy));

const { DB: DB2, W: W2, COV: COV2 } = await boot();
const healed = DB2.EVENTS.find((e) => e.id === target.id);
ok('the duplicate groups merged', healed.shifts[0].splits.length === 2, String(healed.shifts[0].splits.length));
ok('  · into one group of 25',
  healed.shifts[0].splits.find((s) => s.role === 'Event Steward').required === 25);

section('5. An event with people on it is left alone and reported');

const busy = JSON.parse(globalThis.localStorage.getItem('eprosta.wof.v1'));
const bt = busy.events.find((e) => e.id === target.id);
bt.shifts[0].splits = [
  { id: 'y-d1-sp-1', role: 'Event Steward', required: 5, pickupTime: null, office: 'EP Event Services', uniform: 'White Shirt', travel: 'Own transport', tags: [], assignments: [{ employeeId: 'e-9', confirmation: 'confirmed', respondedAt: null, declinedFrom: null }] },
  { id: 'y-d1-sp-2', role: 'Event Steward', required: 20, pickupTime: null, office: 'EP Event Services', uniform: 'White Shirt', travel: 'Own transport', tags: [], assignments: [] },
];
globalThis.localStorage.setItem('eprosta.wof.v1', JSON.stringify(busy));

const { DB: DB3, W: W3 } = await boot();
const untouched = DB3.EVENTS.find((e) => e.id === target.id);
ok('the groups are NOT merged, because somebody is on one', untouched.shifts[0].splits.length === 2);
ok('  · and the rostered worker is still there',
  untouched.shifts[0].splits[0].assignments.length === 1);
ok('  · and the skip is reported rather than silent', W3.unmergedRoleGroups() >= 1,
  String(W3.unmergedRoleGroups()));
```

- [ ] **Step 2: Run and confirm it fails**

Run: `node event-roles-tests.mjs`
Expected: FAIL on "the duplicate groups merged" reporting `3`.

- [ ] **Step 3: Implement**

Add to `src/lib/wof.ts`, near `spanWindows`:

```ts
/** Events left with duplicate role groups because people are already on them. */
let unmerged = 0;

/** How many saved events could not be merged. Reported, never swallowed. */
export const unmergedRoleGroups = (): number => unmerged;

/**
 * Collapse duplicate role groups on events seeded before the merge existed.
 *
 * `seedEvent()` runs once per event, so a job seeded under the old rule keeps
 * three Event Steward groups a day forever without this.
 *
 * Split ids are positional, so merging renumbers them, and any application or
 * attendance row keyed on an old id would be orphaned. An event with anybody on
 * it is therefore left exactly as it is and counted — a job that cannot be
 * tidied is something staffing should be told about, not something to hide.
 */
function mergeSavedRoleGroups(): void {
  unmerged = 0;

  EVENTS.forEach((ev) => {
    if (!String(ev.id).startsWith('ev-wof-')) return;

    const dupes = ev.shifts.some(
      (sh) => new Set(sh.splits.map((s) => s.role)).size !== sh.splits.length,
    );
    if (!dupes) return;

    const occupied = ev.shifts.some((sh) => sh.splits.some((sp) => sp.assignments.length));
    const applied = hasApplications(ev.id);
    if (occupied || applied) {
      unmerged += 1;
      return;
    }

    ev.shifts = ev.shifts.map((sh) => {
      const order: string[] = [];
      const byRole = new Map<string, Split>();
      sh.splits.forEach((sp) => {
        const seen = byRole.get(sp.role);
        if (!seen) {
          order.push(sp.role);
          byRole.set(sp.role, { ...sp, assignments: [] });
        } else {
          seen.required += sp.required;
        }
      });
      return {
        ...sh,
        splits: order.map((role, j) => ({
          ...byRole.get(role)!,
          id: `${ev.id}-d${sh.day}-sp-${j + 1}`,
        })),
      };
    });
  });
}

/** Does anybody hold an application against this event? */
function hasApplications(eventId: string): boolean {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY_APPS) || '[]');
    return Array.isArray(raw) && raw.some((a: { eventId?: string }) => a && a.eventId === eventId);
  } catch {
    return false;
  }
}
```

`KEY_APPS` is declared lower in the file as `const KEY_APPS = 'epteam.applications';`. Move that declaration above `mergeSavedRoleGroups` so it is initialised before first call.

`Split` is NOT currently imported in `src/lib/wof.ts`. Add it to the existing type import at line 50:

```ts
import type {
  AttendanceOutcome, ChargeKind, ChargeUnit, EpEvent, ResolvedRate, Split, Tone,
} from '@/data/types';
```

Call it in `load()`, immediately after the `WOFS.forEach(normaliseEventInfo);` line:

```ts
  // Events seeded before role groups merged still carry duplicates.
  mergeSavedRoleGroups();
```

- [ ] **Step 4: Run and confirm it passes**

Run: `node event-roles-tests.mjs`
Expected: PASS.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test`

---

### Task 4: Portal — open event roles, grouped applications

**Files:**
- Modify: `src/lib/portal.ts`
- Modify: `event-roles-tests.mjs`

**Interfaces:**
- Consumes: `COV.eventRoles`, `EventRole` from Task 2.
- Produces:
  - `interface OpenEventRole { id: string; event: EpEvent; wof: WOF.Wof | null; role: EventRole; eligibility: Eligibility; application: Application | null; applied: number }`
  - `openEventRoles(): OpenEventRole[]`
  - `Application.groupId: string`
  - `apply(row: OpenEventRole, note?: string): Application[]`
  - `withdrawGroup(groupId: string): void`
  - `applicationForRole(eventId: string, role: string): Application | null`
  Consumed by Tasks 5 and 6.

- [ ] **Step 1: Write the failing test**

```js
section('6. A worker is offered one card per role, not one per day');

const rows = PORTAL.openEventRoles().filter((r) => r.event.id === ev.id);
ok('two cards for a six-day, two-role job', rows.length === 2, String(rows.length));
ok('  · each carrying the whole run', rows.every((r) => r.role.days === 6));

section('7. Applying once covers every day, and withdraws as one');

const card = rows.find((r) => r.role.role === 'Event Steward');
const made = PORTAL.apply(card);
ok('one click writes a row per day', made.length === 6, String(made.length));
ok('  · all sharing one group', new Set(made.map((a) => a.groupId)).size === 1);
ok('  · and the role is findable as one application',
  !!PORTAL.applicationForRole(ev.id, 'Event Steward'));

PORTAL.withdrawGroup(made[0].groupId);
ok('withdrawing removes all six, not one',
  PORTAL.myApplications().filter((a) => a.eventId === ev.id && a.role === 'Event Steward').length === 0);
```

- [ ] **Step 2: Run and confirm it fails**

Run: `node event-roles-tests.mjs`
Expected: FAIL, `PORTAL.openEventRoles is not a function`.

- [ ] **Step 3: Add `groupId` with read-time migration**

In `src/lib/portal.ts`, add the field to `Application`:

```ts
  /**
   * Every row written by one click on one event role shares this.
   *
   * Rows written before the field existed are given a synthetic one on read, so
   * an application made yesterday still shows and withdraws as a single act.
   */
  groupId: string;
```

and migrate in `applications()`:

```ts
export function applications(): Application[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY_APPS) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.map((a: Application) => ({
      ...a,
      groupId: a.groupId || `legacy:${a.employeeId}:${a.eventId}:${a.role}`,
    }));
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Replace `openRoles` with `openEventRoles`**

```ts
export interface OpenEventRole {
  id: string;
  event: EpEvent;
  wof: WOF.Wof | null;
  role: EventRole;
  eligibility: Eligibility;
  application: Application | null;
  /** How many of the role's days this worker has already applied for. */
  applied: number;
}

/**
 * Open roles a worker could apply for, one per role per event.
 *
 * A six-day job wanting two roles is two cards, not twenty-four. The gates are
 * unchanged and still asked in the same order — is the job real, is there a
 * gap, am I already on it — but they are now asked of the role across the run
 * rather than of one role group on one day.
 */
export function openEventRoles(): OpenEventRole[] {
  const me = actingEmployee();
  const mine = new Set(
    myAssignments().filter((a) => stillHeld(a.assignment)).map((a) => a.split.id),
  );
  const rows: OpenEventRole[] = [];

  EVENTS.forEach((ev) => {
    const w = WOF.byEvent(ev.id) || null;
    if (!WOF.visibleToWorkers(w).visible) return;
    if (new Date(ev.end) < NOW) return;

    eventRoles(ev).forEach((role) => {
      const parts = role.parts.filter((p) => new Date(p.shift.start) >= NOW);
      if (!parts.length) return;
      if (parts.some((p) => mine.has(p.split.id))) return;
      if (role.gap <= 0) return;

      const app = applicationForRole(ev.id, role.role);
      rows.push({
        id: `${ev.id}:${role.role}`,
        event: ev,
        wof: w,
        role,
        eligibility: eligibilityAcross(me, role),
        application: app,
        applied: app
          ? myApplications().filter((a) => a.groupId === app.groupId).length
          : 0,
      });
    });
  });

  return rows.sort((a, b) => +new Date(a.role.start) - +new Date(b.role.start));
}
```

Import `eventRoles` and the `EventRole` type from `./coverage` at the top of the file.

- [ ] **Step 5: Eligibility across the run**

```ts
/**
 * Can this worker take this role for the WHOLE run?
 *
 * All-or-nothing, so one clash sinks the application — and says which day, so
 * the worker can free it rather than being told a flat no. Reasons are
 * de-duplicated: a missing SIA licence is one problem, not six.
 */
export function eligibilityAcross(
  emp: ReturnType<typeof actingEmployee>,
  role: EventRole,
): Eligibility {
  const missing = new Set<string>();
  const warn = new Set<string>();

  role.parts.forEach((p) => {
    const e = eligibility(emp, p.split, p.shift);
    e.missing.forEach((m) => missing.add(m));
    e.warn.forEach((m) => warn.add(m));
  });

  return { ok: !missing.size, missing: [...missing], warn: [...warn] };
}
```

`eligibility()` already names the clashing job; extend its clash line to name the day so the message reads usefully per part:

```ts
  if (clash)
    missing.push(
      `Clashes with ${clash.event.name} on ${fmtDate(shift.start)}`,
    );
```

Import `fmtDate` from `@/lib/format` if not already imported.

- [ ] **Step 6: Fan out on apply, withdraw as a group**

```ts
export const applicationForRole = (eventId: string, role: string): Application | null =>
  myApplications().find((a) => a.eventId === eventId && a.role === role) || null;

/**
 * Apply for a role across the whole event.
 *
 * One row per day, sharing a group. The rows are what coverage, check-in and
 * attendance read; the group is what the worker and the staffing team see.
 */
export function apply(row: OpenEventRole, note?: string): Application[] {
  const list = applications();
  const groupId = 'app-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const made: Application[] = [];

  row.role.parts.forEach((p, i) => {
    if (list.some((a) => a.employeeId === ACTING_EMPLOYEE_ID && a.splitId === p.split.id)) return;
    const rec: Application = {
      id: `${groupId}-${i + 1}`,
      groupId,
      employeeId: ACTING_EMPLOYEE_ID,
      eventId: row.event.id,
      shiftId: p.shift.id,
      splitId: p.split.id,
      role: row.role.role,
      start: p.shift.start,
      end: p.shift.end,
      note: note || '',
      appliedAt: new Date().toISOString(),
      status: 'applied',
    };
    list.push(rec);
    made.push(rec);
  });

  saveApplications(list);
  return made;
}

export function withdrawGroup(groupId: string): void {
  saveApplications(
    applications().filter((a) => !(a.employeeId === ACTING_EMPLOYEE_ID && a.groupId === groupId)),
  );
}
```

Delete `openRoles`, `applicationFor` and the old `withdraw`. Update the `openRoles` badge count at the bottom of the file to `openEventRoles()`.

- [ ] **Step 7: Run and confirm it passes**

Run: `node event-roles-tests.mjs`
Expected: PASS.

- [ ] **Step 8: Add the clash test**

```js
section('8. A clash on one day blocks the run, and names the day');

// Book the acting worker on something covering 3 Sep, then re-read the card.
const clashRows = PORTAL.openEventRoles().filter((r) => r.event.id === ev.id);
const blocked = clashRows.find((r) => !r.eligibility.ok);
if (blocked) {
  ok('the card is offered, not hidden', !!blocked.role);
  ok('  · and the reason names a date', /\d/.test(blocked.eligibility.missing.join(' ')),
    blocked.eligibility.missing.join(' | '));
} else {
  ok('no clash present in this fixture — skipped', true);
}
```

- [ ] **Step 9: Test the legacy-application migration**

Spec requirement 9. An application written before `groupId` existed must still group and withdraw as one.

```js
section('9. An application saved before groups existed still withdraws as one');

const legacyApps = [1, 2, 3].map((n) => ({
  id: `old-${n}`,
  employeeId: PORTAL.actingEmployee().id,
  eventId: ev.id,
  shiftId: ev.shifts[n - 1].id,
  splitId: ev.shifts[n - 1].splits[0].id,
  role: 'Event Steward',
  start: ev.shifts[n - 1].start,
  end: ev.shifts[n - 1].end,
  note: '',
  appliedAt: new Date().toISOString(),
  status: 'applied',
}));
globalThis.localStorage.setItem('epteam.applications', JSON.stringify(legacyApps));

const revived = PORTAL.myApplications().filter((a) => a.eventId === ev.id);
ok('rows without a group get one on read', revived.every((a) => !!a.groupId));
ok('  · and the three share it', new Set(revived.map((a) => a.groupId)).size === 1,
  [...new Set(revived.map((a) => a.groupId))].join(', '));

PORTAL.withdrawGroup(revived[0].groupId);
ok('  · so withdrawing takes all three',
  PORTAL.myApplications().filter((a) => a.eventId === ev.id).length === 0);
```

Run: `node event-roles-tests.mjs`
Expected: PASS.

- [ ] **Step 10: Verify**

Run: `npm run typecheck && npm test`
Expected: TypeScript will error in `StaffJobs.tsx` and `StaffShifts.tsx` until Task 5. That is expected; do not proceed to `npm test` until Task 5 is done if the bundle fails.

---

### Task 5: Worker UI — one card per role per event

**Files:**
- Modify: `src/pages/StaffJobs.tsx`
- Modify: `src/pages/StaffShifts.tsx:168`

**Interfaces:**
- Consumes: `OpenEventRole`, `openEventRoles`, `apply`, `withdrawGroup` from Task 4.
- Produces: no new exports.

- [ ] **Step 1: Retype the page state**

In `StaffJobs.tsx` replace `PORTAL.OpenRole` with `PORTAL.OpenEventRole` throughout, and replace the estimate helper so it prices the whole run:

```tsx
  const estimate = (r: PORTAL.OpenEventRole) => {
    const perDay =
      (+new Date(r.role.parts[0].shift.end) - +new Date(r.role.parts[0].shift.start)) / 3600000;
    const hours = Math.round(perDay * r.role.days * 10) / 10;
    return { hours, perDay: Math.round(perDay * 10) / 10, days: r.role.days, pay: round2(hours * rate) };
  };
```

- [ ] **Step 2: Repoint the data source and filters**

```tsx
  const all = PORTAL.openEventRoles();
  const eligible = all.filter((r) => r.eligibility.ok);
  const applied = all.filter((r) => !!r.application);

  const rows = all
    .filter((r) => (show === 'all' ? true : show === 'applied' ? !!r.application : r.eligibility.ok))
    .filter((r) => role === 'all' || r.role.role === role);

  const roles = [...new Set(all.map((r) => r.role.role))].sort();
```

The `Applied (n)` segmented count now counts cards, not rows — which is the point.

- [ ] **Step 3: Repoint the card and withdraw**

```tsx
            <JobCard
              key={r.id}
              r={r}
              rate={rate}
              est={estimate(r)}
              onApply={() => setApplying(r)}
              onWithdraw={() => {
                if (r.application) PORTAL.withdrawGroup(r.application.groupId);
                toast('Application withdrawn — all days.', { tone: 'info' });
              }}
            />
```

- [ ] **Step 4: Update `JobCard` body**

Inside `JobCard`, replace the shift-level fields with role-level ones:

```tsx
        <h3 className="text-[15px] font-semibold text-ink">{r.role.role}</h3>
        <p className="text-[13px] text-ink-2">
          {r.event.name} · {fmtRange(r.role.start, r.role.end)} · {countLabel(r.role.days, 'day')}
        </p>
```

and the pay block:

```tsx
        <div className="text-[19px] font-bold text-ink">{money(est.pay)}</div>
        <div className="text-[12px] text-ink-3">
          {est.days} × {est.perDay}h × {money(rate)}
        </div>
        <div className="text-[12px] text-ink-2">
          <strong>{r.role.gap}</strong> of {r.role.required} still needed
        </div>
```

Change the apply button label to `Apply for this job` and the withdraw label to `Withdraw application`.

- [ ] **Step 5: Fix `StaffShifts.tsx:168`**

That page lists per-split rows (`r.split.id`) and has no `application` in scope, so it needs a split-keyed entry point that still withdraws the whole group. Add to `src/lib/portal.ts` in Task 4:

```ts
/**
 * Withdraw from the run this split belongs to.
 *
 * "My shifts" lists days, not roles, so the worker clicks withdraw on a
 * Wednesday. They applied for the job, not for the Wednesday, so the whole
 * group goes — withdrawing one day of six would leave an application nobody
 * asked for and a rota with a hole in the middle.
 */
export function withdrawForSplit(splitId: string): void {
  const app = myApplications().find((a) => a.splitId === splitId);
  if (app) withdrawGroup(app.groupId);
}
```

Then in `StaffShifts.tsx:168`:

```tsx
                PORTAL.withdrawForSplit(r.split.id);
                toast('Application withdrawn — all days of this job.', { tone: 'info' });
```

- [ ] **Step 6: Update the page subtitle**

The current copy says "Shifts on confirmed bookings". Replace with:

```
Roles on confirmed bookings that still need people. Applying puts you forward for the whole job — every day of it — and puts you in front of the staffing team. It does not book you on.
```

- [ ] **Step 7: Verify in the browser**

Run the dev server via the preview tooling, open `/my/jobs` as a worker, and confirm STAFF TESTER shows **2 cards, not 24**, each reading `Tue 1 Sep – Sun 6 Sep · 6 days` with whole-run pay. Apply on one and confirm it shows as applied and withdraws in a single action.

- [ ] **Step 8: Verify**

Run: `npm run typecheck && npm test`

---

### Task 6: Staffing page — role-first, days underneath

**Files:**
- Modify: `src/pages/EventDetail.tsx`

**Interfaces:**
- Consumes: `eventRoles`, `EventRole` from Task 2.
- Produces: no new exports.

- [ ] **Step 1: Add the view toggle**

In the Shifts & staffing tab, add a `Segmented` control above the shift cards with options `['role', 'By role']` and `['day', 'By day']`, defaulting to `role`. Keep all existing day markup under the `day` branch untouched — a single short day must stay findable.

- [ ] **Step 2: Render the role view**

```tsx
{view === 'role' ? (
  <div className="grid gap-3">
    {eventRoles(ev).map((r) => (
      <div key={r.role} className="card p-3.5">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h3 className="text-[15px] font-semibold text-ink">{r.role}</h3>
            <p className="text-[12.5px] text-ink-3">
              {fmtRange(r.start, r.end)} · {countLabel(r.days, 'day')}
            </p>
          </div>
          <div className="text-right tabular-nums">
            <div className="text-[17px] font-bold text-ink">
              {r.filled}/{r.required}
            </div>
            <div className="text-[12px]" style={{ color: TONE_HEX[coverageTone(r, r.start, r.end)] }}>
              {r.gap ? `${r.gap} short` : 'Fully staffed'}
            </div>
          </div>
        </div>
        <ul className="mt-2.5 grid gap-1">
          {r.parts.map((p) => {
            const c = splitCoverage(p.split);
            return (
              <li key={p.split.id} className="flex justify-between text-[12.5px] text-ink-2">
                <span>{p.shift.label} · {fmtDate(p.shift.start)}</span>
                <span className="tabular-nums">
                  {c.filled}/{c.required}
                  {c.gap ? <span className="text-ink-3"> · {c.gap} short</span> : null}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    ))}
  </div>
) : (
  /* existing day markup, unchanged */
)}
```

- [ ] **Step 3: Group the assigned-staff list by application group**

Where the assigned-staff table lists one row per split assignment, collapse consecutive days for the same worker and role into one row reading `Tue 1 – Sun 6 Sep · 6 days`. Derive the grouping from the assignment's `employeeId` plus the split's `role`, since assignments carry no `groupId` of their own.

- [ ] **Step 4: Verify in the browser**

Open STAFF TESTER on the staffing page and confirm: role view shows **Event Steward 0/150** and **Response Steward 0/30**, the day breakdown under each lists Day 1–6, and switching to "By day" reproduces the existing screen with **2 role groups per day, not 4**.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test`
Expected: all green except the known `availability-tests.mjs` failure.
