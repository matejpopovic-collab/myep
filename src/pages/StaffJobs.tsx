/* ============================================================================
   STAFF PORTAL — OPEN JOBS
   ----------------------------------------------------------------------------
   The worker's side of the staffing gap. Every unfilled role on the operator's
   Staffing screen is a shift somebody could be doing; this is that same list,
   read from the other end.

   Three decisions worth naming:

   1. A shift is listed only if the work order behind it is a signed order and
      has not been hidden from the staff calendar. Advertising a shift on a job
      the client has not committed to is how workers end up travelling to an
      event that was cancelled three weeks earlier.

   2. Ineligibility is EXPLAINED, not hidden. A worker who cannot take a role
      because their SIA licence lapses the week before still needs to know the
      shift exists — that is what turns "I have no work" into "I should renew my
      licence". Hiding the row loses the only useful signal in it.

   3. Applying is not accepting. The application sits as "awaiting review" until
      an operator assigns it. The old system blurred applicant, recipient and
      confirmed staff into one word and nobody could tell which they were.
   ========================================================================== */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import {
  EmptyState, Kpi, PageHeader, Pill, Provenance, Segmented, TagPill,
} from '@/components/primitives';
import { TimingPill } from '@/components/wof-ui';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { TONE_BG, TONE_HEX, TONE_LINE } from '@/lib/status';
import { countLabel, fmtDateTime, fmtRange, money, round2, timing } from '@/lib/format';
import type { Tone } from '@/data/types';
import * as PORTAL from '@/lib/portal';
import { usePortalVersion, useWofVersion } from '@/lib/useStore';

type Show = 'eligible' | 'all' | 'applied';

export default function StaffJobsPage() {
  const toast = useToast();
  usePortalVersion();
  useWofVersion();

  const me = PORTAL.actingEmployee();
  const rate = round2(me.payRate + (me.payUplift || 0));

  const [show, setShow] = useState<Show>('eligible');
  const [role, setRole] = useState('all');
  const [applying, setApplying] = useState<PORTAL.OpenEventRole | null>(null);

  // The whole run, because that is now what one card sells. Six days at nine
  // hours shown as "9h" six times over is the thing that made the old list
  // unreadable.
  const estimate = (r: PORTAL.OpenEventRole) => {
    const first = r.role.parts[0];
    const perShift =
      Math.round(((+new Date(first.shift.end) - +new Date(first.shift.start)) / 3600000) * 10) / 10;
    // Shifts, not days. A role sold against two car parks and a night window is
    // three groups on every day it works, so a seventeen-day job can be
    // sixty-two shifts — and pay follows the shifts. Days stay separate below
    // because that is the commitment being made to a diary.
    const hours = Math.round(perShift * r.role.groups * 10) / 10;
    return { hours, perShift, days: r.role.days, shifts: r.role.groups, pay: round2(hours * rate) };
  };

  const all = PORTAL.openEventRoles();
  const eligible = all.filter((r) => r.eligibility.ok);
  // Cards, not rows: a worker who applied for one six-day job has applied for
  // one thing, and a count of six here would say otherwise.
  const applied = all.filter((r) => !!r.application);

  const rows = all
    .filter((r) => (show === 'all' ? true : show === 'applied' ? !!r.application : r.eligibility.ok))
    .filter((r) => role === 'all' || r.role.role === role);

  const roles = [...new Set(all.map((r) => r.role.role))].sort();
  const potential = eligible.reduce((s, r) => s + estimate(r).pay, 0);
  const ds = PORTAL.staffDocs();

  return (
    <>
      <PageHeader
        title="Open jobs"
        subtitle="Roles on confirmed bookings that still need people. Applying puts you forward for the whole job — every day of it — and puts you in front of the staffing team. It does not book you on, and you are free to apply for more than one."
        actions={
          <Link className="btn btn-secondary" to="/my/shifts">
            <Icon name="calendar" decorative className="icon-sm" /> My shifts
          </Link>
        }
      />

      <div className="flex flex-wrap gap-3 mb-5">
        <Kpi
          label="You can apply for"
          value={eligible.length}
          sub={`${all.length} open in total, across ${new Set(all.map((r) => r.event.id)).size} events`}
          tone={eligible.length ? 'healthy' : 'neutral'}
        />
        <Kpi
          label="Applications in"
          value={applied.length}
          sub={applied.length ? 'Awaiting a decision from staffing' : 'Nothing submitted yet'}
          tone={applied.length ? 'info' : 'neutral'}
        />
        <Kpi
          label="If you got them all"
          value={money(potential, { pence: false })}
          sub={`Gross, at your ${money(rate)}/hr rate`}
          tone="neutral"
        />
        <Kpi
          label="Your rate"
          value={`${money(rate)}/hr`}
          sub={`${me.employmentType}${me.payUplift ? ` · includes ${money(me.payUplift)} uplift` : ''}`}
          tone="neutral"
        />
      </div>

      {/* One banner rather than repeating the same reason on twenty cards. If a
          document is the thing standing between this worker and every shift on
          the page, that is the headline, not a footnote. */}
      {ds.outstanding ? (
        <Blockers blocking={ds.blocking} outstanding={ds.outstanding} />
      ) : null}

      <div className="card p-3.5 mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <Segmented<Show>
            ariaLabel="Filter open jobs"
            value={show}
            onChange={setShow}
            options={[
              ['eligible', `I qualify (${eligible.length})`],
              ['all', `Everything (${all.length})`],
              ['applied', `Applied (${applied.length})`],
            ]}
          />
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1.5" htmlFor="role">
              Role
            </label>
            <select className="field w-auto" id="role" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="all">Any role</option>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {rows.length ? (
        <div className="grid gap-3">
          {rows.map((r) => (
            <JobCard
              key={r.id}
              r={r}
              rate={rate}
              est={estimate(r)}
              onApply={() => setApplying(r)}
              onWithdraw={() => {
                if (r.application) PORTAL.withdrawGroup(r.application.groupId);
                toast('Application withdrawn — every day of it.', { tone: 'info' });
              }}
            />
          ))}
        </div>
      ) : (
        <div className="card">
          <EmptyState
            iconName="search"
            title={
              show === 'applied'
                ? 'You have not applied for anything yet'
                : show === 'eligible'
                  ? 'Nothing open that you qualify for right now'
                  : 'No open shifts match that filter'
            }
            body={
              show === 'eligible'
                ? 'Switch to “Everything” to see shifts you are close to qualifying for — each one tells you exactly what is missing.'
                : 'New shifts appear here as soon as a booking is confirmed and the staffing team opens it up.'
            }
            action={
              show !== 'all' ? (
                <button type="button" className="btn btn-secondary" onClick={() => setShow('all')}>
                  Show everything
                </button>
              ) : undefined
            }
          />
        </div>
      )}

      <Provenance>
        Shifts are listed from confirmed orders only — nothing here can be cancelled because a client changed
        their mind about booking. Pay shown is your own rate multiplied by the booked shift length; overtime
        is paid on the hours you actually work, which is why the figure on Hours and pay can be higher than
        the estimate you see here.
      </Provenance>

      {applying ? (
        <ApplyDialog
          r={applying}
          rate={rate}
          est={estimate(applying)}
          onClose={() => setApplying(null)}
          onSubmit={(note) => {
            const made = PORTAL.apply(applying, note);
            const { role, event } = applying;
            setApplying(null);
            toast(
              `Applied for ${role.role} on ${event.name} — all ${countLabel(made.length, 'day')}. Staffing will be in touch.`,
              { tone: 'healthy' },
            );
          }}
        />
      ) : null}
    </>
  );
}

function Blockers({ blocking, outstanding }: { blocking: number; outstanding: number }) {
  const tone: Tone = blocking ? 'critical' : 'atRisk';
  return (
    <div className="card p-3.5 mb-4" style={{ borderColor: TONE_LINE[tone], background: TONE_BG[tone] }}>
      <div className="flex items-start gap-2.5">
        <span style={{ color: TONE_HEX[tone], marginTop: 1 }}>
          <Icon name="alert" decorative />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-ink mb-0.5">
            {blocking
              ? `${countLabel(blocking, 'document')} must be in order before you can be booked`
              : `${countLabel(outstanding, 'document')} ${outstanding === 1 ? 'needs' : 'need'} attention`}
          </div>
          <p className="text-[12.5px] text-ink-2 leading-relaxed">
            You can still apply. Staffing will not be able to confirm you onto a shift until these are
            cleared.
          </p>
        </div>
        <Link className="btn btn-secondary btn-sm shrink-0" to="/my/documents">
          Sort it out
        </Link>
      </div>
    </div>
  );
}

function JobCard({
  r,
  rate,
  est,
  onApply,
  onWithdraw,
}: {
  r: PORTAL.OpenEventRole;
  rate: number;
  est: { hours: number; perShift: number; days: number; shifts: number; pay: number };
  onApply: () => void;
  onWithdraw: () => void;
}) {
  const app = r.application;
  const el = r.eligibility;
  const t = timing(r.role.start, r.role.end);
  // Uniform, meeting point and tags are properties of the role, so any day of
  // the run answers for all of them.
  const first = r.role.parts[0].split;

  return (
    <article className={`card p-4 ${el.ok ? '' : 'opacity-95'}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-1.5">
            <TimingPill t={t} status={t.phase === 'live' ? 'live' : 'upcoming'} />
            {(first.tags || []).map((tag: string) => (
              <TagPill key={tag} tagId={tag} />
            ))}
            {app ? (
              <Pill
                label="Applied — awaiting review"
                tone="info"
                hint={`Submitted ${fmtDateTime(app.appliedAt)}`}
              />
            ) : null}
          </div>

          <h2 className="text-[16px] font-bold text-ink leading-tight">{r.role.role}</h2>
          <p className="text-[13px] text-ink-2 mt-0.5">
            {r.event.name} · {countLabel(r.role.days, 'day')}
          </p>

          <dl
            className="grid gap-x-6 gap-y-1.5 mt-3 text-[12.5px]"
            style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' }}
          >
            <Fact
              icon="clock"
              label="When"
              value={`${fmtRange(r.role.start, r.role.end)} · ${est.shifts} × ${est.perShift}h`}
            />
            <Fact icon="mapPin" label="Where" value={r.wof?.venue || r.event.name} />
            <Fact
              icon="events"
              label="Meet at"
              value={
                first.pickupTime ? `${first.pickupTime} · ${first.office}` : `${first.office} · time not set`
              }
            />
            <Fact icon="staff" label="Uniform" value={`${first.uniform} · ${first.travel}`} />
          </dl>
        </div>

        <div className="w-full sm:w-52 shrink-0 sm:text-right">
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1">Estimated pay</div>
          <div className="text-[24px] font-bold leading-none tabular-nums text-ink">
            {money(est.pay, { pence: false })}
          </div>
          <div className="text-[12px] text-ink-3 mt-1">
            {est.shifts} × {est.perShift}h × {money(rate)}
          </div>
          <div className="text-[12.5px] text-ink-2 mt-2.5">
            <strong className="text-ink">{r.role.gap}</strong> of {r.role.required} still needed
          </div>
        </div>
      </div>

      {el.ok && el.warn.length ? <Note tone="atRisk" lines={el.warn} /> : null}
      {!el.ok ? <Note tone="critical" lines={el.missing} title="You cannot take this job yet" /> : null}

      <div className="flex flex-wrap items-center gap-2 mt-3.5 pt-3.5 border-t border-surface-line-soft">
        {app ? (
          <>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onWithdraw}>
              Withdraw application
            </button>
            <span className="text-[12.5px] text-ink-3">Applied {fmtDateTime(app.appliedAt)}</span>
          </>
        ) : el.ok ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={onApply}>
            Apply for this job
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-secondary btn-sm" disabled title="Clear the points above first">
              Apply for this job
            </button>
            <Link className="btn btn-ghost btn-sm" to="/my/documents">
              What do I need?
            </Link>
          </>
        )}
      </div>
    </article>
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

function Note({ tone, lines, title }: { tone: Tone; lines: string[]; title?: string }) {
  return (
    <div className="well mt-3.5 p-3" style={{ borderColor: TONE_LINE[tone] }}>
      {title ? (
        <div className="text-[12.5px] font-semibold mb-1" style={{ color: TONE_HEX[tone] }}>
          {title}
        </div>
      ) : null}
      <ul className="text-[12.5px] text-ink-2 leading-relaxed space-y-0.5">
        {lines.map((l, i) => (
          <li key={i}>· {l}</li>
        ))}
      </ul>
    </div>
  );
}

/* A confirmation step, because an application is a commitment of the worker's
   time and the shift may start at 06:15 two hours' travel away. The dialog
   restates exactly that before they commit. */
function ApplyDialog({
  r,
  rate,
  est,
  onClose,
  onSubmit,
}: {
  r: PORTAL.OpenEventRole;
  rate: number;
  est: { hours: number; perShift: number; days: number; shifts: number; pay: number };
  onClose: () => void;
  onSubmit: (note: string) => void;
}) {
  const [note, setNote] = useState('');
  const first = r.role.parts[0].split;

  return (
    <Modal
      title={`Apply for ${r.role.role}?`}
      width={480}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => onSubmit(note.trim())}>
            Submit application
          </button>
        </>
      }
    >
      <p className="text-[13.5px] text-ink-2 leading-relaxed mb-3">
        {r.event.name} — {r.role.role}.
      </p>
      <dl className="grid gap-2 text-[13px] mb-4">
        <div className="flex justify-between gap-4">
          <dt className="text-ink-3">Job</dt>
          <dd className="text-ink text-right">{fmtRange(r.role.start, r.role.end)}</dd>
        </div>
        {/* Spelled out, because this is the commitment being made. Applying is
            for the whole run, and a worker who can only do four of the six days
            needs to know that before they submit, not after. Shifts are named
            separately where the role runs more than one group a day: six days
            can be eighteen shifts, and only one of those numbers is the one
            being paid. */}
        <div className="flex justify-between gap-4">
          <dt className="text-ink-3">Days</dt>
          <dd className="text-ink text-right">
            {countLabel(r.role.days, 'day')} — all of them
            {r.role.groups > r.role.days ? `, ${countLabel(r.role.groups, 'shift')}` : ''}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-ink-3">Meet</dt>
          <dd className="text-ink text-right">
            {first.pickupTime
              ? `${first.pickupTime} at ${first.office}`
              : `${first.office} — time to be confirmed`}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-ink-3">Estimated pay</dt>
          <dd className="text-ink text-right tabular-nums">
            {money(est.pay)} ({est.shifts} × {est.perShift}h × {money(rate)})
          </dd>
        </div>
      </dl>
      <label className="block text-[12.5px] font-semibold text-ink mb-1.5" htmlFor="app-note">
        Anything staffing should know? <span className="font-normal text-ink-3">Optional</span>
      </label>
      <textarea
        className="field"
        id="app-note"
        rows={3}
        placeholder="For example: I can only do the first four days, or I have my own transport."
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <p className="text-[12px] text-ink-3 mt-2.5 leading-relaxed">
        Applying does not book you on. Staffing will confirm or decline, and you will see the outcome on My
        shifts. You can withdraw at any time before you are confirmed.
      </p>
    </Modal>
  );
}
