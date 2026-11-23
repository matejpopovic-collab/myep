/* ============================================================================
   SHELVES: the catalogue's categories and departments, for any list of charges
   ----------------------------------------------------------------------------
   The deployment builder's kit and services picker (`CatalogueBrowser`) files
   every line on a shelf (`category`) and tags it with the rate card's
   departments (`depts`). The Table of charges and a client's Rates tab list
   the same 300-odd lines, so they band them the same way: one header per
   shelf, in the picker's shelf order, and the same Department chips.

   Staff lines have no shelf in the catalogue; here they sit on one of their
   own, first, because that is how the kind filter orders them too. A kit or
   service line whose category is missing or unknown lands on "not yet
   filed" for its kind, so nothing drops out of the list for want of a tag.

   Two kinds of line are not catalogue items at all and get a band of their
   own rather than "not yet filed": replacement and damage-excess prices
   (whatever the stock register points `replacementChargeId` at — the same
   derived set `HOP.isReplacementCharge` uses), and the cancellation charge.
   ========================================================================== */

import { CATEGORIES, DEPARTMENTS } from '@/data/catalogue';
import type { Charge, ChargeKind } from '@/data/types';
import { isReplacementCharge } from './hop';

export const STAFF_SHELF = '__staff';
const UNFILED = (k: ChargeKind) => `__unfiled-${k}`;
export const REPLACEMENT_SHELF = '__replacement';
export const CANCELLATION_SHELF = '__cancellation';
const CANCELLATION_ID = 'ch-cancellation';

type Shelvable = Pick<Charge, 'id' | 'kind' | 'category'>;

export interface Shelf { id: string; label: string; kind: ChargeKind }

const KIND_ORDER: ChargeKind[] = ['staff', 'kit', 'service'];

/** Every shelf, in the order a list is banded: staff, kit shelves, service shelves. */
export const SHELVES: Shelf[] = KIND_ORDER.flatMap((k): Shelf[] =>
  k === 'staff'
    ? [{ id: STAFF_SHELF, label: 'Staff', kind: 'staff' }]
    : [
        ...CATEGORIES.filter((c) => c.kind === k).map((c) => ({ id: c.id, label: c.label, kind: k })),
        k === 'kit'
          ? { id: REPLACEMENT_SHELF, label: 'Replacement & damage', kind: k }
          : { id: CANCELLATION_SHELF, label: 'Cancellation', kind: k },
        { id: UNFILED(k), label: k === 'kit' ? 'Kit not yet filed' : 'Services not yet filed', kind: k },
      ],
);

const BY_ID = new Map(SHELVES.map((s, i) => [s.id, { s, i }]));

/** The shelf a charge is banded under. */
export function shelfOf(c: Shelvable): string {
  if (c.kind === 'staff') return STAFF_SHELF;
  if (c.id === CANCELLATION_ID) return CANCELLATION_SHELF;
  if (c.kind === 'kit' && isReplacementCharge(c.id)) return REPLACEMENT_SHELF;
  const hit = c.category ? BY_ID.get(c.category) : undefined;
  return hit && hit.s.kind === c.kind ? c.category! : UNFILED(c.kind);
}

export const shelfLabel = (id: string) => BY_ID.get(id)?.s.label ?? '';

/**
 * Re-orders rows into shelf order, keeping each shelf's own order (stable).
 * The rows can be anything that leads back to a charge.
 */
export function byShelf<R>(rows: R[], chargeOf: (r: R) => Shelvable | undefined): R[] {
  const rank = (r: R) => {
    const c = chargeOf(r);
    return c ? BY_ID.get(shelfOf(c))?.i ?? SHELVES.length : SHELVES.length;
  };
  return rows
    .map((r, i) => ({ r, i, k: rank(r) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.r);
}

/** Shelves with at least one of these charges on them, in order. */
export const shelvesIn = (cs: Shelvable[]) => {
  const here = new Set(cs.map(shelfOf));
  return SHELVES.filter((s) => here.has(s.id));
};

/** Department keys that at least one of these charges is tagged with, in the rate card's order. */
export const deptsIn = (cs: Pick<Charge, 'depts'>[]) =>
  Object.keys(DEPARTMENTS).filter((d) => cs.some((c) => (c.depts || []).includes(d)));

export const inDept = (c: Pick<Charge, 'depts'> | undefined, dept: string | null) =>
  !dept || !!c?.depts?.includes(dept);

const norm = (s: string) => s.toLowerCase().replace(/[-–—/()!,.+&]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The picker's search: every word of the query must appear in the line's
 * name, size, code, shelf, aliases or departments, spaced or squashed
 * ("hivis"). So "portaloo" finds the same thing on every screen.
 */
export function matchesCharge(c: Charge, q: string, shelf = shelfLabel(shelfOf(c))): boolean {
  if (!q.trim()) return true;
  const hay = norm(
    [c.name, c.family, c.variant, c.code, c.role, shelf, ...(c.aliases || []), ...(c.depts || []).map((d) => DEPARTMENTS[d] || d)]
      .filter(Boolean)
      .join(' '),
  );
  const squashed = hay.replace(/ /g, '');
  return norm(q)
    .split(' ')
    .every((t) => hay.includes(t) || squashed.includes(t));
}
