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
     · VISIBILITY explains itself, and states the lifecycle rule: a WOF that has
       not been signed is never visible to workers, whatever the toggle says.
   ========================================================================== */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { fmtDate } from '@/lib/format';
import { CLIENTS, JOB_TYPES, MANAGERS, jobType } from '@/data/db';
import * as W from '@/lib/wof';
import { LiveWindowField } from './LiveWindowField';

export function NewWofDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();

  const orphans = W.calendarRows().filter((r) => !r.wof && r.schedule);
  // Next reference, so the job code can be shown before the WOF exists. Asked
  // of the allocator rather than recomputed here — a second expression for the
  // same number is a preview that can disagree with what gets issued.
  const nextRef = W.nextRef();

  const [scheduleId, setScheduleId] = useState('');
  const [title, setTitle] = useState('');
  const [jobCode, setJobCode] = useState(nextRef);
  const [clientId, setClientId] = useState(CLIENTS.find((c) => c.status === 'active')!.id);
  // Job type is no longer chosen on this form: it comes from the linked
  // schedule, or stays the default. Department follows it.
  const [jobTypeId, setJobTypeId] = useState(JOB_TYPES[0].id);
  const [department, setDepartment] = useState(W.defaultDepartment(JOB_TYPES[0].id));
  const [ownerId, setOwnerId] = useState(MANAGERS[0].id);
  const [start, setStart] = useState('2026-09-01T09:00');
  const [end, setEnd] = useState('2026-09-01T18:00');
  // Which days of the span are the event itself. Defaults to all of them, so a
  // form nobody touches raises the job it always used to.
  const [liveFrom, setLiveFrom] = useState(1);
  const [liveTo, setLiveTo] = useState(999);
  const [venue, setVenue] = useState('');
  const [postcode, setPostcode] = useState('');
  const [meet, setMeet] = useState('');
  const [active, setActive] = useState(true);
  const [visible, setVisible] = useState(false);

  const jt = jobType(jobTypeId);

  const codeError = !jobCode.trim()
    ? 'Required'
    : W.jobCodeInUse(jobCode.trim())
      ? 'Already used by another job'
      : null;
  const dateError = start && end && new Date(end) <= new Date(start) ? 'The end must be after the start.' : null;

  const pickSchedule = (id: string) => {
    setScheduleId(id);
    const r = orphans.find((o) => o.scheduleId === id);
    if (!r) return;
    setTitle(r.name);
    setClientId(r.clientId);
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
      jobCode: jobCode.trim(),
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
      active,
      staffCalendarVisible: visible,
    });
    onClose();
    navigate(`/wofs/${w.id}`);
  };

  return (
    <Modal
      title="Raise a work order"
      width={640}
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
        {orphans.length ? (
          <div>
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Against a known event</span>
            <select className="field" value={scheduleId} onChange={(e) => pickSchedule(e.target.value)}>
              <option value="">— start from a blank WOF —</option>
              {orphans.map((r) => (
                <option key={r.scheduleId!} value={r.scheduleId!}>
                  {r.name} · {fmtDate(r.start)}
                  {r.wofOverdue ? ' · WOF OVERDUE' : ''}
                </option>
              ))}
            </select>
            <p className="text-[11.5px] text-ink-3 mt-1.5">
              Picking one fills the whole form. {orphans.filter((r) => r.wofOverdue).length} are past the lead
              time on their trigger rule.
            </p>
          </div>
        ) : null}

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
              value={jobCode}
              onChange={(e) => setJobCode(e.target.value)}
            />
            <span className={`block text-[11px] mt-1 ${codeError ? 'text-status-critical' : 'text-ink-3'}`}>
              {codeError ??
                (jobCode === nextRef ? 'Assigned automatically' : 'Custom code — will be checked for duplicates')}
            </span>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
              Client <span className="text-status-critical">*</span>
            </span>
            <select className="field" value={clientId} onChange={(e) => setClientId(e.target.value)}>
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

        <p className="text-[11.5px] text-ink-3 leading-relaxed">
          {jt
            ? `${jt.docs.length} documents will be added to this job's checklist. Default deposit ${jt.depositPct}%, payment terms ${jt.termsDays} days. Both are configurable in Reference data.`
            : ''}
        </p>

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

        {/* Visibility ---------------------------------------------------- */}
        <div className="card p-3" style={{ background: 'var(--surface-raised)' }}>
          <div className="flex items-start justify-between gap-3 mb-2">
            <label className="flex items-center gap-2.5">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
              <span className="text-[13px] text-ink">Active job</span>
            </label>
            <label className="flex items-center gap-2.5">
              <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />
              <span className="text-[13px] text-ink">Show on the staff calendar</span>
            </label>
          </div>
          <p className="text-[11.5px] text-ink-3 leading-relaxed">
            {visible ? (
              <>
                Workers will see shifts for this job <strong className="text-ink">once it becomes an order</strong>{' '}
                — not before. A WOF that has not been signed is never visible, whatever this is set to.
              </>
            ) : (
              'Shifts stay hidden from workers even after the job is confirmed. Use this for jobs being staffed by direct assignment only.'
            )}
          </p>
        </div>
      </div>
    </Modal>
  );
}
