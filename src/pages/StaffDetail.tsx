/* ============================================================================
   STAFF RECORD — a worker, on a page of its own
   ----------------------------------------------------------------------------
   Clicking a worker used to open a 620px dialog over the register. That was
   enough for a phone number, but not for what an operator actually comes here
   to read: the rating and what it is buying them, every shift they are booked
   on, and the timesheets behind their strikes.

   So it is a route, `/staff/:id`, the same move the client record made:

     · a URL — "look at Alice's timesheets" is a link, not directions.
     · a back button that goes back.
     · room to show the whole timesheet history, not the last five rows.

   `/staff?id=` still works; the register redirects it here.
   ========================================================================== */

import { useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { Avatar, Breadcrumb, EmptyState, Kpi, Pill, Rating, TagPill } from '@/components/primitives';
import { BandPill, FlagMarker, RatingBreakdown, RatingCriteria } from '@/components/rating';
import { MenuButton, Modal } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { TONE_BG, TONE_HEX, TONE_LINE } from '@/lib/status';
import { countLabel, fmtDate, fmtDateFull } from '@/lib/format';
import { ATTENDANCE, employee as employeeById, event as eventById } from '@/data/db';
import * as RATING from '@/lib/rating';
import * as FLAGS from '@/lib/flags';
import * as ROLES from '@/lib/roles';
import { useFlagVersion, usePayRatesVersion, useRolesVersion } from '@/lib/useStore';
import { ClearFlag, FlagWorker, upcomingFor } from './Staff';
import { PayCard, SetPayRate, payEditDenial } from './staff/PayRate';

export default function StaffDetailPage() {
  const { id = '' } = useParams();
  const toast = useToast();
  useFlagVersion();
  usePayRatesVersion();
  useRolesVersion();

  const [ratingOpen, setRatingOpen] = useState(false);
  const [criteria, setCriteria] = useState(false);
  const [flagging, setFlagging] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [payOpen, setPayOpen] = useState(false);

  const e = employeeById(id);
  // A mistyped or removed id goes back to the register, which can be searched.
  if (!e) return <Navigate to="/staff" replace />;

  const upcoming = upcomingFor(e).sort((a, b) => a.start.localeCompare(b.start));
  const history = ATTENDANCE.filter((a) => a.employeeId === e.id).sort((a, b) => b.date.localeCompare(a.date));
  const hours = history.reduce((sum, h) => sum + (h.hours || 0), 0);
  const s = RATING.score(e);
  const flagged = e.status === 'flagged';
  const message = () => toast(`Message sent to ${e.name}.`, { tone: 'healthy' });

  const field = (label: string, value: React.ReactNode) => (
    <div>
      <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1">{label}</div>
      <div className="text-[13.5px] text-ink">{value}</div>
    </div>
  );

  return (
    <>
      <Breadcrumb trail={[{ label: 'Staff register', to: '/staff' }, { label: e.name }]} />

      <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
        <div className="flex items-center gap-3.5 min-w-0">
          <Avatar hue={e.hue} initials={e.initials} size={56} />
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold text-ink leading-tight">{e.name}</h1>
            <div className="flex items-center gap-2 flex-wrap mt-1.5">
              <Pill status={e.status} />
              {e.available ? (
                <Pill status="active" label="Available" />
              ) : (
                <Pill status="inactive" label="Unavailable" />
              )}
              <FlagMarker emp={e} />
              <span className="text-[13px] text-ink-3">
                {e.office} · {e.department}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button type="button" className="btn btn-primary" onClick={message}>
            <Icon name="bell" decorative /> Send message
          </button>
          <MenuButton
            label={`Actions for ${e.name}`}
            items={[
              { label: 'Edit details', icon: 'edit', onSelect: () => toast(`Editing ${e.name}.`) },
              ...(ROLES.can('pay.view')
                ? [{
                    label: 'Set pay rate',
                    icon: 'edit',
                    hint: payEditDenial() || 'A custom hourly rate, from a date you choose',
                    disabled: !!payEditDenial(),
                    onSelect: () => setPayOpen(true),
                  }]
                : []),
              { label: 'How ratings are earned', icon: 'info', onSelect: () => setCriteria(true) },
              '-',
              {
                label: flagged ? 'Clear flag' : 'Flag worker',
                icon: 'flag',
                danger: !flagged,
                hint:
                  flagged && e.flag
                    ? `Currently flagged: ${FLAGS.reason(e.flag.reasonId).label}`
                    : 'Stops them being assigned or applying until it is cleared',
                onSelect: () => (flagged ? setClearing(true) : setFlagging(true)),
              },
            ]}
          />
        </div>
      </div>

      {e.flag ? (
        <div className="well p-3 mb-5" style={{ borderColor: TONE_LINE.critical, background: TONE_BG.critical }}>
          <div className="flex items-start gap-2.5">
            <span style={{ color: TONE_HEX.critical, marginTop: 1 }}>
              <Icon name="flag" decorative className="icon-sm" />
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] font-semibold text-ink mb-0.5">
                Flagged — not assignable and cannot apply
              </div>
              <p className="text-[12.5px] text-ink-2 leading-relaxed">{FLAGS.flagLine(e)}</p>
            </div>
            <button type="button" className="btn btn-secondary btn-sm shrink-0" onClick={() => setClearing(true)}>
              Clear flag
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-3 mb-5">
        <Kpi
          label="Shifts worked"
          value={String(e.shiftsWorked)}
          sub={e.startedAt ? `since ${fmtDateFull(e.startedAt)}` : 'all time'}
        />
        <Kpi
          label="Hours on timesheets"
          value={`${Math.round(hours * 10) / 10}h`}
          sub={history.length ? `across ${countLabel(history.length, 'timesheet')}` : 'none approved yet'}
        />
        <Kpi
          label="Strikes"
          value={String(e.strikes)}
          sub={e.strikes ? 'from late arrivals and no-shows' : 'clean record'}
          tone={e.strikes >= 3 ? 'critical' : e.strikes ? 'atRisk' : 'healthy'}
        />
        <Kpi
          label="Upcoming shifts"
          value={String(upcoming.length)}
          sub={upcoming.length ? `next ${fmtDate(upcoming[0].start)}` : 'nothing booked'}
          tone={upcoming.length ? 'info' : 'neutral'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] items-start">
        {/* ---- left: who they are ------------------------------------------ */}
        <div className="grid gap-4">
          <div className="card p-5">
            <h2 className="text-[15px] font-semibold text-ink mb-3">Rating</h2>
            <div className="flex items-center gap-3 mb-3">
              <Rating emp={e} />
              <BandPill emp={e} />
            </div>
            {/* The score, and what it is buying this worker. */}
            <button
              type="button"
              className="well p-3 w-full text-left hover:border-surface-line transition"
              onClick={() => setRatingOpen(true)}
            >
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] text-ink">{s.band.perk}</span>
                  <span className="block text-[11.5px] text-ink-3 mt-0.5">{RATING.summary(e)}</span>
                </span>
                <span className="text-ink-3 shrink-0">
                  <Icon name="chevronRight" decorative className="icon-sm" />
                </span>
              </div>
            </button>
          </div>

          <div className="card p-5">
            <h2 className="text-[15px] font-semibold text-ink mb-3">Details</h2>
            <div className="grid grid-cols-2 gap-x-5 gap-y-3">
              {field(
                'Email',
                <a href={`mailto:${e.email}`} className="text-accent no-underline hover:underline break-all">
                  {e.email}
                </a>,
              )}
              {field(
                'Phone',
                <a href={`tel:${e.phone.replace(/\s/g, '')}`} className="text-ink no-underline hover:underline">
                  {e.phone}
                </a>,
              )}
              {field('Office', e.office)}
              {field('Department', e.department)}
              {field('Employment', e.employmentType || '—')}
              {field('Started', e.startedAt ? fmtDateFull(e.startedAt) : '—')}
            </div>
          </div>

          <PayCard emp={e} onEdit={() => setPayOpen(true)} />

          <div className="card p-5">
            <h2 className="text-[15px] font-semibold text-ink mb-3">Requirements held</h2>
            <div className="flex flex-wrap gap-1.5">
              {e.tags.length ? (
                e.tags.map((t) => <TagPill key={t} tagId={t} />)
              ) : (
                <span className="text-[13px] text-ink-3 italic">None recorded</span>
              )}
            </div>
          </div>
        </div>

        {/* ---- right: what they are doing, and what they did --------------- */}
        <div className="grid gap-4">
          <div className="card p-5">
            <h2 className="text-[15px] font-semibold text-ink mb-3">
              Upcoming shifts <span className="text-ink-3 font-normal">· {upcoming.length}</span>
            </h2>
            {upcoming.length ? (
              <div className="grid gap-1.5">
                {upcoming.map((u, i) => (
                  <Link
                    key={i}
                    to={`/events/${u.evId}`}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-surface-raised border border-surface-line-soft no-underline hover:border-surface-line"
                  >
                    <span className="flex-1 min-w-0">
                      <span className="block text-[13px] text-ink truncate">{u.evName}</span>
                      <span className="block text-[11.5px] text-ink-3">
                        {u.shiftLabel} · {u.role}
                      </span>
                    </span>
                    <span className="text-[11.5px] text-ink-3 whitespace-nowrap">{fmtDate(u.start)}</span>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="text-[13px] text-ink-3 italic">No upcoming shifts.</div>
            )}
          </div>

          <div className="card overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-3">
              <h2 className="text-[15px] font-semibold text-ink">
                Timesheets <span className="text-ink-3 font-normal">· {history.length}</span>
              </h2>
              {history.length ? (
                <Link to="/timesheets" className="text-[12.5px] text-accent no-underline hover:underline">
                  All timesheets
                </Link>
              ) : null}
            </div>
            {history.length ? (
              <div className="overflow-x-auto">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Event</th>
                      <th>Role</th>
                      <th>Scheduled</th>
                      <th>Actual</th>
                      <th>Hours</th>
                      <th>Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h) => {
                      const ev = eventById(h.eventId);
                      return (
                        <tr key={h.id}>
                          <td className="text-ink-2 text-[13px] whitespace-nowrap">{fmtDate(h.date)}</td>
                          <td className="text-[13px]">
                            {ev ? (
                              <Link
                                to={`/events/${ev.id}`}
                                className="text-ink-2 no-underline hover:text-accent hover:underline"
                              >
                                {ev.name}
                              </Link>
                            ) : (
                              <span className="text-ink-3">—</span>
                            )}
                          </td>
                          <td className="text-ink-2 text-[13px]">{h.role}</td>
                          <td className="text-ink-2 text-[13px] tabular-nums whitespace-nowrap">{h.scheduled}</td>
                          <td className="text-ink-2 text-[13px] tabular-nums whitespace-nowrap">{h.actual}</td>
                          <td className="text-ink-2 text-[13px] tabular-nums">{h.hours ? `${h.hours}h` : '—'}</td>
                          <td>
                            <Pill status={h.outcome} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState iconName="attendance" title="No timesheets yet" body="Approved shifts will appear here." />
            )}
          </div>
        </div>
      </div>

      {ratingOpen ? (
        <Modal
          title={`${e.name} · rating`}
          width={560}
          onClose={() => setRatingOpen(false)}
          footer={
            <>
              <button type="button" className="btn btn-secondary" data-close onClick={() => setRatingOpen(false)}>
                Close
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setRatingOpen(false);
                  setCriteria(true);
                }}
              >
                How ratings are earned
              </button>
            </>
          }
        >
          <RatingBreakdown emp={e} />
        </Modal>
      ) : null}

      {criteria ? (
        <Modal
          title="How a rating is earned"
          width={560}
          onClose={() => setCriteria(false)}
          footer={
            <button type="button" className="btn btn-secondary" data-close onClick={() => setCriteria(false)}>
              Close
            </button>
          }
        >
          <RatingCriteria />
        </Modal>
      ) : null}

      {flagging ? <FlagWorker emp={e} onClose={() => setFlagging(false)} /> : null}
      {clearing ? <ClearFlag emp={e} onClose={() => setClearing(false)} /> : null}
      {payOpen ? <SetPayRate emp={e} by={ROLES.acting().name} onClose={() => setPayOpen(false)} /> : null}
    </>
  );
}
