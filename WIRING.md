# What is wired, and what is not

A running record of which actions in the console change real state, so nobody
has to click one to find out. Updated as each phase lands.

**Rule for this file:** if an action is listed as wired, clicking it changes
state that survives a reload. If it is listed as not wired, it should say so in
the UI too — a control that acknowledges a click and changes nothing is the
failure this whole exercise exists to remove.

---

## The clock

`NOW` is real wall-clock time (`src/data/clock.ts`). The sample data is moved
forward to meet it by a whole number of weeks, pinned at first run, so every
seeded event keeps its weekday and the data sits within a few days of today
however long after July 2026 you open the app.

Consequences worth knowing:

- Records you create are stored with absolute dates and stamped with the offset
  in force. Change the offset and the stores discard state written under the old
  one, rather than mixing two time frames.
- `reanchor()` in `clock.ts` moves the whole world to today. It does not move
  records you have created — clear the other stores if you use it.

---

## Phase 1 — the staffing spine · **done**

### Stores

| Module | Owns | Persists as |
|---|---|---|
| `lib/events.ts` | Events, shifts, role groups, assignments, locations | `eprosta.events.v1` |
| `lib/checkins.ts` | Check-in approvals, and the attendance rows they write | `eprosta.checkins.v1` |
| `lib/notifications.ts` | Raised messages, read and dismissed state | `eprosta.notifications.v1` |

All three follow the pattern set by `lib/schedules.ts`: journal over seed,
`subscribe`/`emit`, and a `use…Version()` hook in `lib/useStore.ts`.

One deliberate difference. `clients.ts` and `schedules.ts` journal individual
field edits, so seed improvements keep landing on records you have touched. An
event is four levels deep, and reconciling a seed edit against a user deletion
at every level fails silently. So the granularity for events is the whole
event: touch any part of one and it is stored whole from then on. Events you
have never touched still track the seed.

### Wired on `/events`

- **New event** — controlled form, validated, real record. Refuses a blank
  name, a missing client, a duplicate name, and an end before the start.
- **Edit / Copy / Delete event.** Copy duplicates shifts and role groups but
  not staff. Delete offers an undo.
- **Send callout** — recorded in Notifications, disabled when there is no gap.
- After any save the filters move to the new row, so it cannot be created into
  a hidden state. A brand new event has no shifts, so "Needs staff" would
  otherwise hide it every time.
- An event with no shifts reads **"No shifts yet"**, not "Fully staffed".

### Wired on `/events/:id`

- Add, edit and delete **shifts**; day index derived from the event start.
- Add, edit, duplicate and delete **role groups**, with requirements.
- **Assign manually** — workers land as *invited / awaiting*, never confirmed.
- **Change status**, singly or in bulk. Confirmation and response move together.
- **Remove from shift**, singly or in bulk, with undo.
- **Notify selected** — the message text is recorded against the event.
- **Locations** — add, edit, remove. **Additional information** — edit.
- **Requires accreditation** — writes through instead of sitting in component
  state.
- **Check-ins** — approve, adjust-times-and-approve, reject, approve all clean.
  Approval writes an attendance row, so payroll sees it, and marks the
  assignment confirmed and checked in.
- **Exports** produce real CSV files. The accreditation list is one row per
  person, not per assignment, so nobody gets four passes for four days.

### The invariant this rests on

`split.required` and `assignment.confirmation` are the only stored facts.
Everything else — filled, gap, awaiting, coverage tone, urgency — is derived by
`lib/coverage.ts`. **Assigning somebody does not fill a role.** Confirming them
does. `events-tests.mjs` asserts this directly; it is the guard against the four
irreconcilable numbers the live app showed for one shift.

### Verification

```
npm test              # all three suites
npm run test:events   # 78 assertions, this phase
```

The events suite bundles the modules with esbuild, shims `localStorage`, and
re-imports a fresh bundle to simulate a reload — so "it survives a reload" is a
tested claim, not a hope.

---

## Answering an invitation · **done**

Open jobs and My shifts split the world between them: work you *could* apply
for, and work with your name on it. An invitation belongs to the second, so it
leaves the first — `openRoles()` excludes any split the worker is on. That part
was always right and is the answer to "why can't he see the job he was invited
to".

What was wrong was the decline. Three bugs, one interaction:

**The dialog made a promise the code did not keep.** It said "this puts the role
back on the open list", while `openRoles()` excluded every split the worker had
*any* assignment on, declined or not. The role left their open jobs for good and
sat in My shifts marked declined. `Assignment.declinedFrom` now records what was
given up, and the rule has two halves:

| They declined | Result |
|---|---|
| an invitation they never accepted | straight back on their open jobs |
| a shift they had **confirmed** | staffing must invite them again |

Which matches the strike rule already in place: dropping out costs the team
coverage, turning work down does not.

**`assign()` could not re-invite anybody.** It skipped every employee already on
the group — including declined ones — so the "staffing must invite them again"
half of that rule had no working way to be carried out. The operator picked the
name, the dialog reported success, nothing happened. A declined worker is now
re-invited in place, resetting their record rather than pushing a second one
next to it.

**The worker's answer was never journalled.** `StaffShifts.tsx` wrote
`assignment.confirmation` straight into the shared object. The operator's
coverage bar moved — both screens read the same object — and then the answer
evaporated on reload, so a worker who confirmed on Friday was back to "awaiting"
on Monday. Confirm and decline now go through `events.respond()`, which commits.

### On the card

The action row branches on `confirmation`. An unanswered invitation is a
question with two answers and is laid out as one — "Yes, I'll be there" and
"No, I can't make it" together. A confirmed shift is not a question, so the only
thing offered is a way out, at the far end where it cannot be hit by somebody
scanning for the primary action. The strike warning fires only on a confirmed
drop-out; threatening it for declining an invitation penalises somebody who has
done nothing wrong.

### Verification

```
npm run test:roles     # 117 assertions, 30 of them this
```

Both halves of the rule, the re-invite path, and survival of a reload for a
confirm and a decline. Checked against the old code: reverting the `openRoles`
filter fails 1, reverting `assign()` fails 3.

---

## Confirmation — one act, not three · **done**

Briefing §2.2 says a WOF that passes client sign-off "will seed the event
calendar and subsequently provide shifts for the staff allocation tool". That
is one sentence describing one act, and it was being implemented as three
clicks — record the signature, advance to sign-off, advance to order — with the
seeding hidden behind the third. A signed job could sit unstaffed for as long
as nobody remembered to finish clicking.

### What a signature now does

`signQuoteAndConfirm()` (`lib/wof.ts`) records the signature and then walks the
job to `order` **through** `signoff`, not over it, so the history keeps both
moments. On the way it:

| Step | Function | Result |
|---|---|---|
| Seeds the rota | `seedEvent` / `ensureStaffingEvent` | One shift per day of the run, role slots from the staff lines |
| Prepares the kit | `prepareKit` | A manifest held in the office — **no Hire Hop reference** |
| Stamps the date | `advance` | `orderedAt`, which every backfilled entry downstream derives from |

`signQuote()` still exists and still returns a `Signoff`, so nothing that called
it had to change. Callers that want to report what the signature created call
`signQuoteAndConfirm()` and pass the result to `describeConfirmation()`.

### Why the kit is prepared and not sent

The Hire Hop reference is assigned once and never reissued — two references for
one job means the warehouse holds two lists with no way to tell which
supersedes which. A quote can still gain a variation between sign-off and
picking, so sending on signature would burn the reference on a list nobody
should pick.

So `KitPrep` is a separate, weaker thing: a manifest with a timestamp and no
reference. `kitChangesSincePrep()` shows the office what has moved since the
client confirmed, while it is still free to fix. The push at stage 6 is
unchanged and still assigns the reference. Once it has, `prepareKit()` refuses
to rebuild — the warehouse's copy is the baseline from then on, and two
baselines would give the picking screen two answers to "what changed".

### What is deliberately NOT invented

- A **kit-only hire** becomes an order with no staffing event. An empty rota
  reading "0/0, fully staffed" is a queue of work that does not exist.
- A **staff-only job** gets no pick list rather than an empty one.
- A quote with **no priced lines** is not ordered at all. `confirmOrder()` never
  passes `force` — a signature is a fact about the client, not a licence to skip
  a check about us. The reason comes back in `Confirmation.blocked` and the
  toast says so instead of claiming success.

### Before it happens

`orderPreview()` computes the same numbers without creating any of them, from
the same `seedShifts()` the real thing uses. The sign dialog renders it: "seeds
7 shifts, 41 roles to fill; prepares 3 kit lines (58 items)". A control that
does more than it says is the failure this rebuild exists to remove.

### Verification

```
npm run test:confirm   # 62 assertions
```

Covers the stage walk and its history order, the seeded shift and role counts
against the quantities sold, the absence of a Hire Hop reference at prep time,
kit-only and staff-only jobs, the blocked case, idempotence, preview-versus-
actual, and survival of a reload.

---

## Client rates and the client record · **done**

### Stores

| Module | Owns | Persists as |
|---|---|---|
| `lib/rates.ts` | Prices agreed with one client for one charge line | `eprosta.rates.v1` |
| `lib/clientfiles.ts` | The account's own documents — metadata | `eprosta.clientdocs.v1` |
| `lib/clientfiles.ts` | …and the files themselves | IndexedDB `eprosta-client-files` |

The rate CARD an account sits on is a field on the client (`rateCardId`) and is
journalled by `lib/clients.ts` with the rest of the record, not here — it is a
fact about the account, and putting it in two stores would give it two answers.

### How a line is priced

```
an agreed price   beats   the account's card   beats   the published rate
```

Written down once, in `RATES.rateFor`, which is what `W.line()` calls. A card
is a FACTOR on the published table (`RATE_CARDS` in `db.ts`), not a copy of it,
so an April rate rise reaches all three cards at once and no card can hold last
year's price. Volume breaks scale with the headline, or a card discount would
evaporate at the moment the client books the volume it was given for.

Nothing here re-prices work already quoted. `LineItem.snap` still freezes the
rate onto the job; moving a line onto a new agreement is `repriceLine`, which
is deliberate, audited and one line at a time. Overtime is the deliberate
exception — `raiseOvertimeVariation` passes the original line's snap, because
an overrun is the same hour of the same shift and must not arrive on the
invoice at a second rate.

### Who may do it

`clients.rates` — "Agree client rates" — and deliberately NOT `charges.edit`.
Setting a price for one account is what the person who negotiated it does;
changing the published table every client is priced from is Finance's. Folding
the first into the second means either an account manager cannot honour a deal
they signed, or they can move every client's price in order to do it.

Held by Senior Manager, Client Manager, Finance and Super Admin. Operations has
`clients.edit` but not this — its own blurb says no pay rates. It covers both
the agreed price list and moving an account between cards; the confirm dialog
shows every line that moves before the button is pressed.

### Every screen shows the price it will charge

`rateAt(id, NOW)` is the PUBLISHED rate and belongs only where there is no
account in hand — the table of charges. Anywhere a WOF or a client is in scope,
prices come from `RATES.rateFor(id, w.clientId, NOW)`: the deployment builder's
role picker and totals, the add-line dialog, and `ChargePicker` (which takes a
`clientId`). Each says whose prices they are and what the published figure was,
so a number that is not on the rate card explains itself rather than looking
like a bug.

Group 9 of the test suite is the regression: what a preview offers must equal
what `addLine` charges, for an agreed line, a card line and a published-rate
account — asserted against the rendered markup, because that is where the two
disagreed the first time.

### The client record

`/clients/:id` (`pages/ClientDetail.tsx`) — Details, Requirements, Rates,
Documents, Work & events. It replaces the modal the register used to open; the
old `?id=` deep link redirects to it. `?tab=rates` and `?tab=documents` are
linkable.

### Documents

Real files, held in IndexedDB in this browser and nowhere else. When the
browser refuses to keep the bytes — a private window, a full disk — the record
is still written with `stored: false` and the row says so. A register that
quietly loses the document is worse than one that never claimed to have it.

### Verification

```
npm run test:client-rates   # 74 assertions
```

Card arithmetic and tier scaling, the order of precedence, a quote line taking
the account's rate, an agreement not reaching backwards, a card not counting as
staleness, below-cost refusal, the margin floor, moving cards, document expiry
states, the record-only path, the permission split (a role can agree a client
rate without holding the rate card), and the page rendering at its own URL.

---

## Not yet wired

Phase 2 — approvals and attendance beyond the event screen:

- `/checkins` — the standalone approvals queue. Still reads the raw seed; needs
  pointing at `lib/checkins.ts`, which already has everything it needs.
- `/attendance` — read-only today.
- `/notifications` — read and dismissed state is still component-local; needs
  pointing at `lib/notifications.ts`.
- The top-bar bell counts from the seed and does not agree with the page it
  links to.

Phase 3 — the rest:

- `/settings/team` — invites and role assignment.
- `/staff` — CSV export, bulk actions.
- `/job-types` — reference data edits. (`/charges` now edits rates and shows
  all three cards; adding a staff or service line is still stock-register only.)
- `/wofs/:id` — a few menu items ("View rate history").
- `Shell.tsx` — "Sign out", personal account settings.

### Things that cannot work locally

Not lies, just absent services. Where these appear the UI should say so:

- Email, SMS and push delivery. Callouts and messages are *recorded*; nothing
  leaves the browser. The notify dialog states this.
- Hire Hop push, DocuSign, and the payroll run itself. The kit list *prepared*
  on confirmation is real state and survives a reload; only the API call that
  would carry it to Hire Hop is absent.
