/* ============================================================================
   RAISE A WORK ORDER
   ----------------------------------------------------------------------------
   Deliberately offers the schedule entries with no WOF first: that is the
   bidirectional link the briefing asks for, and it is how a WOF should normally
   be raised — against a known event, not from a blank form.

   Three things this form does that the live "Event Info" form does not:

     · JOB CODE is assigned and checked for duplicates. Two jobs sharing a code
       silently merge on every report that groups by it — the same failure that
       produced the `YYY` and `ZZZ` client codes.
     · DATES are validated against each other rather than accepted and left to
       render as a negative duration downstream.
     · VISIBILITY is not offered here: shifts can only be advertised once the
       client has signed, so the toggle lives on the job's Overview.
   ========================================================================== */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { countLabel, fmtDate, money } from '@/lib/format';
import {
  CLIENTS, DEPARTMENTS, JOB_TYPES, MANAGERS, SERVICE_TYPES, TEAM, TEAM_BANDS,
  client as clientById, jobType,
} from '@/data/db';
import * as C from '@/lib/classification';
import { hue as hueVars } from '@/lib/hues';
import * as W from '@/lib/wof';
import * as SD from '@/lib/standarddocs';
import * as ROLES from '@/lib/roles';
import { LiveWindowField } from './LiveWindowField';

/** The responsible-people slots offered when raising. The account manager is
 *  left to the Event info tab; "Created by" above already names the owner. */
const PEOPLE_FIELDS: { key: keyof W.ResponsiblePeople; label: string }[] = [
  { key: 'opsLead', label: 'Ops manager lead' },
  { key: 'opsSupport', label: 'Ops manager support' },
  { key: 'onsiteLead', label: 'Ops lead onsite' },
  { key: 'directorCover', label: 'Director cover' },
];

const SVC = hueVars('blue');

/** Today as YYYY-MM-DD in local time (toISOString would give the UTC date). */
function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function NewWofDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();

  const rows = W.calendarRows();
  const orphans = rows.filter((r) => !r.wof && r.schedule);
  const [scheduleId, setScheduleId] = useState('');
  // The previous job this form was copied from, if any. Display only — a copy
  // is not a link, so nothing about it is stored on the new WOF.
  const [copiedFrom, setCopiedFrom] = useState('');
  // Whether the copied job's deployments (areas, places, shift patterns, roles,
  // headcounts, kit) come across too. On by default: the setup is usually the
  // thing worth copying. Cloned AFTER the WOF exists, through the same
  // W.cloneDeployments the quote tab uses, so days are remapped by phase onto
  // THIS job's dates and every line is priced at today's rate card.
  const [bringDeployments, setBringDeployments] = useState(true);
  const [title, setTitle] = useState('');
  // The job code is DERIVED (service-DDMMYY-client, see W.autoJobCode) and
  // follows the form until somebody types over it. Once typed over it is
  // theirs — a legacy code being preserved — until they ask for the automatic
  // one back.
  const [jobCode, setJobCode] = useState('');
  const [codeEdited, setCodeEdited] = useState(false);
  const [clientId, setClientId] = useState(CLIENTS.find((c) => c.status === 'active')!.id);
  // Job type decides the document checklist, deposit default and payment
  // terms, and cannot be changed once the WOF is raised — so it is chosen
  // here. Picking a known event fills it from the schedule. Department
  // follows it.
  const [jobTypeId, setJobTypeId] = useState(JOB_TYPES[0].id);
  const [department, setDepartment] = useState(W.defaultDepartment(JOB_TYPES[0].id));
  const [ownerId, setOwnerId] = useState(MANAGERS[0].id);
  // Opens on today (the viewer's local date), 09:00–18:00 — not a fixed date.
  const [start, setStart] = useState(() => `${todayLocal()}T09:00`);
  const [end, setEnd] = useState(() => `${todayLocal()}T18:00`);
  // Which days of the span are the event itself. Defaults to all of them, so a
  // form nobody touches raises the job it always used to.
  const [liveFrom, setLiveFrom] = useState(1);
  const [liveTo, setLiveTo] = useState(999);
  const [venue, setVenue] = useState('');
  const [postcode, setPostcode] = useState('');
  const [meet, setMeet] = useState('');
  // The rest of the live form, so a job can be raised complete rather than
  // finished on the Event info tab. All optional.
  // Tier: '' reads it off the quote's headcount; anything else is a hand-set band.
  const [tier, setTier] = useState('');
  const [people, setPeople] = useState<W.ResponsiblePeople>({});
  // Starts on what EP sells the account — the same first guess W.create makes.
  const [serviceIds, setServiceIds] = useState<string[]>(() => [
    ...(clientById(CLIENTS.find((c) => c.status === 'active')!.id)?.serviceTypes || []),
  ]);
  const [notes, setNotes] = useState('');

  const jt = jobType(jobTypeId);

  // The event picker answers to the client: it is chosen first, and the list
  // narrows to that account. Two kinds of entry, kept apart because they do
  // different things —
  //   · SCHEDULED events with no WOF yet. Picking one LINKS the WOF to the
  //     schedule entry and takes its dates (the bidirectional link above).
  //   · PREVIOUS jobs already raised for this client. Picking one COPIES the
  //     job's details (name, type, venue, meeting point, manager) as a starting
  //     point, but not its dates or job code — it is a new job, not a re-run of
  //     the old one, and it is not linked to anything.
  const clientOrphans = orphans.filter((r) => r.clientId === clientId);
  const clientPrevious = rows
    .filter((r) => r.wof && r.clientId === clientId)
    .sort((a, b) => +new Date(b.start) - +new Date(a.start));
  const overdueCount = clientOrphans.filter((r) => r.wofOverdue).length;
  // One select, two sources — the value carries which one it came from.
  const pickValue = scheduleId ? `s:${scheduleId}` : copiedFrom ? `w:${copiedFrom}` : '';

  const autoCode = W.autoJobCode({ department, end, clientId });
  const code = codeEdited ? jobCode : autoCode;

  const codeError = !code.trim()
    ? 'Required'
    : W.jobCodeInUse(code.trim())
      ? 'Already used by another job'
      : null;
  const dateError = start && end && new Date(end) <= new Date(start) ? 'The end must be after the start.' : null;

  const pickClient = (id: string) => {
    setClientId(id);
    setServiceIds([...(clientById(id)?.serviceTypes || [])]);
    // The list now belongs to another account, so whatever was picked from the
    // old one no longer applies. The fields it filled stay as they are.
    setScheduleId('');
    setCopiedFrom('');
  };

  const pickEvent = (value: string) => {
    setScheduleId('');
    setCopiedFrom('');
    if (value.startsWith('w:')) copyPrevious(value.slice(2));
    else if (value.startsWith('s:')) pickSchedule(value.slice(2));
  };

  const copyPrevious = (wofId: string) => {
    const r = clientPrevious.find((o) => o.wof!.id === wofId);
    if (!r) return;
    const w = r.wof!;
    setCopiedFrom(wofId);
    setBringDeployments(true);
    setTitle(w.title);
    setJobTypeId(w.jobTypeId);
    setDepartment(w.departmentId || W.defaultDepartment(w.jobTypeId));
    setOwnerId(w.ownerId);
    setVenue(w.venue || '');
    setPostcode(w.postcode || '');
    setMeet(w.staffMeetingPoint || '');
    setPeople({ ...(w.people || {}) });
    setServiceIds([...(w.serviceIds || [])]);
  };

  // The job being copied, and what its deployments amount to.
  const copySource = copiedFrom ? clientPrevious.find((o) => o.wof!.id === copiedFrom)?.wof || null : null;
  const copyBlocks = copySource ? W.deployments(copySource) : [];
  const copyLines = copySource
    ? (copySource.lines || []).filter((l) => l.patternId || l.placement).length
    : 0;

  const pickSchedule = (id: string) => {
    setScheduleId(id);
    const r = orphans.find((o) => o.scheduleId === id);
    if (!r) return;
    setTitle(r.name);
    setJobTypeId(r.type);
    setDepartment(W.defaultDepartment(r.type));
    setStart(String(r.start).slice(0, 16));
    setEnd(String(r.end).slice(0, 16));
    setOwnerId(r.ownerId);
    setVenue(r.venue || '');
  };

  const save = () => {
    if (!title.trim()) {
      toast('Give the event a name.', { tone: 'critical' });
      return;
    }
    if (codeError || dateError) return;

    // Clamp before storing rather than relying on the reader to do it. 999 is
    // this form's "to the end of the job" and has no business reaching the WOF.
    const days = W.spanWindowsOf(start, end).length || 1;
    const from = Math.min(Math.max(liveFrom, 1), days);
    const to = Math.min(Math.max(liveTo, from), days);

    const w = W.create({
      scheduleId: scheduleId || null,
      title: title.trim(),
      jobCode: code.trim(),
      clientId,
      departmentId: department,
      jobTypeId,
      start: start + ':00',
      end: end + ':00',
      liveFrom: from,
      liveTo: to,
      ownerId,
      venue: venue.trim(),
      postcode: postcode.trim().toUpperCase(),
      staffMeetingPoint: meet.trim(),
      // Every new job starts active. Pausing one is a detail-page decision,
      // made once there is something to pause (an order, committed kit).
      active: true,
      // Advertising shifts is switched on from the job's Overview once the
      // client has signed — a WOF is never shown to staff before that.
      staffCalendarVisible: false,
      people,
      serviceIds,
      notes: notes.trim(),
      scaleOverride: tier || null,
    });
    if (copySource && bringDeployments && copyBlocks.length) {
      const r = W.cloneDeployments(copySource, w, ROLES.actingActor());
      toast(
        r.lines
          ? `Deployments copied from ${copySource.ref}: ${countLabel(r.lines, 'line')}, ${money(r.value, { pence: false })}.` +
              (r.droppedDays ? ` ${countLabel(r.droppedDays, 'day')} had nowhere to land on this run.` : '')
          : `No deployments from ${copySource.ref} fitted this job's days.`,
        { tone: r.lines ? 'healthy' : 'atRisk' },
      );
    }
    SD.attachAllTo(w).then((a) => {
      const m = SD.describe(a);
      if (m) toast(m, { tone: a.expired.length ? 'atRisk' : 'healthy' });
    });
    onClose();
    // Straight onto Event info: the dialog now takes people, tier, service
    // lines and notes too; the tab takes what is left (cost code, work group).
    navigate(`/wofs/${w.id}#event`);
  };

  return (
    <Modal
      title="Raise a work order"
      width={820}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={save}>
            Raise WOF
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Event info ---------------------------------------------------- */}
        <div className="grid grid-cols-3 gap-3">
          <label className="block col-span-2">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
              Event name <span className="text-status-critical">*</span>
            </span>
            <input
              className="field"
              placeholder="e.g. Ascot Late Summer Raceday"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Job code</span>
            <input
              className="field font-mono text-[12.5px]"
              value={code}
              onChange={(e) => {
                setJobCode(e.target.value);
                setCodeEdited(true);
              }}
            />
            <span className={`block text-[11px] mt-1 ${codeError ? 'text-status-critical' : 'text-ink-3'}`}>
              {codeError ??
                (!codeEdited || code === autoCode ? (
                  'Service · last day · client'
                ) : (
                  <>
                    Custom code ·{' '}
                    <button
                      type="button"
                      className="underline"
                      onClick={() => {
                        setCodeEdited(false);
                        setJobCode('');
                      }}
                    >
                      use {autoCode}
                    </button>
                  </>
                ))}
            </span>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
              Client <span className="text-status-critical">*</span>
            </span>
            <select className="field" value={clientId} onChange={(e) => pickClient(e.target.value)}>
              {CLIENTS.filter((c) => c.status === 'active').map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
              Created by <span className="text-status-critical">*</span>
            </span>
            <select className="field" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              {MANAGERS.filter((m) => m.id !== 'm-fd').map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} — {m.role}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div>
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Start from</span>
          <select
            className="field"
            value={pickValue}
            disabled={!clientOrphans.length && !clientPrevious.length}
            onChange={(e) => pickEvent(e.target.value)}
          >
            <option value="">
              {clientOrphans.length || clientPrevious.length
                ? '— start from a blank WOF —'
                : '— no events for this client yet —'}
            </option>
            {clientOrphans.length ? (
              <optgroup label="Scheduled — no WOF yet">
                {clientOrphans.map((r) => (
                  <option key={r.scheduleId!} value={`s:${r.scheduleId}`}>
                    {r.name} · {fmtDate(r.start)}
                    {r.wofOverdue ? ' · WOF OVERDUE' : ''}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {clientPrevious.length ? (
              <optgroup label="Previous jobs — copy details and deployments">
                {clientPrevious.map((r) => (
                  <option key={r.wof!.id} value={`w:${r.wof!.id}`}>
                    {r.name} · {fmtDate(r.start)} · {r.wof!.jobCode}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
          <p className="text-[11.5px] text-ink-3 mt-1.5">
            {copiedFrom
              ? 'Copied from a previous job — set the dates for this one. The job code is new.'
              : scheduleId
                ? 'Linked to the scheduled event — the form is filled from it.'
                : clientOrphans.length || clientPrevious.length
                  ? `A scheduled event fills the whole form; a previous job copies its details and deployments but not its dates.${overdueCount ? ` ${overdueCount} scheduled ${overdueCount === 1 ? 'is' : 'are'} past the lead time on ${overdueCount === 1 ? 'its' : 'their'} trigger rule.` : ''}`
                  : 'Nothing scheduled or raised for this client yet — start from a blank WOF.'}
          </p>
          {copySource && copyBlocks.length ? (
            <label className="flex items-start gap-2.5 mt-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={bringDeployments}
                onChange={(e) => setBringDeployments(e.target.checked)}
              />
              <span className="text-[12.5px] text-ink-2 leading-snug">
                <span className="text-ink font-medium">Bring its deployments across</span> —{' '}
                {countLabel(copyBlocks.length, 'deployment')}, {countLabel(copyLines, 'line')}: areas, shift patterns,
                roles, headcounts and kit. Days follow their phase onto this job&rsquo;s dates; prices come from
                today&rsquo;s rate card.
              </span>
            </label>
          ) : null}
        </div>

        <div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
                Job type <span className="text-status-critical">*</span>
              </span>
              <select
                className="field"
                value={jobTypeId}
                onChange={(e) => {
                  setJobTypeId(e.target.value);
                  setDepartment(W.defaultDepartment(e.target.value));
                }}
              >
                {JOB_TYPES.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
                Service <span className="text-status-critical">*</span>
              </span>
              <select className="field" value={department} onChange={(e) => setDepartment(e.target.value)}>
                {DEPARTMENTS.map((d) => (
                  <option key={d} value={d}>
                    {d} ({W.serviceCode(d)})
                  </option>
                ))}
              </select>
            </label>
          </div>
          <span className="block text-[11.5px] text-ink-3 mt-1.5 leading-relaxed">
            {jt
              ? `${jt.docs.length} document${jt.docs.length === 1 ? '' : 's'} will be added to this job's checklist. Default deposit ${jt.depositPct}%, payment terms ${jt.termsDays} days. Set per job type in Checklist configuration. The type can't be changed after the WOF is raised.`
              : ''}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
              Starts <span className="text-status-critical">*</span>
            </span>
            <input
              className="field"
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
              Ends <span className="text-status-critical">*</span>
            </span>
            <input className="field" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
        </div>
        {dateError ? <p className="text-[11.5px] mt-[-6px] text-status-critical">{dateError}</p> : null}

        {!dateError ? (
          <LiveWindowField
            start={start}
            end={end}
            from={liveFrom}
            to={liveTo}
            onChange={(f, t) => {
              setLiveFrom(f);
              setLiveTo(t);
            }}
          />
        ) : null}

        <div className="grid grid-cols-3 gap-3">
          <label className="block col-span-2">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Venue</span>
            <input className="field" placeholder="Venue name" value={venue} onChange={(e) => setVenue(e.target.value)} />
          </label>
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Post code</span>
            <input
              className="field"
              placeholder="SL5 7JX"
              autoCapitalize="characters"
              value={postcode}
              onChange={(e) => setPostcode(e.target.value)}
            />
          </label>
        </div>

        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Staff meeting point</span>
          <input
            className="field"
            placeholder="e.g. Steward cabin, Main Car Park Gate C"
            value={meet}
            onChange={(e) => setMeet(e.target.value)}
          />
          <span className="block text-[11px] text-ink-3 mt-1">
            Workers see this on the shift, so write it as directions rather than a code.
          </span>
        </label>

        {/* Classification & people ------------------------------------- */}
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Tier / classification</span>
            <select className="field" value={tier} onChange={(e) => setTier(e.target.value)}>
              <option value="">Auto (from headcount)</option>
              {[...C.AUTO_SCALES].reverse().map((sc) => (
                <option key={sc} value={sc}>
                  {C.SCALE_LABEL[sc]}
                </option>
              ))}
              {C.MANUAL_ONLY_SCALES.map((sc) => (
                <option key={sc} value={sc}>
                  {C.SCALE_LABEL[sc]}
                </option>
              ))}
            </select>
          </label>
          {PEOPLE_FIELDS.map((r) => (
            <label key={r.key} className="block">
              <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">{r.label}</span>
              <select
                className="field"
                value={people[r.key] || ''}
                onChange={(e) => setPeople((p) => ({ ...p, [r.key]: e.target.value || null }))}
              >
                <option value="">Not assigned</option>
                {TEAM_BANDS.map((band) => (
                  <optgroup key={band} label={band}>
                    {TEAM.filter((t) => t.band === band && t.active).map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} — {t.role}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
          ))}
        </div>

        <fieldset className="min-w-0">
          <legend className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Service types</legend>
          <div className="flex flex-wrap gap-2">
            {SERVICE_TYPES.map((s) => {
              const on = serviceIds.includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setServiceIds((l) => (on ? l.filter((x) => x !== s.id) : [...l, s.id]))}
                  className={`rounded-full border px-3 py-1 text-[12.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
                    on ? 'font-medium' : 'border-surface-line text-ink-2 hover:bg-surface-hover'
                  }`}
                  style={on ? { borderColor: SVC.solid, background: SVC.chip, color: SVC.fg } : undefined}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
        </fieldset>

        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Notes</span>
          <textarea
            className="field"
            rows={3}
            placeholder="Internal notes about this job"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
      </div>
    </Modal>
  );
}
