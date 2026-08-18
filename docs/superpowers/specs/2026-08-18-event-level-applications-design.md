# Event-level applications

**Date:** 2026-08-18
**Status:** Approved for planning

## The problem

A worker looking at STAFF TESTER (WOF-2026-0125, Tue 1 Sep - Sun 6 Sep) sees the
same job offered 24 times: "Event Steward - STAFF TESTER - Day 1", four times
over, and again for each of six days. They apply day by day, or more likely
give up.

Two separate causes are stacked on top of each other.

**Per-day fan-out.** `openRoles()` in `src/lib/portal.ts` emits one row per
event x shift x split. Six shifts times four role groups is 24 rows. The unit a
worker is offered is a *split* - one role group on one day - because that is the
unit everything else in the app is keyed on.

**Duplicate role groups.** `seedShifts()` in `src/lib/wof.ts` creates one role
group per staff quote line. Three Event Steward lines (5, 10, 10) become three
separate Event Steward groups on every day, which is where 30/day and 180 total
come from. Nothing merges them, so even a per-event list would still show the
same role three times.

## Decisions

Settled with the user before design:

| Question | Decision |
|---|---|
| What is one card in the worker's list? | One card per **role, per event**. Applying puts them forward for every day. |
| Duplicate role groups | **Merge into one group per role**, per day. Totals unchanged. |
| Staffing page | **Role-first**, with the per-day breakdown kept underneath. |
| Storage | **Fan out on apply with a shared `groupId`.** |
| Worker who clashes on one day | **Show the card, blocked, naming the day.** |

### Why fan-out rather than an event-level record

The split has to remain the unit of truth. Check-ins, attendance and payroll are
all per-day, and a single day being short is a real operational state that has to
stay visible and fixable. An event-level application record would force coverage,
assignment and every reader of `splitId` to grow a second code path.

Fanning out keeps the per-day truth exactly where it is and makes the grouping
explicit rather than inferred. Deriving the group from
`(employeeId, eventId, role)` instead was rejected: it cannot distinguish a
complete application from one that has been partly withdrawn, which is precisely
the state an operator needs to see.

## Data model

### `EventRole` (new, in `src/lib/coverage.ts`)

`coverage.ts` already declares itself the single origin of every staffing figure
on every screen - the reason the four irreconcilable numbers the old app printed
for one Wilderness shift cannot come back. An event-level staffing figure belongs
there and nowhere else.

```ts
export interface EventRole {
  event: EpEvent;
  role: string;
  /** Every day this role runs, in shift order. */
  parts: { shift: Shift; split: Split }[];
  /** Summed across parts. */
  required: number;
  assigned: number;
  filled: number;
  awaiting: number;
  gap: number;
  days: number;
  start: string;
  end: string;
}

export function eventRoles(ev: EpEvent): EventRole[];
```

STAFF TESTER yields two: Event Steward 0/150, Response Steward 0/30.

### `Application` (changed, in `src/lib/portal.ts`)

One new field. Rows stay per-split.

```ts
export interface Application {
  // ...unchanged...
  /** Every row written by one click on one event role shares this. */
  groupId: string;
}
```

Rows saved before this field exists are migrated on read by synthesising a
`groupId` from `employeeId + eventId + role`, so an application made yesterday
still shows and withdraws as one unit.

## Changes by component

### `src/lib/wof.ts` - `seedShifts`

Group staff lines by resolved role **within each day** before building splits,
summing `qty` into `required`.

Day matters: `dayFromDescription()` can pin a line to a single day, and a line
that says "day 4 only" must not merge into the every-day group. Grouping key is
`(dayNo, role)`.

Role resolves as it does today: `chargeById(l.chargeId)?.role || l.description`.

### `src/lib/wof.ts` - load-time merge (migration)

`seedEvent()` runs once per event, so existing events keep their unmerged groups.
STAFF TESTER would not change without this.

Split ids are positional (`ev-wof-125-d6-sp-3`). Merging renumbers them, which
would orphan any application or attendance row pointing at an old id.

Therefore the load-time merge runs **only for an event with no assignments and
no applications**. Anything with people on it is left alone. The count of events
skipped is reported rather than silently swallowed - an event that cannot be
merged is a thing the operator should know about, not a thing to hide.

### `src/lib/portal.ts`

- `openRoles()` becomes `openEventRoles()`: one row per event role with `gap > 0`,
  sorted by event start.
- `apply(row, note?)` writes one `Application` per part, sharing a new `groupId`.
- `withdraw(groupId)` removes the whole group.
- `applicationFor(splitId)` becomes `applicationForRole(eventId, role)`.
- `eligibility()` evaluates across every shift in the role. Clash detection
  returns the offending day by name, and returns *all* reasons rather than the
  first - the existing contract.

### Worker card (`src/pages/StaffShifts.tsx`)

Shows the run and the whole-event pay:

```
Event Steward
STAFF TESTER - Tue 1 Sep to Sun 6 Sep - 6 days
Estimated pay  GBP 660        6 x 9h x GBP 12.21
25 of 25 still needed
[ Apply for this job ]
```

Blocked state keeps the card and disables the button:
`Clashes with Alresford Show on Wed 3 Sep`.

### Staffing page (`src/pages/EventDetail.tsx`)

The Shifts tab gains a role-first default: each `EventRole` with whole-event
coverage, expanding to its Day 1-6 parts. The existing day tabs remain as a
secondary "By day" view, because a single short day is still something to see
and fix.

Assigned-staff and applicant lists show one row per `groupId`, spanning the run,
rather than one row per day.

## Testing

New harness `event-roles-tests.mjs`, wired into `npm test`, following the
one-harness-per-concern layout already in the repo.

1. Three Event Steward lines seed **one** group of 25 per day; totals unchanged
   at 30/day and 180 overall.
2. A line pinned to day 4 does **not** merge into the every-day group.
3. `eventRoles()` sums required, filled and gap across all six days.
4. One `apply()` writes six rows sharing one `groupId`.
5. `withdraw(groupId)` removes all six, not one.
6. A clash on day 3 blocks the whole application and names day 3.
7. A day that is short on its own is still visible under its role.
8. The load-time merge skips an event that has assignments, and says it did.
9. An application saved without a `groupId` still groups and withdraws correctly.

## Risks and things deliberately not done

- **Merging is not reversible from the UI.** Once three Event Steward lines
  become one group of 25, nothing on screen records that it came from three quote
  lines. The user confirmed this is acceptable. If those lines ever need to be
  rostered or billed separately, this decision has to be revisited first.
- **All-or-nothing applying.** A worker free on five of six days can no longer
  apply for those five. This follows directly from the chosen card model and was
  accepted knowingly; the card explains which day is the problem.
- **Volume.** 25 stewards across 6 days is 150 assignments on one role. Well
  within what the in-memory model handles, but worth noting before anyone adds a
  per-assignment render cost.
- **Not touching** `qty` semantics on quote lines, the free-text day parsing in
  `dayFromDescription()`, or the callout flow. The note at `wof.ts` about a quote
  line carrying no real day field stands unchanged.
