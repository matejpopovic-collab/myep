/* ============================================================================
   EVENTS LIST
   ----------------------------------------------------------------------------
   Rebuilt around the staffing gap, which is the whole reason the product
   exists. Previously the ratio was the smallest, bottom-most element on the
   card; here it is the hero, sized and coloured by gap × time-to-event so
   "0 of 416 tomorrow" and "0 of 4 tomorrow" no longer look identical.

   Also fixed here:
     · "In -4 days" / "In -1 days" negative-day maths      -> Live now / Started
     · 00:00 rendered as a real start time                 -> All day
     · Card grid and "New Event" CTA bleeding off-canvas   -> responsive grid
     · No way to sort or filter by understaffed            -> default urgency sort
     · Duplicate "Office: All offices" chip                -> only when filtered
     · Low-contrast range picker labels                    -> neutral grey
     · Unlabelled floating refresh icon                    -> labelled + auto-refresh note
   ========================================================================== */

import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { CoverageBar, EmptyState, PageHeader, SearchField } from '@/components/primitives';
import { TimingPill } from '@/components/wof-ui';
import { ConfirmDestructive, MenuButton, Modal } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { TONE_BG, TONE_HEX } from '@/lib/status';
import { coverageTone, eventCoverage, pct, urgencyScore, type Coverage } from '@/lib/coverage';
import { countLabel, fmtDate, fmtRange, timing } from '@/lib/format';
import { CLIENTS, EMPLOYEES, EVENTS, NOW, OFFICES, client as clientById } from '@/data/db';
import type { EpEvent } from '@/data/types';
import * as EV from '@/lib/events';
import * as NOTIFY from '@/lib/notifications';
import { useEventsVersion } from '@/lib/useStore';

type SortKey = 'urgency' | 'date' | 'gap' | 'name';

function weekStart(v: string | Date): Date {
  const x = new Date(v);
  x.setHours(0, 0, 0, 0);
  const dow = (x.getDay() + 6) % 7; // Monday-first
  x.setDate(x.getDate() - dow);
  return x;
}

/* Group key from LOCAL date parts. toISOString() converts to UTC, which in any
   timezone ahead of UTC (BST, for one) rolled Monday back to Sunday and
   labelled the group "Week of Sun, 26 Jul". */
function weekKey(v: string | Date): string {
  const x = weekStart(v);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

const read = (k: string, fallback: string) => {
  try {
    return localStorage.getItem(k) || fallback;
  } catch {
    return fallback;
  }
};

export default function EventsPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // Coverage is derived from assignments, so anything that touches an
  // assignment anywhere in the product changes the numbers on this page.
  useEventsVersion();

  const [weeks, setWeeks] = useState(() => Number(read('epteam.events.weeks', '4')));
  const [office, setOffice] = useState('All Offices');
  const [sort, setSort] = useState<SortKey>(() => read('epteam.events.sort', 'urgency') as SortKey);
  const [needsStaff, setNeedsStaff] = useState(false);
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [, setTick] = useState(0);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<EpEvent | null>(null);
  const [deleting, setDeleting] = useState<EpEvent | null>(null);

  const clientFilter = params.get('client');

  const from = weekStart(NOW);
  const to = new Date(from);
  to.setDate(to.getDate() + weeks * 7);

  const inWindow = (ev: EpEvent) => new Date(ev.start) < to && new Date(ev.end) >= from;

  const events = EVENTS.filter((ev) => {
    if (!inWindow(ev)) return false;
    if (clientFilter && ev.clientId !== clientFilter) return false;
    if (office !== 'All Offices' && ev.office !== office) return false;
    if (needsStaff && eventCoverage(ev).gap === 0) return false;
    if (query) {
      const c = clientById(ev.clientId);
      if (!`${ev.name} ${c ? c.name : ''}`.toLowerCase().includes(query.toLowerCase())) return false;
    }
    return true;
  });

  const within = (a: EpEvent, b: EpEvent) =>
    sort === 'date'
      ? +new Date(a.start) - +new Date(b.start)
      : sort === 'gap'
        ? eventCoverage(b).gap - eventCoverage(a).gap
        : sort === 'name'
          ? a.name.localeCompare(b.name)
          : urgencyScore(b) - urgencyScore(a);

  // Week grouping still needs chronological groups, so stabilise by week then
  // apply the chosen sort within each week.
  const sorted = events.slice().sort((a, b) => {
    const wa = +weekStart(a.start) - +weekStart(b.start);
    return wa !== 0 ? wa : within(a, b);
  });

  const totals = sorted.reduce(
    (a, ev) => {
      const c = eventCoverage(ev);
      a.required += c.required;
      a.filled += c.filled;
      a.gap += c.gap;
      if (c.gap > 0 && timing(ev.start, ev.end).phase !== 'past') a.eventsWithGap++;
      return a;
    },
    { required: 0, filled: 0, gap: 0, eventsWithGap: 0 },
  );

  const needingStaff = EVENTS.filter((ev) => inWindow(ev) && eventCoverage(ev).gap > 0).length;

  const activeFilters: { k: string; label: string }[] = [];
  // A chip only appears when a NON-DEFAULT filter is on — the live app showed
  // "Office: All offices" permanently, duplicating the dropdown above it.
  if (office !== 'All Offices') activeFilters.push({ k: 'office', label: `Office: ${office}` });
  if (needsStaff) activeFilters.push({ k: 'needsStaff', label: 'Needs staff' });
  if (query) activeFilters.push({ k: 'query', label: `“${query}”` });

  const clearFilter = (k: string) => {
    if (k === 'all' || k === 'office') setOffice('All Offices');
    if (k === 'all' || k === 'needsStaff') setNeedsStaff(false);
    if (k === 'all' || k === 'query') setQuery('');
  };

  /**
   * Make sure the event you just saved is actually on screen.
   *
   * Same rule as the schedules register: being shown an unchanged list after a
   * save is indistinguishable from the save having failed. Here there are four
   * ways to be hidden — a typed filter, an office filter, the "needs staff"
   * chip, and the date window — and a new event trips at least one of them
   * often enough to matter. A brand new event has no shifts, so it has no gap,
   * so "Needs staff" hides it every time.
   *
   * The filters move to the row rather than the row having to satisfy them.
   */
  const reveal = (ev: EpEvent) => {
    setQuery('');
    setNeedsStaff(false);
    if (ev.office !== office) setOffice('All Offices');

    const weeksOut = Math.ceil((+new Date(ev.start) - +weekStart(NOW)) / (7 * 86_400_000));
    if (weeksOut > weeks) {
      const widened = [1, 2, 4, 6, 8].find((w) => w >= weeksOut);
      // Past the widest window there is nothing to widen to, so say so rather
      // than silently leaving the operator looking at a list without their row.
      if (widened) setWeeks(widened);
      else
        toast(
          `${ev.name} is more than eight weeks out — open it directly from the client or the calendar.`,
          { tone: 'info' },
        );
    }
  };

  const groups = new Map<string, EpEvent[]>();
  sorted.forEach((ev) => {
    const k = weekKey(ev.start);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(ev);
  });

  return (
    <>
      <PageHeader
        title="Events"
        subtitle="Every booking in the selected window, ordered by how urgently it needs staff."
        actions={
          <>
            {/* Recomputes the time-relative labels — "in 3 days", "Live now",
                and the urgency sort that depends on them — which drift in a tab
                left open overnight. Coverage itself updates on every mutation
                and never needs asking for. */}
            <button
              type="button"
              className="btn btn-secondary tip"
              data-tip="Recalculates the countdowns. Staffing numbers update on their own."
              disabled={refreshing}
              onClick={() => {
                setRefreshing(true);
                setTick(Date.now());
                window.setTimeout(() => setRefreshing(false), 350);
              }}
            >
              <Icon name="refresh" decorative /> {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              <Icon name="plus" decorative /> New Event
            </button>
          </>
        }
      />

      <SummaryBar totals={totals} count={sorted.length} events={sorted} />

      {/* Controls ------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2.5 mb-5">
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Filter these events…"
          ariaLabel="Filter events by name or client"
          className="w-64"
        />

        <button type="button" className="chip" aria-pressed={needsStaff} onClick={() => setNeedsStaff((n) => !n)}>
          <Icon name="alert" decorative className="icon-sm" />
          Needs staff
          <span className="text-2xs opacity-70">{needingStaff}</span>
        </button>

        <label className="sr-only" htmlFor="office">
          Filter by office
        </label>
        <select className="field w-auto" id="office" value={office} onChange={(e) => setOffice(e.target.value)}>
          {OFFICES.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor="sort">
          Sort events
        </label>
        <select
          className="field w-auto"
          id="sort"
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as SortKey);
            try {
              localStorage.setItem('epteam.events.sort', e.target.value);
            } catch {
              /* private mode */
            }
          }}
        >
          <option value="urgency">Sort: Most urgent first</option>
          <option value="date">Sort: Start date</option>
          <option value="gap">Sort: Largest gap</option>
          <option value="name">Sort: Name A–Z</option>
        </select>

        <div className="flex-1" />

        <div className="segmented" role="group" aria-label="Date range">
          {[1, 2, 4, 6, 8].map((w) => (
            <button
              key={w}
              type="button"
              aria-pressed={weeks === w}
              onClick={() => {
                setWeeks(w);
                try {
                  localStorage.setItem('epteam.events.weeks', String(w));
                } catch {
                  /* private mode */
                }
              }}
            >
              {w} {w === 1 ? 'week' : 'weeks'}
            </button>
          ))}
        </div>
      </div>

      {activeFilters.length ? (
        <div className="flex items-center gap-2 flex-wrap mb-4">
          <span className="text-[12px] text-ink-3">Filtered by</span>
          {activeFilters.map((a) => (
            <button key={a.k} type="button" className="chip" aria-pressed onClick={() => clearFilter(a.k)}>
              {a.label} <Icon name="close" decorative className="icon-sm" />
            </button>
          ))}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => clearFilter('all')}>
            Clear all
          </button>
        </div>
      ) : null}

      {!sorted.length ? (
        <div className="card">
          {/* Two different empty states. "Nothing matches your filters" and
              "there is nothing here at all" need different offers, and showing
              "Clear all filters" to somebody with no events is a dead end. */}
          {EVENTS.length ? (
            <EmptyState
              iconName="events"
              title="No events match these filters"
              body="Try widening the date range, choosing a different office, or clearing the filters above."
              action={
                <button type="button" className="btn btn-secondary" onClick={() => clearFilter('all')}>
                  Clear all filters
                </button>
              }
            />
          ) : (
            <EmptyState
              iconName="events"
              title="No events yet"
              body="Events arrive one of two ways: automatically, when a WOF reaches Order and seeds the calendar, or by hand here for work that never had a WOF."
              action={
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                    <Icon name="plus" decorative /> New event
                  </button>
                  <Link className="btn btn-secondary" to="/schedules">
                    Open the event register
                  </Link>
                </div>
              }
            />
          )}
        </div>
      ) : (
        [...groups.entries()].map(([k, evs]) => (
          <WeekGroup key={k} weekKeyValue={k} events={evs} onDelete={setDeleting} onEdit={setEditing} onReveal={reveal} />
        ))
      )}

      {creating ? (
        <EventDialog
          onClose={() => setCreating(false)}
          onSaved={(ev) => {
            setCreating(false);
            reveal(ev);
            toast(`${ev.name} created. Add a shift to start staffing it.`, {
              tone: 'healthy',
              action: { label: 'Open', onSelect: () => navigate(`/events/${ev.id}`) },
            });
          }}
        />
      ) : null}

      {editing ? (
        <EventDialog
          ev={editing}
          onClose={() => setEditing(null)}
          onSaved={(ev) => {
            setEditing(null);
            reveal(ev);
            toast(`${ev.name} updated.`, { tone: 'healthy' });
          }}
        />
      ) : null}

      {deleting ? (
        <DeleteEvent
          ev={deleting}
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            const ev = deleting;
            setDeleting(null);
            // Snapshot before the delete so Undo has something to put back.
            // A typed confirmation stops the accident; only an undo fixes the
            // one that gets typed anyway.
            const restore = structuredClone(ev);
            EV.removeEvent(ev.id);
            toast(`${ev.name} deleted.`, {
              tone: 'critical',
              action: {
                label: 'Undo',
                onSelect: () => {
                  EV.restoreEvent(restore);
                  toast(`${restore.name} restored.`, { tone: 'healthy' });
                },
              },
            });
          }}
        />
      ) : null}
    </>
  );
}

/* ------------------------------------------------------- summary strip -- */
/* Answers "what is on fire?" before the operator scrolls anything. */

function SummaryBar({
  totals,
  count,
  events,
}: {
  totals: { required: number; filled: number; gap: number };
  count: number;
  events: EpEvent[];
}) {
  const covered = totals.required ? Math.round((totals.filled / totals.required) * 100) : 100;
  const tone = totals.gap === 0 ? 'healthy' : covered < 40 ? 'critical' : covered < 80 ? 'atRisk' : 'healthy';
  const worst = events
    .filter((ev) => timing(ev.start, ev.end).phase !== 'past')
    .sort((a, b) => urgencyScore(b) - urgencyScore(a))[0];

  const cov: Coverage = { required: totals.required, assigned: 0, filled: totals.filled, awaiting: 0, gap: totals.gap };

  return (
    <div className="card p-4 mb-5 flex flex-wrap items-center gap-x-8 gap-y-4">
      <div>
        <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1.5">Roles unfilled</div>
        <div className="flex items-baseline gap-2">
          <span className="text-[30px] font-bold leading-none tabular-nums" style={{ color: TONE_HEX[tone] }}>
            {totals.gap.toLocaleString()}
          </span>
          <span className="text-[13px] text-ink-2">
            of {totals.required.toLocaleString()} across {countLabel(count, 'event')}
          </span>
        </div>
      </div>

      <div className="min-w-[180px] flex-1 max-w-sm">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px] font-bold uppercase tracking-wider text-ink-3">Overall coverage</span>
          <span className="text-[13px] font-semibold tabular-nums" style={{ color: TONE_HEX[tone] }}>
            {covered}%
          </span>
        </div>
        <CoverageBar cov={cov} tone={tone} height={8} />
      </div>

      {worst ? (
        <div className="min-w-[220px]">
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1.5">Needs you first</div>
          <Link
            to={`/events/${worst.id}`}
            className="text-[13.5px] font-semibold text-ink no-underline hover:text-accent hover:underline flex items-center gap-1.5"
          >
            {worst.name}
            <Icon name="chevronRight" decorative className="icon-sm" />
          </Link>
          <div className="text-[12px] text-ink-2 mt-0.5">
            {eventCoverage(worst).gap} unfilled · {timing(worst.start, worst.end).label}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- grouping -- */
/* Week grouping kept — the critique called it the right mental model. */

function WeekGroup({
  weekKeyValue,
  events,
  onDelete,
  onEdit,
  onReveal,
}: {
  weekKeyValue: string;
  events: EpEvent[];
  onDelete: (ev: EpEvent) => void;
  onEdit: (ev: EpEvent) => void;
  onReveal: (ev: EpEvent) => void;
}) {
  // Count only the shifts that actually fall inside this week, so the week
  // header can't claim an 8-day festival's full headcount twice.
  const wkFrom = new Date(weekKeyValue + 'T00:00:00');
  const wkTo = new Date(wkFrom);
  wkTo.setDate(wkTo.getDate() + 7);
  const wk = eventCoverage({
    shifts: events.flatMap((e) => e.shifts).filter((sh) => {
      const s = new Date(sh.start);
      return s >= wkFrom && s < wkTo;
    }),
  } as EpEvent);
  const isThisWeek = weekKeyValue === weekKey(NOW);

  return (
    <section className="mb-7">
      <div className="flex items-center gap-3 mb-3">
        <h2 className="text-[14px] font-bold text-ink flex items-center gap-2">
          <Icon name="calendar" decorative className="icon-sm" />
          Week of {fmtDate(weekKeyValue)}
          {isThisWeek ? (
            <span className="pill" style={{ background: TONE_BG.info, color: TONE_HEX.info }}>
              This week
            </span>
          ) : null}
        </h2>
        <div className="h-px flex-1 bg-surface-line-soft" />
        <span className="text-[12px] text-ink-3 tabular-nums">
          {wk.filled}/{wk.required} filled · {countLabel(events.length, 'event')}
        </span>
      </div>
      <div className="grid gap-3.5 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {events.map((ev) => (
          <EventCard
            key={ev.id}
            ev={ev}
            onDelete={() => onDelete(ev)}
            onEdit={() => onEdit(ev)}
            onReveal={onReveal}
          />
        ))}
      </div>
    </section>
  );
}

function EventCard({
  ev,
  onDelete,
  onEdit,
  onReveal,
}: {
  ev: EpEvent;
  onDelete: () => void;
  onEdit: () => void;
  onReveal: (ev: EpEvent) => void;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const cov = eventCoverage(ev);
  const tone = coverageTone(cov, ev.start, ev.end);
  const t = timing(ev.start, ev.end);
  const client = clientById(ev.clientId);
  const p = pct(cov);

  return (
    <article
      className="card relative group flex flex-col overflow-hidden transition hover:border-surface-line"
      style={{ borderLeft: `3px solid ${TONE_HEX[tone]}` }}
    >
      <Link to={`/events/${ev.id}`} className="absolute inset-0 z-10" aria-label={`Open ${ev.name}`} />

      <div className="p-3.5 pb-3">
        <div className="flex items-start gap-2 mb-2">
          <h3 className="flex-1 text-[14.5px] font-semibold text-ink leading-snug min-w-0">{ev.name}</h3>
          <span className="relative z-20 shrink-0 opacity-60 group-hover:opacity-100">
            <MenuButton
              label={`More actions for ${ev.name}`}
              items={[
                { label: 'Open event', icon: 'externalLink', onSelect: () => navigate(`/events/${ev.id}`) },
                { label: 'Edit event', icon: 'edit', onSelect: onEdit },
                {
                  label: 'Send callout',
                  icon: 'megaphone',
                  // Nothing to advertise on a fully staffed event, and a
                  // callout that reaches workers for zero roles is how an app
                  // teaches people to ignore its notifications.
                  disabled: cov.gap === 0,
                  hint:
                    cov.gap === 0
                      ? 'Fully staffed — there is nothing to advertise'
                      : `Advertise ${countLabel(cov.gap, 'unfilled role')} to available staff`,
                  onSelect: () => {
                    const pool = availablePool(ev);
                    NOTIFY.callout({
                      eventId: ev.id,
                      eventName: ev.name,
                      role: null,
                      gap: cov.gap,
                      audience: 'best-rated first, then everyone',
                      recipients: pool,
                    });
                    toast(
                      `Callout sent for ${countLabel(cov.gap, 'role')} to ${countLabel(pool, 'worker')}.`,
                      { tone: 'healthy' },
                    );
                  },
                },
                {
                  label: 'Copy event',
                  icon: 'copy',
                  hint: 'Copies the shifts and role groups. Staff are not copied across.',
                  onSelect: () => {
                    const r = EV.duplicateEvent(ev.id);
                    if (!r.ok || !r.event) return;
                    const copy = r.event;
                    onReveal(copy);
                    toast(`${copy.name} created — shifts copied, staff not.`, {
                      tone: 'healthy',
                      action: { label: 'Open', onSelect: () => navigate(`/events/${copy.id}`) },
                    });
                  },
                },
                '-',
                { label: 'Delete event', icon: 'trash', danger: true, onSelect: onDelete },
              ]}
            />
          </span>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap mb-2.5">
          <TimingPill
            t={t}
            status={t.phase === 'live' ? 'live' : t.phase === 'past' ? 'complete' : 'upcoming'}
          />
          {ev.requiresAccreditation ? (
            <span
              className="pill tip"
              tabIndex={0}
              data-tip="Workers need accreditation before this event"
              style={{ background: TONE_BG.neutral, color: TONE_HEX.neutral }}
            >
              Accreditation
            </span>
          ) : null}
        </div>

        <div className="text-[12.5px] text-ink-2 leading-relaxed">
          <div className="truncate">{client ? client.name : '—'}</div>
          <div className="text-ink-3">{fmtRange(ev.start, ev.end, ev.allDay)}</div>
        </div>
      </div>

      {/* Staffing gap: the hero of the card, not a footnote ---------------- */}
      <div className="mt-auto px-3.5 pt-3 pb-3.5 border-t border-surface-line-soft bg-black/10">
        <div className="flex items-end justify-between gap-3 mb-2">
          <div>
            <div className="flex items-baseline gap-1">
              <span className="text-[26px] font-bold leading-none tabular-nums" style={{ color: TONE_HEX[tone] }}>
                {cov.filled}
              </span>
              <span className="text-[15px] font-semibold text-ink-3 leading-none tabular-nums">/ {cov.required}</span>
            </div>
            <div
              className="text-[12px] mt-1"
              style={{ color: cov.required === 0 ? TONE_HEX.neutral : cov.gap ? TONE_HEX[tone] : TONE_HEX.healthy }}
            >
              {/* An event with no shifts has nothing to fill, which is not the
                  same as being fully staffed. Reading "Fully staffed" on an
                  event you created thirty seconds ago is the kind of false
                  reassurance that stops someone opening it. */}
              {cov.required === 0 ? (
                'No shifts yet'
              ) : cov.gap ? (
                <>
                  <strong>{cov.gap.toLocaleString()}</strong> {cov.gap === 1 ? 'role' : 'roles'} unfilled
                </>
              ) : (
                'Fully staffed'
              )}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[15px] font-bold tabular-nums" style={{ color: TONE_HEX[tone] }}>
              {p}%
            </div>
            {cov.awaiting ? <div className="text-[11px] text-status-at-risk">{cov.awaiting} unconfirmed</div> : null}
          </div>
        </div>
        <CoverageBar cov={cov} tone={tone} height={6} />
      </div>
    </article>
  );
}

/* Destructive, so it is behind a typed confirmation and states the blast
   radius. In the live app this was a one-click inline button. */
function DeleteEvent({ ev, onClose, onConfirm }: { ev: EpEvent; onClose: () => void; onConfirm: () => void }) {
  const cov = eventCoverage(ev);
  return (
    <ConfirmDestructive
      title={`Delete “${ev.name}”?`}
      confirmLabel="Delete event"
      typeToConfirm={ev.name}
      onClose={onClose}
      onConfirm={onConfirm}
      message={
        <>
          This permanently removes the event, its {countLabel(ev.shifts.length, 'shift')} and{' '}
          <strong>{countLabel(cov.assigned, 'staff assignment')}</strong>.{' '}
          {cov.filled ? (
            <>
              <strong>{cov.filled} workers have already confirmed</strong> and will be notified that their
              shift is cancelled.{' '}
            </>
          ) : null}
          This cannot be undone.
        </>
      }
    />
  );
}

/** Verified, available staff — the realistic reach of a callout. */
function availablePool(ev: EpEvent): number {
  return EMPLOYEES.filter(
    (e) =>
      e.status === 'verified' &&
      e.available &&
      (ev.office === 'EP Event Services' || e.office === ev.office),
  ).length;
}

/* ==========================================================================
   CREATE / EDIT AN EVENT
   --------------------------------------------------------------------------
   One dialog for both, for the same reason the schedules register uses one:
   they are the same seven fields, and a second near-identical form is how the
   two drift apart.

   The form this replaces had no `value` or `onChange` on any input and a submit
   handler that fired a toast. Nothing typed into it was ever read. Every field
   here is controlled, validated on submit, and written through `lib/events.ts`.
   ========================================================================== */

function EventDialog({
  ev,
  onClose,
  onSaved,
}: {
  ev?: EpEvent;
  onClose: () => void;
  onSaved: (ev: EpEvent) => void;
}) {
  const editing = !!ev;
  const defaults = EV.defaultEventTimes();
  const activeClients = CLIENTS.filter((c) => c.status === 'active');

  const [name, setName] = useState(ev?.name ?? '');
  const [clientId, setClientId] = useState(ev?.clientId ?? '');
  const [start, setStart] = useState(ev ? EV.local(new Date(ev.start)) : defaults.start);
  const [end, setEnd] = useState(ev ? EV.local(new Date(ev.end)) : defaults.end);
  const [office, setOffice] = useState(ev?.office ?? OFFICES[1]);
  const [allDay, setAllDay] = useState(ev?.allDay ?? false);
  const [accred, setAccred] = useState(ev?.requiresAccreditation ?? false);
  const [touched, setTouched] = useState(false);

  const input = (): EV.EventInput => ({
    name, clientId, office, start, end, allDay, requiresAccreditation: accred,
  });

  // Silent until they have tried to save, so the form does not shout at
  // somebody three characters into an event name.
  const errors = touched ? EV.validateEvent(input(), ev?.id) : {};

  const submit = () => {
    setTouched(true);
    const e = EV.validateEvent(input(), ev?.id);
    if (EV.hasErrors(e)) return;
    const r = ev ? EV.updateEvent(ev.id, input()) : EV.createEvent(input());
    if (r.ok && r.event) onSaved(r.event);
  };

  const Err = ({ msg }: { msg?: string }) =>
    msg ? <span className="block text-[11.5px] text-status-critical mt-1">{msg}</span> : null;

  return (
    <Modal
      title={editing ? 'Edit event' : 'New event'}
      width={560}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit}>
            {editing ? 'Save changes' : 'Create event'}
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
            placeholder="e.g. Reading Festival 22nd–25th"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Err msg={errors.name} />
        </label>

        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
            Client <span className="text-status-critical">*</span>
          </span>
          <select className="field" value={clientId} onChange={(e) => setClientId(e.target.value)}>
            <option value="">Select a client…</option>
            {[...activeClients]
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
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
              Starts <span className="text-status-critical">*</span>
            </span>
            <input
              className="field"
              type="datetime-local"
              value={start}
              onChange={(e) => {
                setStart(e.target.value);
                // Most events are same-day. Pre-filling the end saves the
                // second date without preventing a multi-day build being
                // typed over it.
                if (!end || new Date(end) <= new Date(e.target.value)) {
                  const d = new Date(e.target.value);
                  d.setHours(19, 0, 0, 0);
                  setEnd(EV.local(d));
                }
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

        <label className="flex items-center gap-2.5">
          <input type="checkbox" checked={accred} onChange={(e) => setAccred(e.target.checked)} />
          <span className="text-[13px] text-ink-2">Requires accreditation</span>
        </label>

        {!editing ? (
          <p className="text-[12px] text-ink-3 leading-relaxed border-t border-surface-line-soft pt-3">
            Created without shifts, so it will show <strong>0 / 0</strong> until you add one. An event
            invented with a shift would report a staffing gap nobody asked for.
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
