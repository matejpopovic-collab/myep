/* ============================================================================
   EP HOP — THE KIT QUEUE
   ----------------------------------------------------------------------------
   The warehouse's home screen, and the thing that did not exist before: the
   receiving end of `sendToHop`.

   Two decisions show on this page and are worth reading off it.

   ORDERED BY WHEN THE KIT IS NEEDED, not by when the office sent the list.
   The warehouse works to a load-out date; sorting by push time buries Friday's
   job under one sent yesterday for a job in three weeks.

   THE PICKING LIST IS GROUPED BY LOCATION. A picker walks the building once,
   and a list in the order the estimator happened to type it sends somebody
   from the radio cage to the yard and back for one more cone.
   ========================================================================== */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { DataTable, type Column } from '@/components/DataTable';
import { Icon } from '@/components/Icon';
import { EmptyState, PageHeader, Pill, Provenance, Section } from '@/components/primitives';
import { useToast } from '@/components/Toast';
import { TONE_BG, TONE_HEX, TONE_LINE } from '@/lib/status';
import { countLabel, fmtDate, fmtRange, timing } from '@/lib/format';
import * as HOP from '@/lib/hop';
import * as ROLES from '@/lib/roles';
import * as W from '@/lib/wof';
import { useStockVersion, useWofVersion } from '@/lib/useStore';

/* ------------------------------------------------------------------ list --- */

function StatePill({ p }: { p: HOP.PrepJob }) {
  const meta = HOP.PREP_META[p.state];
  return <Pill label={meta.label} tone={meta.tone} hint={meta.blurb} />;
}

export default function KitJobsPage() {
  useStockVersion();
  useWofVersion();
  const [openId, setOpenId] = useState<string | null>(null);

  const rows = HOP.queue();
  const live = rows.filter((r) => r.prep.state !== 'returned');
  const shortRows = live.filter((r) => r.short);
  const amendedRows = live.filter((r) => r.amended > 0);

  const columns: Column<HOP.QueueRow>[] = [
    {
      key: 'job', label: 'Job',
      cell: (r) => (
        <>
          <div className="text-[13.5px] text-ink">{r.w.title}</div>
          <div className="text-[11.5px] text-ink-3">
            <span className="font-mono">{r.w.picking?.epHopRef || '—'}</span> · {r.w.venue}
          </div>
        </>
      ),
    },
    {
      key: 'needed', label: 'On site', nowrap: true,
      cell: (r) => (
        <>
          <div className="text-[13px] text-ink-2">{fmtDate(r.w.start)}</div>
          <div className="text-[11.5px] text-ink-3">{timing(r.w.start).label}</div>
        </>
      ),
    },
    {
      key: 'state', label: 'State', nowrap: true,
      cell: (r) => (
        <span className="inline-flex items-center gap-1.5">
          <StatePill p={r.prep} />
          {r.amended ? (
            <Pill
              label={`${r.amended} amended`}
              tone="atRisk"
              hint="The office changed these lines after you were told. Re-pick them."
            />
          ) : null}
          {r.short ? (
            <Pill label="Short" tone="atRisk" hint="At least one line could not be picked in full." />
          ) : null}
        </span>
      ),
    },
    {
      key: 'held', label: 'Who', nowrap: true,
      cell: (r) =>
        r.prep.heldBy ? (
          <span className="text-[12.5px] text-ink-2">{ROLES.member(r.prep.heldBy)?.name || r.prep.heldBy}</span>
        ) : (
          <span className="text-[12.5px] text-ink-3">unclaimed</span>
        ),
    },
    {
      key: 'progress', label: 'Picked', align: 'right', nowrap: true,
      cell: (r) => (
        <span className="tabular-nums text-ink-2">
          {r.picked.toLocaleString()}
          <span className="text-ink-3">/{r.wanted.toLocaleString()}</span>
        </span>
      ),
    },
    {
      key: 'act', label: '', align: 'right', nowrap: true,
      cell: (r) => (
        <button
          type="button"
          className={`btn btn-sm ${r.prep.state === 'returned' ? 'btn-secondary' : 'btn-primary'}`}
          onClick={() => setOpenId(openId === r.w.id ? null : r.w.id)}
        >
          {openId === r.w.id ? 'Close' : 'Open'}
        </button>
      ),
    },
  ];

  const open = rows.find((r) => r.w.id === openId) || null;

  return (
    <>
      <PageHeader
        title="Kit jobs"
        subtitle="Everything the office has sent to the warehouse, soonest needed first. Open a job to pick against it."
      />

      {amendedRows.length || shortRows.length ? (
        <div
          className="card p-4 mb-4"
          style={{ background: TONE_BG.atRisk, border: `1px solid ${TONE_LINE.atRisk}` }}
        >
          {amendedRows.length ? (
            <div className="text-[12.5px] text-ink mb-1">
              <strong>{countLabel(amendedRows.length, 'job')}</strong> changed after you were told —{' '}
              {amendedRows.map((r) => r.w.picking?.epHopRef).join(', ')}. Those lines need re-picking.
            </div>
          ) : null}
          {shortRows.length ? (
            <div className="text-[12.5px] text-ink">
              <strong>{countLabel(shortRows.length, 'job')}</strong> cannot be picked in full.
            </div>
          ) : null}
        </div>
      ) : null}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.w.id}
        rowClass={(r) => (r.prep.state === 'returned' ? 'opacity-60' : '')}
        empty={
          <EmptyState
            title="Nothing to pick"
            body="No job has been sent to the warehouse yet. Lists arrive here when the office sends them from a work order."
          />
        }
      />

      {open ? <PickPanel row={open} onClose={() => setOpenId(null)} /> : null}

      <Provenance>
        Sorted by when the kit has to be on site, not by when the list was sent — the warehouse works to
        a load-out date. A job stays on this list after it goes out so the return is somebody&rsquo;s job
        too. Quantities are what the office asked for at the moment it told you; a later change to the
        quote shows as an amendment rather than silently rewriting the list you are picking against.
      </Provenance>
    </>
  );
}

/* ------------------------------------------------------------------ pick --- */

/**
 * The picking list for one job.
 *
 * Rendered inline rather than in a modal on purpose: a picker has this open on
 * a tablet while walking, and a dialog that traps focus and has to be
 * dismissed is the wrong shape for a screen somebody is working FROM rather
 * than working ON.
 */
export function PickPanel({ row, onClose }: { row: HOP.QueueRow; onClose: () => void }) {
  const toast = useToast();
  const { w, prep } = row;
  const waves = HOP.pickWaves(w);
  const drift = W.kitChangesSincePush(w);

  const step = (to: HOP.PrepState) => {
    const res = HOP.advancePrep(w, to);
    if (!res.ok) {
      toast(res.reason || 'Not moved.', { tone: 'atRisk' });
      return;
    }
    toast(`${w.picking?.epHopRef}: ${HOP.PREP_META[to].label.toLowerCase()}.`, { tone: 'healthy' });
    if (to === 'returned') onClose();
  };

  const at = HOP.PREP_STATES.indexOf(prep.state);
  const next = HOP.PREP_STATES[at + 1];
  const nextBlock = next ? HOP.advancePrepBlocker(w, next) : null;
  // The check-in opens as soon as the kit is OUT, not once somebody has
  // clicked "returned". A van comes back in pieces over two days, and a
  // warehouse that has to declare the job finished before it can write down
  // the first load will write it on paper instead.
  const returning = prep.state === 'out' || prep.state === 'returned';

  const pick = (lineId: string, wanted: number, value: string) => {
    const n = Number(value);
    const res = HOP.setPicked(w, lineId, Number.isFinite(n) ? n : 0);
    if (!res.ok) toast(res.reason || 'Not recorded.', { tone: 'atRisk' });
    else if (n < wanted) toast(`Recorded ${n} of ${wanted}. The job is short on this line.`, { tone: 'info' });
  };

  return (
    <>
      <Section
        title={`${w.picking?.epHopRef || 'Kit list'} — ${w.title}`}
        right={
          <span className="inline-flex items-center gap-2">
            {/* The work order is the office's screen, not the warehouse's: a role
                without `wof.view` gets no link to a page that would bounce it
                straight back. Everything a picker needs from the job — the
                dates, the venue, the load-out — is on the card below. */}
            {ROLES.can('wof.view') ? (
              <Link className="btn btn-secondary btn-sm" to={`/wofs/${w.id}`}>Open the work order</Link>
            ) : null}
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
          </span>
        }
      />

      <div className="card p-4 mb-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12.5px] text-ink-2">
          <span><Icon name="calendar" decorative className="icon-sm" /> {fmtRange(w.start, w.end)}</span>
          <span><Icon name="mapPin" decorative className="icon-sm" /> {w.venue}</span>
          <span>
            <Icon name="inbox" decorative className="icon-sm" /> {row.picked}/{row.wanted} items picked
          </span>
          {prep.heldBy ? (
            <span>
              <Icon name="staff" decorative className="icon-sm" />{' '}
              {ROLES.member(prep.heldBy)?.name || prep.heldBy}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-1.5 mt-3 flex-wrap">
          {HOP.PREP_STATES.map((st, i) => (
            <span
              key={st}
              className="pill"
              title={HOP.PREP_META[st].blurb}
              style={{
                background: i <= at ? TONE_BG.info : 'transparent',
                color: i <= at ? TONE_HEX.info : 'var(--ink-3)',
                border: `1px solid ${i <= at ? TONE_LINE.info : 'var(--line)'}`,
              }}
            >
              {HOP.PREP_META[st].label}
            </span>
          ))}
        </div>

        {next ? (
          <button
            type="button"
            className="btn btn-primary btn-sm mt-3"
            disabled={!!nextBlock}
            title={nextBlock || undefined}
            onClick={() => step(next)}
          >
            Mark {HOP.PREP_META[next].label.toLowerCase()}
          </button>
        ) : null}
        {nextBlock ? <p className="text-[11.5px] text-ink-3 mt-2">{nextBlock}</p> : null}
      </div>

      {drift.length ? (
        <div
          className="card p-4 mb-4"
          style={{ background: TONE_BG.atRisk, border: `1px solid ${TONE_LINE.atRisk}` }}
        >
          <div className="text-[12.5px] font-semibold text-ink mb-1">
            The quote has moved since this list was sent
          </div>
          <ul className="text-[12px] text-ink-2 leading-relaxed space-y-0.5">
            {drift.map((c, i) => (
              <li key={i}>
                ·{' '}
                {c.kind === 'added'
                  ? `Added ${c.description}`
                  : c.kind === 'removed'
                    ? `Removed ${c.description}`
                    : `${c.description}: ${c.from} → ${c.to}`}
              </li>
            ))}
          </ul>
          <p className="text-[11.5px] text-ink-3 mt-1.5">
            Pick what is on the list below. The office has to re-send before any of this counts.
          </p>
        </div>
      ) : null}

      {returning ? <ReturnPanel row={row} /> : null}

      {waves.length ? (
        waves.map((wave) => (
        <div key={wave.day} className="mb-4">
          {/* The wave heading is the whole point of this screen: a festival does
              not load out once, and a picker who cannot see that pulls the
              breakdown signage on the build day and stands it in the yard for
              a week. Shown even when there is only one wave, so the date is
              never something the reader has to assume. */}
          <div className="flex items-baseline gap-2 flex-wrap mb-2">
            <span className="text-[13px] font-semibold text-ink">
              Out {fmtDate(wave.date)}
            </span>
            <Pill
              label={wave.kind === 'break' ? 'Breakdown' : wave.kind === 'build' ? 'Build' : 'Event'}
              tone={wave.kind === 'event' ? 'info' : 'neutral'}
              hint={`Day ${wave.day} of the job`}
            />
            <span className="text-[11.5px] text-ink-3 tabular-nums">
              {wave.picked}/{wave.wanted} picked
            </span>
          </div>
          {wave.groups.map((g) => (
          <div key={g.location} className="card p-4 mb-3">
            <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2">
              {g.location}
            </div>
            <div className="space-y-2">
              {g.lines.map(({ line, prep: pl, amended, code, back, days }) => {
                const short = pl.picked < pl.wanted;
                return (
                  <div
                    key={pl.lineId}
                    className="flex items-center gap-3 flex-wrap"
                    style={amended ? { background: TONE_BG.atRisk, borderRadius: 8, padding: 8 } : undefined}
                  >
                    <div className="flex-1 min-w-[220px]">
                      <div className="text-[13.5px] text-ink">{line.description}</div>
                      <div className="text-[11.5px] text-ink-3">
                        <span className="font-mono">{code}</span>
                        {' · '}
                        {countLabel(days, 'day')}, back {fmtDate(back)}
                        {line.subHire ? ' · sub-hire, not from the yard' : ''}
                        {amended ? ' · changed since you were told — re-pick' : ''}
                      </div>
                    </div>
                    <label className="inline-flex items-center gap-2">
                      <span className="text-[11.5px] text-ink-3">picked</span>
                      <input
                        className="field"
                        style={{ width: 84 }}
                        type="number"
                        min={0}
                        max={pl.wanted}
                        defaultValue={pl.picked}
                        disabled={prep.state === 'out' || prep.state === 'returned'}
                        onBlur={(e) => pick(pl.lineId, pl.wanted, e.target.value)}
                      />
                      <span className="text-[12.5px] text-ink-2 tabular-nums">
                        of {pl.wanted.toLocaleString()}
                      </span>
                    </label>
                    {short ? (
                      <Pill
                        label={`${(pl.wanted - pl.picked).toLocaleString()} short`}
                        tone="atRisk"
                        hint="Recorded as not found. The job can still go out — the office needs to know."
                      />
                    ) : (
                      <Pill label="Full" tone="healthy" />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          ))}
        </div>
        ))
      ) : (
        <div className="card p-4">
          <p className="text-[13px] text-ink-3">
            Nothing on this list resolves to a line on the work order any more. The office has emptied
            the kit from this job — it needs re-sending before there is anything to pick.
          </p>
        </div>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- return --- */

/**
 * Checking the kit back in.
 *
 * Three boxes per line, and a fourth number nobody types: UNACCOUNTED. That
 * one is the honest state of most returns — "we think twelve came back and we
 * are not sure about the other three" — and showing it is what stops somebody
 * typing a figure that balances just to clear the row.
 *
 * Unaccounted stock is deliberately NOT recharged. "We cannot find three" and
 * "the client lost three" are different claims and only the second reaches an
 * invoice.
 */
function ReturnPanel({ row }: { row: HOP.QueueRow }) {
  const toast = useToast();
  const { w, prep } = row;
  const totals = HOP.prepReturn(prep);
  const owed = HOP.rechargeable(w);
  const block = HOP.rechargeBlocker(w);
  // Damage and loss that cannot be billed. When nothing at all is billable the
  // blocker already says why, so this only has to cover the mixed case — two
  // lines chargeable and a third that never will be, which is the one a
  // sentence under the button would otherwise leave out.
  const skipped = HOP.rechargeSkipped(w);

  const set = (lineId: string, field: 'back' | 'damaged' | 'lost', value: string) => {
    const l = prep.lines.find((x) => x.lineId === lineId)!;
    const next = {
      back: l.back ?? 0,
      damaged: l.damaged ?? 0,
      lost: l.lost ?? 0,
      [field]: Math.max(0, Number(value) || 0),
    };
    const res = HOP.checkIn(w, lineId, next);
    if (!res.ok) toast(res.reason || 'Not recorded.', { tone: 'atRisk' });
  };

  const raise = () => {
    const res = HOP.raiseRecharge(w);
    if (!res.ok) {
      toast(res.reason || 'Nothing raised.', { tone: 'atRisk' });
      return;
    }
    toast(
      `${countLabel(res.raised || 0, 'line')} raised as a variation, worth ${
        (res.value || 0).toLocaleString('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 })
      }. The client approves it like any other.`,
      { tone: 'healthy' },
    );
  };

  return (
    <>
      <Section title="Checking in" />
      <div className="card p-4 mb-4">
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] text-ink-2 mb-3">
          <span>{totals.back.toLocaleString()} back</span>
          <span>{totals.damaged.toLocaleString()} damaged</span>
          <span>{totals.lost.toLocaleString()} lost</span>
          {totals.unaccounted ? (
            <span style={{ color: TONE_HEX.atRisk }}>
              {totals.unaccounted.toLocaleString()} unaccounted
            </span>
          ) : (
            <span style={{ color: TONE_HEX.healthy }}>all accounted for</span>
          )}
        </div>

        <div className="space-y-2">
          {prep.lines.map((pl) => {
            const line = w.lines.find((l) => l.id === pl.lineId);
            if (!line || !pl.picked) return null;
            const left = HOP.unaccounted(pl);
            return (
              <div key={pl.lineId} className="flex items-center gap-3 flex-wrap">
                <div className="flex-1 min-w-[200px]">
                  <div className="text-[13.5px] text-ink">{line.description}</div>
                  <div className="text-[11.5px] text-ink-3">
                    {pl.picked.toLocaleString()} went out
                    {pl.rechargedAt ? ' · recharged' : ''}
                  </div>
                </div>
                {(['back', 'damaged', 'lost'] as const).map((f) => (
                  <label key={f} className="inline-flex items-center gap-1.5">
                    <span className="text-[11.5px] text-ink-3">{f}</span>
                    <input
                      className="field"
                      style={{ width: 72 }}
                      type="number"
                      min={0}
                      max={pl.picked}
                      defaultValue={pl[f] ?? 0}
                      disabled={!!pl.rechargedAt && f !== 'back'}
                      onBlur={(e) => set(pl.lineId, f, e.target.value)}
                    />
                  </label>
                ))}
                {left ? (
                  <Pill
                    label={`${left} unaccounted`}
                    tone="atRisk"
                    hint="Not yet counted either way. Not recharged — somebody has to look again."
                  />
                ) : (
                  <Pill label="Accounted" tone="healthy" />
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--line)' }}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!!block}
            title={block || undefined}
            onClick={raise}
          >
            Recharge {owed.length ? countLabel(owed.length, 'line') : 'the client'}
          </button>
          <p className="text-[11.5px] text-ink-3 mt-2 leading-relaxed">
            {block ||
              'Raises one variation line per item at its replacement price. The client approves or queries it in their portal exactly like a staff variation — nothing new to explain to them.'}
          </p>
          {!block && skipped.length ? (
            <p className="text-[11.5px] mt-1.5 leading-relaxed" style={{ color: TONE_HEX.atRisk }}>
              Not included:{' '}
              {skipped.map((sk) => `${sk.name} (${sk.qty}) — ${sk.why}`).join('; ')}. Raise it on the work
              order by hand if the client owes it.
            </p>
          ) : null}
        </div>
      </div>
    </>
  );
}
