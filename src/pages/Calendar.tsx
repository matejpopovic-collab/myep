/* ============================================================================
   EVENT CALENDAR — bidirectional with the WOF
   ----------------------------------------------------------------------------
   Briefing §2.3 and §3. The two requirements that make this screen different
   from an ordinary calendar:

     1. "Events appear before a WOF exists." The calendar is driven by the EVENT
        SCHEDULES reference dataset, not by WOFs. A known recurring event is on
        here whether or not anyone has raised paperwork — and if the lead time
        on its trigger rule has passed with no WOF, it is flagged.

     2. "When a WOF is raised and progresses, the calendar entry updates
        automatically." Status is derived from the WOF stage, never stored
        twice: no WOF / in progress / quote sent / confirmed / complete.

   Filterable by manager, per the briefing.

   AND ONE MORE, ADDED LATER
   -------------------------
   The calendar is the only work-order-shaped screen a warehouse role keeps, so
   it is also the screen where a withheld capability could be handed back by
   accident. Everything on here that is really the WORK ORDER — its status, its
   reference, its documents, its value, the link that opens it and the button
   that raises one — is behind `wof.view`. What is left without it is the thing
   the warehouse actually came for: what is on, where, and when. `showWof` is
   threaded down rather than re-asked per component so there is one answer per
   render and the month, the list and the day dialog cannot disagree.
   ========================================================================== */

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import {
  CoverageBar, EmptyState, Kpi, PageHeader, Pill, Provenance, SearchField, Segmented,
} from '@/components/primitives';
import { DataTable, type Column } from '@/components/DataTable';
import { ClientLink, DocChip, ManagerChip } from '@/components/wof-ui';
import { Modal } from '@/components/Modal';
import { TONE_BG, TONE_HEX, TONE_LINE } from '@/lib/status';
import { countLabel, dayDiff, fmtDate, fmtDateFull, fmtRange, money, timing } from '@/lib/format';
import { coverageTone } from '@/lib/coverage';
import { MANAGERS, NOW, client as clientById, jobType, schedule as scheduleById } from '@/data/db';
import type { EventScheduleEntry, Tone } from '@/data/types';
import * as ROLES from '@/lib/roles';
import * as W from '@/lib/wof';
import { useRolesVersion, useSchedulesVersion, useWofVersion } from '@/lib/useStore';

type View = 'month' | 'list';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const LEGEND: [string, Tone, string][] = [
  ['No WOF', 'critical', 'A known event with no paperwork raised. The calendar shows it anyway — that is the point.'],
  ['In progress', 'atRisk', 'A WOF exists and is being worked up. Not yet priced or sent.'],
  ['Quote sent', 'info', 'Priced and with the client. Awaiting a digital signature.'],
  ['Confirmed', 'healthy', 'Signed and ordered. Shifts now exist in the staffing tool.'],
  ['Complete', 'neutral', 'Delivered and invoiced.'],
];

export default function CalendarPage() {
  const navigate = useNavigate();
  useWofVersion();
  // The register drives this screen, so a new entry has to redraw the month.
  useSchedulesVersion();
  // …and switching who you are acting as has to redraw it too, or the screen
  // keeps the last person's permissions until something else happens to change.
  useRolesVersion();

  const showWof = ROLES.can('wof.view');

  const [view, setView] = useState<View>(() => {
    try {
      return (localStorage.getItem('eprosta.cal.view') as View) || 'month';
    } catch {
      return 'month';
    }
  });
  // Opens on the month you are actually in. This was pinned to August 2026,
  // which was fine while the clock was frozen there and wrong the moment it
  // became real: the calendar opened on a grid a month adrift of its own data.
  const [month, setMonth] = useState(() => new Date(NOW.getFullYear(), NOW.getMonth(), 1));
  const [owner, setOwner] = useState('all');
  const [status, setStatus] = useState('all');
  const [query, setQuery] = useState('');
  const [raising, setRaising] = useState<EventScheduleEntry | null>(null);
  const [day, setDay] = useState<{ day: Date; events: W.CalendarRow[] } | null>(null);

  const q = query.trim().toLowerCase();
  const rows = W.calendarRows().filter((r) => {
    if (owner !== 'all' && r.ownerId !== owner) return false;
    if (status !== 'all' && r.status.id !== status) return false;
    if (q) {
      const c = clientById(r.clientId);
      if (!`${r.name} ${c ? c.name : ''} ${r.venue}`.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const noWof = rows.filter((r) => !r.wof);
  const overdue = rows.filter((r) => r.wofOverdue);
  const confirmed = rows.filter((r) => r.status.id === 'confirmed');
  const confirmedValue = confirmed.reduce((s, r) => s + (r.value || 0), 0);
  // The "when" summary for a role that gets no pipeline figures: an event is in
  // the next week if it starts within seven days or is already running.
  const soon = rows.filter((r) => dayDiff(NOW, r.end) >= 0 && dayDiff(NOW, r.start) <= 7);

  const openRaise = (scheduleId: string | null) => {
    const s = scheduleId ? scheduleById(scheduleId) : null;
    if (s) setRaising(s);
  };

  return (
    <>
      <PageHeader
        title="Event calendar"
        subtitle={
          showWof
            ? 'Every known event, whether or not a WOF exists for it. Status comes from the WOF, so this view and the pipeline can never disagree.'
            : 'Every known event, with its dates and venue. The work order behind a job is the office\u2019s screen; this one answers what is on and when.'
        }
        actions={
          <>
            {ROLES.can('schedules.view') ? (
              <Link className="btn btn-secondary" to="/schedules">
                <Icon name="settings" decorative /> Event schedules
              </Link>
            ) : null}
            {showWof ? (
              <button type="button" className="btn btn-primary" onClick={() => navigate('/wofs')}>
                <Icon name="plus" decorative /> Raise WOF
              </button>
            ) : null}
          </>
        }
      />

      <div className="flex flex-wrap gap-3 mb-5">
        {showWof ? (
          <>
              <Kpi
                label="Events with no WOF"
                value={String(noWof.length)}
                sub={overdue.length ? `${overdue.length} past their trigger lead time` : 'All within lead time'}
                tone={overdue.length ? 'critical' : noWof.length ? 'atRisk' : 'healthy'}
              />
              <Kpi
                label="Confirmed"
                value={String(confirmed.length)}
                sub={`${money(confirmedValue, { compact: true })} of confirmed work`}
                tone="healthy"
              />
              <Kpi
                label="Awaiting signature"
                value={String(rows.filter((r) => r.status.id === 'quote-sent').length)}
                sub="Quoted, not yet signed"
                tone="info"
              />
              <Kpi label="On the calendar" value={String(rows.length)} sub="Scheduled events in the register" tone="neutral" />
          </>
        ) : (
          <>
            <Kpi label="On the calendar" value={String(rows.length)} sub="Scheduled events in the register" tone="neutral" />
            <Kpi
              label="On in the next 7 days"
              value={String(soon.length)}
              sub="Running now or starting within a week"
              tone={soon.length ? 'info' : 'neutral'}
            />
          </>
        )}
      </div>

      {showWof && overdue.length ? (
        <div className="card p-3.5 mb-5" style={{ background: TONE_BG.critical, borderColor: TONE_LINE.critical }}>
          <div className="flex items-start gap-2.5">
            <span style={{ color: TONE_HEX.critical, marginTop: 1 }}>
              <Icon name="alert" decorative />
            </span>
            <div className="flex-1">
              <div className="text-[13px] font-semibold text-ink mb-1">
                {overdue.length} event{overdue.length > 1 ? 's have' : ' has'} passed the lead time on its
                trigger rule with no WOF raised
              </div>
              <div className="text-[13px] text-ink-2 leading-relaxed">
                {overdue.map((r, i) => (
                  <span key={r.scheduleId ?? i}>
                    {i ? ' · ' : ''}
                    <button
                      type="button"
                      className="text-accent no-underline hover:underline bg-transparent border-0 p-0 cursor-pointer font-inherit"
                      onClick={() => openRaise(r.scheduleId)}
                    >
                      {r.name}
                    </button>{' '}
                    <span className="text-ink-3">
                      ({fmtDate(r.start)}, WOF was due {r.wofDueBy ? fmtDate(r.wofDueBy) : '—'})
                    </span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2.5 mb-5">
        <SearchField value={query} onChange={setQuery} placeholder="Filter events…" ariaLabel="Filter calendar" />

        <label className="sr-only" htmlFor="owner">
          Filter by manager
        </label>
        <select className="field w-auto" id="owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="all">All managers</option>
          {MANAGERS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>

        {showWof ? (
          <>
            <label className="sr-only" htmlFor="status">
              Filter by WOF status
            </label>
            <select className="field w-auto" id="status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="all">All statuses</option>
              {[
                ['no-wof', 'No WOF'],
                ['in-progress', 'In progress'],
                ['quote-sent', 'Quote sent'],
                ['confirmed', 'Confirmed'],
                ['complete', 'Complete'],
              ].map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </>
        ) : null}

        <div className="flex-1" />

        {view === 'month' ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="btn-icon"
              aria-label="Previous month"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
            >
              <Icon name="chevronLeft" decorative />
            </button>
            <span className="text-[13.5px] font-semibold text-ink w-32 text-center">
              {MONTH_NAMES[month.getMonth()]} {month.getFullYear()}
            </span>
            <button
              type="button"
              className="btn-icon"
              aria-label="Next month"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
            >
              <Icon name="chevronRight" decorative />
            </button>
          </div>
        ) : null}

        <Segmented<View>
          ariaLabel="Calendar view"
          value={view}
          onChange={(v) => {
            setView(v);
            try {
              localStorage.setItem('eprosta.cal.view', v);
            } catch {
              /* private mode */
            }
          }}
          options={[
            ['month', 'Month'],
            ['list', 'List'],
          ]}
        />
      </div>

      {view === 'month' ? (
        <MonthView
          rows={rows}
          month={month}
          showWof={showWof}
          onRaise={openRaise}
          onDay={(day, events) => setDay({ day, events })}
        />
      ) : (
        <ListView rows={rows} showWof={showWof} onRaise={openRaise} />
      )}

      <div className="card p-4 mt-5">
        {/* No status colour on the chips means no status legend: a key to a
            scale that is not on the screen is worse than no key. Build and
            break days stay for everyone — that is a "when", and it is the
            difference between a van loaded on the right morning and the wrong
            one. */}
        {showWof ? (
          <>
            <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2.5">Status legend</div>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {LEGEND.map(([l, t, hint]) => (
                <span key={l} className="inline-flex items-center gap-2 tip" tabIndex={0} data-tip={hint}>
                  <Pill label={l} tone={t} hint={false} />
                </span>
              ))}
            </div>
          </>
        ) : null}

        {/* Phase sits under status rather than beside it: they are two
            different questions about the same chip, and one row of eight
            reads as one scale with eight steps. */}
        <div
          className={`text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2.5 ${showWof ? 'mt-4' : ''}`}
        >
          Build &amp; break days
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-[12px] text-ink-2">
          <span className="inline-flex items-center gap-2">
            <span
              className="rounded px-1.5 py-0.5 text-[11px]"
              style={{ background: TONE_BG.healthy, color: TONE_HEX.healthy }}
            >
              Event day
            </span>
            <span className="text-ink-3">Filled — the event itself.</span>
          </span>
          <span className="inline-flex items-center gap-2">
            <span
              className="rounded px-1.5 py-0.5 text-[11px]"
              style={{
                color: TONE_HEX.healthy,
                boxShadow: `inset 0 0 0 1px ${TONE_LINE.healthy}`,
              }}
            >
              ▲ Build day
            </span>
            <span className="text-ink-3">Outlined — before the event.</span>
          </span>
          <span className="inline-flex items-center gap-2">
            <span
              className="rounded px-1.5 py-0.5 text-[11px]"
              style={{
                color: TONE_HEX.healthy,
                boxShadow: `inset 0 0 0 1px ${TONE_LINE.healthy}`,
              }}
            >
              ▼ Break day
            </span>
            <span className="text-ink-3">Outlined — breaking down after.</span>
          </span>
          <span className="text-ink-3">
            {showWof
              ? 'Set on the WOF. A job with no build or break days is all event days.'
              : 'Set by the office. A job with no build or break days is all event days.'}
          </span>
        </div>
      </div>

      {raising ? <RaiseDialog s={raising} onClose={() => setRaising(null)} /> : null}
      {day ? (
        <DayDialog
          day={day.day}
          events={day.events}
          showWof={showWof}
          onClose={() => setDay(null)}
          onRaise={(id) => {
            setDay(null);
            openRaise(id);
          }}
        />
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------- day kind --
   A job's span is not all the same kind of day. A festival sold 4 -> 10 Sep is
   two build days, four event days and one breakdown day, and a calendar that
   paints all seven the same is the reason an operator books a crew for a day
   nobody is on site.

   Phase is drawn as a TEXTURE, not a colour. Colour on this screen already
   means WOF status and has a legend saying so; a second colour system on the
   same chip would leave a green build day and a green event day arguing about
   which green means what. So the status tone still fills the chip and the
   phase changes its edge: event days solid, build and break days hollowed out
   and marked, which also reads on a greyscale print and to anyone who does not
   separate the tones. ------------------------------------------------------ */

const PHASE_MARK: Record<W.DayKind, string> = { build: '▲', event: '', break: '▼' };
const PHASE_WORD: Record<W.DayKind, string> = {
  build: 'Build day',
  event: 'Event day',
  break: 'Break day',
};

/** The chip for one job on one day, phase included. */
function DayChip({
  row,
  kind,
  showWof,
  onRaise,
}: {
  row: W.CalendarRow;
  kind: W.DayKind | null;
  showWof: boolean;
  onRaise: (scheduleId: string | null) => void;
}) {
  // Colour on this chip means WOF status. Without the capability there is no
  // status to mean, so the chip goes neutral rather than keeping a colour whose
  // key has been taken off the screen.
  const tone = showWof ? row.status.tone : 'neutral';
  const off = kind === 'build' || kind === 'break';

  // A build or break day keeps the status colour but loses the fill, so the
  // event days of a run are the ones that read as solid blocks at a glance.
  const style = off
    ? {
        background: 'transparent',
        color: TONE_HEX[tone],
        boxShadow: `inset 0 0 0 1px ${TONE_LINE[tone]}`,
      }
    : { background: TONE_BG[tone], color: TONE_HEX[tone] };

  const tip = showWof
    ? `${row.name} — ${row.status.label}` +
      (kind ? ` · ${PHASE_WORD[kind]}` : '') +
      (row.wof ? '' : '. Click to raise a WOF.')
    : `${row.name}${kind ? ` · ${PHASE_WORD[kind]}` : ''}${row.venue ? ` · ${row.venue}` : ''}`;

  const body = (
    <>
      {kind && PHASE_MARK[kind] ? (
        <span aria-hidden="true" className="mr-1 opacity-70">
          {PHASE_MARK[kind]}
        </span>
      ) : null}
      {row.name}
      {/* The mark is decorative, so the words carry the meaning for a screen
          reader rather than a triangle it would read as punctuation. */}
      {off ? <span className="sr-only"> — {PHASE_WORD[kind!]}</span> : null}
    </>
  );

  const cls = 'block w-full text-left no-underline rounded px-1.5 py-1 text-[11px] leading-tight truncate tip';

  // Nothing to open and nothing to raise: the chip is a label, not a control,
  // and rendering it as one keeps it out of the tab order instead of offering a
  // click that would bounce off the route guard.
  if (!showWof) {
    return (
      <span className={cls} tabIndex={0} data-tip={tip} style={style}>
        {body}
      </span>
    );
  }

  return row.wof ? (
    <Link to={`/wofs/${row.wof.id}`} className={cls} tabIndex={0} data-tip={tip} style={style}>
      {body}
    </Link>
  ) : (
    <button
      type="button"
      className={`${cls} border-0 cursor-pointer`}
      data-tip={tip}
      style={style}
      onClick={() => onRaise(row.scheduleId)}
    >
      {body}
    </button>
  );
}

/* ---------------------------------------------------------- month view -- */

function MonthView({
  rows,
  month,
  showWof,
  onRaise,
  onDay,
}: {
  rows: W.CalendarRow[];
  month: Date;
  showWof: boolean;
  onRaise: (scheduleId: string | null) => void;
  onDay: (day: Date, events: W.CalendarRow[]) => void;
}) {
  const y = month.getFullYear();
  const m = month.getMonth();
  const first = new Date(y, m, 1);
  const startOffset = (first.getDay() + 6) % 7; // Monday-first
  const gridStart = new Date(y, m, 1 - startOffset);

  const cells = Array.from({ length: 42 }, (_, i) => {
    const day = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const dayEnd = new Date(day);
    dayEnd.setHours(23, 59, 59);
    return {
      day,
      inMonth: day.getMonth() === m,
      events: rows.filter((r) => new Date(r.start) <= dayEnd && new Date(r.end) >= day),
      isToday: dayDiff(day, NOW) === 0,
    };
  });

  return (
    <div className="card overflow-hidden">
      <div className="grid grid-cols-7 border-b border-surface-line">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div key={d} className="px-2 py-2 text-[11px] font-bold uppercase tracking-wider text-ink-3 text-center">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((c, i) => (
          <div
            key={i}
            className={`min-h-[104px] p-1.5 border-b border-r border-surface-line-soft ${
              i % 7 === 6 ? 'border-r-0' : ''
            } ${c.inMonth ? '' : 'opacity-40'}`}
            style={c.isToday ? { background: 'var(--accent-soft)' } : undefined}
          >
            <div className={`text-[11.5px] font-semibold mb-1 ${c.isToday ? 'text-accent' : 'text-ink-3'}`}>
              {c.day.getDate()}
              {c.isToday ? ' · today' : ''}
            </div>
            <div className="space-y-1">
              {c.events.slice(0, 3).map((r, j) => (
                <DayChip
                  key={j}
                  row={r}
                  // Only a raised WOF knows its build and break days. A schedule
                  // entry with no paperwork has dates and nothing else, and
                  // guessing a build day for it would be inventing one.
                  kind={r.wof ? W.dayKindOn(r.wof, c.day) : null}
                  showWof={showWof}
                  onRaise={onRaise}
                />
              ))}
              {c.events.length > 3 ? (
                <button
                  type="button"
                  className="text-[10.5px] text-ink-3 px-1.5 hover:text-accent hover:underline bg-transparent border-0 cursor-pointer w-full text-left"
                  onClick={() => onDay(c.day, c.events)}
                >
                  +{c.events.length - 3} more
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- list view -- */

function ListView({
  rows,
  showWof,
  onRaise,
}: {
  rows: W.CalendarRow[];
  showWof: boolean;
  onRaise: (id: string | null) => void;
}) {
  if (!rows.length) {
    return (
      <div className="card">
        <EmptyState
          iconName="calendar"
          title="Nothing on the calendar"
          body="No events match the current filters."
        />
      </div>
    );
  }

  const columns: Column<W.CalendarRow>[] = [
    {
      key: 'date', label: 'Date', nowrap: true,
      cell: (r) => (
        <>
          <div className="text-[13px] text-ink">{fmtDate(r.start)}</div>
          <div className="text-[11.5px] text-ink-3">{timing(r.start, r.end).label}</div>
        </>
      ),
    },
    {
      key: 'name', label: 'Event',
      cell: (r) => (
        <>
          <div className="text-[13.5px] text-ink font-medium">{r.name}</div>
          <div className="text-[11.5px] text-ink-3">{r.venue || ''}</div>
        </>
      ),
    },
    { key: 'client', label: 'Client', cell: (r) => <ClientLink id={r.clientId} /> },
    ...(!showWof ? [] : [{
      key: 'status', label: 'WOF status', nowrap: true,
      cell: (r) => (
        <>
          <Pill status={r.status.id} label={r.status.label} tone={r.status.tone} hint={false} />
          {r.wof ? <div className="text-[11px] text-ink-3 mt-0.5 font-mono">{r.wof.ref}</div> : null}
          {r.wofOverdue && r.wofDueBy ? (
            <div className="text-[11px] mt-0.5" style={{ color: TONE_HEX.critical }}>
              WOF was due {fmtDate(r.wofDueBy)}
            </div>
          ) : null}
        </>
      ),
    } as Column<W.CalendarRow>]),
    {
      key: 'staffing', label: 'Staffing', nowrap: true,
      cell: (r) => {
        if (!r.coverage)
          return (
            <span className="text-[12.5px] text-ink-3">
              {r.wof && W.atLeast(r.wof, 'order') ? 'No shifts' : '—'}
            </span>
          );
        const tone = coverageTone(r.coverage, r.start, r.end);
        return (
          <div className="w-28">
            <div className="flex items-baseline justify-between text-[11.5px] mb-1">
              <span className="tabular-nums font-semibold text-ink-2">
                {r.coverage.filled}/{r.coverage.required}
              </span>
              {r.coverage.gap ? <span style={{ color: TONE_HEX[tone] }}>{r.coverage.gap} short</span> : null}
            </div>
            <CoverageBar cov={r.coverage} tone={tone} height={5} />
          </div>
        );
      },
    },
    ...(!showWof ? [] : [{
      key: 'docs', label: 'Documents', nowrap: true,
      cell: (r) => (r.wof ? <DocChip wof={r.wof} /> : <span className="text-[12.5px] text-ink-3">—</span>),
    } as Column<W.CalendarRow>]),
    { key: 'owner', label: 'Manager', nowrap: true, cell: (r) => <ManagerChip id={r.ownerId} /> },
    // Value, the WOF reference, the document chip and the raise button are the
    // work order showing through the calendar. Withheld together, because
    // leaving any one of them turns "no access to the pipeline" into "no access
    // to the pipeline page".
    ...(!showWof ? [] : [{
      key: 'value', label: 'Value', align: 'right', nowrap: true,
      cell: (r) =>
        r.value != null ? (
          <span className="tabular-nums text-ink">{money(r.value, { pence: false })}</span>
        ) : (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onRaise(r.scheduleId)}>
            Raise WOF
          </button>
        ),
    } as Column<W.CalendarRow>]),
  ];

  return (
    <>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r, i) => r.scheduleId || r.wof?.id || String(i)}
        rowHref={
          showWof ? (r) => (r.wof ? `/wofs/${r.wof.id}` : `/schedules?id=${r.scheduleId}`) : undefined
        }
        footer={
          showWof
            ? {
                name: `${rows.length} event${rows.length === 1 ? '' : 's'}`,
                value: money(rows.reduce((s, r) => s + (r.value || 0), 0), { pence: false }),
              }
            : { name: `${rows.length} event${rows.length === 1 ? '' : 's'}` }
        }
      />
      <Provenance>
        Rows come from the Event schedules reference dataset. A row with no WOF is not an error — it is a
        known event waiting for paperwork, and the lead time on its trigger rule is what turns it red.
      </Provenance>
    </>
  );
}

/* ------------------------------------------------------------- day view -- */

/**
 * Everything on one date.
 *
 * A month cell fits three rows; on a festival week it was hiding the rest
 * behind "+2 more" that could not be opened. A count you cannot expand is worse
 * than no count — it tells you something is there and then refuses to say what.
 */
function DayDialog({
  day,
  events,
  showWof,
  onClose,
  onRaise,
}: {
  day: Date;
  events: W.CalendarRow[];
  showWof: boolean;
  onClose: () => void;
  onRaise: (scheduleId: string | null) => void;
}) {
  return (
    <Modal title={fmtDateFull(day)} width={560} onClose={onClose}>
      <p className="text-[12.5px] text-ink-3 mb-3">
        {countLabel(events.length, 'event')} on this date, running or in build.
      </p>
      <div className="grid gap-1.5">
        {events.map((r, i) => {
          // Named in full here rather than marked, because this dialog has the
          // room the month cell does not.
          const kind = r.wof ? W.dayKindOn(r.wof, day) : null;
          const body = (
            <>
              <span className="flex-1 min-w-0">
                <span className="block text-[13.5px] text-ink truncate">{r.name}</span>
                <span className="block text-[11.5px] text-ink-3 truncate">
                  {clientById(r.clientId)?.name ?? ''}
                  {r.venue ? ` · ${r.venue}` : ''}
                </span>
                <span className="block text-[11.5px] text-ink-3">
                  {kind ? `${PHASE_WORD[kind]} · ` : ''}
                  {fmtRange(r.start, r.end)}
                </span>
              </span>
              <span className="shrink-0 flex flex-col items-end gap-1">
                {showWof ? (
                  <Pill status={r.status.id} label={r.status.label} tone={r.status.tone} hint={false} />
                ) : null}
                {r.coverage && r.coverage.required > 0 ? (
                  <span className="text-[11.5px] text-ink-3 tabular-nums">
                    {r.coverage.filled}/{r.coverage.required} staffed
                  </span>
                ) : null}
              </span>
            </>
          );

          const cls =
            'flex items-start gap-3 px-3 py-2.5 rounded-lg bg-surface-raised border border-surface-line-soft no-underline hover:border-surface-line text-left w-full';

          if (!showWof) {
            return (
              <div key={i} className={cls}>
                {body}
              </div>
            );
          }

          return r.wof ? (
            <Link key={i} to={`/wofs/${r.wof.id}`} className={cls} onClick={onClose}>
              {body}
            </Link>
          ) : (
            <button key={i} type="button" className={cls} onClick={() => onRaise(r.scheduleId)}>
              {body}
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

/* -------------------------------------------------- raise from calendar -- */

function RaiseDialog({ s, onClose }: { s: EventScheduleEntry; onClose: () => void }) {
  const navigate = useNavigate();
  const jt = jobType(s.type);

  const kv = (k: string, v: string) => (
    <div className="flex items-baseline justify-between gap-4 py-1.5 border-b border-surface-line-soft last:border-0">
      <span className="text-[12.5px] text-ink-3">{k}</span>
      <span className="text-[13px] text-ink-2 text-right">{v}</span>
    </div>
  );

  return (
    <Modal
      title={`Raise a WOF for ${s.name}`}
      width={520}
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
              const w = W.create({
                scheduleId: s.id, title: s.name, clientId: s.clientId, jobTypeId: s.type,
                start: s.start, end: s.end, ownerId: s.ownerId, venue: s.venue,
              });
              onClose();
              navigate(`/wofs/${w.id}`);
            }}
          >
            Raise WOF
          </button>
        </>
      }
    >
      <p className="text-[13.5px] text-ink-2 leading-relaxed mb-4">
        This event is already on the calendar from the schedules register. Raising a WOF links the two: from
        now on the calendar entry takes its status from the WOF.
      </p>
      <div className="space-y-1 mb-4">
        {kv('Client', clientById(s.clientId)?.name || '—')}
        {kv('Venue', s.venue)}
        {kv('Dates', fmtRange(s.start, s.end))}
        {kv('Recurrence', s.recurrence)}
        {kv('Trigger rule', s.triggerRule)}
        {kv('Job type', jt?.label || s.type)}
      </div>
      <p className="text-[12.5px] text-ink-3 leading-relaxed">
        A document checklist of {jt?.docs.length ?? 0} items will be created from the job type, with due
        dates worked back from the event date.
      </p>
    </Modal>
  );
}
