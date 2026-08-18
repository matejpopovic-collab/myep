/* ============================================================================
   STAFF PORTAL — MY SHIFTS
   ----------------------------------------------------------------------------
   The rota, from the worker's side, with the four things they actually ring the
   office about: what time do I meet, where, what am I wearing, and am I
   definitely on this.

   The last one is the important one. The operator screen distinguishes
   "assigned" from "confirmed" because the difference is the staffing gap. The
   worker has never been shown that distinction, so nobody knows they are the
   unconfirmed one holding up a 15-person shift. Here it is the first thing on
   the card, with the button that resolves it.

   Applications sit in the same timeline as confirmed shifts, clearly marked. A
   worker planning their week needs to see "and I might also have this" — but
   never to mistake it for booked work.
   ========================================================================== */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import {
  EmptyState, Kpi, PageHeader, Pill, Provenance, Segmented, TagPill,
} from '@/components/primitives';
import { ConfirmDestructive } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { dayDiff, fmtDate, fmtDateTime, fmtRange, money, round2, timing } from '@/lib/format';
import { NOW, event as eventById } from '@/data/db';
import type { EpEvent, Shift, Split } from '@/data/types';
import * as PORTAL from '@/lib/portal';
import { usePortalVersion } from '@/lib/useStore';

type When = 'upcoming' | 'past';

interface Row {
  kind: 'booked' | 'applied';
  start: string;
  end: string;
  event: EpEvent;
  shift: Shift;
  split: Split;
  confirmation?: string;
  /** Set on a declined row: what they gave up, which decides whether it is
      back on their open jobs or waiting on staffing to ask again. */
  declinedFrom?: string;
  application?: PORTAL.Application;
}

const hoursOf = (r: { start: string; end: string }) =>
  Math.round(((+new Date(r.end) - +new Date(r.start)) / 3600000) * 10) / 10;

export default function StaffShiftsPage() {
  const toast = useToast();
  usePortalVersion();

  const me = PORTAL.actingEmployee();
  const rate = round2(me.payRate + (me.payUplift || 0));
  const [when, setWhen] = useState<When>('upcoming');
  const [cancelling, setCancelling] = useState<PORTAL.MyAssignment | null>(null);
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);

  const booked: Row[] = PORTAL.myAssignments().map((a) => ({
    kind: 'booked',
    start: a.shift.start,
    end: a.shift.end,
    event: a.event,
    shift: a.shift,
    split: a.split,
    confirmation: a.assignment.confirmation,
    declinedFrom: a.assignment.declinedFrom,
  }));

  const applied: Row[] = PORTAL.myApplications()
    .map((app) => {
      const ev = eventById(app.eventId);
      const sh = ev?.shifts.find((s) => s.id === app.shiftId);
      const sp = sh?.splits.find((s) => s.id === app.splitId);
      return { kind: 'applied' as const, start: app.start, end: app.end, event: ev!, shift: sh!, split: sp!, application: app };
    })
    .filter((r) => r.event && r.shift && r.split);

  const all = booked.concat(applied).sort((a, b) => +new Date(a.start) - +new Date(b.start));
  const upcoming = all.filter((r) => new Date(r.end) >= NOW);
  const past = all.filter((r) => new Date(r.end) < NOW).reverse();
  const rows = when === 'upcoming' ? upcoming : past;

  const unconfirmed = upcoming.filter((r) => r.kind === 'booked' && r.confirmation !== 'confirmed');
  const nextUp = upcoming.find((r) => r.kind === 'booked');
  const hoursBooked = upcoming.filter((r) => r.kind === 'booked').reduce((s, r) => s + hoursOf(r), 0);

  const findAssignment = (splitId: string) => PORTAL.myAssignments().find((a) => a.split.id === splitId);

  const confirm = (splitId: string) => {
    const a = findAssignment(splitId);
    if (!a) return;
    // Routed through the events store rather than written into the assignment
    // object: both screens read the same record either way, but only this way
    // is the answer journalled and still there after a reload.
    if (!PORTAL.respondToInvite(splitId, 'confirmed')) return;
    rerender();
    toast(
      `Confirmed for ${a.split.role} on ${fmtDate(a.shift.start)}. Thanks — the client's coverage has just gone up by one.`,
      { tone: 'healthy' },
    );
  };

  return (
    <>
      <PageHeader
        title="My shifts"
        subtitle="Everything you are booked on, plus anything you have applied for. Confirm a shift as soon as you know you can make it — until you do, the staffing team still counts that role as unfilled and may give it to somebody else."
        actions={
          <Link className="btn btn-secondary" to="/my/jobs">
            <Icon name="search" decorative className="icon-sm" /> Find more work
          </Link>
        }
      />

      <div className="flex flex-wrap gap-3 mb-5">
        <Kpi
          label="Shifts booked"
          value={upcoming.filter((r) => r.kind === 'booked').length}
          sub={nextUp ? `Next: ${fmtDate(nextUp.start)}` : 'Nothing booked yet'}
          tone="info"
        />
        <Kpi
          label="Hours booked"
          value={hoursBooked.toFixed(1)}
          sub={`About ${money(hoursBooked * rate, { pence: false })} gross at your rate`}
          tone="neutral"
        />
        <Kpi
          label="Awaiting your confirmation"
          value={unconfirmed.length}
          sub={unconfirmed.length ? 'The staffing team is waiting on you' : 'Nothing outstanding'}
          tone={unconfirmed.length ? 'atRisk' : 'healthy'}
        />
        <Kpi
          label="Applications open"
          value={upcoming.filter((r) => r.kind === 'applied').length}
          sub="Not booked work — a decision is still to come"
          tone="neutral"
        />
      </div>

      <div className="mb-4">
        <Segmented<When>
          ariaLabel="Which shifts"
          value={when}
          onChange={setWhen}
          options={[
            ['upcoming', `Coming up (${upcoming.length})`],
            ['past', `Already worked (${past.length})`],
          ]}
        />
      </div>

      {rows.length ? (
        <div className="grid gap-3">
          {rows.map((r, i) => (
            <ShiftCard
              key={`${r.kind}-${r.split.id}-${i}`}
              r={r}
              rate={rate}
              onConfirm={() => confirm(r.split.id)}
              onWithdraw={() => {
                PORTAL.withdrawForSplit(r.split.id);
                toast('Application withdrawn — every day of that job.', { tone: 'info' });
              }}
              onCancel={() => {
                const a = findAssignment(r.split.id);
                if (a) setCancelling(a);
              }}
            />
          ))}
        </div>
      ) : (
        <div className="card">
          <EmptyState
            iconName="calendar"
            title={when === 'upcoming' ? 'Nothing booked in' : 'No past shifts on record'}
            body={
              when === 'upcoming'
                ? 'Open jobs lists every shift on a confirmed booking that still needs people, with the ones you qualify for at the top.'
                : 'Once you have worked a shift and your supervisor approves the check-in, it appears here and on Hours and pay.'
            }
            action={
              when === 'upcoming' ? (
                <Link className="btn btn-primary" to="/my/jobs">
                  Find open jobs
                </Link>
              ) : undefined
            }
          />
        </div>
      )}

      <Provenance>
        Shift details are the ones the staffing team entered on the job — if a meet time changes, it
        changes here. "Confirmed" means you have told us you are coming; it is the number the client sees
        as their coverage, which is why an unconfirmed shift is chased.
      </Provenance>

      {/* Two different acts behind one dialog. Turning down an invitation you
          never accepted costs the staffing team nothing and carries no strike;
          walking away from a shift you confirmed costs them coverage and, close
          to the day, does. Wording both the same way either threatens somebody
          who has done nothing wrong, or lets somebody drop out under the
          impression they are declining. */}
      {cancelling ? (
        (() => {
          const held = cancelling.assignment.confirmation === 'confirmed';
          const days = dayDiff(NOW, cancelling.shift.start);
          const strike = held && days <= 2;
          return (
            <ConfirmDestructive
              title={held ? 'Drop out of this shift?' : 'Turn down this shift?'}
              confirmLabel={held ? 'Drop out' : 'Turn it down'}
              message={
                <>
                  <strong className="text-ink">{cancelling.split.role}</strong> on{' '}
                  {cancelling.event.name}, {fmtRange(cancelling.shift.start, cancelling.shift.end)}.
                  <br />
                  <br />
                  {held ? (
                    <>
                      You confirmed this one, so the client is counting on it being covered. Dropping
                      out leaves the staffing team{' '}
                      {days <= 1 ? (
                        <strong className="text-status-critical">less than a day</strong>
                      ) : (
                        `${days} days`
                      )}{' '}
                      to refill it, and they will need to invite you again if you change your mind.{' '}
                      {strike
                        ? 'Dropping out this close to an event is recorded as a strike against your record.'
                        : ''}
                    </>
                  ) : (
                    <>
                      You have not confirmed this one, so nothing is lost by saying no — there is no
                      strike for turning work down. It goes back on your open jobs, so you can still
                      pick it up later if it suits you.
                    </>
                  )}
                </>
              }
              onClose={() => setCancelling(null)}
              onConfirm={() => {
                PORTAL.respondToInvite(cancelling.split.id, 'declined');
                setCancelling(null);
                rerender();
                toast(
                  held
                    ? 'You have been taken off that shift. Staffing has been notified.'
                    : 'Turned down. It is back on your open jobs if you change your mind.',
                  { tone: 'info' },
                );
              }}
            />
          );
        })()
      ) : null}
    </>
  );
}

function ShiftCard({
  r,
  rate,
  onConfirm,
  onWithdraw,
  onCancel,
}: {
  r: Row;
  rate: number;
  onConfirm: () => void;
  onWithdraw: () => void;
  onCancel: () => void;
}) {
  const t = timing(r.start, r.end);
  const past = t.phase === 'past';
  const h = hoursOf(r);

  return (
    <article className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-1.5">
            <StatusPill r={r} />
            <Pill
              status={t.phase === 'live' ? 'live' : past ? 'complete' : 'upcoming'}
              label={t.label}
              tone={t.tone}
            />
            {(r.split.tags || []).map((tag) => (
              <TagPill key={tag} tagId={tag} />
            ))}
          </div>

          <h2 className="text-[16px] font-bold text-ink leading-tight">{r.split.role}</h2>
          <p className="text-[13px] text-ink-2 mt-0.5">
            {r.event.name} · {r.shift.label}
          </p>

          <dl
            className="grid gap-x-6 gap-y-1.5 mt-3 text-[12.5px]"
            style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' }}
          >
            <Fact icon="clock" label="Shift" value={`${fmtRange(r.start, r.end)} · ${h}h`} />
            <Fact
              icon="events"
              label="Meet at"
              value={
                r.split.pickupTime
                  ? `${r.split.pickupTime} · ${r.split.office}`
                  : `${r.split.office} · time not set`
              }
            />
            <Fact icon="staff" label="Uniform" value={r.split.uniform} />
            <Fact icon="mapPin" label="Getting there" value={r.split.travel} />
          </dl>

          {r.event.additionalInfo && !past ? (
            <div className="well p-3 mt-3">
              <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1">On the day</div>
              <p className="text-[12.5px] text-ink-2 leading-relaxed">{r.event.additionalInfo}</p>
            </div>
          ) : null}
        </div>

        <div className="w-full sm:w-44 shrink-0 sm:text-right">
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1">
            {past ? 'Booked value' : 'Estimated pay'}
          </div>
          <div className="text-[22px] font-bold leading-none tabular-nums text-ink">
            {money(h * rate, { pence: false })}
          </div>
          <div className="text-[12px] text-ink-3 mt-1">
            {h}h × {money(rate)}
          </div>
        </div>
      </div>

      {past ? (
        <div className="flex items-center gap-2 mt-3.5 pt-3.5 border-t border-surface-line-soft">
          <Link className="btn btn-ghost btn-sm" to="/my/pay">
            <Icon name="trendUp" decorative className="icon-sm" /> See what you were paid
          </Link>
        </div>
      ) : r.kind === 'applied' ? (
        <div className="flex items-center gap-2 mt-3.5 pt-3.5 border-t border-surface-line-soft">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onWithdraw}>
            Withdraw application
          </button>
          <span className="text-[12.5px] text-ink-3">
            Applied {fmtDateTime(r.application!.appliedAt)}
          </span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 mt-3.5 pt-3.5 border-t border-surface-line-soft">
          {/* An unanswered invitation is a question with two answers, and it is
              laid out as one: both buttons together, weighted but not hidden.
              A confirmed shift is not a question — the only thing left to offer
              is a way out, and that belongs at the far end where it cannot be
              hit by somebody scanning for the primary action. */}
          {r.confirmation === 'confirmed' ? (
            <>
              <span className="text-[12.5px] text-ink-2 inline-flex items-center gap-1.5">
                <Icon name="checkCircle" decorative className="icon-sm" />
                Confirmed. Turn up at {r.split.pickupTime || 'the time above'}.
              </span>
              <div className="flex-1" />
              <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
                I can no longer do this
              </button>
            </>
          ) : r.confirmation === 'declined' ? (
            <span className="text-[12.5px] text-ink-3">
              {/* Only one of these is true, and which one depends on what they
                  gave up. Saying "back on your open jobs" to somebody who
                  dropped out of a confirmed shift sends them looking for a
                  role that is deliberately not there. */}
              {(r.declinedFrom ?? 'confirmed') === 'confirmed'
                ? 'You dropped out of this one. Staffing will need to invite you again.'
                : 'You turned this one down. It is back on your open jobs if you change your mind.'}
            </span>
          ) : (
            <>
              <button type="button" className="btn btn-primary btn-sm" onClick={onConfirm}>
                Yes, I'll be there
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>
                No, I can't make it
              </button>
              <span className="text-[12.5px] text-ink-3 ml-1">
                Until you answer, this role still counts as unfilled.
              </span>
            </>
          )}
        </div>
      )}
    </article>
  );
}

function StatusPill({ r }: { r: Row }) {
  if (r.kind === 'applied') {
    return (
      <Pill
        label="Applied — awaiting review"
        tone="info"
        hint="Not booked work. Staffing will confirm or decline."
      />
    );
  }
  if (r.confirmation === 'confirmed') {
    return (
      <Pill
        label="You are booked on"
        tone="healthy"
        hint="You have confirmed. The client counts this role as covered."
      />
    );
  }
  if (r.confirmation === 'declined') return <Pill status="declined" />;
  return (
    <Pill
      label="Needs your confirmation"
      tone="atRisk"
      hint="Until you confirm, this role still counts as unfilled."
    />
  );
}

function Fact({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div>
      <dt className="text-ink-3 flex items-center gap-1.5 mb-0.5">
        <Icon name={icon} decorative className="icon-sm" /> {label}
      </dt>
      <dd className="text-ink-2">{value}</dd>
    </div>
  );
}
