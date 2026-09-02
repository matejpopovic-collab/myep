/* ============================================================================
   CLIENT RECORD — RATES
   ----------------------------------------------------------------------------
   The tab that answers "what does this account pay", which until now was
   answered by opening the signed framework and reading it.

   Two controls, in the order they matter:

     THE CARD is the blanket position — Standard, Preferred, Premium. Changing
     it moves every line at once, so the change is stated in money before it is
     made rather than reported after.

     THE PRICE LIST is the exceptions. One line, one agreed number, and a note
     saying where the number came from — because the question asked of these six
     months later is never "what is it" but "who agreed that, and against what".

   Neither touches a job that has already been priced. See `lib/rates.ts`.
   ========================================================================== */

import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { EmptyState, Provenance, SearchField, Segmented } from '@/components/primitives';
import { ConfirmDestructive, Modal } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { TONE_BG, TONE_HEX, TONE_LINE } from '@/lib/status';
import { countLabel, fmtDate, money } from '@/lib/format';
import { CHARGES, RATE_CARDS } from '@/data/db';
import type { Client, ChargeKind } from '@/data/types';
import * as CLIENT_STORE from '@/lib/clients';
import * as RATES from '@/lib/rates';
import * as ROLES from '@/lib/roles';
import { useRatesVersion } from '@/lib/useStore';

type KindFilter = 'all' | ChargeKind;

const BASIS_LABEL: Record<RATES.RateRow['basis'], string> = {
  standard: 'Published',
  card: 'Card',
  client: 'Agreed',
};

export default function RatesTab({ c, onSaved }: { c: Client; onSaved: () => void }) {
  const toast = useToast();
  useRatesVersion();

  const [kind, setKind] = useState<KindFilter>('all');
  const [q, setQ] = useState('');
  const [agreedOnly, setAgreedOnly] = useState(false);
  const [editing, setEditing] = useState<{ chargeId: string } | null>(null);
  const [clearing, setClearing] = useState<RATES.RateRow | null>(null);
  const [movingTo, setMovingTo] = useState<string | null>(null);

  const card = RATES.clientCard(c.id);
  const rows = RATES.rateTable(c.id).filter((r) => {
    if (r.retired && !r.agreed) return false;
    if (kind !== 'all' && r.kind !== kind) return false;
    if (agreedOnly && !r.agreed) return false;
    if (q && !`${r.name} ${r.code}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });
  const agreed = rows.filter((r) => r.agreed).length;
  const stale = RATES.staleAgreements(c.id);
  const canEdit = ROLES.can('clients.rates');

  return (
    <>
      {/* --- the card ------------------------------------------------------ */}
      <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2">
        Rate card
      </div>
      <div className="grid gap-2.5 md:grid-cols-3 mb-2">
        {RATE_CARDS.map((rc) => {
          const on = rc.id === card.id;
          return (
            <button
              key={rc.id}
              type="button"
              aria-pressed={on}
              {...ROLES.gate('clients.rates')}
              onClick={() => (on ? undefined : setMovingTo(rc.id))}
              className="card p-3.5 text-left"
              style={on ? { borderColor: TONE_LINE.info, background: TONE_BG.info } : undefined}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13.5px] font-semibold text-ink">{rc.label}</span>
                <span className="text-[12px] tabular-nums text-ink-2">
                  {rc.factor === 1
                    ? 'published'
                    : `${rc.factor > 1 ? '+' : '−'}${Math.round(Math.abs(1 - rc.factor) * 100)}%`}
                </span>
              </div>
              <p className="text-[11.5px] text-ink-3 mt-1 leading-relaxed">{rc.blurb}</p>
              {on ? (
                <div className="text-[11.5px] font-medium mt-1.5" style={{ color: TONE_HEX.info }}>
                  This account
                </div>
              ) : null}
            </button>
          );
        })}
      </div>
      <p className="text-[11.5px] text-ink-3 leading-relaxed mb-5">
        The card prices every line that has not been separately agreed. It is a position on the published
        table of charges, so a rate rise reaches this account with everyone else — it cannot quietly hold
        last year's price.
      </p>

      {/* --- agreements that have gone bad --------------------------------- */}
      {stale.length ? (
        <div
          className="card p-4 mb-5"
          style={{ background: TONE_BG.atRisk, borderColor: TONE_LINE.atRisk }}
        >
          <div className="flex items-start gap-2.5">
            <span style={{ color: TONE_HEX.atRisk, marginTop: 1 }}>
              <Icon name="alert" decorative />
            </span>
            <div className="flex-1">
              <div className="text-[13px] font-semibold text-ink mb-1">
                {countLabel(stale.length, 'agreed price has', 'agreed prices have')} fallen behind cost
              </div>
              <p className="text-[13px] text-ink-2 leading-relaxed">
                An agreed price is held on purpose, so nothing here has changed on its own — that is the
                problem. These were signed against a cost price that has since moved.
              </p>
              <ul className="mt-2 grid gap-1">
                {stale.map((s) => {
                  const ch = CHARGES.find((x) => x.id === s.price.chargeId);
                  return (
                    <li key={s.price.chargeId} className="text-[12.5px] text-ink-2">
                      <strong className="text-ink">{ch?.name || s.price.chargeId}</strong> — agreed{' '}
                      {money(s.price.charge)} against a cost of {money(s.cost)}:{' '}
                      {s.severity === 'below-cost'
                        ? 'every one of these loses money.'
                        : `${s.margin}% margin, under the ${RATES.MARGIN_FLOOR}% floor.`}
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </div>
      ) : null}

      {/* --- the price list ------------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-2.5 mb-3">
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
          value={q}
          onChange={setQ}
          placeholder="Filter by name or code…"
          ariaLabel="Filter rates"
        />
        <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
          <input
            type="checkbox"
            checked={agreedOnly}
            onChange={(e) => setAgreedOnly(e.target.checked)}
          />
          Agreed prices only ({RATES.clientPrices(c.id).length})
        </label>
      </div>

      {rows.length ? (
        <table className="tbl is-dense">
          <thead>
            <tr>
              <th>Charge line</th>
              <th style={{ textAlign: 'right' }}>Cost</th>
              <th style={{ textAlign: 'right' }}>Published</th>
              <th style={{ textAlign: 'right' }}>{c.name} pays</th>
              <th style={{ textAlign: 'right' }}>Margin</th>
              <th>Basis</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.chargeId}>
                <td>
                  <div className="text-[13px] text-ink">{r.name}</div>
                  <div className="text-[11.5px] text-ink-3">
                    <span className="font-mono">{r.code}</span> · per {r.unit}
                    {r.agreed?.note ? ` · ${r.agreed.note}` : ''}
                  </div>
                </td>
                <td style={{ textAlign: 'right' }} className="tabular-nums text-ink-3">
                  {money(r.cost)}
                </td>
                <td style={{ textAlign: 'right' }} className="tabular-nums text-ink-3">
                  {money(r.list)}
                </td>
                <td style={{ textAlign: 'right' }} className="tabular-nums font-semibold text-ink">
                  {money(r.effective)}
                  {/* The unit belongs beside the money. It is in the charge
                      line's subtext too, but nobody reading a price column
                      reads left — and "£320" against "£18.50" is a different
                      question depending on whether it is an hour or a job. */}
                  <div className="text-[11px] font-normal text-ink-3">per {r.unit}</div>
                </td>
                <td
                  style={{ textAlign: 'right', color: TONE_HEX[r.margin >= 45 ? 'healthy' : r.margin >= RATES.MARGIN_FLOOR ? 'atRisk' : 'critical'] }}
                  className="tabular-nums font-medium"
                >
                  {r.margin}%
                </td>
                <td>
                  <span
                    className="pill"
                    style={{
                      background: TONE_BG[r.basis === 'client' ? 'info' : 'neutral'],
                      color: TONE_HEX[r.basis === 'client' ? 'info' : 'neutral'],
                    }}
                  >
                    {BASIS_LABEL[r.basis]}
                  </span>
                  {r.agreed ? (
                    <div className="text-[11px] text-ink-3 mt-0.5">
                      {r.agreed.by}, {fmtDate(r.agreed.at)}
                    </div>
                  ) : null}
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    {...ROLES.gate('clients.rates')}
                    onClick={() => setEditing({ chargeId: r.chargeId })}
                  >
                    {r.agreed ? 'Change' : 'Agree a price'}
                  </button>
                  {r.agreed ? (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm ml-1.5"
                      {...ROLES.gate('clients.rates')}
                      onClick={() => setClearing(r)}
                    >
                      Drop
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState
          title="Nothing matches those filters"
          body="Every charge line this account could be quoted appears here, whether or not a price has been agreed for it."
        />
      )}

      <Provenance>
        {agreed
          ? `${countLabel(agreed, 'line is', 'lines are')} priced by agreement and beat the ${card.label} card. `
          : `Every line is priced from the ${card.label} card. `}
        Changing anything here prices NEW quote lines only — a job already quoted holds the rate it was
        quoted at, and moving it is a re-price on that job, one line at a time.
      </Provenance>

      {editing ? (
        <AgreePrice
          client={c}
          chargeId={editing.chargeId}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            toast(msg, { tone: 'healthy' });
            onSaved();
          }}
        />
      ) : null}

      {clearing ? (
        <ConfirmDestructive
          title={`Drop the agreed price for ${clearing.name}?`}
          confirmLabel="Drop the agreement"
          onClose={() => setClearing(null)}
          onConfirm={() => {
            const was = clearing.effective;
            const r = RATES.clearClientPrice(c.id, clearing.chargeId);
            const now = RATES.rateTable(c.id).find((x) => x.chargeId === clearing.chargeId)!;
            setClearing(null);
            if (!r.ok) return toast(r.reason || 'That did not work.', { tone: 'critical' });
            toast(
              `${clearing.name} goes back to the ${card.label} card: ${money(was)} → ${money(now.effective)}.`,
              { tone: 'neutral' },
            );
            onSaved();
          }}
          message={
            <>
              {c.name} would go back to the <strong>{card.label}</strong> card for this line —{' '}
              {money(clearing.effective)} today, {money(clearing.list * card.factor)} once it does. Jobs
              already quoted keep the price they were quoted at.
            </>
          }
        />
      ) : null}

      {movingTo ? (
        <MoveCard
          client={c}
          to={movingTo}
          onClose={() => setMovingTo(null)}
          onMoved={(msg) => {
            setMovingTo(null);
            toast(msg, { tone: 'healthy' });
            onSaved();
          }}
        />
      ) : null}

      {!canEdit ? (
        <p className="text-[12px] text-ink-3 mt-3">
          {ROLES.denial('clients.rates')}
        </p>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------ agree a price */

function AgreePrice({
  client,
  chargeId,
  onClose,
  onSaved,
}: {
  client: Client;
  chargeId: string;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const row = RATES.rateTable(client.id).find((r) => r.chargeId === chargeId)!;
  const card = RATES.clientCard(client.id);
  const [price, setPrice] = useState(String(row.agreed?.charge ?? row.effective));
  const [note, setNote] = useState(row.agreed?.note || '');

  const n = Number(price);
  const blocker = RATES.setPriceBlocker(client.id, chargeId, n);
  const ratio = row.list ? n / row.list : 1;
  const wild =
    !Number.isFinite(ratio) || !n ? '' : ratio >= 2 ? `${Math.round(ratio)}× ` : ratio <= 0.5 ? 'less than half ' : '';
  const margin = Number.isFinite(n) && n > 0 ? Math.round(((n - row.cost) / n) * 100) : 0;

  return (
    <Modal
      title={`${row.name} for ${client.name}`}
      width={540}
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
            onClick={() => {
              const r = RATES.setClientPrice(client.id, chargeId, n, { note });
              if (r.ok)
                onSaved(
                  `${row.name} is ${money(n)} for ${client.name} — ${money(row.effective)} before.`,
                );
            }}
          >
            Agree this price
          </button>
        </>
      }
    >
      <div className="well p-3 mb-4">
        <div className="flex items-baseline justify-between gap-3 py-0.5">
          <span className="text-[13px] text-ink-2">Cost to EP</span>
          <span className="text-[13px] tabular-nums text-ink-2">{money(row.cost)} per {row.unit}</span>
        </div>
        <div className="flex items-baseline justify-between gap-3 py-0.5">
          <span className="text-[13px] text-ink-2">Published rate</span>
          <span className="text-[13px] tabular-nums text-ink-2">{money(row.list)} per {row.unit}</span>
        </div>
        <div className="flex items-baseline justify-between gap-3 py-0.5">
          <span className="text-[13px] text-ink-2">{card.label} card</span>
          <span className="text-[13px] tabular-nums text-ink-2">
            {money(row.list * card.factor)} per {row.unit}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
            Agreed price per {row.unit} <span className="text-status-critical">*</span>
          </span>
          <input
            className="field"
            type="number"
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </label>
        <div className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Margin at that price</span>
          <div
            className="text-[19px] font-semibold tabular-nums"
            style={{ color: TONE_HEX[margin >= 45 ? 'healthy' : margin >= RATES.MARGIN_FLOOR ? 'atRisk' : 'critical'] }}
          >
            {margin}%
          </div>
        </div>
      </div>
      {blocker ? (
        <p className="text-[12px] mt-1.5" style={{ color: TONE_HEX.critical }}>
          {blocker}
        </p>
      ) : null}
      {/* Not a block — EP does agree unusual numbers, and a rate table that
          argues with the person holding the signed schedule is a rate table
          they stop using. But a figure this far from the published one is more
          often a unit misread than a deal, so it says which unit it is about
          to save, in the sentence the operator would have to say out loud. */}
      {!blocker && wild ? (
        <p className="text-[12px] mt-1.5 leading-relaxed" style={{ color: TONE_HEX.atRisk }}>
          That is {wild} the published rate. Saved as {money(n)} <strong>per {row.unit}</strong> — a{' '}
          {row.unit === 'hour' ? '10-hour shift' : row.unit === 'day' ? '5-day job' : 'run of 10'} of these
          would bill {money(n * (row.unit === 'each' ? 10 : row.unit === 'day' ? 5 : 10))}. Change it if you
          meant a price for the whole job.
        </p>
      ) : null}

      <label className="block mt-3.5">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Where this came from</span>
        <input
          className="field"
          placeholder="e.g. Raceday framework, schedule 2 — held to Jan 2027"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <p className="text-[11.5px] text-ink-3 mt-1.5 leading-relaxed">
          The question asked of an agreed price a year later is never what it is — it is who agreed it, and
          against what. Both are recorded either way; this is the half only you know.
        </p>
      </label>
    </Modal>
  );
}

/* -------------------------------------------------------------- move card -- */

function MoveCard({
  client,
  to,
  onClose,
  onMoved,
}: {
  client: Client;
  to: string;
  onClose: () => void;
  onMoved: (msg: string) => void;
}) {
  const from = RATES.clientCard(client.id);
  const target = RATE_CARDS.find((c) => c.id === to)!;
  const rows = RATES.rateTable(client.id).filter((r) => r.basis !== 'client' && !r.retired);
  const held = RATES.clientPrices(client.id).length;

  return (
    <Modal
      title={`Move ${client.name} to the ${target.label} card?`}
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
            onClick={() => {
              const r = CLIENT_STORE.updateClient(client.id, { rateCardId: to });
              if (r.ok) onMoved(`${client.name} is now priced from the ${target.label} card.`);
            }}
          >
            Move to {target.label}
          </button>
        </>
      }
    >
      <p className="text-[13.5px] text-ink-2 leading-relaxed mb-3">
        {target.blurb} Every line not separately agreed moves at once — including lines nobody has quoted
        this account yet, which is the point of a card and also the reason it is worth reading the list
        before pressing the button.
      </p>

      <div className="well p-3 mb-3" style={{ maxHeight: 260, overflowY: 'auto' }}>
        {rows.slice(0, 40).map((r) => (
          <div key={r.chargeId} className="flex items-baseline justify-between gap-3 py-0.5">
            <span className="text-[12.5px] text-ink-2 truncate">{r.name}</span>
            <span className="text-[12.5px] tabular-nums text-ink-2 whitespace-nowrap">
              {money(r.effective)} → <strong className="text-ink">{money(r.list * target.factor)}</strong>
            </span>
          </div>
        ))}
        {rows.length > 40 ? (
          <div className="text-[11.5px] text-ink-3 mt-1.5">
            …and {rows.length - 40} more, all moved by the same {Math.round(Math.abs(1 - target.factor) * 100)}%.
          </div>
        ) : null}
      </div>

      <p className="text-[12.5px] text-ink-3 leading-relaxed">
        {held
          ? `${countLabel(held, 'agreed price is', 'agreed prices are')} untouched by this — an agreement beats a card, which is what makes it an agreement.`
          : 'Nothing has been separately agreed with this account, so the card is the whole answer.'}{' '}
        Jobs already quoted keep the rates they were quoted at.
      </p>
      <p className="text-[12.5px] text-ink-3 mt-2">
        Currently on <strong className="text-ink">{from.label}</strong>.
      </p>
    </Modal>
  );
}
