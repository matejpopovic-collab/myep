/* ============================================================================
   EP HOP — STOCK REGISTER
   ----------------------------------------------------------------------------
   What EP owns, and what is already promised to somebody else.

   The design decision that shapes this screen is that a single "free" number
   is a lie the moment two jobs overlap. 250 radios with 180 out at Reading and
   90 out at a second job the same weekend is not "free: 250" and it is not
   "free: -20" either — it is free on nineteen days out of twenty-eight and
   twenty short on two of them. So every row carries a strip, and the number
   beside it is the WORST day in the horizon rather than today's.

   Cost and charge appear nowhere on this page. The Warehouse Manager does not
   hold `charges.view` — see the note on `WAREHOUSE_CAPS` in `lib/roles.ts` —
   and the register needs the name and the warehouse code, neither of which is
   money.
   ========================================================================== */

import { useMemo, useState } from 'react';
import { DataTable, type Column } from '@/components/DataTable';
import { Modal } from '@/components/Modal';
import { Icon } from '@/components/Icon';
import { EmptyState, PageHeader, Pill, Provenance, Section } from '@/components/primitives';
import { useToast } from '@/components/Toast';
import { TONE_BG, TONE_HEX, TONE_LINE } from '@/lib/status';
import { addDays, countLabel, fmtDate } from '@/lib/format';
import { NOW, charge as chargeById } from '@/data/db';
import * as HOP from '@/lib/hop';
import * as ROLES from '@/lib/roles';
import { useStockVersion, useWofVersion } from '@/lib/useStore';

/* ------------------------------------------------------------------ strip -- */

/**
 * `HORIZON_DAYS` of availability as one small bar chart.
 *
 * Deliberately not a sparkline of `free`: the eye needs to see the ceiling to
 * read the gap against it, so each day is drawn as committed-against-issuable
 * and a day that breaches the ceiling is drawn in the risk tone at full height.
 * A chart where the overdrawn day is merely shorter than its neighbours is a
 * chart nobody reads correctly at a glance.
 *
 * PRESSURE is drawn above the solid fill in a lighter tone, because "what is
 * gone" and "what is coming" are different facts and the warehouse needs both.
 * Never solid, never counted in `free`: a quote is not a commitment, and a
 * chart that made the two look alike would be the phantom-demand failure the
 * module is designed to avoid, reintroduced as a colour choice.
 */
function Strip({ days, ceiling }: { days: HOP.DayFree[]; ceiling: number }) {
  if (!days.length) return <span className="text-[12px] text-ink-3">Not tracked</span>;
  return (
    <span className="inline-flex items-end gap-[2px]" style={{ height: 26 }} aria-hidden="true">
      {days.map((d) => {
        const short = d.free < 0;
        const pct = (n: number) => (ceiling ? Math.min(100, Math.round((n / ceiling) * 100)) : 0);
        const fill = pct(d.committed);
        // Clipped at the ceiling: pressure that would overflow the shelf is
        // drawn reaching the top, which is the point being made.
        const withPressure = pct(d.committed + d.pressure);
        return (
          <span
            key={d.date}
            title={`${fmtDate(d.date)} — ${d.committed} out, ${d.free} free${
              d.pressure ? `, ${d.pressure} quoted` : ''
            }`}
            style={{
              width: 5, height: 26, display: 'inline-block', borderRadius: 1,
              background: short ? TONE_BG.atRisk : 'var(--line)',
              position: 'relative', overflow: 'hidden',
            }}
          >
            {d.pressure ? (
              <span
                style={{
                  position: 'absolute', left: 0, right: 0, bottom: 0,
                  height: `${withPressure}%`,
                  background: TONE_BG.info,
                }}
              />
            ) : null}
            <span
              style={{
                position: 'absolute', left: 0, right: 0, bottom: 0,
                height: short ? '100%' : `${fill}%`,
                background: short ? TONE_HEX.atRisk : TONE_HEX.info,
              }}
            />
          </span>
        );
      })}
    </span>
  );
}

/* ------------------------------------------------------------------- row --- */

interface Row {
  item: HOP.StockItem;
  name: string;
  code: string;
  location: string;
  issuable: number;
  days: HOP.DayFree[];
  /** The worst day in the horizon. What the row is judged on. */
  worst: number;
  short: HOP.DayFree[];
  consumable: boolean;
  lowStock: boolean;
  /** No longer offered on new quotes. Still owned, still on historic jobs. */
  retired: boolean;
}

function buildRows(): Row[] {
  const from = NOW.toISOString();
  const to = addDays(from, HOP.HORIZON_DAYS);
  return HOP.stockList().map((item) => {
    const c = chargeById(item.chargeId);
    const days = HOP.availability(item.chargeId, from, to);
    const issuable = HOP.issuable(item);
    const worst = days.length ? Math.min(...days.map((d) => d.free)) : issuable;
    return {
      item,
      name: c?.name || item.chargeId,
      code: c?.hireHopCode || c?.code || '—',
      location: item.location,
      issuable,
      days,
      worst,
      short: days.filter((d) => d.free < 0),
      consumable: HOP.isConsumable(c),
      lowStock: item.reorderAt !== undefined && issuable <= item.reorderAt,
      retired: HOP.isItemRetired(item.chargeId),
    };
  });
}

/* ------------------------------------------------------------------ edit --- */

interface Draft {
  owned: string;
  outOfService: string;
  turnaround: string;
  location: string;
  note: string;
  reason: string;
}

const draftFrom = (i: HOP.StockItem): Draft => ({
  owned: String(i.owned),
  outOfService: String(i.outOfService),
  turnaround: String(i.turnaround),
  location: i.location,
  note: i.note,
  reason: '',
});

function EditDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  const toast = useToast();
  const [d, setD] = useState<Draft>(() => draftFrom(row.item));
  const set = (k: keyof Draft, v: string) => setD((x) => ({ ...x, [k]: v }));

  const patch = {
    owned: Number(d.owned),
    outOfService: Number(d.outOfService),
    turnaround: Number(d.turnaround),
    location: d.location,
    note: d.note,
  };
  const blocker = HOP.setStockBlocker(row.item.chargeId, patch);
  const numericMoved =
    patch.owned !== row.item.owned ||
    patch.outOfService !== row.item.outOfService ||
    patch.turnaround !== row.item.turnaround;
  const needReason = numericMoved && !d.reason.trim();

  const save = () => {
    const res = HOP.setStock(row.item.chargeId, patch, d.reason);
    if (!res.ok) {
      toast(res.reason || 'Not saved.', { tone: 'atRisk' });
      return;
    }
    toast(`${row.name} updated.`, { tone: 'healthy' });
    onClose();
  };

  const field = (label: string, k: keyof Draft, hint: string, numeric = true) => (
    <label className="block mb-3">
      <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">{label}</span>
      <input
        className="field"
        type={numeric ? 'number' : 'text'}
        min={numeric ? 0 : undefined}
        value={d[k]}
        onChange={(e) => set(k, e.target.value)}
      />
      <span className="block text-[11.5px] text-ink-3 mt-1.5 leading-relaxed">{hint}</span>
    </label>
  );

  return (
    <Modal
      title={row.name}
      width={560}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!!blocker || needReason}
            title={blocker || (needReason ? 'Say why the count changed.' : undefined)}
            onClick={save}
          >
            Save
          </button>
        </>
      }
    >
      {field('Owned', 'owned', 'Everything EP owns, including anything currently out of service.')}
      {field('Out of service', 'outOfService', 'Away for repair, PAT test or written off. Held apart from owned so the insurance figure and this week stay separable.')}
      {field('Turnaround (days)', 'turnaround', 'Days after a job’s last hire day before this is issuable again — collection, check-in, charge, test.')}
      {field('Location', 'location', 'Which shelf, cage or van. Orders the picking list, because a picker walks the building once.', false)}
      {field('Note', 'note', 'Anything the next person needs to know.', false)}

      <label className="block">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
          Why {needReason ? <span className="text-status-critical">*</span> : null}
        </span>
        <input
          className="field"
          placeholder="e.g. Counted the cage — we have ten more than the register said"
          value={d.reason}
          onChange={(e) => set('reason', e.target.value)}
        />
        <span className="block text-[11.5px] text-ink-3 mt-1.5 leading-relaxed">
          Required for a count change and kept forever. A job can be refused on these numbers, so
          &ldquo;who wrote this down and why&rdquo; has to be answerable later.
        </span>
      </label>

      {blocker ? (
        <p className="text-[12.5px] mt-3" style={{ color: TONE_HEX.atRisk }}>{blocker}</p>
      ) : null}
    </Modal>
  );
}

/* ------------------------------------------------------------------ page --- */

/** A minimal valid spec, used only to ask "could this person add anything at all". */
const EMPTY_SPEC: HOP.NewStockItem = {
  name: '', code: '', dayCost: 1, dayCharge: 1, replaceCost: 1, replaceCharge: 1,
  owned: 0, turnaround: 0, location: '',
};

export default function StockPage() {
  useStockVersion();
  useWofVersion(); // a job reaching Order changes every number on this screen
  const toast = useToast();
  const [editing, setEditing] = useState<Row | null>(null);
  const [adding, setAdding] = useState(false);

  const rows = useMemo(buildRows, [HOP.getVersion()]);
  const short = rows.filter((r) => r.short.length);
  const unmanaged = HOP.kitCharges().filter((c) => !HOP.isManaged(c.id));
  const g = ROLES.gate('kit.stock');
  // Adding kit writes a price as well as a count, so it needs both hats. The
  // blocker names the missing one rather than greying the button in silence.
  const newBlock = HOP.createStockItemBlocker({
    ...EMPTY_SPEC, name: 'x', code: 'XX', owned: 0, turnaround: 0, location: '',
  });

  const columns: Column<Row>[] = [
    {
      key: 'name', label: 'Item',
      cell: (r) => (
        <>
          <div className="text-[13.5px] text-ink">{r.name}</div>
          <div className="text-[11.5px] text-ink-3">
            {r.code} · {r.location || 'no location set'}
            {r.consumable ? ' · consumable' : ''}
          </div>
          {r.retired ? (
            <div className="mt-1">
              <Pill
                label="Retired"
                tone="neutral"
                hint="Not offered on new quotes. Still owned, and still readable on every job that used it."
              />
            </div>
          ) : null}
        </>
      ),
    },
    {
      key: 'owned', label: 'Owned', align: 'right', nowrap: true,
      cell: (r) => <span className="tabular-nums text-ink-2">{r.item.owned.toLocaleString()}</span>,
    },
    {
      key: 'oos', label: 'Out of service', align: 'right', nowrap: true,
      cell: (r) =>
        r.item.outOfService ? (
          <span className="tabular-nums text-ink-2 tip" tabIndex={0} data-tip={r.item.note || 'No note'}>
            {r.item.outOfService.toLocaleString()}
          </span>
        ) : (
          <span className="text-ink-3">—</span>
        ),
    },
    {
      key: 'issuable', label: 'Issuable', align: 'right', nowrap: true,
      cell: (r) => (
        <span className="tabular-nums text-[15px] font-semibold text-ink">
          {r.issuable.toLocaleString()}
        </span>
      ),
    },
    {
      key: 'strip', label: `Next ${HOP.HORIZON_DAYS} days`,
      cell: (r) => <Strip days={r.days} ceiling={r.issuable} />,
    },
    {
      key: 'worst', label: 'Worst day', align: 'right', nowrap: true,
      cell: (r) =>
        r.short.length ? (
          <Pill
            label={`${Math.abs(r.worst)} short`}
            tone="atRisk"
            hint={`Oversubscribed on ${countLabel(r.short.length, 'day')}, first ${fmtDate(r.short[0].date)}.`}
          />
        ) : r.lowStock ? (
          <Pill label="Re-order" tone="info" hint={`At or below the re-order level of ${r.item.reorderAt}.`} />
        ) : (
          <span className="tabular-nums text-ink-2">{r.worst.toLocaleString()}</span>
        ),
    },
    {
      key: 'act', label: '', align: 'right', nowrap: true,
      cell: (r) => {
        const retireBlock = r.retired ? null : HOP.retireStockItemBlocker(r.item.chargeId);
        return (
          <span className="inline-flex items-center gap-1.5">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={g.disabled}
              title={g.title}
              onClick={() => setEditing(r)}
            >
              Edit
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={!!retireBlock}
              title={retireBlock || (r.retired
                ? 'Offer it on new quotes again'
                : 'Stop offering it on new quotes. Nothing historic changes.')}
              onClick={() => {
                const res = HOP.retireStockItem(r.item.chargeId, !r.retired);
                toast(
                  res.ok
                    ? r.retired
                      ? `${r.name} is back on the rate card.`
                      : `${r.name} retired — off new quotes, unchanged on every job that used it.`
                    : res.reason || 'Not changed.',
                  { tone: res.ok ? 'info' : 'atRisk' },
                );
              }}
            >
              {r.retired ? 'Un-retire' : 'Retire'}
            </button>
          </span>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Stock register"
        subtitle="What EP owns, and what ordered work has already promised. Quoted jobs show as pressure — they are coming, but they do not hold anything."
        actions={
          <button
            type="button"
            className="btn btn-primary"
            disabled={!!newBlock}
            title={newBlock || undefined}
            onClick={() => setAdding(true)}
          >
            <Icon name="plus" decorative /> New item
          </button>
        }
      />

      {short.length ? (
        <div
          className="card p-4 mb-4"
          style={{ background: TONE_BG.atRisk, border: `1px solid ${TONE_LINE.atRisk}` }}
        >
          <div className="text-[12.5px] font-semibold text-ink mb-1">
            {countLabel(short.length, 'item')} oversubscribed in the next {HOP.HORIZON_DAYS} days
          </div>
          <ul className="text-[12px] text-ink-2 leading-relaxed space-y-0.5">
            {short.map((r) => (
              <li key={r.item.chargeId}>
                · {r.name} — {Math.abs(r.worst)} short on{' '}
                {countLabel(r.short.length, 'day')}, first {fmtDate(r.short[0].date)}
              </li>
            ))}
          </ul>
          <p className="text-[11.5px] text-ink-3 mt-1.5 leading-relaxed">
            Ordered work only. Sub-hire it, move a job, or correct the count — nothing here is blocked yet.
          </p>
        </div>
      ) : null}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.item.chargeId}
        empty={<EmptyState title="Nothing on the register" body="No kit charge is stock-controlled yet." />}
      />

      {unmanaged.length ? (
        <>
          <Section title="Not stock-controlled" />
          <div className="card p-4">
            <p className="text-[13px] text-ink-2 leading-relaxed mb-2">
              EP does not own these — they are sub-hired from a supplier per job. They are quoted freely
              and can never be short, which is why they carry no count. A zero here would put a false
              shortfall on every job that quotes one.
            </p>
            <ul className="text-[12.5px] text-ink-2 leading-relaxed">
              {unmanaged.map((c) => (
                <li key={c.id}>· {c.name} <span className="text-ink-3">({c.hireHopCode || c.code})</span></li>
              ))}
            </ul>
          </div>
        </>
      ) : null}

      <Provenance>
        Availability is derived from hire windows, not from scanning: an item frees when its job&rsquo;s
        window passes, plus that item&rsquo;s turnaround. Only work at Order or beyond draws stock —
        quotes are speculative, and a register full of jobs that never happened is a register nobody
        reads. The one way this is optimistic is that kit which never came back still frees on schedule;
        until the return leg exists, hold it in out of service.
      </Provenance>

      {editing ? <EditDialog row={editing} onClose={() => setEditing(null)} /> : null}
      {adding ? <NewItemDialog onClose={() => setAdding(false)} /> : null}
    </>
  );
}

/* -------------------------------------------------------------- new item --- */

interface NewDraft {
  name: string; code: string;
  dayCost: string; dayCharge: string;
  replaceCost: string; replaceCharge: string;
  owned: string; turnaround: string; location: string; note: string;
  consumable: boolean;
}

const EMPTY_DRAFT: NewDraft = {
  name: '', code: '',
  dayCost: '', dayCharge: '',
  replaceCost: '', replaceCharge: '',
  owned: '', turnaround: '1', location: '', note: '',
  consumable: false,
};

/**
 * Adding a thing EP owns.
 *
 * One form for three records — a day rate, a replacement price and a shelf
 * count — because an item missing any of them is broken in a way nobody sees
 * until it matters. Grouped under three headings so which half is Finance's
 * and which is the warehouse's is legible without reading the hints.
 */
export function NewItemDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [d, setD] = useState<NewDraft>(EMPTY_DRAFT);
  const set = (k: keyof NewDraft, v: string | boolean) => setD((x) => ({ ...x, [k]: v }));

  const spec: HOP.NewStockItem = {
    name: d.name,
    code: d.code.toUpperCase(),
    dayCost: Number(d.dayCost),
    dayCharge: Number(d.dayCharge),
    replaceCost: Number(d.replaceCost),
    replaceCharge: Number(d.replaceCharge),
    owned: Math.trunc(Number(d.owned)),
    turnaround: Math.trunc(Number(d.turnaround)),
    location: d.location,
    note: d.note,
    consumable: d.consumable,
  };
  const blocker = HOP.createStockItemBlocker(spec);
  const margin = spec.dayCharge > 0 ? Math.round(((spec.dayCharge - spec.dayCost) / spec.dayCharge) * 100) : 0;

  const create = () => {
    const res = HOP.createStockItem(spec);
    if (!res.ok) {
      toast(res.reason || 'Not created.', { tone: 'atRisk' });
      return;
    }
    toast(`${spec.name} is on the register — ${spec.owned} owned, and quotable from today.`, {
      tone: 'healthy',
    });
    onClose();
  };

  const req = <span className="text-status-critical">*</span>;

  const money = (label: string, k: keyof NewDraft) => (
    <label className="block">
      <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">{label} {req}</span>
      <input
        className="field"
        type="number"
        step="0.01"
        min={0}
        placeholder="0.00"
        value={String(d[k])}
        onChange={(e) => set(k, e.target.value)}
      />
    </label>
  );

  const heading = (t: string) => (
    <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2 mt-4">{t}</div>
  );

  return (
    <Modal
      title="New kit item"
      width={560}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!!blocker}
            title={blocker || undefined}
            onClick={create}
          >
            Add to the register
          </button>
        </>
      }
    >
      <p className="text-[13px] text-ink-2 leading-relaxed mb-4">
        Creates a <strong className="text-ink">day rate</strong>, a{' '}
        <strong className="text-ink">replacement price</strong> and the{' '}
        <strong className="text-ink">shelf count</strong> together. An item missing any of them is broken
        in a way nobody sees until it matters, so it is all or nothing.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Name {req}</span>
          <input
            className="field"
            placeholder="e.g. Tower light (LED, 9m)"
            value={d.name}
            onChange={(e) => set('name', e.target.value)}
          />
        </label>
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Warehouse code {req}</span>
          <input
            className="field"
            placeholder="LGT-LED9"
            value={d.code}
            onChange={(e) => set('code', e.target.value.toUpperCase())}
          />
        </label>
      </div>
      <p className="text-[11.5px] text-ink-3 mt-1.5 leading-relaxed">
        The name is what a client reads on the quote. The code is what the picker reads on the shelf —
        capitals, digits and dashes.
      </p>

      <label className="flex items-start gap-2.5 mt-3 well p-3">
        <input
          type="checkbox"
          checked={d.consumable}
          onChange={(e) => set('consumable', e.target.checked)}
          style={{ marginTop: 2 }}
        />
        <span className="text-[12.5px] text-ink-2 leading-relaxed">
          <strong className="text-ink">Consumable</strong> — issued, not lent. Hi-vis, cable ties.
          Charged per item, drawn down permanently, and it needs no replacement price because it cannot
          come back.
        </span>
      </label>

      {heading(d.consumable ? 'Price, per item' : 'Price, per day')}
      <div className="grid grid-cols-2 gap-3">
        {money('Cost to EP', 'dayCost')}
        {money('Charged', 'dayCharge')}
      </div>

      {d.consumable ? null : (
        <>
          {heading('Replacement, per item')}
          <div className="grid grid-cols-2 gap-3">
            {money('Cost to EP', 'replaceCost')}
            {money('Charged', 'replaceCharge')}
          </div>
          <p className="text-[11.5px] text-ink-3 mt-1.5 leading-relaxed">
            What the client pays if it does not come back. Charged once per item, not per day — billing a
            lost £180 handset at its day rate is how these end up settled by argument.
          </p>
        </>
      )}

      {heading('On the shelf')}
      <div className="grid grid-cols-3 gap-3">
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Owned {req}</span>
          <input
            className="field"
            type="number"
            min={0}
            placeholder="0"
            value={d.owned}
            onChange={(e) => set('owned', e.target.value)}
          />
        </label>
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Turnaround</span>
          <input
            className="field"
            type="number"
            min={0}
            value={d.turnaround}
            onChange={(e) => set('turnaround', e.target.value)}
          />
        </label>
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Location</span>
          <input
            className="field"
            placeholder="Yard — bay 4"
            value={d.location}
            onChange={(e) => set('location', e.target.value)}
          />
        </label>
      </div>
      <p className="text-[11.5px] text-ink-3 mt-1.5 leading-relaxed">
        Turnaround is days between a job's last hire day and this being issuable again — collection,
        check-in, test. It comes straight off availability, so a guess here is a promise EP might not
        keep.
      </p>

      {/* The same margin readout the rate-card dialog gives, for the same
          reason: a price typed without it is a price nobody checked. */}
      {spec.dayCharge > 0 ? (
        <div className="well p-3 mt-4">
          <div className="flex items-baseline justify-between">
            <span className="text-[13px] text-ink-2">
              Margin {d.consumable ? 'per item' : 'per day'}
            </span>
            <span
              className="text-[17px] font-bold tabular-nums"
              style={{ color: margin >= 40 ? TONE_HEX.healthy : margin > 0 ? TONE_HEX.atRisk : TONE_HEX.critical }}
            >
              {margin}%
            </span>
          </div>
        </div>
      ) : null}

      {blocker ? (
        <p className="text-[12.5px] mt-3" style={{ color: TONE_HEX.atRisk }}>
          {blocker}
        </p>
      ) : null}
    </Modal>
  );
}
