/* ============================================================================
   EVENT DETAIL — the screen the product lives or dies on
   ----------------------------------------------------------------------------
   Rebuilt against the critique's priority list:

   HEADER
     · `Name: Wilderness Festival` label-value dump      -> real H1 + metadata line
     · no way back to the list                          -> breadcrumb
     · no staffing summary on the screen where you fix it -> coverage in header
     · two date formats in one product                  -> one format, no 00:00
     · no event status                                  -> Live / Upcoming / Complete

   ACTION BAR
     · nine peer buttons in five colours                -> 2 primaries + overflow
     · Delete Event inline at equal weight              -> overflow + typed confirm
     · four different "Tagging" concepts                -> renamed by outcome, deduped

   SHIFTS
     · one-shift-at-a-time dropdown on an 8-day festival -> day strip, coverage per day
     · `Split #130015` as the primary label              -> "Car Park Steward · 15 needed"
     · `14/1` badge that reconciled with nothing         -> single derived source of truth
     · `Assign Employee` vs `Fill Shift`                 -> "Assign manually" vs "Send callout"

   ASSIGNED STAFF
     · Applicant/Recipient/Employee/Staff drift          -> "Assigned staff", one term
     · Status + Confirmation always agreeing             -> merged, real distinction shown
     · 30 buttons in the Actions column                  -> overflow menu per row

   STRUCTURE
     · one unbroken scroll, no anchors                   -> sticky sub-nav
   ========================================================================== */

import { Fragment, createContext, useContext, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import {
  Avatar, Breadcrumb, CoverageBar, EmptyState, Pill, Rating, Segmented, TagPill,
} from '@/components/primitives';
import { BandPill, RatingCriteria } from '@/components/rating';
import { ConfirmDestructive, MenuButton, Modal, type MenuEntry } from '@/components/Modal';
import { DocChip, StagePill } from '@/components/wof-ui';
import { useToast } from '@/components/Toast';
import { TONE_BG, TONE_HEX, statusMeta } from '@/lib/status';
import { coverageTone, eventCoverage, eventRoles, pct, shiftCoverage, splitCoverage } from '@/lib/coverage';
import { countLabel, fmtDate, fmtDuration, fmtRange, fmtTime, money, timing } from '@/lib/format';
import {
  CLIENTS, EMPLOYEES, JOB_ROLES, OFFICES, TAGS,
  client as clientById, employee as employeeById, event as eventById,
} from '@/data/db';
import type {
  Assignment, CheckIn, ConfirmationState, EpEvent, EventLocation, Shift, Split,
} from '@/data/types';
import * as RATING from '@/lib/rating';
import * as PORTAL from '@/lib/portal';
import * as W from '@/lib/wof';
import * as EV from '@/lib/events';
import * as CHECKINS from '@/lib/checkins';
import * as NOTIFY from '@/lib/notifications';
import { useCheckInsVersion, useEventsVersion, useWofVersion } from '@/lib/useStore';

/* ==========================================================================
   THE EVENT IN SCOPE
   --------------------------------------------------------------------------
   Every mutation on this screen needs the event id, and the components that
   fire them are four levels down — page → shifts tab → role group row →
   assigned staff panel. Threading `eventId` through as a prop would mean
   touching every signature in the file to carry a value that never changes
   while the screen is mounted, and would leave the next person free to forget
   it on a new component.
   ========================================================================== */

const EventCtx = createContext<EpEvent | null>(null);

/** The event this screen is showing. Throws rather than silently mutating the
    wrong record, which is the failure this screen's own guard exists to stop. */
function useEvent(): EpEvent {
  const ev = useContext(EventCtx);
  if (!ev) throw new Error('useEvent outside an EventCtx provider');
  return ev;
}

type Tab = 'shifts' | 'staff' | 'checkins' | 'details';
const PER_PAGE = 25;

type Dialog =
  | { kind: 'callout'; split: Split | null }
  | { kind: 'assign'; split: Split }
  | { kind: 'criteria' }
  | { kind: 'requirements'; split: Split | null; scope?: 'location' }
  | { kind: 'editEvent' }
  | { kind: 'shift'; shift?: Shift }
  | { kind: 'split'; shiftId: string; split?: Split }
  | { kind: 'notify'; ids: string[] }
  | { kind: 'deleteEvent' }
  | { kind: 'deleteShift'; shift: Shift }
  | { kind: 'deleteSplit'; split: Split }
  | { kind: 'removeSelected'; ids: string[] }
  | { kind: 'removeOne'; empId: string; splitId: string }
  | { kind: 'location'; loc?: EventLocation }
  | { kind: 'deleteLocation'; loc: EventLocation }
  | { kind: 'info' }
  | { kind: 'note'; empId: string; splitId: string }
  | null;

/**
 * Guard, then render.
 *
 * This used to fall back to `EVENTS[0]` for an unknown id, which meant a stale
 * or mistyped link silently showed somebody a different client's festival and
 * let them act on it. Showing nothing is not a worse experience than showing
 * the wrong thing confidently — it is the only safe one.
 */
export default function EventDetailPage() {
  const { id } = useParams();
  useWofVersion();
  // Every coverage number on this screen is derived from assignments, so the
  // page has to re-render on any mutation in the events store — including ones
  // made from another screen in the same session.
  useEventsVersion();

  const ev = eventById(id);
  if (!ev) return <EventNotFound id={id} />;
  return (
    <EventCtx.Provider value={ev}>
      <EventDetail ev={ev} />
    </EventCtx.Provider>
  );
}

function EventNotFound({ id }: { id?: string }) {
  // A WOF may still point here — if it does, say so and offer the way back.
  const owner = W.all().find((w) => w.eventId === id);
  return (
    <>
      <Breadcrumb trail={[{ label: 'Events', to: '/events' }, { label: 'Not found' }]} />
      <EmptyState
        iconName="events"
        title="That event is not here"
        body={
          owner
            ? `The work order ${owner.ref} refers to this event, but no such event exists. That normally means the job has no staffing on it — a kit-only hire creates no shifts to fill.`
            : 'It may have been deleted, or the link may be out of date. Nothing has been changed.'
        }
        action={
          <div className="flex gap-2">
            <Link className="btn btn-primary" to="/events">
              Back to staffing
            </Link>
            {owner ? (
              <Link className="btn btn-secondary" to={`/wofs/${owner.id}`}>
                Open {owner.ref}
              </Link>
            ) : null}
          </div>
        }
      />
    </>
  );
}

function EventDetail({ ev }: { ev: EpEvent }) {
  const toast = useToast();
  const navigate = useNavigate();
  const client = clientById(ev.clientId)!;

  const [tab, setTab] = useState<Tab>('shifts');
  const [shiftId, setShiftId] = useState(ev.shifts[0]?.id);
  const [splitId, setSplitId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<Dialog>(null);

  const shift = ev.shifts.find((s) => s.id === shiftId) || ev.shifts[0];
  const activeSplit =
    (splitId && shift?.splits.find((s) => s.id === splitId)) || shift?.splits[0] || null;

  const cov = eventCoverage(ev);
  const tone = coverageTone(cov, ev.start, ev.end);
  const t = timing(ev.start, ev.end);
  const dur = fmtDuration(ev.start, ev.end);
  const pendingCheckIns = CHECKINS.pendingCount(ev.id);
  const wof = W.byEvent(ev.id);

  const allAssignments = ev.shifts.flatMap((sh) =>
    sh.splits.flatMap((sp) =>
      sp.assignments
        .map((a) => ({ a, emp: employeeById(a.employeeId), sh, sp }))
        .filter((r) => r.emp),
    ),
  );

  const moreMenu: MenuEntry[] = [
    { label: 'Edit event', icon: 'edit', onSelect: () => setDialog({ kind: 'editEvent' }) },
    {
      label: 'Duplicate event',
      icon: 'copy',
      hint: 'Copies the shifts and role groups. Staff are not copied across.',
      onSelect: () => {
        const r = EV.duplicateEvent(ev.id);
        if (!r.ok || !r.event) return;
        const copy = r.event;
        toast(`${copy.name} created — ${countLabel(copy.shifts.length, 'shift')} copied, staff not.`, {
          tone: 'healthy',
          action: { label: 'Open', onSelect: () => navigate(`/events/${copy.id}`) },
        });
      },
    },
    '-',
    { label: "Who's coming", icon: 'users', onSelect: () => setTab('staff') },
    { label: 'Locations & requirements', icon: 'mapPin', onSelect: () => setTab('details') },
    { label: 'Additional information', icon: 'fileText', onSelect: () => setTab('details') },
    '-',
    { label: 'Delete event', icon: 'trash', danger: true, onSelect: () => setDialog({ kind: 'deleteEvent' }) },
  ];

  const tabs: { k: Tab; label: string; badge?: number }[] = [
    { k: 'shifts', label: 'Shifts & staffing' },
    { k: 'staff', label: 'All assigned staff', badge: allAssignments.length },
    { k: 'checkins', label: 'Check-ins', badge: pendingCheckIns },
    { k: 'details', label: 'Details & locations' },
  ];

  return (
    <>
      <Breadcrumb trail={[{ label: 'Events', to: '/events' }, { label: ev.name }]} />

      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4 mb-5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5 flex-wrap mb-1.5">
            <h1 className="text-[24px] font-bold text-ink leading-tight tracking-tight">{ev.name}</h1>
            <Pill
              status={t.phase === 'live' ? 'live' : t.phase === 'past' ? 'complete' : 'upcoming'}
              label={t.phase === 'live' ? 'Live now' : t.phase === 'past' ? 'Complete' : 'Upcoming'}
              tone={t.tone}
            />
          </div>

          {/* Metadata line. Was three bold "Name:/Start:/End:" label-value rows
              rendered as body text. */}
          <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-[13px] text-ink-2">
            <span className="inline-flex items-center gap-1.5">
              <Icon name="calendar" decorative className="icon-sm" />
              {fmtRange(ev.start, ev.end, ev.allDay)}
              {dur ? ` · ${dur}` : ''}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Icon name="building" decorative className="icon-sm" />
              <Link to={`/clients?id=${client.id}`} className="text-ink-2 no-underline hover:text-accent hover:underline">
                {client.name}
              </Link>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Icon name="mapPin" decorative className="icon-sm" />
              {ev.locations.length ? ev.locations[0].name : 'No location set'}
              {ev.locations.length > 1 ? <span className="text-ink-3">+{ev.locations.length - 1}</span> : null}
            </span>
            <span className="text-ink-3">{t.label}</span>

            {/* Link back to the work order this event was seeded from. Shifts
                only exist because a WOF became an order, so the staffing screen
                should never be a dead end. */}
            {wof ? (
              <span className="inline-flex items-center gap-2">
                <Link to={`/wofs/${wof.id}`} className="inline-flex items-center gap-1.5 no-underline text-accent">
                  <Icon name="fileText" decorative className="icon-sm" />
                  <span className="font-mono text-[12px]">{wof.ref}</span>
                </Link>
                <StagePill wof={wof} />
                {W.docState(wof).outstanding || W.docState(wof).late ? <DocChip wof={wof} /> : null}
              </span>
            ) : (
              <span className="text-ink-3 text-[12.5px] inline-flex items-center gap-1.5">
                <Icon name="fileText" decorative className="icon-sm" /> No linked WOF
              </span>
            )}
          </div>
        </div>

        {/* Two primaries + everything else behind one overflow ------------ */}
        <div className="flex items-center gap-2 shrink-0">
          <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: 'callout', split: null })}>
            <Icon name="megaphone" decorative /> Send callout{cov.gap ? ` · ${cov.gap}` : ''}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setTab('checkins')}>
            <Icon name="checkin" decorative /> Approve check-ins
            {pendingCheckIns ? (
              <span
                className="pill"
                style={{ background: TONE_BG.atRisk, color: TONE_HEX.atRisk, padding: '0 6px' }}
              >
                {pendingCheckIns}
              </span>
            ) : null}
          </button>
          <MenuButton className="btn-icon border border-surface-line" label="More event actions" items={moreMenu} />
        </div>
      </div>

      {/* Coverage: present on the screen where the gap actually gets closed */}
      <div className="card p-4 mb-5">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
          <div className="min-w-[140px]">
            <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1.5">Staffing</div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-[30px] font-bold leading-none tabular-nums" style={{ color: TONE_HEX[tone] }}>
                {cov.filled}
              </span>
              <span className="text-[16px] font-semibold text-ink-3 tabular-nums">/ {cov.required}</span>
            </div>
            <div className="text-[12px] mt-1" style={{ color: cov.gap ? TONE_HEX[tone] : TONE_HEX.healthy }}>
              {cov.gap ? `${cov.gap.toLocaleString()} unfilled` : 'Fully staffed'}
            </div>
          </div>

          <div className="flex-1 min-w-[220px]">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-bold uppercase tracking-wider text-ink-3">
                Coverage across all shifts
              </span>
              <span className="text-[13px] font-semibold tabular-nums" style={{ color: TONE_HEX[tone] }}>
                {pct(cov)}%
              </span>
            </div>
            <CoverageBar cov={cov} tone={tone} height={10} />
            <div className="flex items-center gap-4 mt-2 text-[11.5px] text-ink-3">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full" style={{ background: TONE_HEX[tone] }} />
                {cov.filled} confirmed
              </span>
              {cov.awaiting ? (
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full" style={{ background: TONE_HEX.atRisk }} />
                  {cov.awaiting} accepted, awaiting confirmation
                </span>
              ) : null}
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-surface-line" />
                {cov.gap} unfilled
              </span>
            </div>
          </div>

          {/* The settings TOGGLE has moved out of the action row (settings are
              not actions) into this context bar, and says it saves at once. */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              className={`btn btn-secondary btn-sm ${ev.accreditationExportReady ? '' : 'tip'}`}
              disabled={!ev.accreditationExportReady}
              data-tip={ev.accreditationExportReady ? undefined : ev.accreditationBlockedReason}
              onClick={() => {
                const rows = downloadAccreditation(ev);
                toast(`Accreditation list downloaded — ${countLabel(rows, 'worker')}.`, {
                  tone: 'healthy',
                });
              }}
            >
              <Icon name="download" decorative /> Export accreditation
            </button>
            <label className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-surface-line bg-surface-raised cursor-pointer">
              <input
                type="checkbox"
                checked={ev.requiresAccreditation}
                onChange={(e) => {
                  // Written straight through. The old version kept this in
                  // component state, so the toast said "saved", the box stayed
                  // ticked, and navigating away lost it.
                  EV.setEventRequirements(ev.id, e.target.checked ? ['accredited'] : []);
                  toast(
                    `Accreditation ${e.target.checked ? 'now required' : 'no longer required'} for this event.`,
                    { tone: e.target.checked ? 'info' : 'neutral' },
                  );
                }}
              />
              <span className="text-[12.5px] text-ink-2">Requires accreditation</span>
            </label>
          </div>
        </div>
      </div>

      {/* Sticky sub-nav, so the shift being edited never scrolls out of context */}
      <div className="sticky-sub">
        <div className="flex items-center gap-4">
          <div className="tabs flex-1 border-b-0" role="tablist" aria-label="Event sections">
            {tabs.map((tb) => (
              <button
                key={tb.k}
                type="button"
                className="tab"
                role="tab"
                aria-selected={tab === tb.k}
                onClick={() => {
                  setTab(tb.k);
                  setSelected(new Set());
                }}
              >
                {tb.label}
                {tb.badge ? (
                  <span
                    className="pill ml-1.5"
                    style={{ background: TONE_BG.neutral, color: TONE_HEX.neutral, padding: '0 6px' }}
                  >
                    {tb.badge}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          {/* The Refresh button that sat here has gone. Every number on this
              screen is derived from the events store and re-renders on any
              mutation, so a control offering to fetch again was offering to do
              nothing — and its presence implied the figures might be stale. */}
        </div>
      </div>

      <div className="pt-5">
        {tab === 'shifts' && shift ? (
          <ShiftsTab
            ev={ev}
            shift={shift}
            activeSplit={activeSplit}
            query={query}
            statusFilter={statusFilter}
            selected={selected}
            page={page}
            onShift={(sid) => {
              setShiftId(sid);
              setSplitId(null);
              setSelected(new Set());
              setPage(1);
            }}
            onSplit={(spid) => {
              setSplitId(spid);
              setSelected(new Set());
              setPage(1);
            }}
            onQuery={(q) => {
              setQuery(q);
              setPage(1);
            }}
            onStatusFilter={(s) => {
              setStatusFilter(s);
              setPage(1);
            }}
            onSelected={setSelected}
            onPage={setPage}
            onDialog={setDialog}
          />
        ) : null}

        {/* An event created by hand starts with no shifts, and one seeded from a
            kit-only WOF never gets any. Without this the staffing tab renders
            nothing at all — the operator is told to add a shift by a button that
            is not on the screen. */}
        {tab === 'shifts' && !shift ? (
          <div className="card">
            <EmptyState
              iconName="calendar"
              title="No shifts yet"
              body={
                <>
                  Nobody can be rostered until this event has a shift. Add one for each day or
                  period you need staff, then add a role group to it for every role and headcount
                  {wof ? ' — the quantities on the quote are the numbers to match.' : '.'}
                </>
              }
              action={
                <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: 'shift' })}>
                  <Icon name="plus" decorative className="icon-sm" /> Add shift
                </button>
              }
            />
          </div>
        ) : null}

        {tab === 'staff' ? <AllStaffTab ev={ev} query={query} onQuery={setQuery} /> : null}

        {tab === 'checkins' ? <CheckInsTab ev={ev} /> : null}

        {tab === 'details' ? <DetailsTab ev={ev} onDialog={setDialog} /> : null}
      </div>

      {/* ---------------------------------------------------------- dialogs */}
      {dialog?.kind === 'callout' ? (
        <CalloutDialog
          ev={ev}
          split={dialog.split}
          onCriteria={() => setDialog({ kind: 'criteria' })}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === 'assign' ? (
        <AssignDialog
          split={dialog.split}
          onCriteria={() => setDialog({ kind: 'criteria' })}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === 'criteria' ? (
        <Modal
          title="How a rating is earned"
          width={560}
          onClose={() => setDialog(null)}
          footer={
            <button type="button" className="btn btn-secondary" data-close onClick={() => setDialog(null)}>
              Close
            </button>
          }
        >
          <RatingCriteria />
        </Modal>
      ) : null}

      {dialog?.kind === 'requirements' ? (
        <RequirementsDialog
          ev={ev}
          split={dialog.split}
          scope={dialog.scope}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === 'editEvent' ? (
        <EventFieldsDialog
          ev={ev}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            toast('Event updated.', { tone: 'healthy' });
          }}
        />
      ) : null}

      {dialog?.kind === 'shift' ? (
        <ShiftDialog
          shift={dialog.shift}
          onClose={() => setDialog(null)}
          onSaved={(s, created) => {
            setDialog(null);
            setShiftId(s.id);
            toast(created ? `${s.label} added.` : `${s.label} updated.`, { tone: 'healthy' });
          }}
        />
      ) : null}

      {dialog?.kind === 'split' ? (
        <SplitDialog
          shiftId={dialog.shiftId}
          split={dialog.split}
          onClose={() => setDialog(null)}
          onSaved={(s, created) => {
            setDialog(null);
            setSplitId(s.id);
            toast(created ? `${s.role} added — ${s.required} needed.` : `${s.role} updated.`, {
              tone: 'healthy',
            });
          }}
        />
      ) : null}

      {dialog?.kind === 'notify' && shift ? (
        <NotifyDialog
          ids={dialog.ids}
          shift={shift}
          onClose={() => setDialog(null)}
          onSent={(message) => {
            const ids = dialog.ids;
            NOTIFY.workersNotified({
              eventId: ev.id,
              shiftLabel: shift.label,
              employeeIds: ids,
              message,
            });
            setSelected(new Set());
            setDialog(null);
            toast(`Message to ${countLabel(ids.length, 'worker')} recorded.`, {
              tone: 'healthy',
              action: { label: 'View', onSelect: () => navigate('/notifications') },
            });
          }}
        />
      ) : null}

      {dialog?.kind === 'note' ? (
        <NoteDialog
          empId={dialog.empId}
          splitId={dialog.splitId}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            toast('Note saved against the assignment.', { tone: 'healthy' });
          }}
        />
      ) : null}

      {dialog?.kind === 'location' ? (
        <LocationDialog
          loc={dialog.loc}
          onClose={() => setDialog(null)}
          onSaved={(name, created) => {
            setDialog(null);
            toast(created ? `${name} added.` : `${name} updated.`, { tone: 'healthy' });
          }}
        />
      ) : null}

      {dialog?.kind === 'info' ? (
        <InfoDialog
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            toast('Additional information saved.', { tone: 'healthy' });
          }}
        />
      ) : null}

      {dialog?.kind === 'deleteEvent' ? (
        <ConfirmDestructive
          title={`Delete “${ev.name}”?`}
          confirmLabel="Delete event"
          typeToConfirm={ev.name}
          onClose={() => setDialog(null)}
          onConfirm={() => {
            const restore = structuredClone(ev);
            EV.removeEvent(ev.id);
            navigate('/events');
            toast(`${ev.name} deleted.`, {
              tone: 'critical',
              action: {
                label: 'Undo',
                onSelect: () => {
                  EV.restoreEvent(restore);
                  navigate(`/events/${restore.id}`);
                },
              },
            });
          }}
          message={
            <>
              This removes the event, its {countLabel(ev.shifts.length, 'shift')} and{' '}
              <strong>{countLabel(cov.assigned, 'staff assignment')}</strong>.{' '}
              {cov.filled ? (
                <>
                  <strong>{cov.filled} workers have already confirmed</strong> and will be told their shift is
                  cancelled.{' '}
                </>
              ) : null}
              {wof ? (
                <>
                  {wof.ref} will be left with no staffing record.{' '}
                </>
              ) : null}
              You will have a few seconds to undo it.
            </>
          }
        />
      ) : null}

      {dialog?.kind === 'deleteShift' ? (
        <ConfirmDestructive
          title={`Delete “${dialog.shift.label}”?`}
          confirmLabel="Delete shift"
          onClose={() => setDialog(null)}
          onConfirm={() => {
            const gone = dialog.shift;
            const restore = structuredClone(ev);
            EV.removeShift(ev.id, gone.id);
            setShiftId(ev.shifts[0]?.id);
            setDialog(null);
            toast(`${gone.label} deleted.`, {
              tone: 'critical',
              action: { label: 'Undo', onSelect: () => EV.restoreEvent(restore) },
            });
          }}
          message={
            <>
              This removes {countLabel(dialog.shift.splits.length, 'role group')} and unassigns{' '}
              <strong>
                {countLabel(
                  dialog.shift.splits.reduce((n, s) => n + s.assignments.length, 0),
                  'worker',
                )}
              </strong>
              .
            </>
          }
        />
      ) : null}

      {dialog?.kind === 'deleteSplit' && shift ? (
        <ConfirmDestructive
          title={`Delete “${dialog.split.role}” role group?`}
          confirmLabel="Delete role group"
          onClose={() => setDialog(null)}
          onConfirm={() => {
            const gone = dialog.split;
            const restore = structuredClone(ev);
            EV.removeSplit(ev.id, shift.id, gone.id);
            setSplitId(null);
            setDialog(null);
            toast(`${gone.role} deleted.`, {
              tone: 'critical',
              action: { label: 'Undo', onSelect: () => EV.restoreEvent(restore) },
            });
          }}
          message={
            <>
              This removes the role group and unassigns{' '}
              <strong>{countLabel(dialog.split.assignments.length, 'worker')}</strong>.{' '}
              {dialog.split.assignments.filter((a) => a.confirmation === 'confirmed').length
                ? 'Anyone already confirmed loses a shift they had accepted.'
                : null}
            </>
          }
        />
      ) : null}

      {dialog?.kind === 'deleteLocation' ? (
        <ConfirmDestructive
          title={`Remove “${dialog.loc.name}”?`}
          confirmLabel="Remove location"
          onClose={() => setDialog(null)}
          onConfirm={() => {
            const gone = dialog.loc;
            EV.removeLocation(ev.id, gone.id);
            setDialog(null);
            toast(`${gone.name} removed.`, { tone: 'info' });
          }}
          message={
            <>
              Workers will no longer see this as a meeting point for {ev.name}. No shift is changed.
            </>
          }
        />
      ) : null}

      {dialog?.kind === 'removeSelected' && shift ? (
        <ConfirmDestructive
          title={`Remove ${countLabel(dialog.ids.length, 'worker')} from this shift?`}
          confirmLabel={`Remove ${dialog.ids.length}`}
          onClose={() => setDialog(null)}
          onConfirm={() => {
            const ids = dialog.ids;
            const restore = structuredClone(ev);
            const n = EV.unassignFromShift(ev.id, shift.id, ids);
            setSelected(new Set());
            setDialog(null);
            toast(`${countLabel(n, 'worker')} removed from ${shift.label}.`, {
              tone: 'critical',
              action: { label: 'Undo', onSelect: () => EV.restoreEvent(restore) },
            });
          }}
          message={
            <>
              They will be unassigned from <strong>{shift.label}</strong>. The shift will be{' '}
              {shiftCoverage(shift).gap + dialog.ids.length} short.
            </>
          }
        />
      ) : null}

      {dialog?.kind === 'removeOne' && shift ? (
        <ConfirmDestructive
          title={`Remove ${employeeById(dialog.empId)?.name} from this shift?`}
          confirmLabel="Remove worker"
          onClose={() => setDialog(null)}
          onConfirm={() => {
            const name = employeeById(dialog.empId)?.name || 'Worker';
            const restore = structuredClone(ev);
            EV.unassign(ev.id, dialog.splitId, [dialog.empId]);
            setDialog(null);
            toast(`${name} removed from ${shift.label}.`, {
              tone: 'critical',
              action: { label: 'Undo', onSelect: () => EV.restoreEvent(restore) },
            });
          }}
          message={
            <>
              {employeeById(dialog.empId)?.name} will be unassigned from <strong>{shift.label}</strong>.
            </>
          }
        />
      ) : null}
    </>
  );
}

/* ==========================================================================
   TAB: Shifts & staffing
   ========================================================================== */

function ShiftsTab({
  ev, shift, activeSplit, query, statusFilter, selected, page,
  onShift, onSplit, onQuery, onStatusFilter, onSelected, onPage, onDialog,
}: {
  ev: EpEvent;
  shift: Shift;
  activeSplit: Split | null;
  query: string;
  statusFilter: string;
  selected: Set<string>;
  page: number;
  onShift: (id: string) => void;
  onSplit: (id: string) => void;
  onQuery: (q: string) => void;
  onStatusFilter: (s: string) => void;
  onSelected: (s: Set<string>) => void;
  onPage: (p: number) => void;
  onDialog: (d: Dialog) => void;
}) {
  const shCov = shiftCoverage(shift);
  const shTone = coverageTone(shCov, shift.start, shift.end);
  // Roles lead, days sit underneath. Staff are booked for a run, so "Event
  // Steward 0/150" is the number being worked on; "Day 3 is 4 short" is how it
  // gets fixed, which is why the day view stays rather than being replaced.
  const [view, setView] = useState<'role' | 'day'>('role');
  /**
   * The role a day was opened FROM, when it was opened by clicking one of its
   * day tiles.
   *
   * Clicking a tile is a drill-down, and the By role / By day control reads as
   * a view mode rather than as a way back out of one — so arriving in the day
   * view by that route left no obvious return. Held so the way back can name
   * where it goes, and cleared whenever the view is chosen deliberately.
   */
  const [fromRole, setFromRole] = useState<string | null>(null);
  const roles = eventRoles(ev);

  return (
    <>
      <div className="mb-5">
        <div className="flex items-center justify-between gap-3 mb-2.5">
          <h2 className="text-[15px] font-semibold text-ink">
            Staffing{' '}
            <span className="text-ink-3 font-normal">
              · {countLabel(roles.length, 'role')} across {countLabel(ev.shifts.length, 'day')}
            </span>
          </h2>
          <div className="flex items-center gap-2">
            <Segmented<'role' | 'day'>
              ariaLabel="Group staffing by"
              value={view}
              onChange={(v) => {
                setFromRole(null);
                setView(v);
              }}
              options={[
                ['role', 'By role'],
                ['day', 'By day'],
              ]}
            />
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => onDialog({ kind: 'shift' })}>
              <Icon name="plus" decorative className="icon-sm" /> Add shift
            </button>
          </div>
        </div>

        {view === 'role' ? (
          <div className="grid gap-2.5">
            {roles.map((r) => {
              const tn = coverageTone(r, r.start, r.end);
              return (
                <div key={r.role} className="card p-3.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-[15px] font-semibold text-ink">{r.role}</h3>
                      <p className="text-[12.5px] text-ink-3 mt-0.5">
                        {fmtRange(r.start, r.end)} · {countLabel(r.days, 'day')}
                      </p>
                    </div>
                    <div className="text-right tabular-nums">
                      <div className="text-[17px] font-bold leading-none" style={{ color: TONE_HEX[tn] }}>
                        {r.filled}
                        <span className="text-[13px] text-ink-3">/{r.required}</span>
                      </div>
                      <div className="text-[12px] text-ink-3 mt-0.5">
                        {r.gap ? `${r.gap} short` : 'Fully staffed'}
                      </div>
                    </div>
                  </div>

                  <div className="mt-2.5">
                    <CoverageBar cov={r} tone={tn} height={4} />
                  </div>

                  {/* The per-day breakdown. A role can be fully staffed overall
                      and still have one day nobody picked up, and that day is
                      the only thing worth acting on.

                      Tiles rather than a list: six days stacked as rows pushed
                      the next role off the screen, and comparing days is the
                      whole reason this breakdown exists — which needs them side
                      by side. Same shape as the day strip, one step smaller, so
                      switching views does not feel like changing product. */}
                  <div
                    className="mt-3 grid gap-1.5"
                    style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(104px,1fr))' }}
                  >
                    {r.parts.map((part) => {
                      const c = splitCoverage(part.split);
                      const tp = coverageTone(c, part.shift.start, part.shift.end);
                      // A date alone is enough to tell six days apart, and is
                      // shorter than "Day 3 — Day Shift". It stops being enough
                      // the moment one role runs twice on one date — a day and
                      // a night shift — so the label comes back only then.
                      const sameDay = r.parts.filter(
                        (o) => fmtDate(o.shift.start) === fmtDate(part.shift.start),
                      );
                      const label =
                        sameDay.length > 1
                          ? `${fmtDate(part.shift.start)} · ${fmtTime(part.shift.start)}`
                          : fmtDate(part.shift.start);
                      return (
                        <button
                          key={part.split.id}
                          type="button"
                          title={`${part.shift.label} · ${fmtDate(part.shift.start)} — ${c.filled} of ${c.required}${
                            c.gap ? `, ${c.gap} short` : ', fully staffed'
                          }`}
                          onClick={() => {
                            setFromRole(r.role);
                            setView('day');
                            onShift(part.shift.id);
                            onSplit(part.split.id);
                          }}
                          className="text-left px-2 py-1.5 rounded-lg border border-surface-line-soft bg-surface hover:border-surface-line transition"
                        >
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <span
                              className="w-1.5 h-1.5 rounded-full shrink-0"
                              style={{ background: TONE_HEX[tp] }}
                            />
                            <span className="text-[11.5px] font-semibold text-ink-2 truncate">
                              {label}
                            </span>
                          </div>
                          <div className="text-[13px] font-bold tabular-nums leading-none mb-1">
                            <span style={{ color: TONE_HEX[tp] }}>{c.filled}</span>
                            <span className="text-[11px] text-ink-3">/{c.required}</span>
                          </div>
                          <CoverageBar cov={c} tone={tp} height={3} />
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      {view === 'day' ? (
      <div className="mb-5">
        {fromRole ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm mb-2"
            onClick={() => {
              setFromRole(null);
              setView('role');
            }}
          >
            <Icon name="arrowLeft" decorative className="icon-sm" /> Back to {fromRole}
          </button>
        ) : null}

        <div className="flex gap-2 overflow-x-auto pb-1.5" role="tablist" aria-label="Shifts">
          {ev.shifts.map((s) => {
            const c = shiftCoverage(s);
            const tn = coverageTone(c, s.start, s.end);
            const on = s.id === shift.id;
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => onShift(s.id)}
                className={`shrink-0 text-left px-3 py-2.5 rounded-xl border transition min-w-[152px] ${
                  on ? 'bg-accent-soft border-accent' : 'bg-surface border-surface-line-soft hover:border-surface-line'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: TONE_HEX[tn] }} />
                  <span className={`text-[12.5px] font-semibold ${on ? 'text-ink' : 'text-ink-2'} truncate`}>
                    {s.label}
                  </span>
                </div>
                <div className="text-[11.5px] text-ink-3 mb-1.5">
                  {fmtRange(s.start, s.end)}
                </div>
                <div className="flex items-baseline gap-1 mb-1.5">
                  <span className="text-[15px] font-bold tabular-nums" style={{ color: TONE_HEX[tn] }}>
                    {c.filled}
                  </span>
                  <span className="text-[12px] text-ink-3 tabular-nums">/ {c.required}</span>
                </div>
                <CoverageBar cov={c} tone={tn} height={4} />
              </button>
            );
          })}
        </div>
      </div>
      ) : null}

      {/* Selected shift -------------------------------------------------- */}
      <section className="card mb-5" aria-label={shift.label}>
        {/* The header is tinted and the rows are not. Both sat on plain white
            with a hairline between them, and since the header's type was one
            step off the role name's, four bands of equal weight read as four
            peer rows — the shift and the roles inside it looked like the same
            kind of thing. */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 bg-surface-raised border-b border-surface-line rounded-t-[13px]">
          <div>
            <h3 className="text-[15px] font-bold text-ink">{shift.label}</h3>
            <p className="text-[12.5px] text-ink-2 mt-0.5">
              {fmtRange(shift.start, shift.end)} · {fmtDuration(shift.start, shift.end)} ·{' '}
              {countLabel(shift.splits.length, 'role group')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="text-right mr-1">
              <div className="text-[17px] font-bold tabular-nums leading-none" style={{ color: TONE_HEX[shTone] }}>
                {shCov.filled}
                <span className="text-[13px] text-ink-3">/{shCov.required}</span>
              </div>
              <div className="text-[11px] text-ink-3 mt-0.5">this shift</div>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onDialog({ kind: 'split', shiftId: shift.id })}
            >
              <Icon name="plus" decorative className="icon-sm" /> Add role group
            </button>
            <MenuButton
              label={`More actions for ${shift.label}`}
              items={[
                { label: 'Edit shift', icon: 'edit', onSelect: () => onDialog({ kind: 'shift', shift }) },
                '-',
                {
                  label: 'Delete shift',
                  icon: 'trash',
                  danger: true,
                  onSelect: () => onDialog({ kind: 'deleteShift', shift }),
                },
              ]}
            />
          </div>
        </div>

        {/* Role groups: full-width rows with coverage visible without
            expanding. Named by what they are; the database ID is small print. */}
        <div>
          {shift.splits.map((sp, i) => (
            <SplitRow
              key={sp.id}
              sp={sp}
              shift={shift}
              active={activeSplit?.id === sp.id}
              isLast={i === shift.splits.length - 1}
              onSelect={() => onSplit(sp.id)}
              onDialog={onDialog}
            />
          ))}
        </div>
      </section>

      {activeSplit ? (
        <AssignedStaffPanel
          sp={activeSplit}
          shift={shift}
          query={query}
          statusFilter={statusFilter}
          selected={selected}
          page={page}
          onQuery={onQuery}
          onStatusFilter={onStatusFilter}
          onSelected={onSelected}
          onPage={onPage}
          onDialog={onDialog}
        />
      ) : null}
    </>
  );
}

function SplitRow({
  sp, shift, active, isLast, onSelect, onDialog,
}: {
  sp: Split;
  shift: Shift;
  active: boolean;
  isLast: boolean;
  onSelect: () => void;
  onDialog: (d: Dialog) => void;
}) {
  const toast = useToast();
  const ev = useEvent();
  const c = splitCoverage(sp);
  const tn = coverageTone(c, shift.start, shift.end);

  return (
    <div
      className={`px-4 py-3.5 ${isLast ? '' : 'border-b border-surface-line-soft'} ${
        active ? 'bg-accent-soft' : ''
      } transition`}
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <button type="button" className="flex-1 min-w-[260px] text-left group" aria-pressed={active} onClick={onSelect}>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[14px] font-semibold text-ink group-hover:text-accent">{sp.role}</span>
            {/* The shift's times are stated once, in the header above. Repeating
                them on every role group put the same 25-character string on
                three consecutive rows and left each row's own fact — how many
                people it needs — competing with it. */}
            <span className="text-[12.5px] text-ink-3">· {c.required} needed</span>
          </div>
          <div className="flex items-center gap-x-3.5 gap-y-1 flex-wrap text-[11.5px] text-ink-3">
            <span>Pickup {sp.pickupTime ? sp.pickupTime : <span className="italic">not set</span>}</span>
            <span>{sp.office}</span>
            <span>{sp.uniform}</span>
            <span>{sp.travel}</span>
            <span className="opacity-60 font-mono">#{sp.id}</span>
          </div>
          {sp.tags.length ? (
            <div className="flex gap-1.5 mt-1.5">
              {sp.tags.map((t) => (
                <TagPill key={t} tagId={t} />
              ))}
            </div>
          ) : null}
        </button>

        <div className="w-40 shrink-0">
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-[16px] font-bold tabular-nums" style={{ color: TONE_HEX[tn] }}>
              {c.filled}
              <span className="text-[12px] text-ink-3">/{c.required}</span>
            </span>
            <span className="text-[11px]" style={{ color: c.gap ? TONE_HEX[tn] : TONE_HEX.healthy }}>
              {c.gap ? `${c.gap} short` : 'covered'}
            </span>
          </div>
          <CoverageBar cov={c} tone={tn} height={5} />
          {c.awaiting ? <div className="text-[11px] text-status-at-risk mt-1">{c.awaiting} unconfirmed</div> : null}
        </div>

        {/* Two clearly different verbs. "Assign Employee" and "Fill Shift"
            sounded like the same action and nobody could predict which. */}
        <div className="flex items-center gap-2 shrink-0">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onDialog({ kind: 'assign', split: sp })}>
            <Icon name="userPlus" decorative className="icon-sm" /> Assign manually
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!c.gap}
            onClick={() => onDialog({ kind: 'callout', split: sp })}
          >
            <Icon name="megaphone" decorative className="icon-sm" /> Send callout
          </button>
          <MenuButton
            label={`More actions for ${sp.role}`}
            items={[
              {
                label: 'Edit role group',
                icon: 'edit',
                onSelect: () => onDialog({ kind: 'split', shiftId: shift.id, split: sp }),
              },
              { label: 'Who can work this', icon: 'tagging', onSelect: () => onDialog({ kind: 'requirements', split: sp }) },
              {
                label: 'Duplicate role group',
                icon: 'copy',
                hint: 'Copies the role, headcount and requirements. Staff are not copied across.',
                onSelect: () => {
                  const copy = EV.duplicateSplit(ev.id, shift.id, sp.id);
                  if (copy) toast(`${copy.role} duplicated — ${copy.required} needed, nobody assigned.`, { tone: 'healthy' });
                },
              },
              '-',
              { label: 'Delete role group', icon: 'trash', danger: true, onSelect: () => onDialog({ kind: 'deleteSplit', split: sp }) },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------- assigned staff panel -- */

function AssignedStaffPanel({
  sp, shift, query, statusFilter, selected, page,
  onQuery, onStatusFilter, onSelected, onPage, onDialog,
}: {
  sp: Split;
  shift: Shift;
  query: string;
  statusFilter: string;
  selected: Set<string>;
  page: number;
  onQuery: (q: string) => void;
  onStatusFilter: (s: string) => void;
  onSelected: (s: Set<string>) => void;
  onPage: (p: number) => void;
  onDialog: (d: Dialog) => void;
}) {
  const toast = useToast();
  const ev = useEvent();
  const c = splitCoverage(sp);

  const rows = sp.assignments
    .map((a) => ({ a, emp: employeeById(a.employeeId)! }))
    .filter((r) => r.emp)
    .filter((r) => statusFilter === 'all' || r.a.confirmation === statusFilter)
    .filter((r) => !query || r.emp.name.toLowerCase().includes(query.toLowerCase()));

  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  const current = Math.min(page, pages);
  const pageRows = rows.slice((current - 1) * PER_PAGE, current * PER_PAGE);
  const sel = selected.size;

  /** Group by confirmation, with a subtle group row — not the brightest band. */
  const order = ['confirmed', 'awaiting', 'declined', 'invited'];
  const groups: Record<string, typeof pageRows> = {};
  pageRows.forEach((r) => {
    (groups[r.a.confirmation] ||= []).push(r);
  });

  return (
    <section className="card" aria-label="Assigned staff">
      <div className="px-4 py-3.5 border-b border-surface-line-soft">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-[15px] font-semibold text-ink">Assigned staff</h3>
            {/* One term, one counter. Was "Applicants" (heading), "Recipients
                in view: 15  Selected in view: 0  Total selected: 0". */}
            <p className="text-[12.5px] text-ink-2 mt-0.5">
              {sp.role} · {countLabel(rows.length, 'worker')}
              {sel ? (
                <>
                  {' · '}
                  <span className="text-accent font-semibold">{sel} selected</span>
                </>
              ) : null}
              {c.gap ? (
                <>
                  {' · '}
                  <span style={{ color: TONE_HEX.critical }}>{c.gap} still needed</span>
                </>
              ) : null}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative w-56">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none">
                <Icon name="search" decorative className="icon-sm" />
              </span>
              <input
                className="field pl-8 py-1.5 text-[13px]"
                type="search"
                value={query}
                placeholder="Filter by name…"
                aria-label="Filter assigned staff by name"
                onChange={(e) => onQuery(e.target.value)}
              />
            </div>
            <label className="sr-only" htmlFor="staff-status">
              Filter by status
            </label>
            <select
              className="field w-auto py-1.5 text-[13px]"
              id="staff-status"
              value={statusFilter}
              onChange={(e) => onStatusFilter(e.target.value)}
            >
              <option value="all">All statuses</option>
              <option value="confirmed">Confirmed</option>
              <option value="awaiting">Awaiting confirmation</option>
              <option value="declined">Declined</option>
            </select>
          </div>
        </div>

        {/* Selection toolbar: attached to its table, and only present once
            something is selected. */}
        {sel ? (
          <div className="flex items-center gap-2 mt-3 pt-3 border-t border-surface-line-soft">
            <span className="text-[13px] text-ink-2">{countLabel(sel, 'worker')} selected</span>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => onDialog({ kind: 'notify', ids: [...selected] })}
            >
              <Icon name="bell" decorative className="icon-sm" /> Notify selected
            </button>
            <MenuButton
              className="btn btn-secondary btn-sm"
              label="Change status"
              align="left"
              items={(['confirmed', 'awaiting', 'declined'] as const).map((k) => ({
                label: `Mark as ${statusMeta(k).label.toLowerCase()}`,
                icon: k === 'confirmed' ? 'checkCircle' : k === 'declined' ? 'ban' : 'clock',
                onSelect: () => {
                  const ids = [...selected];
                  const restore = structuredClone(ev);
                  const n = EV.setConfirmation(ev.id, shift.id, ids, k as ConfirmationState);
                  onSelected(new Set());
                  toast(
                    // The coverage consequence, not just the fact of the edit.
                    // Marking twelve people confirmed is only interesting
                    // because it closes twelve of the gap.
                    `${countLabel(n, 'worker')} marked as ${statusMeta(k).label.toLowerCase()} — ${sp.role} now ${
                      splitCoverage(sp).filled
                    }/${sp.required}.`,
                    {
                      tone: k === 'declined' ? 'atRisk' : 'healthy',
                      action: { label: 'Undo', onSelect: () => EV.restoreEvent(restore) },
                    },
                  );
                },
              }))}
            >
              Change status
            </MenuButton>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onSelected(new Set())}>
              Clear selection
            </button>
            <div className="flex-1" />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ color: 'var(--danger)' }}
              onClick={() => onDialog({ kind: 'removeSelected', ids: [...selected] })}
            >
              <Icon name="trash" decorative className="icon-sm" /> Remove from shift
            </button>
          </div>
        ) : null}
      </div>

      {rows.length ? (
        <>
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 38 }}>
                    <input
                      type="checkbox"
                      aria-label="Select all staff in view"
                      checked={sel === rows.length && rows.length > 0}
                      onChange={(e) => onSelected(e.target.checked ? new Set(rows.map((r) => r.emp.id)) : new Set())}
                    />
                    <span className="sr-only">Select</span>
                  </th>
                  <th>Worker</th>
                  <th>Office</th>
                  <th>Rating</th>
                  <th>Status</th>
                  <th>Check-in</th>
                  <th style={{ width: 52 }}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {order
                  .filter((k) => groups[k])
                  .map((k) => (
                    <Fragment key={`g-${k}`}>
                      <tr className="group-row">
                        <td colSpan={7}>
                          {statusMeta(k).label} · {groups[k].length}
                        </td>
                      </tr>
                      {groups[k].map((r) => (
                        <StaffRow
                          key={r.emp.id}
                          a={r.a}
                          emp={r.emp}
                          selected={selected.has(r.emp.id)}
                          onSelect={(on) => {
                            const next = new Set(selected);
                            if (on) next.add(r.emp.id);
                            else next.delete(r.emp.id);
                            onSelected(next);
                          }}
                          onRemove={() => onDialog({ kind: 'removeOne', empId: r.emp.id, splitId: sp.id })}
                          onNote={() => onDialog({ kind: 'note', empId: r.emp.id, splitId: sp.id })}
                          onStatus={(next) => {
                            const restore = structuredClone(ev);
                            EV.setConfirmation(ev.id, shift.id, [r.emp.id], next);
                            toast(
                              `${r.emp.name} marked as ${statusMeta(next).label.toLowerCase()} — ${sp.role} now ${
                                splitCoverage(sp).filled
                              }/${sp.required}.`,
                              {
                                tone: next === 'declined' ? 'atRisk' : 'healthy',
                                action: { label: 'Undo', onSelect: () => EV.restoreEvent(restore) },
                              },
                            );
                          }}
                        />
                      ))}
                    </Fragment>
                  ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-surface-line-soft">
            <span className="text-[12.5px] text-ink-3">
              Showing {(current - 1) * PER_PAGE + 1}–{Math.min(current * PER_PAGE, rows.length)} of{' '}
              {countLabel(rows.length, 'worker')}
            </span>
            {pages > 1 ? (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="btn-icon"
                  disabled={current === 1}
                  aria-label="Previous page"
                  onClick={() => onPage(current - 1)}
                >
                  <Icon name="chevronLeft" decorative />
                </button>
                <span className="text-[12.5px] text-ink-2 px-2 tabular-nums">
                  Page {current} of {pages}
                </span>
                <button
                  type="button"
                  className="btn-icon"
                  disabled={current === pages}
                  aria-label="Next page"
                  onClick={() => onPage(current + 1)}
                >
                  <Icon name="chevronRight" decorative />
                </button>
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <EmptyState
          iconName="users"
          title={query || statusFilter !== 'all' ? 'No staff match these filters' : 'Nobody assigned yet'}
          body={
            query || statusFilter !== 'all' ? (
              'Clear the filters above to see everyone on this role group.'
            ) : (
              <>
                This role group needs <strong>{c.required}</strong> {c.required === 1 ? 'worker' : 'workers'}.
                Send a callout to invite available staff, or assign someone directly.
              </>
            )
          }
          action={
            <div className="flex gap-2">
              <button type="button" className="btn btn-primary" onClick={() => onDialog({ kind: 'callout', split: sp })}>
                <Icon name="megaphone" decorative /> Send callout
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => onDialog({ kind: 'assign', split: sp })}>
                <Icon name="userPlus" decorative /> Assign manually
              </button>
            </div>
          }
        />
      )}
      <span className="sr-only">{shift.label}</span>
    </section>
  );
}

function StaffRow({
  a,
  emp,
  selected,
  onSelect,
  onRemove,
  onNote,
  onStatus,
}: {
  a: Assignment;
  emp: ReturnType<typeof employeeById> & object;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onRemove: () => void;
  onNote: () => void;
  onStatus: (next: ConfirmationState) => void;
}) {
  const navigate = useNavigate();
  const ci = a.checkIn;

  return (
    <tr className={selected ? 'is-selected' : undefined}>
      <td>
        <input
          type="checkbox"
          checked={selected}
          aria-label={`Select ${emp.name}`}
          onChange={(e) => onSelect(e.target.checked)}
        />
      </td>
      <td>
        <Link to={`/staff?id=${emp.id}`} className="flex items-center gap-2.5 no-underline group">
          <Avatar hue={emp.hue} initials={emp.initials} size={28} />
          <span className="min-w-0">
            <span className="block text-[13.5px] text-ink group-hover:text-accent truncate">{emp.name}</span>
            {a.note ? <span className="block text-[11.5px] text-status-at-risk truncate">{a.note}</span> : null}
          </span>
        </Link>
      </td>
      <td className="text-ink-2 text-[13px]">{emp.office}</td>
      <td>
        <Rating emp={emp} />
      </td>
      {/* Status and Confirmation were adjacent columns that always agreed.
          Merged: the pill is the confirmation state, the sub-line explains the
          response that produced it. */}
      <td>
        <Pill status={a.confirmation} />
        <div className="text-[11px] text-ink-3 mt-0.5">Responded: {statusMeta(a.status).label}</div>
      </td>
      <td>
        {ci === 'approved' ? (
          <Pill status="worked" label="Approved" />
        ) : ci === 'pending' ? (
          <Pill status="pending" label="Awaiting approval" />
        ) : (
          <span className="text-ink-3 text-[13px]">—</span>
        )}
      </td>
      {/* One overflow per row instead of two live buttons × 15 rows, one of
          them a one-click destructive Remove. */}
      <td>
        <MenuButton
          label={`Actions for ${emp.name}`}
          items={[
            { label: 'View profile', icon: 'staff', onSelect: () => navigate(`/staff?id=${emp.id}`) },
            '-',
            // The three confirmation states, offered directly. "Change status"
            // opening a dialog to pick one of three was a click and a modal to
            // do what a submenu does in place — and it did neither, because it
            // only fired a toast.
            ...(['confirmed', 'awaiting', 'declined'] as const)
              .filter((k) => k !== a.confirmation)
              .map((k) => ({
                label: `Mark ${statusMeta(k).label.toLowerCase()}`,
                icon: k === 'confirmed' ? 'checkCircle' : k === 'declined' ? 'ban' : 'clock',
                onSelect: () => onStatus(k),
              })),
            '-',
            { label: a.note ? 'Edit note' : 'Add a note', icon: 'fileText', onSelect: onNote },
            { label: 'Remove from shift', icon: 'trash', danger: true, onSelect: onRemove },
          ]}
        />
      </td>
    </tr>
  );
}

/* ==========================================================================
   TAB: All assigned staff (across every shift)
   ========================================================================== */

function AllStaffTab({ ev, query, onQuery }: { ev: EpEvent; query: string; onQuery: (q: string) => void }) {
  const toast = useToast();

  const rows = ev.shifts.flatMap((sh) =>
    sh.splits.flatMap((sp) =>
      sp.assignments
        .map((a) => ({ a, emp: employeeById(a.employeeId)!, sh, sp }))
        .filter((r) => r.emp)
        .filter((r) => !query || r.emp.name.toLowerCase().includes(query.toLowerCase())),
    ),
  );

  // Roll up per person: who is on this event, and how many shifts each.
  const byPerson = new Map<
    string,
    { emp: (typeof rows)[number]['emp']; shifts: typeof rows; confirmed: number; awaiting: number }
  >();
  rows.forEach((r) => {
    if (!byPerson.has(r.emp.id)) byPerson.set(r.emp.id, { emp: r.emp, shifts: [], confirmed: 0, awaiting: 0 });
    const p = byPerson.get(r.emp.id)!;
    p.shifts.push(r);
    if (r.a.confirmation === 'confirmed') p.confirmed++;
    if (r.a.confirmation === 'awaiting') p.awaiting++;
  });
  const people = [...byPerson.values()].sort((a, b) => a.emp.name.localeCompare(b.emp.name));

  return (
    <section className="card">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 border-b border-surface-line-soft">
        <div>
          <h3 className="text-[15px] font-semibold text-ink">Everyone on this event</h3>
          <p className="text-[12.5px] text-ink-2 mt-0.5">
            {countLabel(people.length, 'worker')} across {countLabel(ev.shifts.length, 'shift')} · {rows.length}{' '}
            total assignments
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative w-56">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none">
              <Icon name="search" decorative className="icon-sm" />
            </span>
            <input
              className="field pl-8 py-1.5 text-[13px]"
              type="search"
              value={query}
              placeholder="Filter by name…"
              aria-label="Filter workers by name"
              onChange={(e) => onQuery(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={!people.length}
            onClick={() => {
              const n = downloadWhosComing(ev);
              toast(`Downloaded — ${countLabel(n, 'worker')} across ${countLabel(ev.shifts.length, 'shift')}.`, {
                tone: 'healthy',
              });
            }}
          >
            <Icon name="download" decorative className="icon-sm" /> Download list
          </button>
        </div>
      </div>

      {people.length ? (
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Worker</th>
                <th>Office</th>
                <th>Rating</th>
                <th>Shifts on this event</th>
                <th>Confirmed</th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.emp.id}>
                  <td>
                    <Link to={`/staff?id=${p.emp.id}`} className="flex items-center gap-2.5 no-underline group">
                      <Avatar hue={p.emp.hue} initials={p.emp.initials} size={28} />
                      <span className="text-[13.5px] text-ink group-hover:text-accent">{p.emp.name}</span>
                    </Link>
                  </td>
                  <td className="text-ink-2 text-[13px]">{p.emp.office}</td>
                  <td>
                    <Rating emp={p.emp} />
                  </td>
                  <td className="text-[13px] text-ink-2">{p.shifts.map((s) => s.sh.label).join(', ')}</td>
                  <td>
                    <Pill
                      status={p.awaiting ? 'awaiting' : 'confirmed'}
                      label={`${p.confirmed}/${p.shifts.length} confirmed`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          iconName="users"
          title="No workers assigned yet"
          body="Assign staff to a role group, or send a callout to invite available workers."
        />
      )}
    </section>
  );
}

/* ==========================================================================
   TAB: Check-ins
   ========================================================================== */

function CheckInsTab({ ev }: { ev: EpEvent }) {
  const toast = useToast();
  useCheckInsVersion();
  const [adjusting, setAdjusting] = useState<CheckIn | null>(null);
  const [rejecting, setRejecting] = useState<CheckIn | null>(null);
  const rows = CHECKINS.pending(ev.id);
  const value = CHECKINS.queueValue(ev.id);

  return (
    <section className="card">
      <div className="flex items-center justify-between gap-3 px-4 py-3.5 border-b border-surface-line-soft">
        <div>
          <h3 className="text-[15px] font-semibold text-ink">Check-ins awaiting approval</h3>
          {/* The queue's size was the only thing stated. Its *value* is what
              makes it urgent — these are hours somebody has worked and not been
              paid for. */}
          <p className="text-[12.5px] text-ink-2 mt-0.5">
            {countLabel(value.rows, 'row')} · {value.hours} unpaid hours
            {value.flagged ? (
              <>
                {' · '}
                <span className="text-status-at-risk">{value.flagged} flagged</span>
              </>
            ) : null}
          </p>
        </div>
        {rows.filter((c) => !c.flag).length ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => {
              const r = CHECKINS.approveClean(ev.id);
              toast(
                `${countLabel(r.count, 'clean timesheet')} approved — ${r.hours} hours released to payroll.${
                  value.flagged ? ` ${value.flagged} flagged ${value.flagged === 1 ? 'row' : 'rows'} still need review.` : ''
                }`,
                { tone: 'healthy' },
              );
            }}
          >
            <Icon name="check" decorative className="icon-sm" /> Approve all clean rows
          </button>
        ) : null}
      </div>

      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Worker</th>
                <th>Role</th>
                <th>Scheduled</th>
                <th>Actual</th>
                <th>Flag</th>
                <th style={{ width: 150 }}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const emp = employeeById(c.employeeId)!;
                return (
                  <tr key={c.id}>
                    <td>
                      <span className="flex items-center gap-2.5">
                        <Avatar hue={emp.hue} initials={emp.initials} size={26} />
                        <span className="text-[13.5px] text-ink">{emp.name}</span>
                      </span>
                    </td>
                    <td className="text-ink-2 text-[13px]">{c.role}</td>
                    <td className="text-ink-2 text-[13px] tabular-nums">
                      {fmtTime(c.scheduledIn)}–{fmtTime(c.scheduledOut)}
                    </td>
                    <td className={`text-[13px] tabular-nums ${c.flag ? 'text-status-at-risk' : 'text-ink-2'}`}>
                      {c.actualIn ? fmtTime(c.actualIn) : '—'}–{c.actualOut ? fmtTime(c.actualOut) : '—'}
                    </td>
                    <td>
                      {c.flag ? (
                        <Pill
                          label={c.flag}
                          tone={c.flag.includes('No show') ? 'critical' : 'atRisk'}
                          hint={false}
                        />
                      ) : (
                        <Pill status="worked" label="Clean" hint={false} />
                      )}
                    </td>
                    <td>
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            const r = CHECKINS.approve(c.id);
                            if (!r.ok) return;
                            toast(
                              `${emp.name} approved — ${r.hours} hours at ${money(
                                CHECKINS.payFor(c, r.hours),
                              )} gross.`,
                              {
                                tone: 'healthy',
                                action: { label: 'Undo', onSelect: () => CHECKINS.reopen(c.id) },
                              },
                            );
                          }}
                        >
                          Approve
                        </button>
                        <MenuButton
                          label={`More actions for ${emp.name}'s check-in`}
                          items={[
                            {
                              label: 'Adjust times and approve',
                              icon: 'clock',
                              hint: c.flag
                                ? 'The usual fix for a flagged row'
                                : 'Correct the clock times before releasing to payroll',
                              onSelect: () => setAdjusting(c),
                            },
                            '-',
                            {
                              label: 'Reject check-in',
                              icon: 'ban',
                              danger: true,
                              hint: 'No attendance row is written and no hours are paid',
                              onSelect: () => setRejecting(c),
                            },
                          ]}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          iconName="checkCircle"
          title="All caught up"
          body="Every check-in for this event has been approved. New rows appear here as workers clock out."
          action={
            <Link className="btn btn-secondary" to="/attendance">
              View attendance log
            </Link>
          }
        />
      )}

      {adjusting ? (
        <AdjustCheckInDialog
          c={adjusting}
          onClose={() => setAdjusting(null)}
          onApproved={(hours, gross) => {
            const name = employeeById(adjusting.employeeId)?.name;
            setAdjusting(null);
            toast(`${name} approved at ${hours} hours — ${money(gross)} gross.`, { tone: 'healthy' });
          }}
        />
      ) : null}

      {rejecting ? (
        <RejectCheckInDialog
          c={rejecting}
          onClose={() => setRejecting(null)}
          onRejected={() => {
            const name = employeeById(rejecting.employeeId)?.name;
            setRejecting(null);
            toast(`${name}'s check-in rejected — no hours paid.`, { tone: 'critical' });
          }}
        />
      ) : null}
    </section>
  );
}

/* ==========================================================================
   TAB: Details & locations
   --------------------------------------------------------------------------
   "Add Location" and "Event Location Tagging" were two separate actions with an
   unclear relationship. Merged into one Locations section.
   ========================================================================== */

function DetailsTab({ ev, onDialog }: { ev: EpEvent; onDialog: (d: Dialog) => void }) {
  const client = clientById(ev.clientId)!;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="card">
        <div className="flex items-center justify-between gap-3 px-4 py-3.5 border-b border-surface-line-soft">
          <div>
            <h3 className="text-[15px] font-semibold text-ink">Locations</h3>
            <p className="text-[12.5px] text-ink-2 mt-0.5">
              Where staff report, and what each location requires.
            </p>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onDialog({ kind: 'location' })}>
            <Icon name="plus" decorative className="icon-sm" /> Add location
          </button>
        </div>
        {ev.locations.length ? (
          <div>
            {ev.locations.map((l, i) => (
              <div key={l.id} className={`flex items-start gap-3 px-4 py-3 ${i ? 'border-t border-surface-line-soft' : ''}`}>
                <span className="text-ink-3 mt-0.5">
                  <Icon name="mapPin" decorative />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13.5px] text-ink">{l.name}</div>
                  {l.note ? <div className="text-[12px] text-ink-3 mt-0.5">{l.note}</div> : null}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => onDialog({ kind: 'requirements', split: null, scope: 'location' })}
                >
                  Requirements
                </button>
                <MenuButton
                  label={`Actions for ${l.name}`}
                  items={[
                    { label: 'Edit location', icon: 'edit', onSelect: () => onDialog({ kind: 'location', loc: l }) },
                    '-',
                    {
                      label: 'Remove location',
                      icon: 'trash',
                      danger: true,
                      onSelect: () => onDialog({ kind: 'deleteLocation', loc: l }),
                    },
                  ]}
                />
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            iconName="mapPin"
            title="No locations set"
            body="Add the places staff should report to so they appear in shift confirmations."
          />
        )}
      </section>

      <section className="card">
        <div className="px-4 py-3.5 border-b border-surface-line-soft">
          <h3 className="text-[15px] font-semibold text-ink">Additional information</h3>
          <p className="text-[12.5px] text-ink-2 mt-0.5">Sent to every worker with their shift confirmation.</p>
        </div>
        <div className="px-4 py-3.5">
          {ev.additionalInfo ? (
            <p className="text-[13.5px] text-ink-2 leading-relaxed">{ev.additionalInfo}</p>
          ) : (
            <p className="text-[13.5px] text-ink-3 italic">Nothing added yet.</p>
          )}
          <button
            type="button"
            className="btn btn-secondary btn-sm mt-3.5"
            onClick={() => onDialog({ kind: 'info' })}
          >
            <Icon name="edit" decorative className="icon-sm" />{' '}
            {ev.additionalInfo ? 'Edit information' : 'Add information'}
          </button>
        </div>
      </section>

      <section className="card lg:col-span-2">
        <div className="px-4 py-3.5 border-b border-surface-line-soft">
          <h3 className="text-[15px] font-semibold text-ink">Who can work this event</h3>
          {/* The four-way "Tagging" ambiguity, resolved. All three event-level
              tagging entry points live here, named by outcome. */}
          <p className="text-[12.5px] text-ink-2 mt-0.5">
            Requirements decide which staff are eligible. Client defaults apply to every event for{' '}
            {client.name}; event requirements apply here only.
          </p>
        </div>
        <div className="grid sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-surface-line-soft">
          <div className="px-4 py-3.5">
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-[13px] font-semibold text-ink">Client defaults</span>
              <Link className="btn btn-ghost btn-sm" to={`/clients?id=${client.id}`}>
                Manage
              </Link>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {client.tags.length ? (
                client.tags.map((t) => <TagPill key={t} tagId={t} />)
              ) : (
                <span className="text-[12.5px] text-ink-3 italic">No client defaults</span>
              )}
            </div>
          </div>
          <div className="px-4 py-3.5">
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-[13px] font-semibold text-ink">This event</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => onDialog({ kind: 'requirements', split: null })}
              >
                Manage
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {ev.requiresAccreditation ? (
                <span className="pill" style={{ background: TONE_BG.info, color: TONE_HEX.info }}>
                  Accreditation required
                </span>
              ) : (
                <span className="text-[12.5px] text-ink-3 italic">No event-specific requirements</span>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ==========================================================================
   DIALOGS
   ========================================================================== */

function CalloutDialog({
  ev,
  split,
  onCriteria,
  onClose,
}: {
  ev: EpEvent;
  split: Split | null;
  onCriteria: () => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const [to, setTo] = useState('tiered');
  const gap = split ? splitCoverage(split).gap : eventCoverage(ev).gap;
  const pool = EMPLOYEES.filter((e) => e.status === 'verified' && e.available);
  const eligible = pool.length;
  // The reward, in its most concrete form: a head start measured in hours.
  const trusted = pool.filter((e) => RATING.score(e).band.id === 'trusted').length;
  const reliable = pool.filter((e) => RATING.score(e).band.id === 'reliable').length;

  return (
    <Modal
      title={split ? `Send callout · ${split.role}` : 'Send callout'}
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
              const audience =
                to === 'tiered'
                  ? `${trusted} Trusted first, then ${reliable} Reliable, then the remaining ${eligible - trusted - reliable}`
                  : to === 'office'
                    ? `everyone in ${ev.office}`
                    : to === 'client'
                      ? `staff who have worked for ${clientById(ev.clientId)?.name}`
                      : `all ${eligible} eligible and available`;
              const recipients = to === 'tiered' || to === 'all' ? eligible : pool.length;

              NOTIFY.callout({
                eventId: ev.id,
                eventName: ev.name,
                role: split ? split.role : null,
                gap,
                audience,
                recipients,
              });
              onClose();
              toast(
                `Callout sent for ${gap} unfilled ${gap === 1 ? 'role' : 'roles'} — ${audience}.`,
                {
                  tone: 'healthy',
                  action: { label: 'View', onSelect: () => navigate('/notifications') },
                },
              );
            }}
          >
            Send callout
          </button>
        </>
      }
    >
      <p className="text-[13.5px] text-ink-2 leading-relaxed mb-4">
        Broadcasts the {split ? 'role group' : 'event'} to available staff who meet the requirements. Workers
        accept on a first-come basis until the gap is closed — so who receives it first is what a rating
        buys.
      </p>
      <div className="grid gap-3 mb-4">
        <div className="flex items-center justify-between px-3 py-2.5 rounded-lg bg-surface-raised border border-surface-line-soft">
          <span className="text-[13px] text-ink-2">Roles to fill</span>
          <span className="text-[15px] font-bold" style={{ color: TONE_HEX.critical }}>
            {gap}
          </span>
        </div>
        <div className="flex items-center justify-between px-3 py-2.5 rounded-lg bg-surface-raised border border-surface-line-soft">
          <span className="text-[13px] text-ink-2">Eligible and available staff</span>
          <span className="text-[15px] font-bold text-ink">{eligible}</span>
        </div>
      </div>
      <label className="block mb-3">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Send to</span>
        <select className="field" value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="tiered">
            Best-rated first, then everyone ({trusted} Trusted, {reliable} Reliable)
          </option>
          <option value="all">Eligible and available staff, all at once ({eligible})</option>
          <option value="office">Everyone in {ev.office}</option>
          <option value="client">Previously worked this client</option>
        </select>
      </label>
      {to === 'tiered' ? (
        <div className="well p-3 mb-3">
          <p className="text-[12.5px] text-ink-2 leading-relaxed">
            Trusted workers get the callout <strong className="text-ink">four hours</strong> before Reliable,
            who get it four hours before everybody else. On a first-come shift that head start is the reward
            — and it is the one thing a worker can earn purely by turning up.{' '}
            <button type="button" className="text-accent underline" onClick={onCriteria}>
              How it is earned
            </button>
          </p>
        </div>
      ) : null}
      <label className="flex items-center gap-2.5">
        <input type="checkbox" defaultChecked />
        <span className="text-[13px] text-ink-2">Close the callout automatically once filled</span>
      </label>
    </Modal>
  );
}

/**
 * The staffing queue — where the rating is actually cashed in.
 *
 * The list used to be a flat `sort(b.rating - a.rating)` over an unexplained
 * number, which is the same as no order at all: nobody could say why the fifth
 * name was fifth. It is now ordered by BAND, then by an outstanding
 * application, then by score, with the reason written next to each name.
 */
function AssignDialog({
  split,
  onCriteria,
  onClose,
}: {
  split: Split;
  onCriteria: () => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const ev = useEvent();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const already = new Set(split.assignments.map((a) => a.employeeId));
  // Anyone who asked for this shift through the staff portal is looked at first
  // within their band. They have already said yes.
  const applied = new Set(
    PORTAL.applications()
      .filter((a) => a.splitId === split.id && a.status === 'applied')
      .map((a) => a.employeeId),
  );

  const pool = EMPLOYEES.filter((e) => !already.has(e.id) && e.status !== 'flagged');
  const ranked = RATING.queue(pool, { applied }).filter((r) =>
    r.emp.name.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <Modal
      title={`Assign manually · ${split.role}`}
      width={640}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!picked.size}
            onClick={() => {
              const restore = structuredClone(ev);
              const { assigned: n, refused } = EV.assign(ev.id, split.id, [...picked]);
              NOTIFY.assignmentsMade({ eventId: ev.id, role: split.role, count: n });
              onClose();
              const c = splitCoverage(split);

              // A refusal is the whole point of the availability check, so it
              // is said out loud and named. Reporting only the successes would
              // leave the operator believing they had booked somebody who is on
              // annual leave — which is exactly what the two spreadsheets do.
              if (refused.length) {
                toast(
                  `${countLabel(refused.length, 'worker')} not assigned — ${refused
                    .map((r) => r.reason)
                    .join('; ')}.`,
                  { tone: 'critical' },
                );
              }

              if (n) {
                toast(
                  // Assigned is not filled. Saying so here, at the moment the
                  // operator might otherwise assume the gap is closed, is the
                  // whole reason the two states are modelled separately.
                  `${countLabel(n, 'worker')} assigned to ${split.role} and asked to confirm — still ${c.filled}/${
                    split.required
                  } confirmed.`,
                  {
                    tone: 'healthy',
                    action: { label: 'Undo', onSelect: () => EV.restoreEvent(restore) },
                  },
                );
              }
            }}
          >
            {picked.size ? `Assign ${picked.size}` : 'Assign selected'}
          </button>
        </>
      }
    >
      <p className="text-[13.5px] text-ink-2 mb-3">
        Places a worker directly onto the shift without a callout. They are notified and asked to confirm.{' '}
        <strong>{splitCoverage(split).gap}</strong> still needed.
      </p>
      <div className="well p-3 mb-3.5 flex items-start gap-2.5">
        <span className="text-ink-3 mt-px">
          <Icon name="star" decorative className="icon-sm" />
        </span>
        <p className="text-[12.5px] text-ink-2 leading-relaxed flex-1">
          Ordered by rating band, then by anyone who has applied for this shift. Rating is earned from the
          attendance record — the reward for turning up is being offered work first.{' '}
          <button type="button" className="text-accent underline" onClick={onCriteria}>
            How it is earned
          </button>
        </p>
      </div>
      <input
        className="field mb-3"
        placeholder="Search staff…"
        aria-label="Search staff to assign"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="border border-surface-line-soft rounded-xl overflow-hidden max-h-72 overflow-y-auto">
        {ranked.length ? (
          ranked.map((r, i) => (
            <label
              key={r.emp.id}
              className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-surface-hover ${
                i ? 'border-t border-surface-line-soft' : ''
              }`}
            >
              <input
                type="checkbox"
                checked={picked.has(r.emp.id)}
                onChange={(e) =>
                  setPicked((s) => {
                    const next = new Set(s);
                    if (e.target.checked) next.add(r.emp.id);
                    else next.delete(r.emp.id);
                    return next;
                  })
                }
              />
              <span className="w-6 shrink-0 text-[12px] tabular-nums text-ink-3 text-right">{r.position}</span>
              <Avatar hue={r.emp.hue} initials={r.emp.initials} size={30} />
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[13.5px] text-ink truncate">{r.emp.name}</span>
                  <BandPill emp={r.emp} />
                  {r.applied ? (
                    <Pill label="Applied" tone="info" hint="Asked for this shift through the staff portal" />
                  ) : null}
                </span>
                <span className="block text-[11.5px] text-ink-3 truncate">
                  {r.emp.office} · {r.emp.department}
                  {r.emp.available ? '' : ' · unavailable'}
                </span>
                <span className="block text-[11.5px] text-ink-3 truncate">{r.reason}</span>
              </span>
              <Rating emp={r.emp} />
            </label>
          ))
        ) : (
          <div className="px-3 py-6 text-center text-[13px] text-ink-3">No staff match that search.</div>
        )}
      </div>
    </Modal>
  );
}

function RequirementsDialog({
  ev,
  split,
  scope,
  onClose,
}: {
  ev: EpEvent;
  split: Split | null;
  scope?: 'location';
  onClose: () => void;
}) {
  const toast = useToast();
  const client = clientById(ev.clientId)!;
  const initial = new Set(split ? split.tags : ev.requiresAccreditation ? ['accredited'] : []);
  const [current, setCurrent] = useState<Set<string>>(initial);

  const title = split
    ? `Who can work “${split.role}”`
    : scope === 'location'
      ? 'Location requirements'
      : 'Event requirements';

  return (
    <Modal
      title={title}
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
              const tags = [...current];
              if (split) EV.setSplitRequirements(ev.id, shiftOf(ev, split.id)!.id, split.id, tags);
              else EV.setEventRequirements(ev.id, tags);
              onClose();
              toast(
                tags.length
                  ? `Requirements saved — ${tags.length} must be held to work ${split ? split.role : 'this event'}.`
                  : 'Requirements cleared — anyone eligible can be assigned.',
                { tone: 'healthy' },
              );
            }}
          >
            Save requirements
          </button>
        </>
      }
    >
      <p className="text-[13.5px] text-ink-2 mb-4 leading-relaxed">
        Only staff holding every selected requirement can be assigned or receive a callout. Client defaults
        for <strong>{client.name}</strong> apply on top of these.
      </p>
      <div className="grid gap-1.5">
        {TAGS.map((t) => (
          <label
            key={t.id}
            className="flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-surface-hover cursor-pointer"
          >
            <input
              type="checkbox"
              checked={current.has(t.id)}
              onChange={(e) =>
                setCurrent((s) => {
                  const next = new Set(s);
                  if (e.target.checked) next.add(t.id);
                  else next.delete(t.id);
                  return next;
                })
              }
            />
            <span className="text-[13.5px] text-ink">{t.label}</span>
            {client.tags.includes(t.id) ? (
              <span className="pill ml-auto" style={{ background: TONE_BG.neutral, color: TONE_HEX.neutral }}>
                client default
              </span>
            ) : null}
          </label>
        ))}
      </div>
    </Modal>
  );
}

/** Shows a validation message under a field, or nothing. */
function Err({ msg }: { msg?: string }) {
  return msg ? <span className="block text-[11.5px] text-status-critical mt-1">{msg}</span> : null;
}

/** Which shift a role group belongs to. */
function shiftOf(ev: EpEvent, splitId: string): Shift | undefined {
  return ev.shifts.find((s) => s.splits.some((p) => p.id === splitId));
}

/* --------------------------------------------------------- event fields -- */

function EventFieldsDialog({
  ev,
  onClose,
  onSaved,
}: {
  ev: EpEvent;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(ev.name);
  const [clientId, setClientId] = useState(ev.clientId);
  const [office, setOffice] = useState(ev.office);
  const [start, setStart] = useState(EV.local(new Date(ev.start)));
  const [end, setEnd] = useState(EV.local(new Date(ev.end)));
  const [allDay, setAllDay] = useState(ev.allDay);
  const [touched, setTouched] = useState(false);

  const input = (): EV.EventInput => ({
    name, clientId, office, start, end, allDay, requiresAccreditation: ev.requiresAccreditation,
  });
  const errors = touched ? EV.validateEvent(input(), ev.id) : {};

  const submit = () => {
    setTouched(true);
    if (EV.hasErrors(EV.validateEvent(input(), ev.id))) return;
    if (EV.updateEvent(ev.id, input()).ok) onSaved();
  };

  return (
    <Modal
      title="Edit event"
      width={560}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit}>
            Save changes
          </button>
        </>
      }
    >
      <div className="grid gap-3.5">
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Event name</span>
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
          <Err msg={errors.name} />
        </label>
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Client</span>
          <select className="field" value={clientId} onChange={(e) => setClientId(e.target.value)}>
            {[...CLIENTS]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
          <Err msg={errors.clientId} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Starts</span>
            <input className="field" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
            <Err msg={errors.start} />
          </label>
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Ends</span>
            <input className="field" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
            <Err msg={errors.end} />
          </label>
        </div>
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Office</span>
          <select className="field" value={office} onChange={(e) => setOffice(e.target.value)}>
            {OFFICES.slice(1).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2.5">
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
          <span className="text-[13px] text-ink-2">All day — hide the start and end times</span>
        </label>
        {ev.shifts.length ? (
          <p className="text-[12px] text-ink-3 leading-relaxed border-t border-surface-line-soft pt-3">
            Moving the event does not move its {countLabel(ev.shifts.length, 'shift')}. Shift times are
            edited on the shift itself, because a festival's build day and its show days do not move
            together.
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------- shift -- */

function ShiftDialog({
  shift,
  onClose,
  onSaved,
}: {
  shift?: Shift;
  onClose: () => void;
  onSaved: (s: Shift, created: boolean) => void;
}) {
  const ev = useEvent();
  const defaults = EV.defaultShiftTimes(ev.id);

  const [label, setLabel] = useState(shift?.label ?? `Day ${ev.shifts.length + 1} — Day shift`);
  const [start, setStart] = useState(shift ? EV.local(new Date(shift.start)) : defaults.start);
  const [end, setEnd] = useState(shift ? EV.local(new Date(shift.end)) : defaults.end);
  const [touched, setTouched] = useState(false);

  const input = (): EV.ShiftInput => ({ label, start, end });
  const errors = touched ? EV.validateShift(input()) : {};
  const hours = start && end ? fmtDuration(start, end) : '';

  const submit = () => {
    setTouched(true);
    if (EV.hasErrors(EV.validateShift(input()))) return;
    const r = shift ? EV.updateShift(ev.id, shift.id, input()) : EV.addShift(ev.id, input());
    if (r.ok && r.shift) onSaved(r.shift, !shift);
  };

  return (
    <Modal
      title={shift ? 'Edit shift' : 'Add shift'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit}>
            {shift ? 'Save changes' : 'Add shift'}
          </button>
        </>
      }
    >
      <div className="grid gap-3.5">
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
            Shift name <span className="text-status-critical">*</span>
          </span>
          <input
            className="field"
            placeholder="e.g. Day 8 — Day shift"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Err msg={errors.label} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
              Starts <span className="text-status-critical">*</span>
            </span>
            <input className="field" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
            <Err msg={errors.start} />
          </label>
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
              Ends <span className="text-status-critical">*</span>
            </span>
            <input className="field" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
            <Err msg={errors.end} />
          </label>
        </div>
        {/* The length, as it is typed. A shift's duration is what the operator
            is actually deciding, and it is the thing an overnight shift gets
            wrong — 19:00 to 07:00 on the same date is minus twelve hours. */}
        {hours && !errors.end ? (
          <p className="text-[12px] text-ink-3 -mt-1">
            {hours} long{new Date(end).getDate() !== new Date(start).getDate() ? ', crossing midnight' : ''}.
          </p>
        ) : null}
        {!shift ? (
          <p className="text-[12px] text-ink-3 leading-relaxed border-t border-surface-line-soft pt-3">
            Added with no role groups, so it will show 0 / 0. Add a role group to say who is needed.
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/* ----------------------------------------------------------- role group -- */

const TRAVEL = ['Own transport', 'Office', 'Coach', 'Minibus'];

function SplitDialog({
  shiftId,
  split,
  onClose,
  onSaved,
}: {
  shiftId: string;
  split?: Split;
  onClose: () => void;
  onSaved: (s: Split, created: boolean) => void;
}) {
  const ev = useEvent();

  const [role, setRole] = useState(split?.role ?? JOB_ROLES[0]);
  const [required, setRequired] = useState(String(split?.required ?? 10));
  const [pickupTime, setPickupTime] = useState(split?.pickupTime ?? '');
  const [office, setOffice] = useState(split?.office ?? ev.office);
  const [uniform, setUniform] = useState(split?.uniform ?? 'White shirt');
  const [travel, setTravel] = useState(split?.travel ?? TRAVEL[0]);
  const [tags, setTags] = useState<Set<string>>(new Set(split?.tags ?? []));
  const [touched, setTouched] = useState(false);

  const input = (): EV.SplitInput => ({
    role,
    required: Number(required),
    pickupTime: pickupTime || null,
    office,
    uniform,
    travel,
    tags: [...tags],
  });
  const errors = touched ? EV.validateSplit(input()) : {};

  const assigned = split?.assignments.length ?? 0;
  const shrinking = split && Number(required) < assigned;

  const submit = () => {
    setTouched(true);
    if (EV.hasErrors(EV.validateSplit(input()))) return;
    const r = split
      ? EV.updateSplit(ev.id, shiftId, split.id, input())
      : EV.addSplit(ev.id, shiftId, input());
    if (r.ok && r.split) onSaved(r.split, !split);
  };

  return (
    <Modal
      title={split ? 'Edit role group' : 'Add role group'}
      width={560}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit}>
            {split ? 'Save changes' : 'Add role group'}
          </button>
        </>
      }
    >
      <div className="grid gap-3.5">
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Job role</span>
          <select className="field" value={role} onChange={(e) => setRole(e.target.value)}>
            {JOB_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <Err msg={errors.role} />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
              How many needed <span className="text-status-critical">*</span>
            </span>
            <input
              className="field tabular-nums"
              type="number"
              min={1}
              max={500}
              value={required}
              onChange={(e) => setRequired(e.target.value)}
            />
            <Err msg={errors.required} />
          </label>
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
              Pickup time <span className="font-normal text-ink-3">Optional</span>
            </span>
            <input
              className="field"
              type="time"
              value={pickupTime}
              onChange={(e) => setPickupTime(e.target.value)}
            />
            {/* Left blank the row reads "not set", which is honest. The live
                app rendered an unset pickup as 00:00 — a real-looking midnight. */}
            <span className="block text-[11.5px] text-ink-3 mt-1">
              {pickupTime ? 'Shown to workers on the shift.' : 'Shows as “not set”.'}
            </span>
          </label>
        </div>

        {/* Reducing the headcount below the people already on it is allowed,
            but it is a decision, not a typo, so it is named before it is made. */}
        {shrinking ? (
          <div className="well p-3 flex items-start gap-2.5">
            <span className="text-status-at-risk mt-px">
              <Icon name="alert" decorative className="icon-sm" />
            </span>
            <p className="text-[12.5px] text-ink-2 leading-relaxed flex-1">
              {countLabel(assigned, 'worker')} {assigned === 1 ? 'is' : 'are'} already on this group. Saving{' '}
              {required} leaves it over-filled — nobody is removed, and the extra{' '}
              {assigned - Number(required)} will show as over establishment until you unassign them.
            </p>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Uniform</span>
            <input className="field" value={uniform} onChange={(e) => setUniform(e.target.value)} />
          </label>
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Travel</span>
            <select className="field" value={travel} onChange={(e) => setTravel(e.target.value)}>
              {TRAVEL.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Reporting office</span>
          <select className="field" value={office} onChange={(e) => setOffice(e.target.value)}>
            {OFFICES.slice(1).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>

        <div>
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
            Who can work this <span className="font-normal text-ink-3">Optional</span>
          </span>
          <div className="flex flex-wrap gap-1.5">
            {TAGS.map((t) => (
              <button
                key={t.id}
                type="button"
                className="chip"
                aria-pressed={tags.has(t.id)}
                onClick={() =>
                  setTags((s) => {
                    const next = new Set(s);
                    if (next.has(t.id)) next.delete(t.id);
                    else next.add(t.id);
                    return next;
                  })
                }
              >
                {t.label}
              </button>
            ))}
          </div>
          <span className="block text-[11.5px] text-ink-3 mt-1.5">
            {tags.size
              ? 'Only staff holding every selected requirement can be assigned or receive a callout.'
              : 'No requirements — anyone eligible for the event can be assigned.'}
          </span>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------- location -- */

function LocationDialog({
  loc,
  onClose,
  onSaved,
}: {
  loc?: EventLocation;
  onClose: () => void;
  onSaved: (name: string, created: boolean) => void;
}) {
  const ev = useEvent();
  const [name, setName] = useState(loc?.name ?? '');
  const [note, setNote] = useState(loc?.note ?? '');
  const [touched, setTouched] = useState(false);
  const error = touched && !name.trim() ? 'Give the location a name.' : undefined;

  const submit = () => {
    setTouched(true);
    if (!name.trim()) return;
    if (loc) EV.updateLocation(ev.id, loc.id, name, note);
    else EV.addLocation(ev.id, name, note);
    onSaved(name.trim(), !loc);
  };

  return (
    <Modal
      title={loc ? 'Edit location' : 'Add location'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit}>
            {loc ? 'Save changes' : 'Add location'}
          </button>
        </>
      }
    >
      <div className="grid gap-3.5">
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
            Location name <span className="text-status-critical">*</span>
          </span>
          <input
            className="field"
            placeholder="e.g. Gate C — Staff Entrance"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Err msg={error} />
        </label>
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
            Note for workers <span className="font-normal text-ink-3">Optional</span>
          </span>
          <textarea
            className="field"
            rows={3}
            placeholder="Where exactly to report, what to bring, who to ask for."
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <span className="block text-[11.5px] text-ink-3 mt-1">
            Appears on the worker's shift card, so write it for somebody who has never been here.
          </span>
        </label>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------- additional info + note */

function InfoDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const ev = useEvent();
  const [text, setText] = useState(ev.additionalInfo);

  return (
    <Modal
      title="Additional information"
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
              EV.setAdditionalInfo(ev.id, text.trim());
              onSaved();
            }}
          >
            Save
          </button>
        </>
      }
    >
      <label className="block">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
          Sent to every worker with their shift confirmation
        </span>
        <textarea
          className="field"
          rows={7}
          placeholder="Parking, access, what to bring, who to ask for on arrival."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <span className="block text-[11.5px] text-ink-3 mt-1">
          {text.trim().length} characters. Everyone assigned to this event sees this, on every shift.
        </span>
      </label>
    </Modal>
  );
}

function NoteDialog({
  empId,
  splitId,
  onClose,
  onSaved,
}: {
  empId: string;
  splitId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const ev = useEvent();
  const emp = employeeById(empId);
  const existing =
    shiftOf(ev, splitId)
      ?.splits.find((p) => p.id === splitId)
      ?.assignments.find((a) => a.employeeId === empId)?.note ?? '';
  const [note, setNote] = useState(existing);

  return (
    <Modal
      title={`Note · ${emp?.name}`}
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
              EV.setAssignmentNote(ev.id, splitId, empId, note.trim());
              onSaved();
            }}
          >
            Save note
          </button>
        </>
      }
    >
      <label className="block">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
          Internal note on this assignment
        </span>
        <textarea
          className="field"
          rows={4}
          placeholder="e.g. Arriving late — cleared with the client."
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <span className="block text-[11.5px] text-ink-3 mt-1">
          Shown under their name on the staff list. Not sent to the worker.
        </span>
      </label>
    </Modal>
  );
}

/* -------------------------------------------------------- check-in review */

function AdjustCheckInDialog({
  c,
  onClose,
  onApproved,
}: {
  c: CheckIn;
  onClose: () => void;
  onApproved: (hours: number, gross: number) => void;
}) {
  const emp = employeeById(c.employeeId);
  const [actualIn, setActualIn] = useState(c.actualIn ? EV.local(new Date(c.actualIn)) : '');
  const [actualOut, setActualOut] = useState(c.actualOut ? EV.local(new Date(c.actualOut)) : '');

  const hours =
    actualIn && actualOut
      ? Math.round(((+new Date(actualOut) - +new Date(actualIn)) / 3_600_000) * 10) / 10
      : 0;
  const gross = emp ? Math.round((emp.payRate + emp.payUplift) * hours * 100) / 100 : 0;
  const invalid = !!actualIn && !!actualOut && hours <= 0;

  return (
    <Modal
      title={`Adjust and approve · ${emp?.name}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={invalid}
            onClick={() => {
              const r = CHECKINS.approve(c.id, {
                actualIn: actualIn ? new Date(actualIn).toISOString() : null,
                actualOut: actualOut ? new Date(actualOut).toISOString() : null,
              });
              if (r.ok) onApproved(r.hours, gross);
            }}
          >
            Approve {hours} hours
          </button>
        </>
      }
    >
      {c.flag ? (
        <div className="well p-3 mb-3.5 flex items-start gap-2.5">
          <span className="text-status-at-risk mt-px">
            <Icon name="alert" decorative className="icon-sm" />
          </span>
          <p className="text-[12.5px] text-ink-2 leading-relaxed flex-1">
            Flagged: <strong className="text-ink">{c.flag}</strong>. Correct the times to what was actually
            worked — the worker's own submission is kept alongside what you approve.
          </p>
        </div>
      ) : null}

      <div className="grid gap-3 mb-3.5">
        <div className="flex items-center justify-between px-3 py-2.5 rounded-lg bg-surface-raised border border-surface-line-soft">
          <span className="text-[13px] text-ink-2">Scheduled</span>
          <span className="text-[13px] text-ink tabular-nums">
            {fmtTime(c.scheduledIn)}–{fmtTime(c.scheduledOut)}
          </span>
        </div>
        <div className="flex items-center justify-between px-3 py-2.5 rounded-lg bg-surface-raised border border-surface-line-soft">
          <span className="text-[13px] text-ink-2">Worker clocked</span>
          <span className="text-[13px] text-ink tabular-nums">
            {c.actualIn ? fmtTime(c.actualIn) : '—'}–{c.actualOut ? fmtTime(c.actualOut) : '—'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Approve in</span>
          <input
            className="field"
            type="datetime-local"
            value={actualIn}
            onChange={(e) => setActualIn(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Approve out</span>
          <input
            className="field"
            type="datetime-local"
            value={actualOut}
            onChange={(e) => setActualOut(e.target.value)}
          />
        </label>
      </div>

      {/* What the approval costs, before it is made. This is the number the
          approval actually commits EP to, and it was nowhere on the screen. */}
      <div className="well p-3 mt-3.5">
        <div className="flex items-center justify-between">
          <span className="text-[13px] text-ink-2">Payable</span>
          <span className="text-[15px] font-bold text-ink tabular-nums">
            {invalid ? '—' : `${hours} hrs · ${money(gross)} gross`}
          </span>
        </div>
        {invalid ? (
          <p className="text-[12px] text-status-critical mt-1">The out time must be after the in time.</p>
        ) : (
          <p className="text-[12px] text-ink-3 mt-1">
            At {money((emp?.payRate ?? 0) + (emp?.payUplift ?? 0))}/hr including uplift.
          </p>
        )}
      </div>
    </Modal>
  );
}

function RejectCheckInDialog({
  c,
  onClose,
  onRejected,
}: {
  c: CheckIn;
  onClose: () => void;
  onRejected: () => void;
}) {
  const emp = employeeById(c.employeeId);
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const error = touched && !note.trim() ? 'A rejection needs a reason.' : undefined;

  return (
    <Modal
      title={`Reject check-in · ${emp?.name}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              setTouched(true);
              if (!note.trim()) return;
              if (CHECKINS.reject(c.id, note.trim())) onRejected();
            }}
          >
            Reject check-in
          </button>
        </>
      }
    >
      <p className="text-[13.5px] text-ink-2 leading-relaxed mb-3.5">
        No attendance row is written and <strong className="text-ink">no hours are paid</strong> for this
        shift. The reason is recorded against the assignment, so anyone looking at why this worker was not
        paid can see it.
      </p>
      <label className="block">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
          Reason <span className="text-status-critical">*</span>
        </span>
        <textarea
          className="field"
          rows={3}
          placeholder="e.g. Did not attend — cover arranged from the standby list."
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <Err msg={error} />
      </label>
    </Modal>
  );
}

/* ==========================================================================
   CSV EXPORTS
   --------------------------------------------------------------------------
   "Export" fired a toast reading "Exporting the attendance sheet" and produced
   no file. These produce a real one. There is no server, so the file is built
   in the browser and handed to the download manager — which is all the old
   toast was ever claiming to do anyway.
   ========================================================================== */

/** RFC 4180 quoting. A venue called `Gate C, North` breaks a naive join. */
function csv(rows: (string | number)[][]): string {
  return rows
    .map((r) =>
      r
        .map((cell) => {
          const s = String(cell ?? '');
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(','),
    )
    .join('\r\n');
}

function download(filename: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/** Everyone on the event, one row per assignment. Returns the worker count. */
function downloadWhosComing(ev: EpEvent): number {
  const rows: (string | number)[][] = [
    ['Worker', 'Email', 'Phone', 'Office', 'Department', 'Shift', 'Date', 'Start', 'End', 'Role', 'Status', 'Note'],
  ];
  const people = new Set<string>();

  ev.shifts.forEach((sh) =>
    sh.splits.forEach((sp) =>
      sp.assignments.forEach((a) => {
        const emp = employeeById(a.employeeId);
        if (!emp) return;
        people.add(emp.id);
        rows.push([
          emp.name, emp.email, emp.phone, emp.office, emp.department,
          sh.label, fmtDate(sh.start), fmtTime(sh.start) ?? '', fmtTime(sh.end) ?? '',
          sp.role, statusMeta(a.confirmation).label, a.note,
        ]);
      }),
    ),
  );

  download(`${slug(ev.name)}-whos-coming.csv`, csv(rows));
  return people.size;
}

/**
 * The accreditation list: one row per person, not per assignment.
 *
 * Venues want a pass list, and a name appearing four times because somebody
 * works four days is how you get four passes printed for one person.
 */
function downloadAccreditation(ev: EpEvent): number {
  const seen = new Map<string, { name: string; role: string; days: Set<string> }>();

  ev.shifts.forEach((sh) =>
    sh.splits.forEach((sp) =>
      sp.assignments
        .filter((a) => a.confirmation === 'confirmed')
        .forEach((a) => {
          const emp = employeeById(a.employeeId);
          if (!emp) return;
          const e = seen.get(emp.id) || { name: emp.name, role: sp.role, days: new Set<string>() };
          e.days.add(fmtDate(sh.start));
          seen.set(emp.id, e);
        }),
    ),
  );

  const rows: (string | number)[][] = [['Name', 'Role', 'Days on site', 'Dates']];
  [...seen.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((p) => rows.push([p.name, p.role, p.days.size, [...p.days].join('; ')]));

  download(`${slug(ev.name)}-accreditation.csv`, csv(rows));
  return seen.size;
}

function NotifyDialog({
  ids,
  shift,
  onClose,
  onSent,
}: {
  ids: string[];
  shift: Shift;
  onClose: () => void;
  onSent: (message: string) => void;
}) {
  const n = ids.length;
  const [message, setMessage] = useState(
    `Reminder: your shift on ${shift.label} starts at ${fmtTime(shift.start)}. Please confirm you are attending.`,
  );

  return (
    <Modal
      title={`Notify ${countLabel(n, 'worker')}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!message.trim()}
            onClick={() => onSent(message.trim())}
          >
            Send to {n}
          </button>
        </>
      }
    >
      <p className="text-[13.5px] text-ink-2 mb-3.5">
        Goes to the {n} selected {n === 1 ? 'worker' : 'workers'} on <strong>{shift.label}</strong>.
      </p>
      <label className="block mb-3">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Message</span>
        <textarea className="field" rows={4} value={message} onChange={(e) => setMessage(e.target.value)} />
      </label>
      {/* Says what actually happens. There is no SMS gateway behind this, and
          the old copy promised "a push notification and SMS" — a claim the
          operator would only discover was false when nobody turned up. */}
      <p className="text-[12px] text-ink-3 leading-relaxed">
        Recorded against the event and listed in Notifications. Delivery to workers' phones needs the
        messaging service, which is not connected in this build.
      </p>
    </Modal>
  );
}
