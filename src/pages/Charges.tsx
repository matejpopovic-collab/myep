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
import { Link } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import {
  Kpi, PageHeader, Pill, Provenance, SearchField, Segmented,
} from '@/components/primitives';
import { DataTable, type Column } from '@/components/DataTable';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { TONE_BG, TONE_HEX, TONE_LINE } from '@/lib/status';
import { fmtDate, money } from '@/lib/format';
import { CHARGES, charge as chargeById, chargeVersions } from '@/data/db';
import type { Charge, ChargeKind, Tone } from '@/data/types';
import * as W from '@/lib/wof';
import * as ROLES from '@/lib/roles';
import { useWofs } from '@/lib/useStore';

type KindFilter = 'all' | ChargeKind;

const markupTone = (m: number): Tone => (m >= 45 ? 'healthy' : m >= 30 ? 'atRisk' : 'critical');
const markupOf = (c: { cost: number; charge: number }) =>
  c.cost ? Math.round(((c.charge - c.cost) / c.charge) * 100) : 0;

export default function ChargesPage() {
  const toast = useToast();
  const wofs = useWofs();

  const [kind, setKind] = useState<KindFilter>('all');
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState<string | null>(null);
  const [editing, setEditing] = useState<Charge | null>(null);
  const [, force] = useState(0);

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
          <div className="text-[13.5px] text-ink">{c.name}</div>
          <div className="text-[11.5px] text-ink-3">
            {c.kind}
            {c.role ? ` · fills the ${c.role} role` : ''}
            {c.hireHopCode ? ` · Hire Hop ${c.hireHopCode}` : ''}
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
      key: 'charge', label: 'Charge-out', align: 'right', nowrap: true,
      cell: (c) => (
        <>
          <span className="tabular-nums font-semibold text-ink">{money(c.charge)}</span>
          <div className="text-[11px] text-ink-3">per {c.unit}</div>
        </>
      ),
    },
    {
      key: 'markup', label: 'Markup', align: 'right', nowrap: true,
      cell: (c) => {
        const m = markupOf(c);
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
            {c.tiers.map((t) => (
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
          <button
            type="button"
            className="btn btn-primary"
            {...ROLES.gate('charges.edit')}
            onClick={() =>
              toast(
                'Adding new charge lines is part of the reference-data admin build, out of scope for this prototype.',
                { tone: 'info' },
              )
            }
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
        client pays. Both are versioned; the effective date is what a quote line snapshots.
      </Provenance>

      {detail ? (
        <ChargeDetail
          chargeId={detail}
          onClose={() => setDetail(null)}
          onEdit={(c) => {
            setDetail(null);
            setEditing(c);
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
}: {
  chargeId: string;
  onClose: () => void;
  onEdit: (c: Charge) => void;
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
