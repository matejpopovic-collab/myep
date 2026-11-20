/* ============================================================================
   EVENT SCHEDULES  (reference dataset 3 of 4)
   ----------------------------------------------------------------------------
   Briefing §2.1: "Recurring and one-off events: dates, venues, type, client
   link, WOF trigger rules, lead times."

   This is the register that makes the calendar bidirectional. An entry here
   exists whether or not a WOF has been raised; the trigger rule and lead time
   are what turn "nobody has done the paperwork" into a visible, dated warning
   rather than something Colin has to hold in his head.
   ========================================================================== */

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import {
  Kpi, PageHeader, Pill, Provenance, SearchField, Segmented,
} from '@/components/primitives';
import { DataTable, sortRows, useSort, type Column } from '@/components/DataTable';
import { ConfirmDestructive, MenuButton, Modal } from '@/components/Modal';
import { ClientLink, ManagerChip } from '@/components/wof-ui';
import { useToast } from '@/components/Toast';
import { dayDiff, fmtDate, timing } from '@/lib/format';
import * as WINDOW from '@/lib/wofwindow';
import { TONE_BG } from '@/lib/status';
import { CLIENTS, EVENT_SCHEDULE, JOB_TYPES, MANAGERS, NOW, client as clientById, jobType } from '@/data/db';
import type { EventScheduleEntry } from '@/data/types';
import * as W from '@/lib/wof';
import * as SCHEDULE_STORE from '@/lib/schedules';
import * as SD from '@/lib/standarddocs';
import { useSchedulesVersion, useWofVersion } from '@/lib/useStore';

type Show = 'upcoming' | 'nowof' | 'recurring' | 'all';

/** What the "Recurring" tab counts as recurring. */
const RECURRING = /annual|fortnight|per |fixture|race calendar|weekly|monthly|quarterly/i;

interface Row {
  s: EventScheduleEntry;
  wof: W.Wof | null;
  status: W.CalendarStatus;
  wofDueBy: string;
  overdue: boolean;
  daysToDue: number;
  past: boolean;
}

function enrich(s: EventScheduleEntry): Row {
  const w = (s.wofId ? W.byId(s.wofId) : W.bySchedule(s.id)) || null;
  const wofDueBy = WINDOW.wofDueBy(s);
  return {
    s,
    wof: w,
    status: W.calendarStatus(w),
    wofDueBy,
    overdue: !w && new Date(wofDueBy) < NOW,
    daysToDue: dayDiff(NOW, wofDueBy),
    past: new Date(s.end) < NOW,
  };
}

export default function SchedulesPage() {
  const toast = useToast();
  const navigate = useNavigate();
  useWofVersion();
  useSchedulesVersion();

  const [show, setShow] = useState<Show>('upcoming');
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<EventScheduleEntry | null>(null);
  const [removing, setRemoving] = useState<EventScheduleEntry | null>(null);
  const { sort, toggle } = useSort({ key: 'start', dir: 1 });

  const all = EVENT_SCHEDULE.map(enrich);
  const q = query.trim().toLowerCase();
  const rows = all.filter((r) => {
    if (show === 'upcoming' && r.past) return false;
    if (show === 'nowof' && r.wof) return false;
    if (show === 'recurring' && !RECURRING.test(r.s.recurrence)) return false;
    if (q && !`${r.s.name} ${r.s.venue} ${clientById(r.s.clientId)?.name ?? ''}`.toLowerCase().includes(q))
      return false;
    return true;
  });

  const noWof = all.filter((r) => !r.wof && !r.past);
  const overdue = all.filter((r) => r.overdue && !r.past);
  const dueSoon = all.filter((r) => !r.wof && !r.past && r.daysToDue >= 0 && r.daysToDue <= 14);

  const raise = (scheduleId: string) => {
    const s = EVENT_SCHEDULE.find((x) => x.id === scheduleId)!;
    const w = W.create({
      scheduleId: s.id, title: s.name, clientId: s.clientId, jobTypeId: s.type,
      start: s.start, end: s.end, ownerId: s.ownerId, venue: s.venue,
    });
    SD.attachAllTo(w).then((a) => {
      const m = SD.describe(a);
      if (m) toast(m, { tone: a.expired.length ? 'atRisk' : 'healthy' });
    });
    toast(`${w.ref} raised against ${s.name}. The calendar entry now tracks it.`, { tone: 'healthy' });
    navigate(`/wofs/${w.id}`);
  };

  /**
   * Make sure the row you just saved is actually on screen.
   *
   * Adding a record and being shown an unchanged table is indistinguishable
   * from the save having failed — and it is what happens if you add a past-dated
   * event under "Upcoming", or add anything at all while a filter is typed. So
   * the filters move to the row rather than the row having to satisfy them.
   */
  const reveal = (entry: EventScheduleEntry) => {
    setQuery('');
    if (show === 'nowof' && W.bySchedule(entry.id)) setShow('all');
    else if (new Date(entry.end) < NOW && show !== 'all') setShow('all');
    else if (show === 'recurring' && !RECURRING.test(entry.recurrence)) setShow('all');
  };

  const accessor = (r: Row, k: string) =>
    ({
      name: r.s.name,
      start: +new Date(r.s.start),
      client: clientById(r.s.clientId)?.name,
      due: +new Date(r.wofDueBy),
      status: r.status.id,
    })[k];

  const columns: Column<Row>[] = [
    {
      key: 'name', label: 'Event', sortKey: 'name',
      cell: (r) => (
        <>
          <div className="text-[13.5px] text-ink font-medium">{r.s.name}</div>
          <div className="text-[11.5px] text-ink-3">{r.s.venue}</div>
        </>
      ),
    },
    { key: 'client', label: 'Client', sortKey: 'client', cell: (r) => <ClientLink id={r.s.clientId} /> },
    {
      key: 'type', label: 'Job type', nowrap: true,
      cell: (r) => <span className="text-[12.5px] text-ink-2">{jobType(r.s.type)?.label || r.s.type}</span>,
    },
    {
      key: 'recurrence', label: 'Recurrence', nowrap: true,
      cell: (r) => <span className="text-[12.5px] text-ink-2">{r.s.recurrence}</span>,
    },
    {
      key: 'start', label: 'Next occurrence', sortKey: 'start', nowrap: true,
      cell: (r) => (
        <>
          <div className="text-[13px] text-ink">{fmtDate(r.s.start)}</div>
          <div className="text-[11.5px] text-ink-3">{timing(r.s.start, r.s.end).label}</div>
        </>
      ),
    },
    {
      key: 'due', label: 'Open WOF by', sortKey: 'due', nowrap: true,
      cell: (r) => (
        <>
          <div className={`text-[13px] ${r.overdue ? 'text-status-critical font-semibold' : 'text-ink-2'}`}>
            {fmtDate(r.wofDueBy)}
          </div>
          <div
            className={`text-[11.5px] tip ${!r.wof && !r.overdue && r.daysToDue <= WINDOW.WOF_WARN_DAYS ? 'text-status-at-risk font-medium' : 'text-ink-3'}`}
            tabIndex={0}
            data-tip={WINDOW.dueReason(r.s)}
          >
            {r.wof
              ? 'WOF opened'
              : r.overdue
                ? `${Math.abs(r.daysToDue)} day${Math.abs(r.daysToDue) === 1 ? '' : 's'} overdue`
                : r.daysToDue === 0
                  ? 'Due today'
                  : `${r.daysToDue} day${r.daysToDue === 1 ? '' : 's'} left`}
          </div>
        </>
      ),
    },
    {
      key: 'status', label: 'WOF', sortKey: 'status', nowrap: true,
      cell: (r) => (
        <>
          <Pill status={r.status.id} label={r.status.label} tone={r.status.tone} hint={false} />
          {r.wof ? (
            <div className="text-[11px] mt-0.5">
              <Link to={`/wofs/${r.wof.id}`} className="text-accent no-underline hover:underline font-mono">
                {r.wof.ref}
              </Link>
            </div>
          ) : null}
        </>
      ),
    },
    { key: 'owner', label: 'Manager', nowrap: true, cell: (r) => <ManagerChip id={r.s.ownerId} /> },
    {
      key: 'act', label: '', align: 'right', nowrap: true,
      cell: (r) => (
        <div className="flex items-center justify-end gap-1">
          {r.wof ? (
            <Link className="btn btn-secondary btn-sm" to={`/wofs/${r.wof.id}`}>
              Open WOF
            </Link>
          ) : (
            <button
              type="button"
              className={`btn btn-sm ${r.overdue ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => raise(r.s.id)}
            >
              Raise WOF
            </button>
          )}
          <MenuButton
            label={`More actions for ${r.s.name}`}
            items={[
              { label: 'Edit schedule entry', icon: 'edit', onSelect: () => setEditing(r.s) },
              '-',
              {
                label: 'Remove from register',
                icon: 'trash',
                danger: true,
                // A register entry with a live job on it is the trigger date
                // that job's red row is worked back from. Deleting it would
                // silently remove the nag, so it is disabled rather than
                // offered and then refused.
                disabled: !!r.wof,
                hint: r.wof
                  ? `${r.wof.ref} is raised against this entry — cancel the WOF first`
                  : 'No WOF has been raised against this entry',
                onSelect: () => setRemoving(r.s),
              },
            ]}
          />
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Schedule event"
        subtitle={`Every event managers have scheduled, one-off or recurring. Each one appears on the calendar straight away, and its manager has ${WINDOW.WOF_WINDOW_DAYS} days from scheduling it to open the WOF.`}
        actions={
          <>
            <Link className="btn btn-secondary" to="/calendar">
              <Icon name="calendar" decorative /> Open calendar
            </Link>
            <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
              <Icon name="plus" decorative /> Schedule event
            </button>
          </>
        }
      />

      <div className="flex flex-wrap gap-3 mb-5">
        <Kpi
          label="Scheduled events"
          value={String(all.filter((r) => !r.past).length)}
          sub="Upcoming in the register"
          tone="neutral"
        />
        <Kpi
          label="No WOF raised"
          value={String(noWof.length)}
          sub="Known events with no paperwork"
          tone={noWof.length ? 'atRisk' : 'healthy'}
        />
        <Kpi
          label="WOF overdue"
          value={String(overdue.length)}
          sub="Window closed with no WOF"
          tone={overdue.length ? 'critical' : 'healthy'}
        />
        <Kpi
          label="WOF due within 14 days"
          value={String(dueSoon.length)}
          sub="Raise these next"
          tone={dueSoon.length ? 'info' : 'healthy'}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2.5 mb-5">
        <Segmented<Show>
          ariaLabel="Filter schedules"
          value={show}
          onChange={setShow}
          options={[
            ['upcoming', 'Upcoming'],
            ['nowof', 'No WOF'],
            ['recurring', 'Recurring'],
            ['all', 'Everything'],
          ]}
        />
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Filter by event, venue or client…"
          ariaLabel="Filter schedules"
        />
      </div>

      <DataTable
        columns={columns}
        rows={sortRows(rows, sort.key, sort.dir, accessor)}
        rowKey={(r) => r.s.id}
        sort={sort}
        onSort={toggle}
      />

      <Provenance>
        An event scheduled here has {WINDOW.WOF_WINDOW_DAYS} days to get its WOF opened — less if the event itself
        is sooner. The manager is alerted {WINDOW.WOF_WARN_DAYS} days before the window closes and again if it
        closes with no WOF, and the row and its calendar entry turn red. Events imported before this rule keep
        the lead time they came with.
      </Provenance>

      {adding ? (
        <ScheduleDialog
          onClose={() => setAdding(false)}
          onSaved={(entry) => {
            setAdding(false);
            reveal(entry);
            toast(`${entry.name} scheduled. Open its WOF by ${fmtDate(WINDOW.wofDueBy(entry))}.`, {
              tone: 'healthy',
            });
          }}
        />
      ) : null}

      {editing ? (
        <ScheduleDialog
          entry={editing}
          onClose={() => setEditing(null)}
          onSaved={(entry) => {
            setEditing(null);
            reveal(entry);
            toast(`${entry.name} updated.`, { tone: 'healthy' });
          }}
        />
      ) : null}

      {removing ? (
        <ConfirmDestructive
          title="Remove from the register?"
          confirmLabel="Remove entry"
          typeToConfirm={removing.name}
          message={
            <>
              <strong className="text-ink">{removing.name}</strong> leaves the register and the calendar.
              Nobody will be alerted to open its WOF, because there will be no window left to close. No WOF
              is raised against it, so no job is affected.
            </>
          }
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            const name = removing.name;
            SCHEDULE_STORE.removeSchedule(removing.id);
            toast(`${name} removed from the register.`, { tone: 'info' });
          }}
        />
      ) : null}
    </>
  );
}

/* ==========================================================================
   ADD / EDIT A SCHEDULE ENTRY
   --------------------------------------------------------------------------
   One dialog for both, because they are the same nine fields and a second
   near-identical form is how the two drift apart.

   The lead time gets a live preview of the date it produces. A number of days
   is not a thing anyone can hold against a calendar in their head — "60" is
   meaningless, "trigger lands Tue, 16 Jun" is the fact the operator is actually
   deciding on, and it is the number this whole screen is built to enforce.
   ========================================================================== */

/** `YYYY-MM-DDTHH:mm` for a datetime-local input, in local time, no timezone. */
function toLocalInput(v: string): string {
  return v ? v.slice(0, 16) : '';
}

const RECURRENCE_SUGGESTIONS = [
  'One-off', 'Annual', 'Fixture list', 'Race calendar', 'Per show night',
  'Fortnightly — season', 'Weekly', 'Monthly',
];

function ScheduleDialog({
  entry,
  onClose,
  onSaved,
}: {
  entry?: EventScheduleEntry;
  onClose: () => void;
  onSaved: (entry: EventScheduleEntry) => void;
}) {
  const editingExisting = !!entry;

  const [name, setName] = useState(entry?.name ?? '');
  const [clientId, setClientId] = useState(entry?.clientId ?? '');
  const [venue, setVenue] = useState(entry?.venue ?? '');
  const [type, setType] = useState(entry?.type ?? JOB_TYPES[0].id);
  const [recurrence, setRecurrence] = useState(entry?.recurrence ?? 'One-off');
  const [start, setStart] = useState(toLocalInput(entry?.start ?? ''));
  const [end, setEnd] = useState(toLocalInput(entry?.end ?? ''));
  const [ownerId, setOwnerId] = useState(entry?.ownerId ?? MANAGERS[0].id);
  const [touched, setTouched] = useState(false);

  const input = (): SCHEDULE_STORE.ScheduleInput => ({
    name, clientId, venue, type, recurrence, start, end,
    ownerId,
  });

  // Silent until they have tried to save, so the form does not shout at
  // somebody who has typed three characters of an event name.
  const errors = touched ? SCHEDULE_STORE.validateInput(input(), entry?.id) : {};

  // What the 30-day window means for THIS event, shown as the dates are typed.
  // An existing entry keeps its own clock (or its imported lead time); a new
  // one starts counting today.
  const preview = start
    ? WINDOW.wofDueBy({
        start,
        leadDays: entry?.leadDays ?? WINDOW.WOF_WINDOW_DAYS,
        createdAt: entry ? entry.createdAt : NOW.toISOString(),
      })
    : null;
  const previewPassed = preview ? new Date(preview) < NOW : false;
  const managerName = MANAGERS.find((m) => m.id === ownerId)?.name ?? 'The manager';

  const submit = () => {
    setTouched(true);
    const e = SCHEDULE_STORE.validateInput(input(), entry?.id);
    if (SCHEDULE_STORE.hasErrors(e)) return;
    const r = entry
      ? SCHEDULE_STORE.updateSchedule(entry.id, input())
      : SCHEDULE_STORE.createSchedule(input());
    if (r.ok && r.entry) onSaved(r.entry);
  };

  const Err = ({ msg }: { msg?: string }) =>
    msg ? <span className="block text-[11.5px] text-status-critical mt-1">{msg}</span> : null;

  return (
    <Modal
      title={editingExisting ? 'Edit scheduled event' : 'Schedule event'}
      width={620}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit}>
            {editingExisting ? 'Save changes' : 'Schedule event'}
          </button>
        </>
      }
    >
      <div className="grid gap-3.5">
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
            Event name <span className="text-status-critical">*</span>
          </span>
          <input
            className="field"
            placeholder="e.g. Goodwood Revival"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Err msg={errors.name} />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
              Client <span className="text-status-critical">*</span>
            </span>
            <select className="field" value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">Select a client…</option>
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

          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Job type</span>
            <select className="field" value={type} onChange={(e) => setType(e.target.value)}>
              {JOB_TYPES.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
            Venue <span className="text-status-critical">*</span>
          </span>
          <input
            className="field"
            placeholder="Where the job actually happens"
            value={venue}
            onChange={(e) => setVenue(e.target.value)}
          />
          <Err msg={errors.venue} />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
              Starts <span className="text-status-critical">*</span>
            </span>
            <input
              className="field"
              type="datetime-local"
              value={start}
              onChange={(e) => {
                setStart(e.target.value);
                // Almost every entry in the register is same-day or next-day.
                // Prefilling the end saves the second date without preventing
                // a multi-day build being typed over it.
                if (!end || (entry === undefined && new Date(end) < new Date(e.target.value)))
                  setEnd(e.target.value);
              }}
            />
            <Err msg={errors.start} />
          </label>

          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
              Ends <span className="text-status-critical">*</span>
            </span>
            <input
              className="field"
              type="datetime-local"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
            <Err msg={errors.end} />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Recurrence</span>
            <input
              className="field"
              list="recurrence-suggestions"
              placeholder="One-off"
              value={recurrence}
              onChange={(e) => setRecurrence(e.target.value)}
            />
            <datalist id="recurrence-suggestions">
              {RECURRENCE_SUGGESTIONS.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </label>

          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Manager</span>
            <select className="field" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              {MANAGERS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* No lead time to type: the window is the rule. This says what it
            means for this event, and who will be chased. */}
        {/* Only once there is a date to talk about — before that it is just
            the rule restated, and the rule is always the same. */}
        {preview ? (
        <div
          className="well p-3 flex items-start gap-2.5"
          style={previewPassed ? { background: TONE_BG.critical } : undefined}
        >
          <Icon name="bell" decorative className="icon-sm mt-0.5 shrink-0 text-ink-3" />
          <p className="text-[12.5px] text-ink-2 leading-relaxed">
            {previewPassed ? (
              <>
                The WOF was due by <strong className="text-ink">{fmtDate(preview)}</strong> and is now overdue —
                this will show red until one is opened.
              </>
            ) : (
              <>
                <strong className="text-ink">{managerName}</strong> has until{' '}
                <strong className="text-ink">{fmtDate(preview)}</strong> to open the WOF
                {editingExisting && !entry?.createdAt
                  ? ` (the ${entry?.leadDays}-day lead time this event was imported with).`
                  : ` — ${WINDOW.WOF_WINDOW_DAYS} days from scheduling, or the event day if that is sooner.`}{' '}
                They are alerted {WINDOW.WOF_WARN_DAYS} days before, and again if it passes.
              </>
            )}
          </p>
        </div>
        ) : null}
      </div>
    </Modal>
  );
}
