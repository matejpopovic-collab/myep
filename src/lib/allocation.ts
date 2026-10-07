/* ============================================================================
   EPROSTA — THE WOA (Work Order Allocation)
   ----------------------------------------------------------------------------
   The WOF records what was SOLD. This records what operations will actually
   DELIVER, and it sits between the two halves of the business that used to
   start straight off the quote:

       client pays deposit
         -> ops manager allocates: headcount per role group, split across staff
            pools; the kit quantities really going out
         -> release
         -> staffing assigns (and workers can see the job)
         -> the kit list can go to the warehouse

   WHY IT IS INTERNAL
   ------------------
   An allocation never writes a line, a quote version, a variation or an
   invoice. The client's contract value is computed from lines, so it cannot
   move; the client portal counts staffing against `Split.booked`, so it does
   not see the plan either. What it DOES write is the rota (`Split.required`
   and `Split.pools`) and the quantities the warehouse is told (`kitQty`).

   WHAT "RELEASED" MEANS
   ---------------------
   The draft is a working copy. Nothing reads it but this screen until it is
   released — an ops manager half-way through an edit has told nobody
   anything. A release writes the plan onto the event and freezes the kit
   quantities; editing afterwards opens a revision, and the previous release
   stays in force until the next one.

   The reads the gates need (`allocationBlock`, `kitQty`, ...) live in
   `wof.ts`, so the dependency runs one way: this imports that, never back.
   ========================================================================== */

import { NOW, OFFICES, event as eventById } from '@/data/db';
import type { EpEvent, PoolShare, Shift, Split } from '@/data/types';
import * as W from './wof';
import * as EVT from './events';
import * as NOTIFY from './notifications';
import { countLabel } from './format';

/* ------------------------------------------------------------------ pools */

/**
 * The staff pools operations draw from: the offices, less the catch-all.
 *
 * Read from `OFFICES` rather than listed here, so a new office is a new pool
 * the day it is added to the register. "All Offices" is not a pool — it is a
 * worker who will travel to any of them, and they count inside every pool.
 */
export const POOLS: string[] = OFFICES.filter((o) => o !== 'All Offices');

/** A worker from `office` counts towards `pool`. */
export const inPool = (office: string, pool: string): boolean =>
  office === pool || office === 'All Offices';

/* ------------------------------------------------------------------ state */

export type AllocState =
  /** Not needed: not ordered yet, cancelled, or nothing to staff or pick. */
  | 'none'
  /** Ordered, but the deposit has not landed. */
  | 'deposit'
  /** Deposit in, nobody has started the allocation. */
  | 'ready'
  /** Started, never released. Staffing and the warehouse are waiting. */
  | 'draft'
  /** Released, and the working plan is what is in force. */
  | 'released'
  /** Released, with edits since that have not been released. */
  | 'revising'
  /** Being worked from its sold numbers since before allocation existed. */
  | 'legacy';

export const STATE_META: Record<AllocState, { label: string; tone: 'neutral' | 'info' | 'atRisk' | 'healthy' | 'critical' }> = {
  none:     { label: 'Not needed',          tone: 'neutral' },
  deposit:  { label: 'Awaiting deposit',    tone: 'neutral' },
  ready:    { label: 'Ready to allocate',   tone: 'atRisk' },
  draft:    { label: 'Draft — not released',tone: 'atRisk' },
  released: { label: 'Released',            tone: 'healthy' },
  revising: { label: 'Unreleased changes',  tone: 'info' },
  legacy:   { label: 'Allocated from sold', tone: 'neutral' },
};

/* ------------------------------------------------------------------- rows */

export interface StaffRow {
  splitId: string;
  shiftId: string;
  day: number;
  dayLabel: string;
  /** Start of the group's own window, ISO. */
  start: string;
  end: string;
  role: string;
  place: string | null;
  locationId: string | null;
  /** What the client bought for this group. */
  sold: number;
  /** The working plan. */
  pools: PoolShare[];
  total: number;
  /** What staffing is filling against right now — null before any release. */
  inForce: number | null;
  inForcePools: PoolShare[] | null;
  /** People on the group who have not declined. */
  onIt: number;
  confirmed: number;
  /** Added to the job (a variation, a new day) after the plan was started. */
  isNew: boolean;
  /** The working plan differs from what is in force. */
  changed: boolean;
}

export interface KitRow {
  lineId: string;
  description: string;
  chargeId: string;
  units: number;
  unitLabel: string;
  subHire: boolean;
  sold: number;
  qty: number;
  inForce: number | null;
  isNew: boolean;
  changed: boolean;
}

export interface AllocationView {
  state: AllocState;
  /** Why it cannot be worked on yet, when it cannot. */
  block: string | null;
  event: EpEvent | null;
  staff: StaffRow[];
  kit: KitRow[];
  totals: { soldStaff: number; staff: number; soldKit: number; kit: number };
  /** Head count per pool across the whole plan. */
  byPool: { pool: string; count: number }[];
  /** Rows whose plan differs from what is in force (or, before release, from sold). */
  changes: number;
}

const iso = (): string => new Date(NOW).toISOString();
const sumPools = (p: PoolShare[]): number => p.reduce((s, x) => s + x.count, 0);
const samePools = (a: PoolShare[] | null | undefined, b: PoolShare[] | null | undefined): boolean => {
  const norm = (p: PoolShare[] | null | undefined) =>
    (p || [])
      .filter((x) => x.count > 0)
      .map((x) => `${x.pool}:${x.count}`)
      .sort()
      .join('|');
  return norm(a) === norm(b);
};

/** The sold headcount for a group: frozen on the first release, `required` before it. */
const soldOf = (sp: Split): number => (typeof sp.booked === 'number' ? sp.booked : sp.required);

/** The pool a group starts in before anybody chooses one. */
function defaultPool(w: W.Wof, ev: EpEvent | null, sp: Split | null): string {
  for (const cand of [sp?.office, ev?.office, w.office]) if (cand && POOLS.includes(cand)) return cand;
  return POOLS[0];
}

/**
 * A group's own window is stored as a bare clock time ("06:00") — it comes
 * from the job's shift-pattern library, which has no dates in it. The shift
 * carries the date. Joined here so every reader gets one shape: a full local
 * ISO string. Passing "06:00" to a date formatter is how a row read
 * "NaN:NaN–NaN:NaN".
 */
function atTime(shiftIso: string, t: string | undefined, fallback: string): string {
  if (!t) return fallback;
  if (/^\d{1,2}:\d{2}$/.test(t)) return `${shiftIso.slice(0, 10)}T${t.padStart(5, '0')}:00`;
  return t;
}

function splits(ev: EpEvent | null): { shift: Shift; split: Split }[] {
  if (!ev) return [];
  return ev.shifts.flatMap((shift) => shift.splits.map((split) => ({ shift, split })));
}

export function state(w: W.Wof): AllocState {
  if (w.allocation?.legacy) return 'legacy';
  if (!W.needsAllocation(w)) return 'none';
  if (!W.depositCleared(w)) return 'deposit';
  const a = w.allocation;
  if (!a) return 'ready';
  if (!a.releasedAt) return 'draft';
  return view(w).changes ? 'revising' : 'released';
}

/**
 * The plan as it stands — stored rows where ops has touched them, defaults
 * where they have not. Pure: reading it changes nothing, so the tab can render
 * a ready-to-allocate job without having opened anything on its behalf.
 */
export function view(w: W.Wof): AllocationView {
  const a = w.allocation || null;
  const ev = w.eventId ? eventById(w.eventId) || null : null;
  const released = !!a?.releasedAt && !a.legacy;

  const storedStaff = new Map((a?.staff || []).map((r) => [r.splitId, r]));
  const staff: StaffRow[] = splits(ev).map(({ shift, split }) => {
    const sold = soldOf(split);
    const stored = storedStaff.get(split.id);
    // Zero-count pools are kept in the draft: a pool just added starts at
    // nought, and hiding it would make "Add a pool" look like it did nothing.
    // Release drops them; the rota only ever carries pools with people in.
    const pools = stored
      ? stored.pools.map((p) => ({ ...p }))
      : split.pools?.length
        ? split.pools.map((p) => ({ ...p }))
        : [{ pool: defaultPool(w, ev, split), count: sold }];
    const total = sumPools(pools);
    const inForce = released ? split.required : null;
    const inForcePools = released ? split.pools || null : null;
    const onIt = split.assignments.filter((x) => x.confirmation !== 'declined').length;
    const loc = split.locationId ? ev!.locations.find((l) => l.id === split.locationId) : null;
    return {
      splitId: split.id,
      shiftId: shift.id,
      day: shift.day,
      dayLabel: shift.label,
      start: atTime(shift.start, split.start, shift.start),
      end: atTime(shift.start, split.end, shift.end),
      role: split.role,
      place: loc ? loc.name : null,
      locationId: split.locationId ?? null,
      sold,
      pools,
      total,
      inForce,
      inForcePools,
      onIt,
      confirmed: split.assignments.filter((x) => x.confirmation === 'confirmed').length,
      isNew: !!a && !a.legacy && !stored,
      changed: released
        ? total !== inForce || !samePools(pools, inForcePools)
        : total !== sold,
    };
  });

  const storedKit = new Map((a?.kit || []).map((r) => [r.lineId, r]));
  const kit: KitRow[] = W.kitLines(w).map((l) => {
    const stored = storedKit.get(l.id);
    const qty = stored ? stored.qty : released ? W.kitQty(w, l) : l.qty;
    const inForce = released ? W.kitQty(w, l) : null;
    return {
      lineId: l.id,
      description: l.description,
      chargeId: l.chargeId,
      units: l.units,
      unitLabel: l.unitLabel,
      subHire: !!l.subHire,
      sold: l.qty,
      qty,
      inForce,
      isNew: !!a && !a.legacy && !stored,
      changed: released ? qty !== inForce : qty !== l.qty,
    };
  });

  const byPoolMap = new Map<string, number>();
  staff.forEach((r) => r.pools.forEach((p) => byPoolMap.set(p.pool, (byPoolMap.get(p.pool) || 0) + p.count)));

  return {
    state: 'none', // filled in below; `state()` calls back into here for `changes`
    block: W.needsAllocation(w) && !W.depositCleared(w) ? W.allocationBlock(w) : null,
    event: ev,
    staff,
    kit,
    totals: {
      soldStaff: staff.reduce((s, r) => s + r.sold, 0),
      staff: staff.reduce((s, r) => s + r.total, 0),
      soldKit: kit.reduce((s, r) => s + r.sold, 0),
      kit: kit.reduce((s, r) => s + r.qty, 0),
    },
    byPool: POOLS.map((pool) => ({ pool, count: byPoolMap.get(pool) || 0 })).filter((p) => p.count > 0),
    changes: staff.filter((r) => r.changed).length + kit.filter((r) => r.changed).length,
  };
}

/** `view` with its state filled in. What the screen calls. */
export function read(w: W.Wof): AllocationView {
  const v = view(w);
  v.state = state(w);
  return v;
}

/* -------------------------------------------------------------- mutations */

/**
 * Why this job's allocation cannot be edited, or null.
 *
 * The deposit is the trigger the business asked for: until money is in, the
 * job is not certain enough to plan staff and kit against.
 */
export function editBlock(w: W.Wof): string | null {
  if (W.isTerminal(w.stage)) return 'This job is closed.';
  if (w.allocation?.legacy) return 'This job was already being staffed from its sold numbers before allocation existed.';
  if (!W.atLeast(w, 'order')) return 'Nothing to allocate until the client has signed and the job is an order.';
  if (!W.needsAllocation(w)) return 'Nothing on this job to staff or pick.';
  if (!W.depositCleared(w)) return W.allocationBlock(w);
  return null;
}

/** Materialise the draft from the current view the first time anybody edits it. */
function ensureDraft(w: W.Wof, actor: W.Actor): W.Allocation {
  const v = view(w);
  if (!w.allocation) {
    w.allocation = {
      openedAt: iso(),
      openedBy: actor.by,
      updatedAt: iso(),
      staff: v.staff.map((r) => ({ splitId: r.splitId, pools: r.pools.map((p) => ({ ...p })) })),
      kit: v.kit.map((r) => ({ lineId: r.lineId, qty: r.qty })),
      note: '',
      releasedAt: null,
      releasedBy: null,
      releases: 0,
    };
    W.recordExternal(w, { stage: w.stage, note: 'Allocation (WOA) started' }, actor);
    return w.allocation;
  }
  // Rows added since (a variation, a day added to the event) join the draft
  // at their defaults, so an edit to one of them has somewhere to land.
  const a = w.allocation;
  v.staff.forEach((r) => {
    if (!a.staff.some((s) => s.splitId === r.splitId))
      a.staff.push({ splitId: r.splitId, pools: r.pools.map((p) => ({ ...p })) });
  });
  v.kit.forEach((r) => {
    if (!a.kit.some((k) => k.lineId === r.lineId)) a.kit.push({ lineId: r.lineId, qty: r.qty });
  });
  return a;
}

export interface Result {
  ok: boolean;
  error?: string;
}

const fail = (error: string): Result => ({ ok: false, error });

/** Merge duplicate pools, drop unknown ones, round to whole people. */
function cleanPools(pools: PoolShare[]): PoolShare[] | string {
  const out = new Map<string, number>();
  for (const p of pools) {
    if (!POOLS.includes(p.pool)) return `“${p.pool}” is not a staff pool.`;
    if (!Number.isFinite(p.count) || p.count < 0) return 'Headcount must be zero or more.';
    out.set(p.pool, (out.get(p.pool) || 0) + Math.round(p.count));
  }
  const list = [...out].map(([pool, count]) => ({ pool, count }));
  return list.length ? list : [];
}

/** Set one role group's headcount, pool by pool. */
export function setPools(w: W.Wof, splitId: string, pools: PoolShare[], actor: W.Actor = W.OPERATOR): Result {
  const blocked = editBlock(w);
  if (blocked) return fail(blocked);
  if (!view(w).staff.some((r) => r.splitId === splitId)) return fail('That role group is not on this job.');
  const clean = cleanPools(pools);
  if (typeof clean === 'string') return fail(clean);
  const a = ensureDraft(w, actor);
  const row = a.staff.find((r) => r.splitId === splitId)!;
  // An emptied group keeps one pool at zero, so it still reads as a choice
  // somebody made rather than a row that lost its data.
  row.pools = clean.length ? clean : [{ pool: row.pools[0]?.pool || POOLS[0], count: 0 }];
  a.updatedAt = iso();
  W.save();
  return { ok: true };
}

/** Set one kit line's quantity going out. */
export function setKit(w: W.Wof, lineId: string, qty: number, actor: W.Actor = W.OPERATOR): Result {
  const blocked = editBlock(w);
  if (blocked) return fail(blocked);
  if (!W.kitLines(w).some((l) => l.id === lineId)) return fail('That kit line is not on this job.');
  if (!Number.isFinite(qty) || qty < 0) return fail('Quantity must be zero or more.');
  const a = ensureDraft(w, actor);
  a.kit.find((k) => k.lineId === lineId)!.qty = Math.round(qty);
  a.updatedAt = iso();
  W.save();
  return { ok: true };
}

/**
 * Copy one group's pools onto the same role, place and window on every other
 * day. A ten-day festival is ten near-identical rows per role, and setting
 * them one at a time is how day seven gets missed.
 */
export function copyAcrossDays(w: W.Wof, splitId: string, actor: W.Actor = W.OPERATOR): number {
  if (editBlock(w)) return 0;
  const rows = view(w).staff;
  const src = rows.find((r) => r.splitId === splitId);
  if (!src) return 0;
  const hhmm = (s: string) => s.slice(11, 16);
  const targets = rows.filter(
    (r) =>
      r.splitId !== src.splitId &&
      r.role === src.role &&
      r.locationId === src.locationId &&
      hhmm(r.start) === hhmm(src.start) &&
      hhmm(r.end) === hhmm(src.end),
  );
  if (!targets.length) return 0;
  const a = ensureDraft(w, actor);
  targets.forEach((t) => {
    a.staff.find((r) => r.splitId === t.splitId)!.pools = src.pools.map((p) => ({ ...p }));
  });
  a.updatedAt = iso();
  W.save();
  return targets.length;
}

/** Put every group wholly in one pool, keeping each group's headcount. */
export function setPoolForAll(w: W.Wof, pool: string, actor: W.Actor = W.OPERATOR): Result {
  const blocked = editBlock(w);
  if (blocked) return fail(blocked);
  if (!POOLS.includes(pool)) return fail(`“${pool}” is not a staff pool.`);
  const a = ensureDraft(w, actor);
  a.staff.forEach((r) => {
    r.pools = [{ pool, count: sumPools(r.pools) }];
  });
  a.updatedAt = iso();
  W.save();
  return { ok: true };
}

/** Throw the draft away and start again from what was sold. */
export function resetToSold(w: W.Wof, actor: W.Actor = W.OPERATOR): Result {
  const blocked = editBlock(w);
  if (blocked) return fail(blocked);
  const a = ensureDraft(w, actor);
  const ev = w.eventId ? eventById(w.eventId) || null : null;
  const sold = new Map(splits(ev).map(({ split }) => [split.id, split]));
  a.staff.forEach((r) => {
    const sp = sold.get(r.splitId);
    if (sp) r.pools = [{ pool: r.pools[0]?.pool || defaultPool(w, ev, sp), count: soldOf(sp) }];
  });
  a.kit.forEach((k) => {
    const l = w.lines.find((x) => x.id === k.lineId);
    if (l) k.qty = l.qty;
  });
  a.updatedAt = iso();
  W.save();
  return { ok: true };
}

export function setNote(w: W.Wof, note: string, actor: W.Actor = W.OPERATOR): Result {
  const blocked = editBlock(w);
  if (blocked) return fail(blocked);
  const a = ensureDraft(w, actor);
  a.note = note.trim();
  a.updatedAt = iso();
  W.save();
  return { ok: true };
}

/* ---------------------------------------------------------------- release */

export interface ReleasePreview {
  block: string | null;
  /** Things the ops manager should know before pressing it. Never stop it. */
  warnings: string[];
  staffChanges: StaffRow[];
  kitChanges: KitRow[];
  /** One line each, for the history and the toast. */
  summary: string;
  first: boolean;
  /** The kit list could go to the warehouse straight after. */
  canSendKit: boolean;
}

const fmtPools = (p: PoolShare[]): string =>
  p.filter((x) => x.count > 0).map((x) => `${x.count} ${x.pool}`).join(' + ') || 'none';

export function releasePreview(w: W.Wof): ReleasePreview {
  const v = read(w);
  const first = !w.allocation?.releasedAt;
  const block = editBlock(w);
  const warnings: string[] = [];

  if (!v.event && W.hasStaffWork(w))
    warnings.push('This job has staff on the quote but no staffing event yet — create one from the Overview menu first, or only the kit will be released.');

  v.staff.forEach((r) => {
    const when = `${r.role}${r.place ? ` at ${r.place}` : ''}, ${r.dayLabel}`;
    if (r.onIt > r.total)
      warnings.push(`${when}: ${countLabel(r.onIt, 'person')} already on it, allocating ${r.total}. Nobody is removed automatically — stand ${r.onIt - r.total} down on the event.`);
    else if (r.total === 0 && r.sold > 0)
      warnings.push(`${when}: allocated at zero. The group stays on the rota, empty.`);
  });

  const delta = v.totals.staff - v.totals.soldStaff;
  if (delta < 0)
    warnings.push(`${countLabel(-delta, 'shift')} fewer than the client booked. Their portal counts against what they booked, so this shows to them as a shortfall once the job is staffed.`);

  const staffChanges = v.staff.filter((r) => r.changed);
  const kitChanges = v.kit.filter((r) => r.changed);

  const parts: string[] = [];
  parts.push(`${v.totals.staff} staff shifts${v.totals.staff !== v.totals.soldStaff ? ` (sold ${v.totals.soldStaff})` : ''}`);
  if (v.byPool.length) parts.push(`from ${v.byPool.map((p) => `${p.pool} ${p.count}`).join(', ')}`);
  if (v.kit.length)
    parts.push(
      kitChanges.length
        ? `kit: ${kitChanges.map((k) => `${k.description} ${first ? k.sold : k.inForce} → ${k.qty}`).join('; ')}`
        : 'kit as sold',
    );

  const willHaveKit = v.kit.some((k) => k.qty > 0) || !!w.picking;
  return {
    block: block ?? (first || v.changes ? null : 'Nothing has changed since the last release.'),
    warnings,
    staffChanges,
    kitChanges,
    summary: parts.join(' · '),
    first,
    canSendKit: willHaveKit,
  };
}

export interface ReleaseResult extends Result {
  /** The EP HOP reference, when the kit list went with it. */
  sentKit?: string | null;
}

/**
 * Release the allocation: write it onto the rota and the kit list, and open
 * the job to staffing and the warehouse.
 *
 * `sendKit` sends the kit list to EP HOP in the same act — the common case, and
 * the reason the warehouse was waiting. Off, the list is prepared in the office
 * and sent from the Picking tab when somebody is ready.
 */
export function release(
  w: W.Wof,
  opts: { sendKit?: boolean } = {},
  actor: W.Actor = W.OPERATOR,
): ReleaseResult {
  const pre = releasePreview(w);
  if (pre.block) return fail(pre.block);

  const a = ensureDraft(w, actor);
  const v = view(w);
  const first = !a.releasedAt;

  // The rota. The sold figure is frozen onto `booked` the first time, so the
  // client portal goes on counting against it whatever ops does later.
  if (v.event) {
    EVT.applyAllocation(
      v.event.id,
      v.staff.map((r) => ({ splitId: r.splitId, required: r.total, booked: r.sold, pools: r.pools })),
    );
  }

  // The kit. Frozen here, so later edits to the draft do not reach the yard
  // until the next release.
  a.appliedKit = Object.fromEntries(v.kit.map((k) => [k.lineId, k.qty]));
  a.releasedAt = a.releasedAt || iso();
  a.releasedBy = actor.by;
  a.releasedByName = actor.name;
  a.releases = (a.releases || 0) + 1;
  a.updatedAt = iso();

  W.recordExternal(
    w,
    {
      stage: w.stage,
      note: `${first ? 'Allocation (WOA) released' : `Allocation (WOA) re-released, v${a.releases}`} — ${pre.summary}${
        a.note ? ` · note: “${a.note}”` : ''
      }`,
    },
    actor,
  );

  // The office's copy of the kit list follows the release, until the list has
  // actually gone to the yard — after which the warehouse copy is the baseline
  // and the Picking tab reports the difference as a re-send.
  W.prepareKit(w, {}, actor);

  let sentKit: string | null = null;
  if (opts.sendKit && !W.sendBlock(w)) {
    const p = W.sendToHop(w, actor);
    sentKit = p ? p.epHopRef : null;
  }

  if (v.event) {
    NOTIFY.raise({
      type: 'staffing',
      severity: 'info',
      title: `${first ? 'Ready to staff' : 'Allocation changed'} · ${w.title}`,
      body: first
        ? `Operations released ${countLabel(v.totals.staff, 'shift')}${v.byPool.length ? ` — ${v.byPool.map((p) => `${p.pool} ${p.count}`).join(', ')}` : ''}. Assigning and callouts are open.`
        : `${countLabel(pre.staffChanges.length, 'role group')} changed. Check the gaps before the next callout.`,
      link: `/events/${v.event.id}`,
    });
  }

  W.save();
  return { ok: true, sentKit };
}

/** Pools as a short phrase: "12 London + 5 Midlands". For the screens. */
export const describePools = fmtPools;

/** How many on a group come from each pool, by the worker's office. */
export function filledByPool(split: Split, employeeOffice: (id: string) => string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  split.assignments
    .filter((x) => x.confirmation !== 'declined')
    .forEach((x) => {
      const office = employeeOffice(x.employeeId) || '';
      const pool = (split.pools || []).find((p) => inPool(office, p.pool))?.pool || 'Other';
      out.set(pool, (out.get(pool) || 0) + 1);
    });
  return out;
}
