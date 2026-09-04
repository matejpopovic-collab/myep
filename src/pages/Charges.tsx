/* ============================================================================
   TABLE OF CHARGES  (reference dataset 1 of 4)
   ----------------------------------------------------------------------------
   Briefing §2.1: "Kit day rates, staff charge-out rates, tiered pricing. Feeds
   into quotes, picking and packing, and invoicing."
   Briefing §2.3 adds: job costing "requires cost prices as well as charge-out
   rates in the table of charges."

   The screen exists mainly to make one thing obvious, because it is the design
   principle most likely to be got wrong in the build:

     EDITING A RATE DOES NOT CHANGE AN EXISTING JOB.

   Every rate carries a version history. Quotes snapshot the version that
   applied on the day they were priced. This page shows both — the rate today,
   and every job still holding an older version.
   ========================================================================== */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import {
  Kpi, PageHeader, Pill, Provenance, SearchField, Segmented,
} from '@/components/primitives';
import { DataTable, type Column } from '@/components/DataTable';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { TONE_BG, TONE_HEX, TONE_LINE } from '@/lib/status';
import { countLabel, fmtDate, money } from '@/lib/format';
import {
  CHARGES, JOB_ROLES, NOW, RATE_CARDS, charge as chargeById, chargeVersions, rateAt,
} from '@/data/db';
import type { Charge, ChargeKind, ChargeUnit, Tone } from '@/data/types';
import * as W from '@/lib/wof';
import * as RATES from '@/lib/rates';
import * as ROLES from '@/lib/roles';
import * as CHARGES_LIB from '@/lib/charges';
import { useChargesVersion, useWofs } from '@/lib/useStore';

type KindFilter = 'all' | ChargeKind;

/* The published table priced from one of the three cards. A card is a factor,
   not a second price list — see `RATE_CARDS` — so this is a lens on the same
   rows rather than three tables to keep in step. */
const onCard = (c: Charge, cardId: string) => rateAt(c.id, NOW, cardId)!;

/** How many accounts sit on a card. Read at render — the client register is
    replayed from its own journal and a count taken at import would be stale. */
const CLIENT_COUNT = (cardId: string) => RATES.accountsOnCard(cardId);

const markupTone = (m: number): Tone => (m >= 45 ? 'healthy' : m >= 30 ? 'atRisk' : 'critical');
const markupOf = (c: { cost: number; charge: number }) =>
  c.cost ? Math.round(((c.charge - c.cost) / c.charge) * 100) : 0;

export default function ChargesPage() {
  const toast = useToast();
  const wofs = useWofs();

  const navigate = useNavigate();
  const [kind, setKind] = useState<KindFilter>('all');
  const [card, setCard] = useState<string>('standard');
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState<string | null>(null);
  const [editing, setEditing] = useState<Charge | null>(null);
  const [details, setDetails] = useState<Charge | null>(null);
  const [adding, setAdding] = useState(false);
  const [, force] = useState(0);

  // A line added, corrected or retired anywhere — including on the stock
  // register, which creates kit rates — has to move this table on the same
  // render. `force` remains for the rate dialog, which writes versions
  // straight onto the charge rather than through the journal.
  useChargesVersion();

  const q = query.trim().toLowerCase();
  const rows = CHARGES.filter((c) => {
    if (kind !== 'all' && c.kind !== kind) return false;
    if (q && !`${c.name} ${c.code}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const staleLines = wofs.flatMap((w) => w.lines.filter(W.lineIsStale).map((l) => ({ w, l })));
  const staleJobs = new Set(staleLines.map((s) => s.w.id)).size;

  const columns: Column<Charge>[] = [
    {
      key: 'code', label: 'Code', nowrap: true,
      cell: (c) => <span className="font-mono text-[12px] text-ink-3">{c.code}</span>,
    },
    {
      key: 'name', label: 'Charge line',
      cell: (c) => (
        <>
          <div className="text-[13.5px] text-ink">
            {c.name}
            {c.retired ? (
              <span className="ml-1.5 align-middle">
                <Pill label="Retired" tone="neutral" hint={false} />
              </span>
            ) : null}
          </div>
          <div className="text-[11.5px] text-ink-3">
            {c.kind}
            {c.role ? ` · fills the ${c.role} role` : ''}
            {c.hireHopCode ? ` · Hire Hop ${c.hireHopCode}` : ''}
            {CHARGES_LIB.isEdited(c.id) ? ' · corrected' : ''}
          </div>
        </>
      ),
    },
    {
      key: 'cost', label: 'Cost price', align: 'right', nowrap: true,
      cell: (c) => (
        <>
          <span className="tabular-nums text-ink-2">{money(c.cost)}</span>
          <div className="text-[11px] text-ink-3">per {c.unit}</div>
        </>
      ),
    },
    {
      key: 'charge', label: card === 'standard' ? 'Charge-out' : `Charge-out (${RATES.cards().find((x) => x.id === card)!.label})`,
      align: 'right', nowrap: true,
      cell: (c) => {
        const r = onCard(c, card);
        return (
          <>
            <span className="tabular-nums font-semibold text-ink">{money(r.charge)}</span>
            <div className="text-[11px] text-ink-3">
              {card === 'standard' ? `per ${c.unit}` : `published ${money(c.charge)}`}
            </div>
          </>
        );
      },
    },
    {
      key: 'markup', label: 'Markup', align: 'right', nowrap: true,
      cell: (c) => {
        const m = markupOf({ cost: c.cost, charge: onCard(c, card).charge });
        return (
          <span className="tabular-nums font-medium" style={{ color: TONE_HEX[markupTone(m)] }}>
            {m}%
          </span>
        );
      },
    },
    {
      key: 'tiers', label: 'Volume tiers',
      cell: (c) =>
        c.tiers?.length ? (
          <span className="flex flex-wrap gap-1">
            {onCard(c, card).tiers.map((t) => (
              <span
                key={t.minQty}
                className="pill"
                style={{ background: TONE_BG.neutral, color: TONE_HEX.neutral }}
              >
                {t.minQty}+ → {money(t.charge)}
              </span>
            ))}
          </span>
        ) : (
          <span className="text-[12.5px] text-ink-3">None</span>
        ),
    },
    {
      key: 'version', label: 'Effective from', nowrap: true,
      cell: (c) => (
        <>
          <div className="text-[13px] text-ink-2">{fmtDate(c.effectiveFrom)}</div>
          {c.history?.length ? (
            <div className="text-[11px] text-ink-3">
              {c.history.length} earlier version{c.history.length > 1 ? 's' : ''}
            </div>
          ) : null}
        </>
      ),
    },
    {
      key: 'act', label: '', align: 'right', nowrap: true,
      cell: (c) => (
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDetail(c.id)}>
          Details
        </button>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Table of charges"
        subtitle="The rate card. Cost price and charge-out rate for every role, kit item and service, with volume tiers and full version history. Read by quoting, picking and packing, invoicing and job costing."
        actions={
          /* One door for all three kinds, and the dialog explains why kit
             leaves by a different one: the stock register creates the day
             rate, the replacement price and the shelf count together, because
             an item missing any of them is broken invisibly. */
          <button
            type="button"
            className="btn btn-primary"
            {...ROLES.gate('charges.edit')}
            onClick={() => setAdding(true)}
          >
            <Icon name="plus" decorative /> Add charge line
          </button>
        }
      />

      <div className="card p-4 mb-5" style={{ background: TONE_BG.info, borderColor: TONE_LINE.info }}>
        <div className="flex items-start gap-2.5">
          <span style={{ color: TONE_HEX.info, marginTop: 1 }}>
            <Icon name="info" decorative />
          </span>
          <div className="flex-1">
            <div className="text-[13px] font-semibold text-ink mb-1">
              Changing a rate never rewrites an existing job
            </div>
            <p className="text-[13px] text-ink-2 leading-relaxed">
              Each quote line stores the rate version that applied when it was priced. Editing a rate here
              creates a new version with today's effective date and affects new quotes only. Right now{' '}
              <strong className="text-ink">
                {staleLines.length} live line{staleLines.length === 1 ? '' : 's'}
              </strong>{' '}
              across {staleJobs} job{staleJobs === 1 ? '' : 's'} are deliberately held on a superseded rate,
              because that is the rate the client agreed.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-2.5 mb-5 md:grid-cols-3">
        {RATE_CARDS.map((rc) => {
          const on = rc.id === card;
          const held = CLIENT_COUNT(rc.id);
          return (
            <button
              key={rc.id}
              type="button"
              aria-pressed={on}
              onClick={() => setCard(rc.id)}
              className="card p-3.5 text-left"
              style={on ? { borderColor: TONE_LINE.info, background: TONE_BG.info } : undefined}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13.5px] font-semibold text-ink">{rc.label}</span>
                <span className="text-[12px] tabular-nums text-ink-2">
                  {rc.factor === 1 ? 'published' : `${rc.factor > 1 ? '+' : '−'}${Math.round(Math.abs(1 - rc.factor) * 100)}%`}
                </span>
              </div>
              <p className="text-[11.5px] text-ink-3 mt-1 leading-relaxed">{rc.blurb}</p>
              <div className="text-[11.5px] text-ink-2 mt-1.5">
                {countLabel(held, 'account')} priced from it
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2.5 mb-5">
        <Segmented<KindFilter>
          ariaLabel="Filter by kind"
          value={kind}
          onChange={setKind}
          options={[
            ['all', 'Everything'],
            ['staff', 'Staff'],
            ['kit', 'Kit'],
            ['service', 'Services'],
          ]}
        />
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Filter by name or code…"
          ariaLabel="Filter charges"
        />
      </div>

      <DataTable columns={columns} rows={rows} rowKey={(c) => c.id} />

      <Provenance>
        Cost price is what the line costs EP to supply and is what Job costing books. Charge-out is what the
        client pays. Both are versioned; the effective date is what a quote line snapshots. The three cards
        are positions on this one table, not copies of it — so a rate rise lands on all three at once. A
        price agreed with a single account beats its card and lives on the client record.
      </Provenance>

      {detail ? (
        <ChargeDetail
          chargeId={detail}
          onClose={() => setDetail(null)}
          onEdit={(c) => {
            setDetail(null);
            setEditing(c);
          }}
          onEditDetails={(c) => {
            setDetail(null);
            setDetails(c);
          }}
        />
      ) : null}

      {adding ? (
        <NewChargeDialog
          initialKind={kind === 'all' ? 'staff' : kind}
          onClose={() => setAdding(false)}
          onGoToStock={() => {
            setAdding(false);
            navigate('/warehouse/stock');
          }}
          onCreated={(c) => {
            setAdding(false);
            toast(`${c.name} is on the table of charges and quotable from today.`, { tone: 'healthy' });
          }}
        />
      ) : null}

      {details ? (
        <EditDetails
          charge={details}
          onClose={() => setDetails(null)}
          onSaved={(c) => {
            setDetails(null);
            toast(`${c.name} updated. Quotes already sent are unchanged.`, { tone: 'healthy' });
          }}
        />
      ) : null}

      {editing ? (
        <EditRate
          charge={editing}
          onClose={() => setEditing(null)}
          onPublish={(c) => {
            setEditing(null);
            force((n) => n + 1);
            toast(`New rate published for ${c.name}. Existing quotes are unaffected.`, { tone: 'healthy' });
          }}
        />
      ) : null}
    </>
  );
}

/* ----------------------------------------------------------------- detail -- */

function ChargeDetail({
  chargeId,
  onClose,
  onEdit,
  onEditDetails,
}: {
  chargeId: string;
  onClose: () => void;
  onEdit: (c: Charge) => void;
  onEditDetails: (c: Charge) => void;
}) {
  const c = chargeById(chargeId);
  if (!c) return null;

  const versions = chargeVersions(c);
  const uses = W.all().flatMap((w) => w.lines.filter((l) => l.chargeId === chargeId).map((l) => ({ w, l })));
  const stale = uses.filter((u) => W.lineIsStale(u.l));

  return (
    <Modal
      title={c.name}
      width={680}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Close
          </button>
          {/* Two separate doors, because they are two separate acts. Correcting
              the words is a correction; changing the money writes a version
              with an effective date and leaves signed work alone. */}
          <button
            type="button"
            className="btn btn-secondary"
            {...ROLES.gate('charges.edit')}
            onClick={() => onEditDetails(c)}
          >
            Edit details
          </button>
          {/* Everyone quoting a job needs to READ the rate card. Changing what
              EP Team pays and what clients are charged is Finance's. */}
          <button
            type="button"
            className="btn btn-primary"
            {...ROLES.gate('charges.edit')}
            onClick={() => onEdit(c)}
          >
            Publish a new rate
          </button>
        </>
      }
    >
      <div className="flex flex-wrap gap-3 mb-5">
        <Kpi label="Cost price" value={money(c.cost)} sub={`per ${c.unit}`} tone="neutral" />
        <Kpi label="Charge-out" value={money(c.charge)} sub={`per ${c.unit}`} tone="info" />
        <Kpi
          label="In use on"
          value={String(uses.length)}
          sub={`lines across ${new Set(uses.map((u) => u.w.id)).size} jobs`}
          tone="neutral"
        />
      </div>

      <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2">
        What each card pays today
      </div>
      <div className="well p-3 mb-5">
        {RATE_CARDS.map((rc) => {
          const r = rateAt(c.id, NOW, rc.id)!;
          return (
            <div key={rc.id} className="flex items-baseline justify-between gap-3 py-1">
              <span className="text-[13px] text-ink-2">
                {rc.label}
                {rc.factor === 1 ? '' : ` · ${rc.factor > 1 ? '+' : '−'}${Math.round(Math.abs(1 - rc.factor) * 100)}%`}
              </span>
              <span className="text-[13px] tabular-nums font-semibold text-ink">
                {money(r.charge)} <span className="text-[11px] font-normal text-ink-3">per {c.unit}</span>
              </span>
            </div>
          );
        })}
        <p className="text-[11.5px] text-ink-3 mt-2 leading-relaxed">
          {RATES.accountsHolding(c.id)
            ? `${countLabel(RATES.accountsHolding(c.id), 'account holds', 'accounts hold')} a price agreed for this line that beats their card. It is on their client record, under Rates.`
            : 'No account holds an agreed price for this line — every one of them pays its card rate.'}
        </p>
      </div>

      <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2">Version history</div>
      <table className="tbl mb-5">
        <thead>
          <tr>
            <th>Effective from</th>
            <th style={{ textAlign: 'right' }}>Cost</th>
            <th style={{ textAlign: 'right' }}>Charge</th>
            <th>Tiers</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.effectiveFrom}>
              <td>{fmtDate(v.effectiveFrom)}</td>
              <td style={{ textAlign: 'right' }} className="tabular-nums">
                {money(v.cost)}
              </td>
              <td style={{ textAlign: 'right' }} className="tabular-nums">
                {money(v.charge)}
              </td>
              <td className="text-[12px] text-ink-3">
                {v.tiers?.length ? v.tiers.map((t) => `${t.minQty}+ → ${money(t.charge)}`).join(', ') : '—'}
              </td>
              <td style={{ textAlign: 'right' }}>
                {v.current ? (
                  <Pill label="Current" tone="healthy" hint={false} />
                ) : (
                  <Pill label="Superseded" tone="neutral" hint={false} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {stale.length ? (
        <div className="rounded-lg p-3 mb-5" style={{ background: TONE_BG.atRisk }}>
          <div className="text-[13px] font-semibold text-ink mb-1">
            {stale.length} line{stale.length > 1 ? 's are' : ' is'} still on an older version
          </div>
          <p className="text-[12.5px] text-ink-2 leading-relaxed mb-2">
            This is correct behaviour, not a bug. These jobs were quoted at the earlier rate and the client
            agreed that price. Re-pricing is a deliberate act on the WOF, and it is recorded.
          </p>
          <div className="text-[12.5px] leading-relaxed">
            {[...new Set(stale.map((s) => s.w.id))].map((id, i) => {
              const w = W.byId(id)!;
              return (
                <span key={id}>
                  {i ? ' · ' : ''}
                  <Link to={`/wofs/${id}#quote`} className="text-accent no-underline hover:underline">
                    {w.ref} {w.title}
                  </Link>
                </span>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2">Where it is used</div>
      {uses.length ? (
        <>
          <table className="tbl">
            <thead>
              <tr>
                <th>Job</th>
                <th>Line</th>
                <th style={{ textAlign: 'right' }}>Qty</th>
                <th style={{ textAlign: 'right' }}>Rate used</th>
                <th style={{ textAlign: 'right' }}>Value</th>
              </tr>
            </thead>
            <tbody>
              {uses.slice(0, 12).map((u) => (
                <tr key={u.l.id}>
                  <td>
                    <Link to={`/wofs/${u.w.id}#quote`} className="text-accent no-underline hover:underline">
                      {u.w.title}
                    </Link>
                    <div className="text-[11px] text-ink-3 font-mono">{u.w.ref}</div>
                  </td>
                  <td className="text-[12.5px] text-ink-2">{u.l.description}</td>
                  <td style={{ textAlign: 'right' }} className="tabular-nums">
                    {u.l.qty} × {u.l.units}
                  </td>
                  <td style={{ textAlign: 'right' }} className="tabular-nums">
                    {money(W.lineRate(u.l))}
                    {W.lineIsStale(u.l) && u.l.snap ? (
                      <div className="text-[11px]" style={{ color: TONE_HEX.atRisk }}>
                        v{fmtDate(u.l.snap.rateVersion)}
                      </div>
                    ) : null}
                  </td>
                  <td style={{ textAlign: 'right' }} className="tabular-nums font-semibold">
                    {money(W.lineValue(u.l), { pence: false })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {uses.length > 12 ? (
            <p className="text-[12px] text-ink-3 mt-2">+{uses.length - 12} more lines.</p>
          ) : null}
        </>
      ) : (
        <p className="text-[13px] text-ink-3">Not used on any WOF yet.</p>
      )}
    </Modal>
  );
}

/* -------------------------------------------------------------- edit rate -- */

function EditRate({
  charge,
  onClose,
  onPublish,
}: {
  charge: Charge;
  onClose: () => void;
  onPublish: (c: Charge) => void;
}) {
  const [cost, setCost] = useState(String(charge.cost));
  const [chargeOut, setChargeOut] = useState(String(charge.charge));
  const [from, setFrom] = useState('2026-08-03');

  const m = markupOf({ cost: Number(cost), charge: Number(chargeOut) });
  const was = markupOf(charge);

  const publish = () => {
    charge.history = [
      { effectiveFrom: charge.effectiveFrom, cost: charge.cost, charge: charge.charge, tiers: charge.tiers },
    ].concat(charge.history || []);
    charge.cost = Number(cost);
    charge.charge = Number(chargeOut);
    charge.effectiveFrom = from;
    onPublish(charge);
  };

  return (
    <Modal
      title={`New rate for ${charge.name}`}
      width={520}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={publish}>
            Publish new version
          </button>
        </>
      }
    >
      <p className="text-[13px] text-ink-2 leading-relaxed mb-4">
        This creates a <strong className="text-ink">new version</strong> effective from the date you choose.
        Existing quotes keep the rate they were priced on. Only quotes priced after the effective date pick
        this up.
      </p>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Cost price</span>
          <input className="field" type="number" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} />
        </label>
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Charge-out</span>
          <input
            className="field"
            type="number"
            step="0.01"
            value={chargeOut}
            onChange={(e) => setChargeOut(e.target.value)}
          />
        </label>
      </div>
      <label className="block mb-3">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Effective from</span>
        <input className="field" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </label>
      <div className="well p-3">
        <div className="flex items-baseline justify-between">
          <span className="text-[13px] text-ink-2">Margin on this line</span>
          <span className="text-[17px] font-bold tabular-nums" style={{ color: TONE_HEX[markupTone(m)] }}>
            {m}%
          </span>
        </div>
        <div className="text-[11.5px] text-ink-3 mt-1">Was {was}%</div>
      </div>
    </Modal>
  );
}

/* ============================================================================
   ADDING AND CORRECTING
   ----------------------------------------------------------------------------
   Two dialogs, and the split between them is the point. `NewChargeDialog`
   creates a line and its opening prices. `EditDetails` corrects the words on a
   line that exists and cannot touch the money — that goes through `EditRate`,
   which writes a version with an effective date so a job already priced keeps
   the rate the client agreed.

   Kit leaves by the other door. `createStockItem` writes the day rate, the
   replacement price and the shelf count in one act because an item missing any
   of them is broken in a way nobody sees until a job is picked; splitting that
   across two screens would make the broken state reachable in one click.
   ========================================================================== */

const UNIT_LABEL: Record<ChargeUnit, string> = {
  hour: 'Per hour',
  day: 'Per day',
  each: 'Per item',
};

const UNITS: ChargeUnit[] = ['hour', 'day', 'each'];

/** Every rostered role, plus any role a staff charge already names that the
    roster list does not — `Security Officer` is one of those, and leaving it
    out would offer to create a second charge for a role already supplied. */
function rosterRoles(): string[] {
  const named = CHARGES.filter((c) => c.kind === 'staff' && c.role).map((c) => c.role!);
  return [...new Set([...JOB_ROLES, ...named])].sort((a, b) => a.localeCompare(b));
}

/** The live staff charge already supplying a role, if it is not this one. */
const suppliedBy = (role: string, selfId?: string): Charge | undefined =>
  CHARGES.find((c) => c.id !== selfId && c.kind === 'staff' && !c.retired && c.role === role);

function RoleField({
  value,
  onChange,
  selfId,
}: {
  value: string;
  onChange: (v: string) => void;
  selfId?: string;
}) {
  return (
    <label className="block">
      <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Fills the role</span>
      <select className="field" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Not a rostered role</option>
        {rosterRoles().map((r) => {
          const held = suppliedBy(r, selfId);
          return (
            <option key={r} value={r} disabled={!!held}>
              {r}
              {held ? ` — supplied by ${held.name}` : ''}
            </option>
          );
        })}
      </select>
    </label>
  );
}

const Req = () => <span className="text-status-critical">*</span>;

const FieldHeading = ({ children }: { children: React.ReactNode }) => (
  <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2 mt-4">{children}</div>
);

/* ------------------------------------------------------------ new charge -- */

interface NewDraft {
  name: string;
  code: string;
  unit: ChargeUnit;
  cost: string;
  charge: string;
  role: string;
}

const DRAFT_FOR = (k: ChargeKind): NewDraft => ({
  name: '',
  code: '',
  unit: k === 'staff' ? 'hour' : 'each',
  cost: '',
  charge: '',
  role: '',
});

export function NewChargeDialog({
  initialKind,
  onClose,
  onGoToStock,
  onCreated,
}: {
  initialKind: ChargeKind;
  onClose: () => void;
  onGoToStock: () => void;
  onCreated: (c: Charge) => void;
}) {
  const toast = useToast();
  const [kind, setKind] = useState<ChargeKind>(initialKind);
  const [d, setD] = useState<NewDraft>(() => DRAFT_FOR(initialKind));
  const set = (k: keyof NewDraft, v: string) => setD((x) => ({ ...x, [k]: v }));

  const switchKind = (k: ChargeKind) => {
    setKind(k);
    // The unit that makes sense differs by kind and the numbers do not carry
    // over meaningfully between them, so the form starts clean rather than
    // leaving an hourly cost sitting under a per-item service.
    setD(DRAFT_FOR(k));
  };

  const spec: CHARGES_LIB.NewCharge = {
    kind,
    code: d.code.toUpperCase().trim(),
    name: d.name,
    unit: d.unit,
    cost: Number(d.cost),
    charge: Number(d.charge),
    ...(kind === 'staff' && d.role ? { role: d.role } : {}),
  };
  const blocker = kind === 'kit' ? null : CHARGES_LIB.createChargeBlocker(spec);
  const margin = spec.charge > 0 ? Math.round(((spec.charge - spec.cost) / spec.charge) * 100) : 0;

  const create = () => {
    const res = CHARGES_LIB.createCharge(spec, NOW.toISOString().slice(0, 10));
    if (!res.ok || !res.charge) {
      toast(res.reason || 'Not created.', { tone: 'atRisk' });
      return;
    }
    onCreated(res.charge);
  };

  const moneyField = (label: string, k: 'cost' | 'charge', hint: string) => (
    <label className="block">
      <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
        {label} <Req />
      </span>
      <input
        className="field"
        type="number"
        step="0.01"
        min={0}
        placeholder="0.00"
        value={d[k]}
        onChange={(e) => set(k, e.target.value)}
      />
      <span className="block text-[11px] text-ink-3 mt-1">{hint}</span>
    </label>
  );

  return (
    <Modal
      title="New charge line"
      width={560}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          {kind === 'kit' ? (
            /* Only offered to somebody the register will actually let in.
               `/warehouse/stock` is guarded by `kit.stock`, so handing everyone
               a button that bounces them would be a dead end dressed as a
               door — the card below names who does it instead. */
            ROLES.can('kit.stock') ? (
              <button type="button" className="btn btn-primary" onClick={onGoToStock}>
                Open the stock register
              </button>
            ) : null
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!!blocker}
              title={blocker || undefined}
              onClick={create}
            >
              Add to the table
            </button>
          )}
        </>
      }
    >
      <div className="mb-4">
        <Segmented<ChargeKind>
          ariaLabel="What kind of line"
          value={kind}
          onChange={switchKind}
          options={[
            ['staff', 'Staff'],
            ['kit', 'Kit'],
            ['service', 'Service'],
          ]}
        />
      </div>

      {kind === 'kit' ? (
        <div className="card p-4" style={{ background: TONE_BG.info, borderColor: TONE_LINE.info }}>
          <div className="text-[13px] font-semibold text-ink mb-1">Kit is added on the stock register</div>
          <p className="text-[13px] text-ink-2 leading-relaxed">
            A piece of kit needs three things at once: a <strong className="text-ink">day rate</strong>, a{' '}
            <strong className="text-ink">replacement price</strong> for when it does not come back, and a{' '}
            <strong className="text-ink">shelf count</strong>. An item missing any of them is quotable
            without limit or loseable without charge, and nobody finds out until a job is picked — so the
            register creates all three in one act, and this table shows the rate it produced.
          </p>
          <p className="text-[12.5px] text-ink-2 leading-relaxed mt-2">
            {ROLES.can('kit.stock')
              ? 'The register is under Warehouse in the rail.'
              : 'That is the warehouse’s screen and needs their stock permission as well as this one — ask them to add it, or have it granted under Team & roles.'}
          </p>
        </div>
      ) : (
        <>
          <p className="text-[13px] text-ink-2 leading-relaxed mb-4">
            This adds a line to the published table, effective from today, with{' '}
            <strong className="text-ink">no history</strong> — it has never been priced differently and
            inventing an earlier version would put a rate on the record that was never charged. Both rate
            cards follow from the published figure, so there is nothing else to set.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
                Name <Req />
              </span>
              <input
                className="field"
                placeholder={kind === 'staff' ? 'e.g. Response Steward' : 'e.g. Pre-event site survey'}
                value={d.name}
                onChange={(e) => set('name', e.target.value)}
              />
            </label>
            <label className="block">
              <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
                Code <Req />
              </span>
              <input
                className="field"
                placeholder={kind === 'staff' ? 'ST-RSP' : 'SV-SUR'}
                value={d.code}
                onChange={(e) => set('code', e.target.value.toUpperCase())}
              />
            </label>
          </div>
          <p className="text-[11.5px] text-ink-3 mt-1.5 leading-relaxed">
            The name is what a client reads on the quote. The code is read by people — capitals, digits and
            dashes, and unique across the whole table.
          </p>

          <FieldHeading>Pricing</FieldHeading>
          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
                Priced per <Req />
              </span>
              <select
                className="field"
                value={d.unit}
                onChange={(e) => set('unit', e.target.value as ChargeUnit)}
              >
                {UNITS.map((u) => (
                  <option key={u} value={u}>
                    {UNIT_LABEL[u]}
                  </option>
                ))}
              </select>
              <span className="block text-[11px] text-ink-3 mt-1">Both figures are per this.</span>
            </label>
            {moneyField('Cost price', 'cost', 'What it costs EP to supply.')}
            {moneyField('Charge-out', 'charge', 'What a Standard client pays.')}
          </div>

          {kind === 'staff' ? (
            <>
              <FieldHeading>On the roster</FieldHeading>
              <RoleField value={d.role} onChange={(v) => set('role', v)} />
              <p className="text-[11.5px] text-ink-3 mt-1.5 leading-relaxed">
                A shift for this role is priced from this line. Leave it off and the line is still quotable
                by hand — right for a one-off consultancy day, wrong for a steward. A role already supplied
                by another line cannot be taken; retire that one first.
              </p>
            </>
          ) : null}

          <div className="well p-3 mt-4">
            <div className="flex items-baseline justify-between">
              <span className="text-[13px] text-ink-2">Margin on this line</span>
              <span
                className="text-[17px] font-bold tabular-nums"
                style={{ color: TONE_HEX[markupTone(margin)] }}
              >
                {margin}%
              </span>
            </div>
            <div className="text-[11.5px] text-ink-3 mt-1">
              {spec.charge > 0
                ? `${money(spec.charge)} per ${spec.unit} against a cost of ${money(spec.cost)}.`
                : 'Enter a cost and a charge-out to see it.'}
            </div>
          </div>

          {blocker ? <p className="text-[12.5px] text-ink-3 mt-3 leading-relaxed">{blocker}</p> : null}
        </>
      )}
    </Modal>
  );
}

/* --------------------------------------------------------- edit details -- */

export function EditDetails({
  charge,
  onClose,
  onSaved,
}: {
  charge: Charge;
  onClose: () => void;
  onSaved: (c: Charge) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(charge.name);
  const [code, setCode] = useState(charge.code);
  const [unit, setUnit] = useState<ChargeUnit>(charge.unit);
  const [role, setRole] = useState(charge.role || '');
  const [hireHop, setHireHop] = useState(charge.hireHopCode || '');

  const patch: CHARGES_LIB.ChargeEdit = {
    name,
    code,
    unit,
    ...(charge.kind === 'staff' ? { role: role || null } : {}),
    ...(charge.kind === 'kit' ? { hireHopCode: hireHop || null } : {}),
  };
  const blocker = CHARGES_LIB.editChargeBlocker(charge.id, patch);

  const uses = W.all().flatMap((w) => w.lines.filter((l) => l.chargeId === charge.id));
  const dirty =
    name.trim() !== charge.name ||
    code.toUpperCase().trim() !== charge.code ||
    unit !== charge.unit ||
    (charge.kind === 'staff' && role !== (charge.role || '')) ||
    (charge.kind === 'kit' && hireHop.toUpperCase().trim() !== (charge.hireHopCode || ''));

  const save = () => {
    const res = CHARGES_LIB.editCharge(charge.id, patch);
    if (!res.ok) {
      toast(res.reason || 'Not saved.', { tone: 'atRisk' });
      return;
    }
    onSaved(charge);
  };

  return (
    <Modal
      title={`Edit ${charge.name}`}
      width={520}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!!blocker || !dirty}
            title={blocker || (dirty ? undefined : 'Nothing has changed.')}
            onClick={save}
          >
            Save changes
          </button>
        </>
      }
    >
      <p className="text-[13px] text-ink-2 leading-relaxed mb-4">
        Corrects what this line <strong className="text-ink">says</strong>. The money is not here: cost and
        charge-out move through a new version with an effective date, so a job already priced keeps the rate
        the client agreed.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
            Name <Req />
          </span>
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
            Code <Req />
          </span>
          <input
            className="field"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3 mt-3">
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Priced per</span>
          <select className="field" value={unit} onChange={(e) => setUnit(e.target.value as ChargeUnit)}>
            {UNITS.map((u) => (
              <option key={u} value={u}>
                {UNIT_LABEL[u]}
              </option>
            ))}
          </select>
        </label>
        {charge.kind === 'kit' ? (
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Hire Hop code</span>
            <input
              className="field"
              placeholder="None"
              value={hireHop}
              onChange={(e) => setHireHop(e.target.value.toUpperCase())}
            />
          </label>
        ) : null}
        {charge.kind === 'staff' ? (
          <RoleField value={role} onChange={setRole} selfId={charge.id} />
        ) : null}
      </div>

      {charge.kind === 'staff' ? (
        <p className="text-[11.5px] text-ink-3 mt-1.5 leading-relaxed">
          Moving the role moves what a shift for it is priced from, on the next quote. Shifts already priced
          keep their rate.
        </p>
      ) : null}

      {uses.length ? (
        <div
          className="rounded-lg p-3 mt-4"
          style={{ background: unit === charge.unit ? TONE_BG.info : TONE_BG.atRisk }}
        >
          <div className="text-[13px] font-semibold text-ink mb-1">
            {countLabel(uses.length, 'quoted line')} already{' '}
            {uses.length === 1 ? 'names' : 'name'} this charge
          </div>
          <p className="text-[12.5px] text-ink-2 leading-relaxed">
            {unit === charge.unit ? (
              <>
                They keep the description and the rate they were raised with — those documents were sent as
                they read. This changes what the next quote says.
              </>
            ) : (
              <>
                Those lines keep <strong className="text-ink">per {charge.unit}</strong> and their rate, so
                nothing already sent moves. But the same figure will mean{' '}
                <strong className="text-ink">per {unit}</strong> on the next quote, and the cost and
                charge-out were set against the old unit — publish a new rate straight after this, or the
                line prices at {money(charge.charge)} per {unit}.
              </>
            )}
          </p>
        </div>
      ) : null}
    </Modal>
  );
}
