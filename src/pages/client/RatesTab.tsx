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

   WAGE FRAMEWORKS sit between them: the pay floors this account's jobs can be
   staffed under (NLW, real Living Wage, London Living Wage). Each one set up
   here has its own column of prices — staff lines move with the wage, and an
   agreed price is agreed under one framework. The WOF picks which applies.
   ========================================================================== */

import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { EmptyState, Pill, Provenance, SearchField, Segmented } from '@/components/primitives';
import { ConfirmDestructive, Modal } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { TONE_BG, TONE_HEX, TONE_LINE } from '@/lib/status';
import { countLabel, fmtDate, fmtDateFull, money } from '@/lib/format';
import { CHARGES, NOW, RATE_CARDS } from '@/data/db';
import type { Client, ChargeKind } from '@/data/types';
import * as CLIENT_STORE from '@/lib/clients';
import * as RATES from '@/lib/rates';
import * as ROLES from '@/lib/roles';
import * as WAGES from '@/lib/wages';
import { floorLine } from '../wof/WageFramework';
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
  const enabled = RATES.clientFrameworks(c.id);
  const defFw = RATES.defaultFramework(c.id);
  const [fwPick, setFw] = useState<WAGES.WageFrameworkId>(defFw);
  // A framework switched off while it was the one on screen falls back to NLW.
  const fw: WAGES.WageFrameworkId = enabled.includes(fwPick) ? fwPick : 'nlw';
  const fwMeta = WAGES.framework(fw);

  const setFrameworks = (next: WAGES.WageFrameworkId[], def: WAGES.WageFrameworkId, msg: string) => {
    const r = RATES.setClientFrameworks(c.id, next, def);
    if (!r.ok) return toast(r.reason || 'That did not work.', { tone: 'critical' });
    toast(msg, { tone: 'healthy' });
    onSaved();
  };

  const rows = RATES.rateTable(c.id, fw).filter((r) => {
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

      {/* --- wage frameworks ------------------------------------------------ */}
      {/* A list, not a row of cards. The rate card above is ONE choice out of
          three; frameworks are a SET the account holds, with one of them the
          default. Drawn the same way, the two read as the same kind of
          control — so this is a settings list: a switch per row, the rate in
          its own column, and the default marked on the row it belongs to. */}
      <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2">
        Wage frameworks
        <span className="font-normal normal-case tracking-normal ml-2">
          {enabled.length} of {WAGES.FRAMEWORKS.length} set up
        </span>
      </div>
      <div className="card overflow-hidden mb-2">
        {WAGES.FRAMEWORKS.map((f, i) => {
          const on = enabled.includes(f.id);
          const isDefault = defFw === f.id;
          const next = WAGES.nextRate(f.id);
          return (
            <div
              key={f.id}
              className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3${i ? ' border-t border-surface-line-soft' : ''}`}
            >
              <label
                className="flex items-center gap-3 min-w-0 flex-1 cursor-pointer"
                title={f.statutory ? 'The legal minimum — every account has it.' : undefined}
              >
                <input
                  type="checkbox"
                  className="shrink-0"
                  aria-label={`${f.label} set up for ${c.name}`}
                  checked={on}
                  disabled={!!f.statutory || !canEdit}
                  onChange={(e) => {
                    const nextSet = e.target.checked
                      ? [...enabled, f.id]
                      : enabled.filter((x) => x !== f.id);
                    setFrameworks(
                      nextSet,
                      e.target.checked || defFw !== f.id ? defFw : 'nlw',
                      e.target.checked
                        ? `${c.name} can now be quoted under the ${f.label}.`
                        : `${f.label} switched off for ${c.name}. Jobs already priced under it keep their prices.`,
                    );
                  }}
                />
                <span className="min-w-0">
                  <span className={`flex items-center gap-2 text-[13.5px] font-semibold ${on ? 'text-ink' : 'text-ink-3'}`}>
                    <span className="font-mono text-[11.5px] font-medium text-ink-3 w-8">{f.short}</span>
                    {f.label}
                    {f.statutory ? <span className="text-[11.5px] font-normal text-ink-3">· statutory, always on</span> : null}
                  </span>
                  <span className="block text-[11.5px] text-ink-3 mt-0.5 pl-10">{f.blurb}</span>
                </span>
              </label>

              <div className="text-right w-36 shrink-0">
                <div className={`text-[14px] font-semibold tabular-nums ${on ? 'text-ink' : 'text-ink-3'}`}>
                  {money(WAGES.floorOn(f.id))}
                  <span className="text-[11.5px] font-normal text-ink-3">/hr</span>
                </div>
                {next ? (
                  <div className="text-[11px] text-ink-3 tabular-nums">
                    {money(next.rate)} from {fmtDateFull(next.from).replace(/^\w+, /, '')}
                  </div>
                ) : null}
              </div>

              <div className="w-40 shrink-0 flex justify-end">
                {on && isDefault ? (
                  <Pill label="Default for new jobs" tone="info" hint={false} />
                ) : on ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    {...ROLES.gate('clients.rates')}
                    onClick={() => setFrameworks(enabled, f.id, `New jobs for ${c.name} start on the ${f.label}.`)}
                  >
                    Make default
                  </button>
                ) : (
                  <span className="text-[12px] text-ink-3">Not set up</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-[11.5px] text-ink-3 leading-relaxed mb-5">
        Each work order picks one of the frameworks set up here. It sets the least anyone on that job is
        paid per hour, and prices the staff lines to match — the published rate moves by the extra pay, with
        the margin held, unless a price has been agreed under that framework below.
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
        {enabled.length > 1 ? (
          <Segmented<WAGES.WageFrameworkId>
            ariaLabel="Prices under wage framework"
            value={fw}
            onChange={setFw}
            options={enabled.map((id) => [id, WAGES.framework(id).short])}
          />
        ) : null}
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
          Agreed prices only ({RATES.rateTable(c.id, fw).filter((r) => r.agreed).length})
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
                    {fw !== 'nlw' && r.kind === 'staff' && WAGES.premiumOn(fw) > 0
                      ? ` · +${money(WAGES.premiumOn(fw))}/hr ${fwMeta.short} wage`
                      : ''}
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
        {fw !== 'nlw' ? `Prices under the ${fwMeta.label} (${floorLine(fw)}). ` : ''}
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
          fw={fw}
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
            const r = RATES.clearClientPrice(c.id, clearing.chargeId, fw);
            const now = RATES.rateTable(c.id, fw).find((x) => x.chargeId === clearing.chargeId)!;
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
              {money(clearing.effective)} today,{' '}
              {money(RATES.frameworkRate(clearing.chargeId, NOW, card.id, fw)?.charge ?? clearing.list * card.factor)} once
              it does. Jobs
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
  fw,
  onClose,
  onSaved,
}: {
  client: Client;
  chargeId: string;
  fw: WAGES.WageFrameworkId;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const row = RATES.rateTable(client.id, fw).find((r) => r.chargeId === chargeId)!;
  const card = RATES.clientCard(client.id);
  const fwMeta = WAGES.framework(fw);
  const onCard = RATES.frameworkRate(chargeId, NOW, card.id, fw)?.charge ?? row.list * card.factor;
  const [price, setPrice] = useState(String(row.agreed?.charge ?? row.effective));
  const [note, setNote] = useState(row.agreed?.note || '');

  const n = Number(price);
  const blocker = RATES.setPriceBlocker(client.id, chargeId, n, fw);
  const ratio = row.list ? n / row.list : 1;
  const wild =
    !Number.isFinite(ratio) || !n ? '' : ratio >= 2 ? `${Math.round(ratio)}× ` : ratio <= 0.5 ? 'less than half ' : '';
  const margin = Number.isFinite(n) && n > 0 ? Math.round(((n - row.cost) / n) * 100) : 0;

  return (
    <Modal
      title={`${row.name} for ${client.name}${fw === 'nlw' ? '' : ` · ${fwMeta.short}`}`}
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
              const r = RATES.setClientPrice(client.id, chargeId, n, { note, framework: fw });
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
          <span className="text-[13px] text-ink-2">
            Cost to EP{fw !== 'nlw' && row.kind === 'staff' ? ` at the ${fwMeta.short}` : ''}
          </span>
          <span className="text-[13px] tabular-nums text-ink-2">{money(row.cost)} per {row.unit}</span>
        </div>
        <div className="flex items-baseline justify-between gap-3 py-0.5">
          <span className="text-[13px] text-ink-2">Published rate</span>
          <span className="text-[13px] tabular-nums text-ink-2">{money(row.list)} per {row.unit}</span>
        </div>
        <div className="flex items-baseline justify-between gap-3 py-0.5">
          <span className="text-[13px] text-ink-2">
            {card.label} card{fw !== 'nlw' && row.kind === 'staff' ? `, ${fwMeta.short}` : ''}
          </span>
          <span className="text-[13px] tabular-nums text-ink-2">
            {money(onCard)} per {row.unit}
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
