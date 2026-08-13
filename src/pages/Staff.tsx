/* ============================================================================
   STAFF
   ----------------------------------------------------------------------------
   The old page's subtitle promised "search, status, tags, office, department,
   worked shift date and strikes" and then shipped none of them. All seven now
   exist as a real filter bar.

   Also fixed:
     · rows ~92px tall with 56px avatars      -> ~44px rows, 32px avatars (20+ visible)
     · unlabelled 4-star rating on every row  -> numeric value + accessible sentence
     · green check vs red flag, colour only   -> labelled status pills (WCAG 1.4.1)
     · two identical "Search employees…" boxes-> one, and it filters this list
     · email + phone on every row             -> moved to the detail panel
     · "Notify Filtered Staff", filtered by what? -> "Notify 47 staff" + live chips
     · no headers, no sort, no count, no pages-> all four
   ========================================================================== */

import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { Avatar, EmptyState, PageHeader, Pill, Rating, TagPill } from '@/components/primitives';
import { BandPill, FlagMarker, RatingBreakdown, RatingCriteria } from '@/components/rating';
import { MenuButton, Modal } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { TONE_BG, TONE_HEX, TONE_LINE, statusMeta } from '@/lib/status';
import { countLabel, fmtDate } from '@/lib/format';
import {
  ATTENDANCE, DEPARTMENTS, EMPLOYEES, EVENTS, NOW, OFFICES, TAGS,
  employee as employeeById, tag as tagById,
} from '@/data/db';
import type { Employee, Tone } from '@/data/types';
import * as RATING from '@/lib/rating';
import * as FLAGS from '@/lib/flags';
import { useFlagVersion } from '@/lib/useStore';

const PER_PAGE = 20;
type SortKey = 'name' | 'office' | 'department' | 'rating' | 'shiftsWorked' | 'strikes';

interface UpcomingShift {
  evId: string;
  evName: string;
  shiftLabel: string;
  role: string;
  start: string;
}

function upcomingFor(emp: Employee): UpcomingShift[] {
  const out: UpcomingShift[] = [];
  EVENTS.forEach((ev) =>
    ev.shifts.forEach((sh) =>
      sh.splits.forEach((sp) => {
        if (sp.assignments.some((a) => a.employeeId === emp.id) && new Date(sh.start) >= NOW) {
          out.push({ evId: ev.id, evName: ev.name, shiftLabel: sh.label, role: sp.role, start: sh.start });
        }
      }),
    ),
  );
  return out;
}

export default function StaffPage() {
  const toast = useToast();
  useFlagVersion();
  const [params, setParams] = useSearchParams();

  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const [office, setOffice] = useState('All Offices');
  const [department, setDepartment] = useState('all');
  const [strikes, setStrikes] = useState('all');
  const [band, setBand] = useState('all');
  const [workedSince, setWorkedSince] = useState('');
  const [tags, setTags] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [profile, setProfile] = useState<Employee | null>(null);
  const [ratingFor, setRatingFor] = useState<Employee | null>(null);
  const [criteria, setCriteria] = useState(false);
  const [flagging, setFlagging] = useState<Employee | null>(null);
  const [clearingFlag, setClearingFlag] = useState<Employee | null>(null);
  const [notifying, setNotifying] = useState(false);

  // Deep link from anywhere in the app: /staff?id=e-6 opens the panel.
  const deepId = params.get('id');
  useEffect(() => {
    if (!deepId) return;
    const emp = employeeById(deepId);
    if (emp) setProfile(emp);
    setParams({}, { replace: true });
  }, [deepId, setParams]);

  const rows = EMPLOYEES.filter((e) => {
    if (q && !`${e.name} ${e.email}`.toLowerCase().includes(q.toLowerCase())) return false;
    if (status !== 'all' && e.status !== status) return false;
    if (office !== 'All Offices' && e.office !== office) return false;
    if (department !== 'all' && e.department !== department) return false;
    if (strikes === '0' && e.strikes !== 0) return false;
    if (strikes === '1+' && e.strikes < 1) return false;
    if (strikes === '3+' && e.strikes < 3) return false;
    if (band !== 'all' && RATING.score(e).band.id !== band) return false;
    if (tags.size && ![...tags].every((t) => e.tags.includes(t))) return false;
    if (workedSince) {
      // Approximated from recent attendance so the filter is real, not decorative.
      if (!ATTENDANCE.some((a) => a.employeeId === e.id && a.date >= workedSince)) return false;
    }
    return true;
  }).sort((a, b) => {
    const va = a[sort.key];
    const vb = b[sort.key];
    const r = typeof va === 'string' ? va.localeCompare(String(vb)) : (va as number) - (vb as number);
    return r * sort.dir;
  });

  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  const current = Math.min(page, pages);
  const pageRows = rows.slice((current - 1) * PER_PAGE, current * PER_PAGE);

  const activeCount =
    (q ? 1 : 0) +
    (status !== 'all' ? 1 : 0) +
    (office !== 'All Offices' ? 1 : 0) +
    (department !== 'all' ? 1 : 0) +
    (strikes !== 'all' ? 1 : 0) +
    (band !== 'all' ? 1 : 0) +
    (workedSince ? 1 : 0) +
    tags.size;

  const clearFilters = () => {
    setQ('');
    setStatus('all');
    setOffice('All Offices');
    setDepartment('all');
    setStrikes('all');
    setBand('all');
    setWorkedSince('');
    setTags(new Set());
    setPage(1);
  };

  const toggleSort = (k: SortKey) =>
    setSort((s) => (s.key === k ? { key: k, dir: (-s.dir as 1 | -1) } : { key: k, dir: 1 }));

  const th = (key: SortKey, label: string) => {
    const on = sort.key === key;
    return (
      <th
        className="is-sortable"
        aria-sort={on ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
        tabIndex={0}
        role="button"
        onClick={() => toggleSort(key)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleSort(key);
          }
        }}
      >
        <span className="inline-flex items-center gap-1">
          {label}
          {on ? <Icon name={sort.dir === 1 ? 'chevronUp' : 'chevronDown'} decorative className="icon-sm" /> : null}
        </span>
      </th>
    );
  };

  const notifyCount = selected.size || rows.length;

  return (
    <>
      <PageHeader
        title="Staff"
        subtitle="Search and filter the workforce by status, requirements, office, department, recent shifts, strikes and rating band."
        actions={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setCriteria(true)}>
              <Icon name="star" decorative /> How ratings are earned
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => toast(`Exporting ${countLabel(rows.length, 'row')} to CSV.`, { tone: 'healthy' })}
            >
              <Icon name="download" decorative /> Export
            </button>
            {/* Says exactly who it will reach, and how that number was reached. */}
            <button type="button" className="btn btn-primary" disabled={!rows.length} onClick={() => setNotifying(true)}>
              <Icon name="bell" decorative /> Notify {notifyCount} staff
            </button>
          </>
        }
      />

      <StatsRow
        onQuickStatus={(s) => {
          setStatus(s);
          setPage(1);
        }}
        onQuickBand={(b) => {
          setBand(b);
          setPage(1);
        }}
      />

      {/* Filter bar: the seven filters the subtitle always promised -------- */}
      <div className="card p-3.5 mb-4">
        <div className="flex flex-wrap items-end gap-2.5">
          <div className="relative flex-1 min-w-[200px] max-w-xs">
            <label className="block text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1.5" htmlFor="q">
              Search
            </label>
            <span className="absolute left-3 bottom-2 text-ink-3 pointer-events-none">
              <Icon name="search" decorative className="icon-sm" />
            </span>
            <input
              className="field pl-8"
              id="q"
              type="search"
              value={q}
              placeholder="Name or email…"
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
          </div>

          <Select
            id="status"
            label="Status"
            value={status}
            onChange={setStatus}
            options={[
              ['all', 'Any status'],
              ['verified', 'Verified'],
              ['flagged', 'Flagged'],
              ['pending', 'Pending'],
            ]}
          />
          <Select id="office" label="Office" value={office} onChange={setOffice} options={OFFICES.map((o) => [o, o])} />
          <Select
            id="department"
            label="Department"
            value={department}
            onChange={setDepartment}
            options={[['all', 'Any department'], ...DEPARTMENTS.map((d) => [d, d] as [string, string])]}
          />
          <Select
            id="strikes"
            label="Strikes"
            value={strikes}
            onChange={setStrikes}
            options={[
              ['all', 'Any'],
              ['0', 'None'],
              ['1+', '1 or more'],
              ['3+', '3 or more'],
            ]}
          />
          <Select
            id="band"
            label="Rating band"
            value={band}
            onChange={setBand}
            options={[
              ['all', 'Any band'],
              ...RATING.BANDS.map((b) => [b.id, b.label] as [string, string]),
              ['new', 'New — no record yet'],
            ]}
          />

          <div>
            <label
              className="block text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1.5"
              htmlFor="workedSince"
            >
              Worked since
            </label>
            <input
              className="field w-auto"
              id="workedSince"
              type="date"
              value={workedSince}
              onChange={(e) => {
                setWorkedSince(e.target.value);
                setPage(1);
              }}
            />
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap mt-3 pt-3 border-t border-surface-line-soft">
          <span className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mr-1">Requirements</span>
          {TAGS.map((t) => (
            <button
              key={t.id}
              type="button"
              className="chip"
              aria-pressed={tags.has(t.id)}
              onClick={() => {
                setTags((s) => {
                  const next = new Set(s);
                  if (next.has(t.id)) next.delete(t.id);
                  else next.add(t.id);
                  return next;
                });
                setPage(1);
              }}
            >
              {t.label}
            </button>
          ))}
          {activeCount ? (
            <button type="button" className="btn btn-ghost btn-sm ml-auto" onClick={clearFilters}>
              <Icon name="close" decorative className="icon-sm" /> Clear {activeCount} filters
            </button>
          ) : null}
        </div>
      </div>

      <section className="card">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-surface-line-soft">
          <span className="text-[13px] text-ink-2">
            <strong className="text-ink">{rows.length.toLocaleString()}</strong> of{' '}
            {EMPLOYEES.length.toLocaleString()} staff
            {selected.size ? (
              <>
                {' · '}
                <span className="text-accent font-semibold">{selected.size} selected</span>
              </>
            ) : null}
          </span>
          {selected.size ? (
            <div className="flex items-center gap-2">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setNotifying(true)}>
                Notify {selected.size}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>
                Clear selection
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
                        aria-label="Select all staff on this page"
                        checked={pageRows.length > 0 && pageRows.every((r) => selected.has(r.id))}
                        onChange={(e) =>
                          setSelected((s) => {
                            const next = new Set(s);
                            pageRows.forEach((r) => (e.target.checked ? next.add(r.id) : next.delete(r.id)));
                            return next;
                          })
                        }
                      />
                    </th>
                    {th('name', 'Name')}
                    {th('office', 'Office')}
                    {th('department', 'Department')}
                    {th('rating', 'Rating')}
                    {th('shiftsWorked', 'Shifts')}
                    {th('strikes', 'Strikes')}
                    <th>Status</th>
                    <th>Requirements</th>
                    <th style={{ width: 52 }}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((e) => (
                    <Row
                      key={e.id}
                      e={e}
                      selected={selected.has(e.id)}
                      onSelect={(on) =>
                        setSelected((s) => {
                          const next = new Set(s);
                          if (on) next.add(e.id);
                          else next.delete(e.id);
                          return next;
                        })
                      }
                      onProfile={() => setProfile(e)}
                      onFlag={() => setFlagging(e)}
                      onClearFlag={() => setClearingFlag(e)}
                      onMessage={() => toast(`Message sent to ${e.name}.`, { tone: 'healthy' })}
                      onEdit={() => toast(`Editing ${e.name}.`)}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-surface-line-soft">
              <span className="text-[12.5px] text-ink-3">
                Showing {(current - 1) * PER_PAGE + 1}–{Math.min(current * PER_PAGE, rows.length)} of{' '}
                {rows.length.toLocaleString()}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="btn-icon"
                  disabled={current === 1}
                  aria-label="Previous page"
                  onClick={() => setPage(current - 1)}
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
                  onClick={() => setPage(current + 1)}
                >
                  <Icon name="chevronRight" decorative />
                </button>
              </div>
            </div>
          </>
        ) : (
          <EmptyState
            iconName="staff"
            title="No staff match these filters"
            body="Try removing a requirement or widening the office and department filters."
            action={
              <button type="button" className="btn btn-secondary" onClick={clearFilters}>
                Clear all filters
              </button>
            }
          />
        )}
      </section>

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

      {profile ? (
        <Profile
          e={profile}
          onClose={() => setProfile(null)}
          onRating={() => {
            setRatingFor(profile);
            setProfile(null);
          }}
          onClearFlag={() => {
            setClearingFlag(profile);
            setProfile(null);
          }}
          onMessage={() => {
            const name = profile.name;
            setProfile(null);
            toast(`Message sent to ${name}.`, { tone: 'healthy' });
          }}
        />
      ) : null}

      {ratingFor ? (
        <Modal
          title={`${ratingFor.name} · rating`}
          width={560}
          onClose={() => setRatingFor(null)}
          footer={
            <>
              <button type="button" className="btn btn-secondary" data-close onClick={() => setRatingFor(null)}>
                Close
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setRatingFor(null);
                  setCriteria(true);
                }}
              >
                How ratings are earned
              </button>
            </>
          }
        >
          <RatingBreakdown emp={ratingFor} />
        </Modal>
      ) : null}

      {flagging ? <FlagWorker emp={flagging} onClose={() => setFlagging(null)} /> : null}
      {clearingFlag ? <ClearFlag emp={clearingFlag} onClose={() => setClearingFlag(null)} /> : null}

      {notifying ? (
        <NotifyDialog
          count={notifyCount}
          usingSelection={selected.size > 0}
          chips={[
            ...(status !== 'all' ? [statusMeta(status).label] : []),
            ...(office !== 'All Offices' ? [office] : []),
            ...(department !== 'all' ? [department] : []),
            ...(strikes !== 'all' ? [`${strikes} strikes`] : []),
            ...[...tags].map((t) => tagById(t)?.label || t),
            ...(q ? [`“${q}”`] : []),
          ]}
          onClose={() => setNotifying(false)}
          onSend={() => {
            setNotifying(false);
            toast(`Message sent to ${countLabel(notifyCount, 'worker')}.`, { tone: 'healthy' });
          }}
        />
      ) : null}
    </>
  );
}

function Select({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <div>
      <label className="block text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1.5" htmlFor={id}>
        {label}
      </label>
      <select className="field w-auto" id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

function StatsRow({
  onQuickStatus,
  onQuickBand,
}: {
  onQuickStatus: (s: string) => void;
  onQuickBand: (b: string) => void;
}) {
  const verifiedless = EMPLOYEES.filter((e) => e.status === 'flagged').length;
  const pending = EMPLOYEES.filter((e) => e.status === 'pending').length;
  const avail = EMPLOYEES.filter((e) => e.available).length;
  // Trusted is the number worth watching: it is the pool that gets first
  // refusal on every callout, so it is the health of the reward scheme.
  const trusted = EMPLOYEES.filter((e) => RATING.score(e).band.id === 'trusted').length;

  const cards: { label: string; value: number; tone: Tone; onClick?: () => void }[] = [
    { label: 'Total staff', value: EMPLOYEES.length, tone: 'info' },
    { label: 'Available', value: avail, tone: 'healthy' },
    { label: 'Trusted band', value: trusted, tone: 'healthy', onClick: () => onQuickBand('trusted') },
    { label: 'Flagged', value: verifiedless, tone: 'critical', onClick: () => onQuickStatus('flagged') },
    { label: 'Pending checks', value: pending, tone: 'atRisk', onClick: () => onQuickStatus('pending') },
  ];

  return (
    <div className="grid gap-3 grid-cols-2 lg:grid-cols-5 mb-4">
      {cards.map((c) => {
        const body = (
          <>
            <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1.5">{c.label}</div>
            <div className="text-[24px] font-bold leading-none tabular-nums" style={{ color: TONE_HEX[c.tone] }}>
              {c.value}
            </div>
          </>
        );
        return c.onClick ? (
          <button
            key={c.label}
            type="button"
            className="card p-3.5 text-left hover:border-surface-line transition"
            onClick={c.onClick}
          >
            {body}
          </button>
        ) : (
          <div key={c.label} className="card p-3.5 text-left">
            {body}
          </div>
        );
      })}
    </div>
  );
}

/* Dense: name, office, department, rating, shifts, strikes, status, tags.
   Email and phone are PII noise in a scanning list — they live in the panel. */
function Row({
  e, selected, onSelect, onProfile, onFlag, onClearFlag, onMessage, onEdit,
}: {
  e: Employee;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onProfile: () => void;
  onFlag: () => void;
  onClearFlag: () => void;
  onMessage: () => void;
  onEdit: () => void;
}) {
  return (
    <tr className={selected ? 'is-selected' : undefined}>
      <td>
        <input
          type="checkbox"
          checked={selected}
          aria-label={`Select ${e.name}`}
          onChange={(ev) => onSelect(ev.target.checked)}
        />
      </td>
      <td>
        <button type="button" className="flex items-center gap-2.5 text-left group" onClick={onProfile}>
          <Avatar hue={e.hue} initials={e.initials} size={30} />
          <span className="text-[13.5px] text-ink group-hover:text-accent">{e.name}</span>
          {!e.available ? (
            <span className="pill" style={{ background: TONE_BG.neutral, color: TONE_HEX.neutral }}>
              Unavailable
            </span>
          ) : null}
        </button>
      </td>
      <td className="text-ink-2 text-[13px] whitespace-nowrap">{e.office}</td>
      <td className="text-ink-2 text-[13px] whitespace-nowrap">{e.department}</td>
      {/* Band next to the stars, because the stars are the input and the band
          is what actually changes what happens to this worker. */}
      <td>
        <div className="flex items-center gap-2">
          <Rating emp={e} />
          <BandPill emp={e} />
        </div>
      </td>
      <td className="tabular-nums text-ink-2 text-[13px]">{e.shiftsWorked}</td>
      <td>
        {e.strikes ? (
          <span
            className="pill"
            style={{
              background: TONE_BG[e.strikes >= 3 ? 'critical' : 'atRisk'],
              color: TONE_HEX[e.strikes >= 3 ? 'critical' : 'atRisk'],
            }}
          >
            {e.strikes}
          </span>
        ) : (
          <span className="text-ink-3 text-[13px]">0</span>
        )}
      </td>
      {/* A flag is the one status that stops somebody earning, so it does not
          hide behind a pill that reads the same as every other state. The
          marker carries the reason, who raised it and when. */}
      <td>
        <div className="flex flex-col gap-1 items-start">
          <Pill status={e.status} />
          <FlagMarker emp={e} />
        </div>
      </td>
      <td>
        <div className="flex gap-1 flex-wrap max-w-[190px]">
          {e.tags.slice(0, 2).map((t) => (
            <TagPill key={t} tagId={t} />
          ))}
          {e.tags.length > 2 ? (
            <span
              className="pill tip"
              tabIndex={0}
              data-tip={e.tags.slice(2).map((t) => tagById(t)?.label).join(', ')}
              style={{ background: TONE_BG.neutral, color: TONE_HEX.neutral }}
            >
              +{e.tags.length - 2}
            </span>
          ) : null}
          {!e.tags.length ? <span className="text-ink-3 text-[13px]">—</span> : null}
        </div>
      </td>
      <td>
        <MenuButton
          label={`Actions for ${e.name}`}
          items={[
            { label: 'View profile', icon: 'staff', onSelect: onProfile },
            { label: 'Send message', icon: 'bell', onSelect: onMessage },
            { label: 'Edit details', icon: 'edit', onSelect: onEdit },
            '-',
            {
              label: e.status === 'flagged' ? 'Clear flag' : 'Flag worker',
              icon: 'flag',
              danger: e.status !== 'flagged',
              hint:
                e.status === 'flagged' && e.flag
                  ? `Currently flagged: ${FLAGS.reason(e.flag.reasonId).label}`
                  : 'Stops them being assigned or applying until it is cleared',
              onSelect: e.status === 'flagged' ? onClearFlag : onFlag,
            },
          ]}
        />
      </td>
    </tr>
  );
}

/* --------------------------------------------------------------- profile -- */
/* Where email, phone and the rest of the PII now lives, out of the list. */

function Profile({
  e,
  onClose,
  onRating,
  onClearFlag,
  onMessage,
}: {
  e: Employee;
  onClose: () => void;
  onRating: () => void;
  onClearFlag: () => void;
  onMessage: () => void;
}) {
  const upcoming = upcomingFor(e);
  const history = ATTENDANCE.filter((a) => a.employeeId === e.id);
  const s = RATING.score(e);

  const field = (label: string, value: React.ReactNode) => (
    <div>
      <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1">{label}</div>
      <div className="text-[13.5px] text-ink">{value}</div>
    </div>
  );

  return (
    <Modal
      title={e.name}
      width={620}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn btn-primary" onClick={onMessage}>
            Send message
          </button>
        </>
      }
    >
      <div className="flex items-center gap-3.5 pb-4 mb-4 border-b border-surface-line-soft">
        <Avatar hue={e.hue} initials={e.initials} size={52} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <Pill status={e.status} />
            {e.available ? <Pill status="active" label="Available" /> : <Pill status="inactive" label="Unavailable" />}
            <FlagMarker emp={e} />
          </div>
          <div className="text-[12.5px] text-ink-2">
            {e.office} · {e.department}
          </div>
        </div>
        <div className="text-right">
          <Rating emp={e} />
          <div className="mt-1">
            <BandPill emp={e} />
          </div>
        </div>
      </div>

      {e.flag ? (
        <div className="well p-3 mb-4" style={{ borderColor: TONE_LINE.critical, background: TONE_BG.critical }}>
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
            <button type="button" className="btn btn-secondary btn-sm shrink-0" onClick={onClearFlag}>
              Clear flag
            </button>
          </div>
        </div>
      ) : null}

      {/* The score, and what it is buying this worker. An operator who can see
          the working can defend the queue order to the person in it. */}
      <button
        type="button"
        className="well p-3 mb-5 w-full text-left hover:border-surface-line transition"
        onClick={onRating}
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

      <div className="grid grid-cols-2 gap-x-5 gap-y-3 mb-5">
        {field(
          'Email',
          <a href={`mailto:${e.email}`} className="text-accent no-underline hover:underline">
            {e.email}
          </a>,
        )}
        {field('Phone', e.phone)}
        {field('Shifts worked', String(e.shiftsWorked))}
        {field(
          'Strikes',
          e.strikes ? (
            <span style={{ color: TONE_HEX[e.strikes >= 3 ? 'critical' : 'atRisk'] }}>{e.strikes}</span>
          ) : (
            '0'
          ),
        )}
      </div>

      <div className="mb-5">
        <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2">Requirements held</div>
        <div className="flex flex-wrap gap-1.5">
          {e.tags.length ? (
            e.tags.map((t) => <TagPill key={t} tagId={t} />)
          ) : (
            <span className="text-[13px] text-ink-3 italic">None recorded</span>
          )}
        </div>
      </div>

      <div className="mb-5">
        <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2">
          Upcoming shifts · {upcoming.length}
        </div>
        {upcoming.length ? (
          <div className="grid gap-1.5">
            {upcoming.slice(0, 5).map((u, i) => (
              <Link
                key={i}
                to={`/events/${u.evId}`}
                className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-surface-raised border border-surface-line-soft no-underline hover:border-surface-line"
                onClick={onClose}
              >
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] text-ink truncate">{u.evName}</span>
                  <span className="block text-[11.5px] text-ink-3">
                    {u.shiftLabel} · {u.role}
                  </span>
                </span>
                <span className="text-[11.5px] text-ink-3">{fmtDate(u.start)}</span>
              </Link>
            ))}
          </div>
        ) : (
          <div className="text-[13px] text-ink-3 italic">No upcoming shifts.</div>
        )}
      </div>

      <div>
        <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2">
          Recent attendance · {history.length}
        </div>
        {history.length ? (
          <div className="grid gap-1.5">
            {history.slice(0, 5).map((h) => (
              <div
                key={h.id}
                className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-surface-raised border border-surface-line-soft"
              >
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] text-ink">{h.role}</span>
                  <span className="block text-[11.5px] text-ink-3">
                    {fmtDate(h.date)} · {h.actual}
                  </span>
                </span>
                <Pill status={h.outcome} />
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[13px] text-ink-3 italic">No attendance recorded.</div>
        )}
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------- flagging -- */
/**
 * Flagging is not a label, it is a stop. The dialog therefore leads with what
 * it will actually do — take them out of the assign list and block them
 * applying — and names the upcoming shifts they are already booked on, since
 * those do not cancel themselves and somebody has to go and refill them.
 */
function FlagWorker({ emp, onClose }: { emp: Employee; onClose: () => void }) {
  const toast = useToast();
  const [reasonId, setReasonId] = useState(FLAGS.REASONS[0].id);
  const [note, setNote] = useState('');
  const upcoming = upcomingFor(emp);

  return (
    <Modal
      title={`Flag ${emp.name}`}
      width={500}
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
              FLAGS.set(emp.id, { reasonId, note });
              onClose();
              toast(
                `${emp.name} flagged — ${FLAGS.reason(reasonId).label.toLowerCase()}. They will not appear in the assign list.`,
                { tone: 'critical' },
              );
            }}
          >
            Flag worker
          </button>
        </>
      }
    >
      <p className="text-[13.5px] text-ink-2 leading-relaxed mb-4">
        A flag removes {emp.name.split(' ')[0]} from the manual assign list and blocks them applying for open
        jobs. It does not change their rating — that is earned from attendance and nothing typed here moves
        it.
      </p>

      {upcoming.length ? (
        <div className="well p-3 mb-4" style={{ borderColor: TONE_LINE.atRisk }}>
          <div className="text-[12.5px] font-semibold text-ink mb-1">
            Already booked on {countLabel(upcoming.length, 'upcoming shift')}
          </div>
          <ul className="text-[12.5px] text-ink-2 leading-relaxed space-y-0.5">
            {upcoming.slice(0, 3).map((u, i) => (
              <li key={i}>
                · {u.evName} — {u.role}, {fmtDate(u.start)}
              </li>
            ))}
            {upcoming.length > 3 ? <li>· and {upcoming.length - 3} more</li> : null}
          </ul>
          <p className="text-[12px] text-ink-3 mt-1.5">
            Flagging does not remove them from these. Take them off the shift separately if that is what you
            mean to do.
          </p>
        </div>
      ) : null}

      <label className="block mb-3">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Reason</span>
        <select className="field" value={reasonId} onChange={(e) => setReasonId(e.target.value)}>
          {FLAGS.REASONS.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
        <span className="block text-[12px] text-ink-3 mt-1.5">{FLAGS.reason(reasonId).blurb}</span>
      </label>

      <label className="block">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
          What happened? <span className="font-normal text-ink-3">Recorded against the flag</span>
        </span>
        <textarea
          className="field"
          rows={3}
          placeholder="Dates, the event, who reported it — enough that somebody else can pick this up."
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
    </Modal>
  );
}

function ClearFlag({ emp, onClose }: { emp: Employee; onClose: () => void }) {
  const toast = useToast();
  const previous = emp.flag ? emp.preFlagStatus || 'verified' : 'verified';

  return (
    <Modal
      title={`Clear the flag on ${emp.name}`}
      width={460}
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
              FLAGS.clear(emp.id);
              onClose();
              toast(
                `Flag cleared. ${emp.name} is back in the assign list as ${statusMeta(emp.status).label.toLowerCase()}.`,
                { tone: 'healthy' },
              );
            }}
          >
            Clear the flag
          </button>
        </>
      }
    >
      <div className="well p-3 mb-4">
        <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1">Current flag</div>
        <p className="text-[12.5px] text-ink-2 leading-relaxed">{FLAGS.flagLine(emp)}</p>
      </div>
      <p className="text-[13.5px] text-ink-2 leading-relaxed">
        Clearing this puts {emp.name.split(' ')[0]} back to{' '}
        <strong className="text-ink">{statusMeta(previous).label}</strong> — the status they held before the
        flag, not a clean slate they never had — and they can be assigned and apply again.
      </p>
    </Modal>
  );
}

function NotifyDialog({
  count,
  usingSelection,
  chips,
  onClose,
  onSend,
}: {
  count: number;
  usingSelection: boolean;
  chips: string[];
  onClose: () => void;
  onSend: () => void;
}) {
  return (
    <Modal
      title={`Notify ${countLabel(count, 'worker')}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={onSend}>
            Send to {count}
          </button>
        </>
      }
    >
      <p className="text-[13.5px] text-ink-2 mb-3">
        {usingSelection
          ? 'Sends to the workers you selected.'
          : 'Sends to everyone matching the filters currently applied:'}
      </p>
      {!usingSelection ? (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {chips.length ? (
            chips.map((c) => (
              <span key={c} className="pill" style={{ background: TONE_BG.info, color: TONE_HEX.info }}>
                {c}
              </span>
            ))
          ) : (
            <span className="pill" style={{ background: TONE_BG.neutral, color: TONE_HEX.neutral }}>
              All staff — no filters applied
            </span>
          )}
        </div>
      ) : null}
      <label className="block mb-3">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Message</span>
        <textarea className="field" rows={4} placeholder="Type your message…" />
      </label>
      <label className="flex items-center gap-2.5">
        <input type="checkbox" defaultChecked />
        <span className="text-[13px] text-ink-2">Also send by SMS</span>
      </label>
    </Modal>
  );
}
