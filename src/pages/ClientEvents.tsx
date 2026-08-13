/* ============================================================================
   CLIENT PORTAL — MY EVENTS
   ----------------------------------------------------------------------------
   What a client actually rings up to ask: "is my event staffed?"

   The admin Staffing screen answers the same question, but in operator language
   — splits, callouts, confirmation states, other people's jobs. This page
   answers only that one question, for one organisation, and says the quiet part
   out loud: a role that is assigned but unconfirmed is NOT a filled role, and
   pretending otherwise is how a client arrives on site to find fourteen
   stewards where fifteen were promised.

   Deliberately absent: pay rates, margin, other clients, any worker's record.
   Those are not filtered out on this page — portal.clientEvents() never hands
   them over in the first place.
   ========================================================================== */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import {
  CoverageBar, EmptyState, Kpi, PageHeader, Pill, Provenance, Segmented,
} from '@/components/primitives';
import { TONE_HEX } from '@/lib/status';
import { countLabel, fmtRange } from '@/lib/format';
import { coverageTone, pct, shiftCoverage } from '@/lib/coverage';
import * as PORTAL from '@/lib/portal';
import type { EpEvent } from '@/data/types';
import { usePortalVersion, useWofVersion } from '@/lib/useStore';

type Filter = 'all' | 'upcoming' | 'gaps';

export default function ClientEventsPage() {
  useWofVersion();
  usePortalVersion();

  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<string | null>(null);

  const rows = PORTAL.clientEvents();
  const shown = rows.filter((r) =>
    filter === 'all' ? true : filter === 'gaps' ? r.coverage.gap > 0 : r.timing.phase !== 'past',
  );

  const total = rows.reduce(
    (a, r) => ({
      required: a.required + r.coverage.required,
      assigned: a.assigned + r.coverage.assigned,
      filled: a.filled + r.coverage.filled,
      awaiting: a.awaiting + r.coverage.awaiting,
      gap: a.gap + r.coverage.gap,
    }),
    { required: 0, assigned: 0, filled: 0, awaiting: 0, gap: 0 },
  );
  const upcoming = rows.filter((r) => r.timing.phase !== 'past');
  const p = pct(total);

  return (
    <>
      <PageHeader
        title="My events"
        subtitle={`Every confirmed booking for ${PORTAL.actingClient().name}, and how far EP Team has got filling it. A role counts as filled only once the worker has confirmed they are attending — the same number your account manager is working to.`}
        actions={
          <Link className="btn btn-secondary" to="/client/hours">
            <Icon name="attendance" decorative className="icon-sm" /> Hours delivered
          </Link>
        }
      />

      <div className="flex flex-wrap gap-3 mb-5">
        <Kpi label="Confirmed bookings" value={rows.length} sub={`${upcoming.length} still to run`} tone="info" />
        <Kpi
          label="Roles required"
          value={total.required.toLocaleString()}
          sub="Across every shift of every booking"
          tone="neutral"
        />
        <Kpi
          label="Confirmed"
          value={total.filled.toLocaleString()}
          sub={`${p}% of what you have booked`}
          tone={p >= 95 ? 'healthy' : p >= 80 ? 'atRisk' : 'critical'}
        />
        <Kpi
          label="Still unfilled"
          value={total.gap.toLocaleString()}
          sub={
            total.awaiting
              ? `${total.awaiting} more assigned but not yet confirmed`
              : 'Every assigned worker has confirmed'
          }
          tone={total.gap ? (total.gap > total.required * 0.15 ? 'critical' : 'atRisk') : 'healthy'}
        />
      </div>

      <div className="mb-4">
        <Segmented<Filter>
          ariaLabel="Filter bookings"
          value={filter}
          onChange={setFilter}
          options={[
            ['all', 'All bookings'],
            ['upcoming', 'Still to run'],
            ['gaps', 'Not yet full'],
          ]}
        />
      </div>

      {shown.length ? (
        <div className="grid gap-3.5">
          {shown.map((r) => (
            <BookingCard
              key={r.event.id}
              row={r}
              open={open === r.event.id}
              onToggle={() => setOpen((o) => (o === r.event.id ? null : r.event.id))}
            />
          ))}
        </div>
      ) : (
        <div className="card">
          <EmptyState
            iconName="events"
            title="Nothing matches that filter"
            body="Try “All bookings”. If a job you are expecting is missing, it has not been confirmed as an order yet — your account manager will still be quoting it."
          />
        </div>
      )}

      <Provenance>
        Coverage is counted from the staff allocation tool in real time — this is the same figure EP Team
        sees, not a copy sent to you at some point in the past. Bookings appear here once the order is
        signed; anything still at quote stage is not shown, because it is not yet a commitment either way.
      </Provenance>
    </>
  );
}

function BookingCard({
  row,
  open,
  onToggle,
}: {
  row: PORTAL.ClientEventRow;
  open: boolean;
  onToggle: () => void;
}) {
  const ev = row.event;
  const cov = row.coverage;
  const tone = coverageTone(cov, ev.start);

  return (
    <article className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <Pill
              status={row.timing.phase === 'live' ? 'live' : row.timing.phase === 'past' ? 'complete' : 'upcoming'}
              label={row.timing.label}
              tone={row.timing.tone}
            />
            {row.wof ? <span className="text-[11.5px] text-ink-3 font-mono">{row.wof.ref}</span> : null}
          </div>
          <h2 className="text-[16px] font-bold text-ink leading-tight">{ev.name}</h2>
          <p className="text-[13px] text-ink-2 mt-1">
            {fmtRange(ev.start, ev.end, ev.allDay)}
            {row.wof && row.wof.venue ? ` · ${row.wof.venue}` : ''}
          </p>
          {ev.locations?.length ? (
            <p className="text-[12.5px] text-ink-3 mt-1 flex items-center gap-1.5">
              <Icon name="mapPin" decorative className="icon-sm" />
              {ev.locations.map((l) => l.name).join(' · ')}
            </p>
          ) : null}
        </div>

        {/* The staffing number is the reason the client opened this page, so it
            is the largest thing on the card, exactly as on the operator side.
            Same maths, same severity rule. */}
        <div className="w-full sm:w-64 shrink-0">
          <div className="flex items-baseline gap-1.5 mb-1.5">
            <span className="text-[28px] font-bold leading-none tabular-nums" style={{ color: TONE_HEX[tone] }}>
              {cov.filled}
            </span>
            <span className="text-[15px] font-semibold text-ink-3 tabular-nums">/ {cov.required}</span>
            <span className="text-[12.5px] text-ink-3 ml-auto">confirmed</span>
          </div>
          <CoverageBar cov={cov} tone={tone} />
          <p className="text-[12.5px] mt-1.5 leading-snug" style={{ color: TONE_HEX[tone] }}>
            {cov.gap ? (
              <>
                <strong>{countLabel(cov.gap, 'role')} still to fill</strong>
                {cov.awaiting ? ` · ${cov.awaiting} assigned, awaiting confirmation` : ''}
              </>
            ) : (
              'Fully staffed and confirmed'
            )}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 mt-3.5 pt-3.5 border-t border-surface-line-soft">
        <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} onClick={onToggle}>
          <Icon name={open ? 'chevronUp' : 'chevronDown'} decorative className="icon-sm" />
          {open ? 'Hide' : 'Show'} the {countLabel(ev.shifts.length, 'shift')}
        </button>
        <div className="flex-1" />
        <Link className="btn btn-ghost btn-sm" to={`/client/hours?event=${ev.id}`}>
          <Icon name="attendance" decorative className="icon-sm" /> Hours delivered
        </Link>
      </div>

      {open ? <ShiftTable ev={ev} /> : null}
    </article>
  );
}

/* Per-shift, because "45 of 129" across a seven-day festival is true but
   useless — the client needs to know WHICH day is short. */
function ShiftTable({ ev }: { ev: EpEvent }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th>Shift</th>
            <th>When</th>
            <th>Roles</th>
            <th style={{ textAlign: 'right' }}>Required</th>
            <th style={{ textAlign: 'right' }}>Confirmed</th>
            <th>Coverage</th>
          </tr>
        </thead>
        <tbody>
          {ev.shifts.map((sh) => {
            const c = shiftCoverage(sh);
            const t = coverageTone(c, sh.start);
            return (
              <tr key={sh.id}>
                <td className="text-[13px] text-ink">{sh.label}</td>
                <td className="text-[12.5px] text-ink-2 whitespace-nowrap tabular-nums">
                  {fmtRange(sh.start, sh.end)}
                </td>
                <td className="text-[12.5px] text-ink-2">{sh.splits.map((sp) => sp.role).join(', ')}</td>
                <td className="tabular-nums text-[13px]" style={{ textAlign: 'right' }}>
                  {c.required}
                </td>
                <td
                  className="tabular-nums text-[13px] font-semibold"
                  style={{ textAlign: 'right', color: TONE_HEX[t] }}
                >
                  {c.filled}
                </td>
                <td style={{ minWidth: 120 }}>
                  <CoverageBar cov={c} tone={t} height={6} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
