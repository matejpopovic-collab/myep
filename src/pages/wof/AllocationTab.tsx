/* ============================================================================
   WOF DETAIL — ALLOCATION (WOA) TAB
   ----------------------------------------------------------------------------
   Where the ops manager turns what was sold into what is going. Opens when the
   deposit lands; staffing and the warehouse wait on its release.

   Every edit saves as it is made, into a DRAFT nobody downstream reads. The
   one act that tells anybody anything is Release, which is why it is the only
   primary button on the tab and why it shows what it is about to change.
   ========================================================================== */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { EmptyState, Kpi, Pill, Provenance, Section } from '@/components/primitives';
import { MenuButton, Modal, type MenuEntry } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { TONE_BG, TONE_HEX, TONE_LINE } from '@/lib/status';
import { countLabel, fmtDate, fmtDateFull } from '@/lib/format';
import type { PoolShare } from '@/data/types';
import * as W from '@/lib/wof';
import * as A from '@/lib/allocation';
import * as ROLES from '@/lib/roles';
import * as HOP from '@/lib/hop';
import { useEventsVersion, useRolesVersion, useWofVersion } from '@/lib/useStore';

export default function AllocationTab({ w, onDeposit }: { w: W.Wof; onDeposit: () => void }) {
  useWofVersion();
  useEventsVersion();
  useRolesVersion();
  const toast = useToast();
  const v = A.read(w);
  const denial = ROLES.denial('wof.allocate');
  const editBlock = A.editBlock(w);
  const readOnly = !!denial || !!editBlock;
  const [releasing, setReleasing] = useState(false);
  const [day, setDay] = useState<'all' | number>('all');

  /* ---- states with nothing to edit ------------------------------------ */

  if (v.state === 'none') {
    return (
      <EmptyState
        iconName="split"
        title={W.atLeast(w, 'order') ? 'Nothing to allocate' : 'Allocation opens after the deposit'}
        body={
          W.atLeast(w, 'order')
            ? 'This job has no staff or kit on it, so there is nothing for operations to allocate.'
            : 'Once the client has signed and paid the deposit, operations set the real headcount, the staff pools and the kit going out here — before staffing or the warehouse start.'
        }
      />
    );
  }

  if (v.state === 'deposit') {
    const dep = W.deposit(w);
    return (
      <EmptyState
        iconName="clock"
        title="Waiting for the deposit"
        body={`${v.block} Staffing cannot assign and the kit list cannot go to the warehouse until the allocation is released.`}
        action={
          dep.due > 0 && !dep.received ? (
            <button type="button" className="btn btn-secondary" onClick={onDeposit} disabled={!!ROLES.denial('wof.edit')}>
              <Icon name="checkCircle" decorative /> Record deposit received
            </button>
          ) : undefined
        }
      />
    );
  }

  if (v.state === 'legacy') {
    return (
      <EmptyState
        iconName="checkCircle"
        title="Allocated from the sold numbers"
        body="This job was already being staffed or picked before allocation existed, so it is running against what was sold. Change headcounts on the event and quantities on the quote as before."
        action={
          v.event ? (
            <Link className="btn btn-secondary" to={`/events/${v.event.id}`}>
              Open the event
            </Link>
          ) : undefined
        }
      />
    );
  }

  /* ---- the plan -------------------------------------------------------- */

  const a = w.allocation;
  const released = !!a?.releasedAt;
  const meta = A.STATE_META[v.state];
  const days = [...new Set(v.staff.map((r) => r.day))].sort((x, y) => x - y);
  const rows = v.staff.filter((r) => day === 'all' || r.day === day);
  const staffDelta = v.totals.staff - v.totals.soldStaff;
  const kitDelta = v.totals.kit - v.totals.soldKit;

  const poolItems: MenuEntry[] = A.POOLS.map((pool) => ({
    label: pool,
    icon: 'users',
    onSelect: () => {
      const r = A.setPoolForAll(w, pool, ROLES.actingActor());
      if (r.ok) toast(`Every role group now draws from ${pool}. Headcounts kept.`, { tone: 'healthy' });
      else toast(r.error!, { tone: 'critical' });
    },
  }));

  return (
    <>
      {/* Status strip ---------------------------------------------------- */}
      <div
        className="card p-4 mb-4"
        style={
          v.state === 'ready' || v.state === 'draft'
            ? { background: TONE_BG.atRisk, borderColor: TONE_LINE.atRisk }
            : undefined
        }
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="text-[11px] font-bold uppercase tracking-wider text-ink-3">
                Work Order Allocation
              </span>
              <Pill label={meta.label} tone={meta.tone} />
              <Pill
                label="Internal"
                tone="neutral"
                variant="quiet"
                hint="Never shown to the client. Their quote, invoice and portal do not change."
              />
            </div>
            <p className="text-[13px] text-ink-2 leading-relaxed max-w-[70ch]">
              {v.state === 'ready' || v.state === 'draft'
                ? 'Staffing and the warehouse are waiting on this. Set how many people each role group really needs and which pools they come from, and what kit is actually going — then release it.'
                : v.state === 'revising'
                  ? `${countLabel(v.changes, 'change')} not released yet. Staffing and the warehouse are still working to the last release.`
                  : 'Released. Staffing are filling these numbers and the warehouse picks these quantities.'}
            </p>
            {released ? (
              <p className="text-[12px] text-ink-3 mt-1.5">
                {a!.releases > 1 ? `Release ${a!.releases}` : 'Released'} by {a!.releasedByName || ROLES.member(a!.releasedBy)?.name || a!.releasedBy}{' '}
                · first released {fmtDateFull(a!.releasedAt!)}
              </p>
            ) : null}
            {denial ? <p className="text-[12px] text-ink-3 mt-1.5">{denial}</p> : null}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!readOnly && v.staff.length ? (
              <MenuButton className="btn btn-secondary btn-sm" label="Put every group in one pool" items={poolItems}>
                <Icon name="users" decorative className="icon-sm" /> Pool for all
                <Icon name="chevronDown" decorative className="icon-sm" />
              </MenuButton>
            ) : null}
            {!readOnly ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  const r = A.resetToSold(w, ROLES.actingActor());
                  if (r.ok) toast('Plan reset to the sold numbers. Pools kept.', { tone: 'healthy' });
                }}
              >
                <Icon name="refresh" decorative className="icon-sm" /> Reset to sold
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary"
              disabled={readOnly || (released && !v.changes)}
              title={denial || editBlock || (released && !v.changes ? 'Nothing has changed since the last release.' : undefined)}
              onClick={() => setReleasing(true)}
            >
              <Icon name="checkCircle" decorative />
              {released ? 'Release changes' : 'Release allocation'}
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 mb-2">
        <Kpi
          label="Staff shifts"
          value={v.totals.staff.toLocaleString()}
          tone={staffDelta === 0 ? 'neutral' : staffDelta < 0 ? 'atRisk' : 'info'}
          sub={
            staffDelta === 0
              ? `As sold (${v.totals.soldStaff})`
              : `Sold ${v.totals.soldStaff} · ${staffDelta > 0 ? '+' : ''}${staffDelta} by ops`
          }
        />
        <Kpi
          label="Pools"
          value={v.byPool.length ? String(v.byPool.length) : '—'}
          sub={v.byPool.map((p) => `${p.pool} ${p.count}`).join(' · ') || 'No staff on this job'}
        />
        <Kpi
          label="Kit items"
          value={v.totals.kit.toLocaleString()}
          tone={kitDelta === 0 ? 'neutral' : 'info'}
          sub={v.kit.length ? (kitDelta === 0 ? `As sold (${v.totals.soldKit})` : `Sold ${v.totals.soldKit} · ${kitDelta > 0 ? '+' : ''}${kitDelta} by ops`) : 'No kit on this job'}
        />
      </div>

      {/* Staff ------------------------------------------------------------ */}
      {v.staff.length ? (
        <>
          <Section
            title="Staff — headcount and pools"
            right={
              days.length > 1 ? (
                <select
                  className="field"
                  style={{ width: 'auto' }}
                  aria-label="Show day"
                  value={day === 'all' ? 'all' : String(day)}
                  onChange={(e) => setDay(e.target.value === 'all' ? 'all' : Number(e.target.value))}
                >
                  <option value="all">All {days.length} days</option>
                  {days.map((d) => (
                    <option key={d} value={d}>
                      {v.staff.find((r) => r.day === d)?.dayLabel || `Day ${d}`}
                    </option>
                  ))}
                </select>
              ) : null
            }
          />
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="tbl is-dense">
                <thead>
                  <tr>
                    <th>Role group</th>
                    <th style={{ textAlign: 'right' }}>Sold</th>
                    <th>Allocation by pool</th>
                    <th style={{ textAlign: 'right' }}>Total</th>
                    <th style={{ textAlign: 'right' }}>On it</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {days
                    .filter((d) => day === 'all' || d === day)
                    .map((d) => {
                      const dayRows = rows.filter((r) => r.day === d);
                      return [
                        <tr key={`g-${d}`} className="group-row is-day">
                          <td colSpan={6}>
                            {dayRows[0]?.dayLabel || `Day ${d}`}
                            <span className="text-ink-3 font-normal"> · {fmtDate(dayRows[0]?.start)}</span>
                          </td>
                        </tr>,
                        ...dayRows.map((r) => (
                          <StaffRowView key={r.splitId} w={w} r={r} readOnly={readOnly} />
                        )),
                      ];
                    })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : W.hasStaffWork(w) ? (
        <div className="card p-4 mt-4 text-[13px] text-ink-2">
          This job has staff on the quote but no staffing event, so there is nothing to allocate staff against yet.
          Create the event from the Overview menu first.
        </div>
      ) : null}

      {/* Kit -------------------------------------------------------------- */}
      {v.kit.length ? (
        <>
          <Section title="Kit — what is actually going" />
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="tbl is-dense">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th style={{ textAlign: 'right' }}>On hire</th>
                    <th style={{ textAlign: 'right' }}>Sold</th>
                    <th style={{ textAlign: 'right' }}>Going</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {v.kit.map((k) => (
                    <KitRowView key={k.lineId} w={w} k={k} readOnly={readOnly} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}

      <NoteField w={w} readOnly={readOnly} />

      <Provenance>
        Sold figures come from the signed quote and do not move. The client is billed for what they bought, and their
        portal counts staffing against it — an allocation below the booking shows to them as a shortfall once the job
        is staffed. Nothing on this tab is sent to the client.
      </Provenance>

      {releasing ? <ReleaseDialog w={w} onClose={() => setReleasing(false)} /> : null}
    </>
  );
}

/* ------------------------------------------------------------- staff row */

/** "06:00–14:00". Read straight off the string: `fmtTime` hides midnight, and a night shift ending 00:00 is a real end. */
function timeWindow(r: A.StaffRow): string {
  const hhmm = (iso: string) => (/T\d{2}:\d{2}/.test(iso) ? iso.slice(11, 16) : '');
  const s = hhmm(r.start);
  const e = hhmm(r.end);
  return s && e ? `${s}–${e}` : '';
}

function StaffRowView({ w, r, readOnly }: { w: W.Wof; r: A.StaffRow; readOnly: boolean }) {
  const toast = useToast();
  const actor = ROLES.actingActor();

  const write = (pools: PoolShare[]) => {
    const res = A.setPools(w, r.splitId, pools, actor);
    if (!res.ok) toast(res.error!, { tone: 'critical' });
  };
  const used = new Set(r.pools.map((p) => p.pool));
  const free = A.POOLS.filter((p) => !used.has(p));
  const over = r.onIt > r.total;
  const delta = r.total - r.sold;

  return (
    <tr>
      <td>
        <div className="text-[13.5px] text-ink flex items-center gap-1.5 flex-wrap">
          {r.role}
          {r.isNew ? <Pill label="New" tone="info" hint="Added to the job since the allocation was started." /> : null}
          {r.changed ? (
            <Pill
              label={r.inForce == null ? 'Changed' : 'Unreleased'}
              tone="info"
              variant="quiet"
              hint={
                r.inForce == null
                  ? `Sold ${r.sold}, allocating ${r.total}.`
                  : `In force: ${r.inForce} (${A.describePools(r.inForcePools || [])}). Release to apply.`
              }
            />
          ) : null}
        </div>
        <div className="text-[11.5px] text-ink-3">
          {[r.place, timeWindow(r)].filter(Boolean).join(' · ') || '—'}
        </div>
      </td>
      <td className="tabular-nums text-ink-3" style={{ textAlign: 'right' }}>
        {r.sold}
      </td>
      <td>
        <div className="flex flex-col gap-1.5">
          {r.pools.map((p, i) => (
            <div key={`${p.pool}-${i}`} className="flex items-center gap-1.5">
              <select
                className="field"
                style={{ width: 170, padding: '4px 8px', fontSize: 12.5 }}
                aria-label={`Pool for ${r.role}`}
                value={p.pool}
                disabled={readOnly}
                onChange={(e) =>
                  write(r.pools.map((x, j) => (j === i ? { ...x, pool: e.target.value } : x)))
                }
              >
                {[p.pool, ...free].map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={0}
                className="field tabular-nums"
                style={{ width: 70, padding: '4px 8px', fontSize: 12.5 }}
                aria-label={`${p.pool} headcount for ${r.role}`}
                value={p.count}
                disabled={readOnly}
                onChange={(e) => {
                  const n = Math.max(0, Math.floor(Number(e.target.value) || 0));
                  write(r.pools.map((x, j) => (j === i ? { ...x, count: n } : x)));
                }}
              />
              {r.pools.length > 1 && !readOnly ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  aria-label={`Remove ${p.pool}`}
                  title={`Remove ${p.pool} from this group`}
                  onClick={() => write(r.pools.filter((_, j) => j !== i))}
                >
                  <Icon name="close" decorative className="icon-sm" />
                </button>
              ) : null}
            </div>
          ))}
          {!readOnly && free.length ? (
            <button
              type="button"
              className="text-[12px] text-accent self-start inline-flex items-center gap-1"
              onClick={() => write([...r.pools, { pool: free[0], count: 0 }])}
            >
              <Icon name="plus" decorative className="icon-sm" /> Add a pool
            </button>
          ) : null}
        </div>
      </td>
      <td style={{ textAlign: 'right' }}>
        <span className="tabular-nums text-[14px] font-semibold text-ink">{r.total}</span>
        {delta ? (
          <div className="text-[11.5px] tabular-nums" style={{ color: TONE_HEX[delta < 0 ? 'atRisk' : 'info'] }}>
            {delta > 0 ? '+' : ''}
            {delta}
          </div>
        ) : null}
      </td>
      <td style={{ textAlign: 'right' }}>
        <span
          className="tabular-nums text-[13px]"
          style={{ color: over ? TONE_HEX.critical : undefined }}
          title={over ? `${r.onIt} already on this group — more than the ${r.total} allocated.` : `${r.confirmed} confirmed`}
        >
          {r.onIt}
        </span>
      </td>
      <td style={{ textAlign: 'right' }}>
        {!readOnly ? (
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            title="Use these pools for the same role, place and times on every other day"
            onClick={() => {
              const n = A.copyAcrossDays(w, r.splitId, actor);
              toast(
                n
                  ? `Copied to ${countLabel(n, 'other day')} — ${A.describePools(r.pools)}.`
                  : 'No other day has this role at the same place and times.',
                { tone: n ? 'healthy' : 'neutral' },
              );
            }}
          >
            <Icon name="copy" decorative className="icon-sm" /> All days
          </button>
        ) : null}
      </td>
    </tr>
  );
}

/* --------------------------------------------------------------- kit row */

function KitRowView({ w, k, readOnly }: { w: W.Wof; k: A.KitRow; readOnly: boolean }) {
  const toast = useToast();
  const line = w.lines.find((l) => l.id === k.lineId);
  // Only ever asked about MORE than is in force: going down cannot be short.
  const short =
    line && !k.subHire && k.qty > (k.inForce ?? k.sold) ? HOP.qtyShortfall(w, line, k.qty) : null;
  const delta = k.qty - k.sold;
  return (
    <tr>
      <td>
        <div className="text-[13.5px] text-ink flex items-center gap-1.5 flex-wrap">
          {k.description}
          {k.subHire ? <Pill label="Sub-hire" tone="neutral" variant="quiet" /> : null}
          {k.isNew ? <Pill label="New" tone="info" hint="Added to the job since the allocation was started." /> : null}
          {k.changed && k.inForce != null ? (
            <Pill label="Unreleased" tone="info" variant="quiet" hint={`In force: ${k.inForce}. Release to send it.`} />
          ) : null}
        </div>
      </td>
      <td className="tabular-nums text-ink-3" style={{ textAlign: 'right' }}>
        {k.units} {k.unitLabel}
        {k.units === 1 ? '' : 's'}
      </td>
      <td className="tabular-nums text-ink-3" style={{ textAlign: 'right' }}>
        {k.sold}
      </td>
      <td style={{ textAlign: 'right' }}>
        <input
          type="number"
          min={0}
          className="field tabular-nums"
          style={{ width: 84, padding: '4px 8px', fontSize: 12.5, textAlign: 'right' }}
          aria-label={`Quantity going for ${k.description}`}
          value={k.qty}
          disabled={readOnly}
          onChange={(e) => {
            const r = A.setKit(w, k.lineId, Math.max(0, Math.floor(Number(e.target.value) || 0)), ROLES.actingActor());
            if (!r.ok) toast(r.error!, { tone: 'critical' });
          }}
        />
        {delta ? (
          <div className="text-[11.5px] tabular-nums" style={{ color: TONE_HEX.info }}>
            {delta > 0 ? '+' : ''}
            {delta}
          </div>
        ) : null}
      </td>
      <td className="text-[12px]">
        {short ? (
          <span style={{ color: TONE_HEX.critical }}>{HOP.describeShortfall(short, { name: false })}</span>
        ) : k.qty === 0 ? (
          <span className="text-ink-3">Not going — left off the picking list</span>
        ) : (
          <span className="text-ink-3">—</span>
        )}
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------------ note */

function NoteField({ w, readOnly }: { w: W.Wof; readOnly: boolean }) {
  const saved = w.allocation?.note || '';
  const [text, setText] = useState(saved);
  const dirty = text.trim() !== saved;
  return (
    <>
      <Section title="Note to staffing and the warehouse" />
      <div className="card p-4">
        <textarea
          className="field"
          rows={3}
          placeholder="Why the numbers differ from the quote, which gate the London pool reports to, what is already on site…"
          value={text}
          disabled={readOnly}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex items-center justify-between mt-2">
          <span className="text-[12px] text-ink-3">Internal. Goes out with the next release.</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={readOnly || !dirty}
            onClick={() => A.setNote(w, text, ROLES.actingActor())}
          >
            Save note
          </button>
        </div>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- release */

function ReleaseDialog({ w, onClose }: { w: W.Wof; onClose: () => void }) {
  const toast = useToast();
  const pre = useMemo(() => A.releasePreview(w), [w]);
  const [sendKit, setSendKit] = useState(pre.canSendKit);
  const v = A.read(w);

  return (
    <Modal
      title={pre.first ? 'Release the allocation' : 'Release the changes'}
      width={600}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!!pre.block}
            onClick={() => {
              const r = A.release(w, { sendKit: pre.canSendKit && sendKit }, ROLES.actingActor());
              onClose();
              if (!r.ok) {
                toast(r.error!, { tone: 'critical' });
                return;
              }
              toast(
                `${pre.first ? 'Allocation released' : 'Changes released'} — staffing can ${pre.first ? 'start assigning' : 'see the new numbers'}${
                  r.sentKit ? `, and the kit list went to the warehouse as ${r.sentKit}` : ''
                }.`,
                { tone: 'healthy' },
              );
            }}
          >
            Release
          </button>
        </>
      }
    >
      {pre.block ? (
        <p className="text-[13px] text-ink-2 mb-3">{pre.block}</p>
      ) : (
        <p className="text-[13.5px] text-ink-2 mb-3 leading-relaxed">
          {pre.first
            ? 'Writes this plan onto the rota and the kit list, and opens the job to staffing and the warehouse. Workers in the chosen pools can see it from now.'
            : 'Writes the changes onto the rota and the kit list. Staffing are told the numbers moved.'}{' '}
          Nothing is sent to the client.
        </p>
      )}

      <div className="well p-3 mb-3 text-[13px] text-ink-2 leading-relaxed">{pre.summary}</div>

      {pre.staffChanges.length || pre.kitChanges.length ? (
        <div className="mb-3">
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1.5">
            {pre.first ? 'Different from the quote' : 'Changed since the last release'}
          </div>
          <ul className="text-[12.5px] text-ink-2 space-y-0.5 max-h-44 overflow-y-auto">
            {pre.staffChanges.map((r) => (
              <li key={r.splitId}>
                · {r.role}
                {r.place ? ` at ${r.place}` : ''}, {r.dayLabel}: {pre.first ? r.sold : r.inForce} → {r.total}{' '}
                <span className="text-ink-3">({A.describePools(r.pools)})</span>
              </li>
            ))}
            {pre.kitChanges.map((k) => (
              <li key={k.lineId}>
                · {k.description}: {pre.first ? k.sold : k.inForce} → {k.qty}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {pre.warnings.length ? (
        <div
          className="rounded-lg p-3 mb-3"
          style={{ background: TONE_BG.atRisk, border: `1px solid ${TONE_LINE.atRisk}` }}
        >
          <ul className="text-[12.5px] text-ink-2 leading-relaxed space-y-1">
            {pre.warnings.map((m, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <span style={{ color: TONE_HEX.atRisk, marginTop: 2 }}>
                  <Icon name="alert" decorative className="icon-sm" />
                </span>
                <span>{m}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {pre.canSendKit ? (
        <label className="flex items-start gap-2 text-[13px] text-ink-2">
          <input type="checkbox" checked={sendKit} onChange={(e) => setSendKit(e.target.checked)} />
          <span>
            {w.picking
              ? `Re-send the kit list to the warehouse now (${w.picking.epHopRef})`
              : 'Send the kit list to the warehouse now'}
            <span className="block text-[12px] text-ink-3">
              {v.kit.filter((k) => k.qty > 0).length} lines, {v.totals.kit} items. Leave off to send it later from
              the Picking tab.
            </span>
          </span>
        </label>
      ) : null}
    </Modal>
  );
}
