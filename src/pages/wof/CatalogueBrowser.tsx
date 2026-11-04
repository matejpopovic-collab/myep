/* ============================================================================
   CATALOGUE BROWSER — step 3's Kit and Services tabs
   ----------------------------------------------------------------------------
   Three hundred rows do not fit a 160px list behind one filter box. So:

     - A SHELF RAIL on the left, one entry per category with its count, and a
       "Picked" entry on top to review what is already ticked. The rail is the
       answer to "what kinds of thing are there", which a search box is not.
     - SEARCH ignores the rail and looks everywhere: name, size, category and
       the names people actually use ("portaloo", "TVCB", "genny"). While a
       search is on, the rail shows where the matches are.
     - DEPARTMENT CHIPS keep the rate card's own column B as a filter, since
       that is how the TM and HVM teams already think about their kit.
     - SIZES ARE ONE LINE. Hi-vis S..5XL is one row with seven chips; each
       chip is still its own charge, priced and stocked on its own.

   Rows with no rate yet are shown, greyed, and cannot be ticked
   (`CHARGES_LIB.hasRate`). Hiding them would make the catalogue look smaller
   than it is and leave nobody knowing what still needs pricing.
   ========================================================================== */

import { useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { TONE_BG, TONE_HEX } from '@/lib/status';
import * as CHARGES_LIB from '@/lib/charges';
import { CATEGORIES, DEPARTMENTS } from '@/data/catalogue';
import type { Charge, ChargeKind } from '@/data/types';

const OTHER = '__other';
const PICKED = '__picked';
const ALL = '__all';

const norm = (s: string) => s.toLowerCase().replace(/[-–—/()!,.+&]/g, ' ').replace(/\s+/g, ' ').trim();

/** Every token of the query must appear in the row's words, spaced or squashed ("hivis"). */
function matches(c: Charge, catLabel: string, q: string): boolean {
  if (!q) return true;
  const hay = norm(
    [c.name, c.family, c.variant, c.code, catLabel, ...(c.aliases || []), ...(c.depts || []).map((d) => DEPARTMENTS[d] || d)]
      .filter(Boolean)
      .join(' '),
  );
  const squashed = hay.replace(/ /g, '');
  return norm(q)
    .split(' ')
    .every((t) => hay.includes(t) || squashed.includes(t));
}

/** One line in the list: a single charge, or a family of sizes drawn as chips. */
type Row = { key: string; label: string; items: Charge[] };

function toRows(list: Charge[]): Row[] {
  const rows: Row[] = [];
  const fam = new Map<string, Row>();
  list.forEach((c) => {
    if (c.family) {
      const k = `${c.category}|${c.family}`;
      let r = fam.get(k);
      if (!r) {
        r = { key: k, label: c.family, items: [] };
        fam.set(k, r);
        rows.push(r);
      }
      r.items.push(c);
    } else rows.push({ key: c.id, label: c.name, items: [c] });
  });
  return rows;
}

export function CatalogueBrowser({
  kind,
  offered,
  query,
  onQuery,
  isPicked,
  onToggle,
  price,
}: {
  kind: ChargeKind;
  /** What this tab can offer: quotable, not replacement, not cancellation. */
  offered: Charge[];
  query: string;
  onQuery: (q: string) => void;
  isPicked: (c: Charge) => boolean;
  onToggle: (c: Charge) => void;
  /** The price as this client pays it, already formatted, with its tooltip if any. */
  price: (c: Charge) => React.ReactNode;
}) {
  const [shelf, setShelf] = useState<string>(ALL);
  const [dept, setDept] = useState<string | null>(null);
  const [pricedOnly, setPricedOnly] = useState(false);

  const cats = useMemo(() => {
    const own = CATEGORIES.filter((c) => c.kind === kind);
    const known = new Set(own.map((c) => c.id));
    const list = own.map((c) => ({ id: c.id, label: c.label }));
    if (offered.some((c) => !c.category || !known.has(c.category))) list.push({ id: OTHER, label: 'Not yet filed' });
    return list;
  }, [kind, offered]);
  const catOf = (c: Charge) => (c.category && cats.some((k) => k.id === c.category) ? c.category : OTHER);
  const labelOf = (id: string) => cats.find((k) => k.id === id)?.label || '';

  const q = query.trim();
  // Everything the department, priced and search filters let through - the rail counts these.
  const passing = offered.filter(
    (c) =>
      (!dept || (c.depts || []).includes(dept)) &&
      (!pricedOnly || CHARGES_LIB.hasRate(c)) &&
      matches(c, labelOf(catOf(c)), q),
  );
  // A search looks everywhere; the rail only narrows when nothing is typed.
  const activeShelf = q && shelf !== PICKED ? ALL : shelf;
  const visible = passing.filter((c) =>
    activeShelf === ALL ? true : activeShelf === PICKED ? isPicked(c) : catOf(c) === activeShelf,
  );
  const groups = cats
    .map((k) => ({ ...k, rows: toRows(visible.filter((c) => catOf(c) === k.id)) }))
    .filter((g) => g.rows.length);

  const deptsHere = Object.keys(DEPARTMENTS).filter((d) => offered.some((c) => (c.depts || []).includes(d)));
  const pickedCount = offered.filter(isPicked).length;
  const unpriced = offered.filter((c) => !CHARGES_LIB.hasRate(c)).length;
  const noun = kind === 'kit' ? 'kit items' : 'services';

  const railBtn = (id: string, label: React.ReactNode, count: number, picked: number) => {
    const on = activeShelf === id;
    return (
      <button
        key={id}
        type="button"
        onClick={() => {
          setShelf(id);
          if (q && id !== ALL) onQuery('');
        }}
        aria-current={on ? 'true' : undefined}
        className="w-full flex items-center gap-1.5 px-2.5 py-[5px] text-left text-[12.5px] border-0 cursor-pointer rounded-md"
        style={{
          background: on ? 'var(--accent-soft)' : 'transparent',
          color: count ? (on ? 'var(--ink)' : 'var(--ink-2)') : 'var(--ink-3)',
          fontWeight: on ? 600 : 400,
          opacity: count || id === PICKED ? 1 : 0.55,
        }}
      >
        <span className="flex-1 min-w-0 truncate">{label}</span>
        {picked ? (
          <span
            className="pill tabular-nums"
            style={{ background: TONE_BG.info, color: TONE_HEX.info, padding: '0 5px', fontSize: 10.5 }}
            title={`${picked} picked`}
          >
            {picked}
          </span>
        ) : null}
        <span className="tabular-nums text-[11px] text-ink-3">{count}</span>
      </button>
    );
  };

  const chip = (label: string, on: boolean, onClick: () => void, title?: string) => (
    <button
      key={label}
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className="px-2 py-[2px] rounded-full text-[11.5px] border cursor-pointer whitespace-nowrap"
      style={{
        background: on ? 'var(--accent-soft)' : 'var(--surface)',
        borderColor: on ? 'var(--accent)' : 'var(--surface-line)',
        color: on ? 'var(--ink)' : 'var(--ink-2)',
        fontWeight: on ? 600 : 400,
      }}
    >
      {label}
    </button>
  );

  return (
    <>
      <div
        className="px-2.5 py-2.5 border-b"
        style={{ background: 'var(--surface-high)', borderColor: 'var(--surface-line)' }}
      >
        <label
          className="flex items-center gap-2 px-3 h-10 rounded-lg border-[1.5px] border-[var(--surface-line)] cursor-text transition-shadow focus-within:border-[var(--accent)] focus-within:shadow-[0_0_0_3px_var(--accent-soft)]"
          style={{ background: 'var(--surface)' }}
        >
          <span className="text-ink-2">
            <Icon name="search" decorative />
          </span>
          <input
            className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[14px] text-ink"
            placeholder={
              kind === 'kit'
                ? `Search all ${offered.length} kit items: name, size or what people call it ("portaloo", "TVCB", "XL")`
                : `Search all ${offered.length} services`
            }
            aria-label={`Search ${noun}`}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
          />
          {query ? (
            <button type="button" className="btn-icon" aria-label="Clear search" onClick={() => onQuery('')}>
              <Icon name="close" decorative className="icon-sm" />
            </button>
          ) : null}
        </label>
      </div>
      {deptsHere.length > 1 || unpriced ? (
        <div
          className="flex items-center gap-1.5 flex-wrap px-2.5 py-1.5 border-b"
          style={{ borderColor: 'var(--surface-line-soft)' }}
        >
          {deptsHere.length > 1 ? (
            <>
              <span className="text-[11px] text-ink-3 mr-0.5">Department</span>
              {chip('All', !dept, () => setDept(null))}
              {deptsHere.map((d) => chip(DEPARTMENTS[d], dept === d, () => setDept(dept === d ? null : d)))}
            </>
          ) : null}
          {unpriced ? (
            <label className="ml-auto flex items-center gap-1.5 text-[11.5px] text-ink-2 cursor-pointer">
              <input type="checkbox" checked={pricedOnly} onChange={(e) => setPricedOnly(e.target.checked)} />
              Priced only
            </label>
          ) : null}
        </div>
      ) : null}

      {/* The rail sets the height: every category shows, no scrollbar on it.
          The list beside it is pinned to that height and scrolls on its own. */}
      <div className="flex">
        <nav
          aria-label={`${kind === 'kit' ? 'Kit' : 'Service'} categories`}
          className="shrink-0 border-r p-1.5"
          style={{ width: 236, borderColor: 'var(--surface-line)', background: 'var(--surface-high)' }}
        >
          {railBtn(
            PICKED,
            <span className="flex items-center gap-1">
              <Icon name="checkCircle" decorative className="icon-sm" /> Picked
            </span>,
            pickedCount,
            0,
          )}
          {railBtn(ALL, q ? 'All matches' : `All ${noun}`, passing.length, 0)}
          <div className="h-px my-1" style={{ background: 'var(--surface-line)' }} />
          {cats.map((k) => {
            const inCat = passing.filter((c) => catOf(c) === k.id);
            return railBtn(k.id, k.label, inCat.length, inCat.filter(isPicked).length);
          })}
        </nav>

        <div className="flex-1 min-w-0 relative">
          <div className="absolute inset-0 overflow-y-auto">
          {groups.map((g) => (
            <section key={g.id} aria-label={g.label}>
              <h4
                className="sticky top-0 z-[1] px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-wider text-ink-3 border-b"
                style={{ background: 'var(--surface-high)', borderColor: 'var(--surface-line-soft)' }}
              >
                {g.label} <span className="font-normal">· {g.rows.reduce((n, r) => n + r.items.length, 0)}</span>
              </h4>
              {g.rows.map((r) => (r.items.length === 1 && !r.items[0].family ? (
                <SingleRow key={r.key} c={r.items[0]} on={isPicked(r.items[0])} onToggle={onToggle} price={price} />
              ) : (
                <FamilyRow key={r.key} row={r} isPicked={isPicked} onToggle={onToggle} price={price} />
              )))}
            </section>
          ))}
          {!groups.length ? (
            <p className="text-[13px] text-ink-3 px-3 py-4">
              {activeShelf === PICKED
                ? `Nothing picked yet. Tick ${noun} from any category and they collect here.`
                : q
                  ? `No ${noun} match "${q}"${dept ? ` in ${DEPARTMENTS[dept]}` : ''}.`
                  : `Nothing here${dept ? ` for ${DEPARTMENTS[dept]}` : ''}.`}
            </p>
          ) : null}
          </div>
        </div>
      </div>
      {unpriced ? (
        <p
          className="text-[11.5px] text-ink-3 px-2.5 py-1.5 border-t"
          style={{ borderColor: 'var(--surface-line)', background: 'var(--surface-high)' }}
        >
          {unpriced} of {offered.length} {noun} have no rate yet. They can be found here but not added until
          they are priced in the Table of charges.
        </p>
      ) : null}
    </>
  );
}

function Depts({ c }: { c: Charge }) {
  if (!c.depts?.length) return null;
  return (
    <span className="text-[10.5px] text-ink-3 truncate">
      {c.depts.map((d) => DEPARTMENTS[d] || d).join(' · ')}
    </span>
  );
}

const NoRate = () => (
  <span className="text-[11px] italic text-ink-3 whitespace-nowrap" title="Not priced on the rate card yet">
    No rate yet
  </span>
);

function SingleRow({
  c, on, onToggle, price,
}: {
  c: Charge;
  on: boolean;
  onToggle: (c: Charge) => void;
  price: (c: Charge) => React.ReactNode;
}) {
  const ok = CHARGES_LIB.hasRate(c);
  return (
    <label
      className={`flex items-center gap-2.5 px-2.5 py-1.5 border-b ${ok ? 'cursor-pointer' : 'cursor-default'}`}
      style={{ borderColor: 'var(--surface-line-soft)', background: on ? 'var(--accent-soft)' : undefined }}
    >
      <input type="checkbox" checked={on} disabled={!ok} onChange={() => onToggle(c)} />
      <span className="flex-1 min-w-0 flex flex-col">
        <span className={`text-[13px] truncate ${ok ? 'text-ink' : 'text-ink-3'}`}>{c.name}</span>
        <Depts c={c} />
      </span>
      {ok ? price(c) : <NoRate />}
    </label>
  );
}

function FamilyRow({
  row, isPicked, onToggle, price,
}: {
  row: Row;
  isPicked: (c: Charge) => boolean;
  onToggle: (c: Charge) => void;
  price: (c: Charge) => React.ReactNode;
}) {
  const priced = row.items.filter(CHARGES_LIB.hasRate);
  const any = row.items.some(isPicked);
  const same = priced.length && priced.every((c) => c.charge === priced[0].charge);
  return (
    <div
      className="flex items-start gap-2.5 px-2.5 py-1.5 border-b"
      style={{ borderColor: 'var(--surface-line-soft)', background: any ? 'var(--accent-soft)' : undefined }}
    >
      <span className="mt-[3px] text-ink-3" aria-hidden>
        <Icon name="layers" decorative className="icon-sm" />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className={`text-[13px] ${priced.length ? 'text-ink' : 'text-ink-3'}`}>{row.label}</span>
          <span className="text-[10.5px] text-ink-3">{row.items.length} options</span>
        </div>
        <div className="flex flex-wrap gap-1 mt-1" role="group" aria-label={`${row.label} options`}>
          {row.items.map((c) => {
            const ok = CHARGES_LIB.hasRate(c);
            const on = isPicked(c);
            return (
              <button
                key={c.id}
                type="button"
                disabled={!ok}
                aria-pressed={on}
                onClick={() => onToggle(c)}
                title={ok ? c.name : `${c.name}: no rate yet`}
                className="px-2 py-[1px] rounded-md text-[11.5px] border whitespace-nowrap"
                style={{
                  cursor: ok ? 'pointer' : 'not-allowed',
                  background: on ? 'var(--accent)' : 'var(--surface)',
                  color: on ? '#fff' : ok ? 'var(--ink-2)' : 'var(--ink-3)',
                  borderColor: on ? 'var(--accent)' : 'var(--surface-line)',
                  borderStyle: ok ? 'solid' : 'dashed',
                  fontWeight: on ? 600 : 400,
                }}
              >
                {on ? '✓ ' : ''}
                {c.variant}
              </button>
            );
          })}
        </div>
        <Depts c={row.items[0]} />
      </div>
      <span className="mt-[2px]">
        {!priced.length ? <NoRate /> : same ? price(priced[0]) : <span className="text-[12px] text-ink-3">varies by option</span>}
      </span>
    </div>
  );
}
