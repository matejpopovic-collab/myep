# EPROSTA — React rebuild

The `epteam-rebuild` prototype, ported to React 19 + TypeScript + Tailwind v4 on Vite.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build
npm run typecheck
```

## What changed and what did not

Every screen, number and design decision from the vanilla build survives. What
moved is the plumbing:

| Vanilla | React |
| --- | --- |
| 24 `.html` files, one script tag each | one SPA, routes in `src/App.tsx` |
| `window.DB`, `window.WOF`, `window.PORTAL` globals | ES modules under `src/data` and `src/lib` |
| `innerHTML` template strings + manual `wire()` | components with local state |
| Tailwind CDN + `tokens.js` config object | Tailwind v4 build dependency, `@theme inline` |
| `U.esc()` on every interpolation | JSX escapes by default |
| jsdom test harness (`wof-tests.js`) | `tsc --noEmit` + route render smoke test |

## Layout

```
src/
  data/       types.ts, db.ts        mock + reference data, typed
  lib/        wof.ts                 the WOF engine: stages, money, gates, store,
                                     client tasks and client-side mutations
              portal.ts              the three tiers, the acting client, scoping
              roles.ts               EP Team roles + capabilities, the `can()`
                                     predicate, invites, lockout guarantees
              rating.ts, flags.ts    worker rating, worker flags
              coverage.ts, format.ts staffing maths, one date/money format
              status.ts              status vocabulary + tone tokens
              useStore.ts            useSyncExternalStore bridges to the above
  components/ Shell, DataTable, Modal, Toast, Icon, primitives, wof-ui, rating
  pages/      one file per route
  styles/     app.css                design tokens, both themes, component classes
```

## Two things worth knowing before editing

**The theme trick.** `src/styles/app.css` declares every colour as a CSS custom
property twice — once on `:root` (light) and once on `.theme-dark` (the sidebar).
The `@theme inline` block is what makes Tailwind respect that: `inline` compiles
`bg-surface` to `background-color: var(--surface)` rather than resolving the
indirection once at `:root`. Drop the keyword and the sidebar renders white.

**The store is deliberately module-global.** `lib/wof.ts` keeps one array and a
version counter; screens read it through `useWofs()` / `useWofVersion()`
(`useSyncExternalStore`). That is on purpose — the whole product exists to keep
one number singular across the pipeline, the calendar, the reports and the
invoice, and threading it through providers would create a second copy of it.
Mutations go through the exported functions so every change writes to the WOF
history.

## Routes

| Tier | Routes |
| --- | --- |
| admin | `/wofs`, `/wofs/:id`, `/calendar`, `/events`, `/events/:id`, `/check-in-approvals`, `/attendance`, `/reports/{cashflow,costing,payroll,documents}`, `/charges`, `/clients`, `/schedules`, `/staff`, `/job-types`, `/notifications`, `/settings/team` |
| client | `/client/jobs`, `/client/jobs/:id`, `/client/events`, `/client/hours` |
| staff | `/my/jobs`, `/my/shifts`, `/my/pay`, `/my/documents` |

Tier access is enforced once, in `<Shell>`: typing an admin URL while acting as
a client redirects to the client home rather than rendering the page. Within the
client tier there is a second guard — `portal.clientJob()` returns `null` for
another client's work order, so a guessed URL yields "not found" rather than a
leak.

The "Viewing as" switcher in the top bar is a prototype device, not a product
feature — real tiers come from the account you sign in with. Under the client
tier it also picks **which** client, because a work order is raised against
whichever organisation rang up. Under the admin tier it picks **which member of
EP Team**, for the same reason one level down: see roles, below.

## Roles inside the EP Team console

A tier is a product; a role is a permission set within one. `portal.ts` answers
"which of the three products am I looking at"; `lib/roles.ts` answers "inside the
EP Team console, what will the software let this person do".

Eight roles — Super Admin, Operations, Client Manager, Recruitment, Scheduling,
Payroll, Finance, Read only — each holding a subset of 26 capabilities. Manage
them at **Account settings ▸ Team & roles** (`/settings/team`, or the account
menu at the foot of the rail). The People tab assigns roles and invites people;
the Roles tab edits each role's permissions one role at a time, because a
26 × 8 matrix on one screen is unreadable and every cell in it is a decision
about who can see what people earn.

Three rules the code enforces rather than describes:

- **Capabilities, not pages.** A screen names the capability it needs. Adding a
  screen therefore cannot silently widen anyone's access.
- **One predicate.** `roles.can()` is the only permission check in the app. The
  sidebar, the route guard and the buttons all call it, so an item you can see
  in the rail always opens, and a button you can see always works. Read and act
  are separate where the split is a real job boundary: Finance can open the
  payroll report, only Payroll can export it; anyone quoting can read the rate
  card, only Finance can change it.
- **You cannot lock the company out.** Super Admin's permissions are immutable,
  the last Super Admin cannot be demoted, suspended or removed, and nobody can
  change their own role. Every refusal returns a *reason*, which the UI shows as
  the disabled control's tooltip.

```bash
node roles-tests.mjs   # 90 assertions over the above, incl. rail ≡ route guard
```

Permissions are enforced client-side only, which is right for a prototype and
wrong for production: `canAccess` and `can()` read a module the browser owns.
Shipping this means the same capability list on the server, checked per request.

## The admin → client round trip

Raise a WOF as EP Team and it appears in that client's portal straight away —
before it is priced, so the client can see it coming. What they can *do* is what
varies by stage, and that lives in one function, `wof.clientTasks()`, called by
the jobs list, the job detail and the rail badge so the three cannot disagree.

| Stage | What the client sees | What they can do |
| --- | --- | --- |
| Raised, unpriced | "Being prepared" | Nothing — and it says so |
| Priced | "Quote ready" | Review the lines and **sign** |
| Signed | "Signed" | Pay the **deposit**; send their **documents** |
| Confirmed → in delivery | "Confirmed" | Approve or **query variations** added on site |
| Invoiced | "Invoiced" | **Pay the invoice** |

Four rules hold across all of it:

- **The client is the actor.** Every client-side mutation passes
  `portal.clientActor()`, so the WOF history reads "signed by Dana Reilly
  (Festival Republic)" and carries a *Client portal* badge on the admin side. An
  audit trail that credits EP Team with signing the client's own quote is worse
  than none.
- **Nothing skips a stage.** Signing makes a WOF *eligible* to become an order;
  an operator still confirms it, because seeding shifts is EP Team's call.
- **Uploads land as submitted, never approved.** EP Compliance approves. Letting
  a client mark their own document approved would make the checklist a
  self-certification and the report meaningless.
- **Documents are only chased after signing.** Due dates are worked back from
  the event date, so an unsigned enquiry can already carry a "late" purchase
  order. Chasing paperwork for a job nobody has committed to trains people to
  ignore the portal.

Variations get a client approval state of their own (`pending` / `accepted` /
`queried`), shown on both sides. Invoicing a queried variation is a **warning on
the admin gate**, not a silent success — that argument is cheaper to have before
the invoice goes out.

Absent from the client portal by construction rather than by filtering: cost
prices, margin, staff pay rates, and every other client's work.

## Picking & packing → Hire Hop

Stage 6 pushes the kit lines to the warehouse. Three rules, because a picking
list that disagrees with the invoice is the same failure as a report that
disagrees with the job:

- **The reference is assigned once and kept.** A re-send keeps
  `HH-2026-9000` and raises its version; it never mints a second reference,
  because two references for one job means the warehouse holds two lists with no
  way to tell which supersedes which.
- **References are allocated from a checked sequence,** not at random. A random
  draw from a 900-wide range collides at roughly 5% over thirty jobs.
- **Each push snapshots a manifest,** so the next one can say *what* changed —
  "Two-way radio 10 → 24", not "re-sent". `kitChangesSincePush()` drives the
  amber strip on the Picking tab and a warning on the gate into stage 7: a list
  sent once and then amended is worse than never sent, because the warehouse is
  confidently picking the wrong thing.

Seeded jobs predate the manifest, so it is reconstructed from the lines that
existed at the moment of the push — which is why Wilderness correctly reports
its on-site lighting variation as something the warehouse has not seen.

## Stage moves

Advancing warns rather than blocks (`DOC_POLICY`), and every override is written
to the history with the operator's name. Two of those warnings are about time
rather than paperwork:

- **Moving to Job** warns if the event has not started. A job cannot be in
  delivery seven weeks before it begins, and every downstream report reads
  `job` as work delivered — the same class of nonsense as the "In -4 days" the
  old app printed.
- **Moving to Invoice** warns if the job has not finished, because that bills
  for work not yet done.

**Stepping back** (`revertStage`) exists for a stage moved by mistake. It needs
a reason, which goes on the history — a stage that moves backwards without one
is indistinguishable from a bug six months later. Crucially it does *not* undo
side effects, and the dialog lists the ones that will survive: a seeded event
keeps its assignments, a signature stays signed, a deposit stays received, an
invoice stays raised. A stage is a marker, not a transaction log. Lost and
cancelled are decisions rather than positions, so they are not steppable; a
completed job reopens to Invoice.

## Jobs with no staff

A kit-only hire — a buggy and a traffic plan, no stewards — has no shifts, no
check-ins and no timesheets, and never will. `hasStaffWork()` is the guard, and
without it several screens claimed **0/0 "fully covered"** with a full green bar
(an empty rota reading as an achievement), sent operators to check-in approvals
that would never have rows, and warned about missing hours on a job that has
none by design. That last one matters most: noise is what teaches people to
click past the warnings that count.

`CoverageBar` now renders a flat neutral track when nothing is required, rather
than a full bar — `pct()` still returns 100 so percentages stay finite, but
nothing-required is not the same as everything-filled.

A kit-only job also **seeds no event at all**. An event *is* the staffing
record; creating an empty one puts a job on the Staffing screen reading "0/0,
fully staffed" — a queue of work that does not exist. Such a job lives on the
calendar and in the pipeline, and simply has no rota.

## Who owns a job's name

A schedule entry is a standing expectation — "Rushden home fixtures,
fortnightly". A WOF is an actual job raised against it. The moment one exists,
**the WOF owns the title, dates, venue and manager**, and the register is only
the fallback. Reading the register instead is how the calendar ends up calling a
job something nobody else calls it.

The one thing that stays with the register is the WOF trigger date, worked back
from the schedule's own start — the rule is "this recurs in September, raise the
paperwork 21 days out", which is a property of the expectation, not of the job.

## Client records

"New client" opened a form, discarded what you typed, and said "Client
created." That is the worst failure mode in this system and the one the original
critique named first — an action that fires a confirmation and changes nothing.

`lib/clients.ts` makes the screen mean what it says: create, edit and delete all
write, and the **code rule the page already states is now enforced at entry** —
2–5 letters, no digits, no `YYY`/`ZZZ` placeholders, unique. Stating a rule
while letting new records break it is how that junk got into the data.

Deleting is refused outright while the client has live work, rather than warned
about; the dialog points at setting the account inactive instead. Warn-not-block
is the policy for *progression*, not for destruction.

Changes are journalled to `eprosta.clients.v1` (additions, edits, removals) and
replayed over the seed on load, so seed improvements still land underneath.

> **Still stubs.** Five other actions toast without writing: **New Event**,
> **Add shift**, **Add role group**, **Requirements saved** (event detail), and
> **Add a note** (check-ins). They were ported faithfully from the vanilla
> prototype, which did the same — but faithful is not the same as right.

## What persists

The save payload (`eprosta.wof.v1`, schema v4, still reads v3) holds the WOFs
**and the events seeded from them**. It has to hold both: a WOF stores
`eventId`, and persisting that pointer while leaving the event in memory meant
that after a reload the job still claimed to have shifts, Staffing could not
find them, and "Open staffing" landed on whatever was first in the seed data.

On load, any `eventId` whose event no longer exists is cleared rather than left
dangling — which repairs anything saved under v3. And `EventDetail` now shows a
real not-found state for an unknown id instead of falling through to `EVENTS[0]`
and confidently displaying a different client's festival.

## State that persists

`localStorage` holds the WOF store (`eprosta.wof.v1`), staff applications,
worker flags, the acting tier, the acting client and a handful of view
preferences. **Reset demo data** on the WOF pipeline clears it and reloads the
seed.

## Try the round trip

1. **EP Team → WOF pipeline → Raise WOF.** Pick any client; give it a name and
   dates. It lands at stage 1 with nothing priced.
2. **Viewing as → Client → that client.** The job is already there, reading
   "Being prepared". Nothing is asked of you yet.
3. Back to **EP Team**, open the WOF, **Quote & variations → Add line**. Price
   a couple of lines.
4. **Viewing as → Client** again. "Sign the quote" is now the first thing on the
   page. Sign it.
5. **EP Team → the WOF → History.** Your signature is there, credited to the
   client and badged *Client portal*. **Move to Order** is now unblocked.
6. Confirm the order, add a variation, and switch back — the client is asked to
   approve it, and querying it puts a warning on the admin's invoice gate.
