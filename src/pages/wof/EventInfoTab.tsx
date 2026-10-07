/* ============================================================================
   WOF DETAIL — EVENT INFO TAB
   ----------------------------------------------------------------------------
   The page a newly raised WOF opens on. The creation dialog asks for the few
   things a job cannot exist without; this is where the rest of the live
   system's "Event Info" form gets filled in — cost code, work group, the
   provisional flag, the five responsible people and the service lines.

   One form, one Save. Nothing writes until Save, because half these fields
   are read by other screens (the venue by the worker app, the dates by the
   deployment grid) and a half-typed value should not reach them.

   No second status. The live form's Draft / Change status is this app's stage
   rail, so the Lifecycle card shows the stage and moves it through the same
   gated advance as the header button. Two state machines for one job is how
   the pipeline and the job screen come to disagree.
   ========================================================================== */

import { useState, type ReactNode } from 'react';
import { Icon } from '@/components/Icon';
import { StagePill, WofTierControl } from '@/components/wof-ui';
import { useToast } from '@/components/Toast';
import { TONE_HEX } from '@/lib/status';
import { fmtDateFull, fmtTime } from '@/lib/format';
import { CLIENTS, MANAGERS, SERVICE_TYPES, TEAM, TEAM_BANDS, manager as managerById } from '@/data/db';
import * as W from '@/lib/wof';
import * as ROLES from '@/lib/roles';
import { useRolesVersion, useWofVersion } from '@/lib/useStore';
import { LiveWindowField } from './LiveWindowField';

const LABEL = 'block text-[12.5px] font-medium text-ink-2 mb-1.5';
const HEAD = 'text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-3';
const HINT = 'block text-[11.5px] text-ink-3 mt-1.5 leading-relaxed';
const ERR = 'block text-[11.5px] text-status-critical mt-1.5 leading-relaxed';

function Field({
  label,
  required,
  error,
  hint,
  className = '',
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={`block ${className}`}>
      <span className={LABEL}>
        {label} {required ? <span className="text-status-critical">*</span> : null}
      </span>
      {children}
      {error ? <span className={ERR}>{error}</span> : hint ? <span className={HINT}>{hint}</span> : null}
    </label>
  );
}

/** Split a local `YYYY-MM-DDTHH:mm` into the date and time inputs. */
const datePart = (v: string) => v.slice(0, 10);
const timePart = (v: string) => v.slice(11, 16) || '09:00';

export default function EventInfoTab({ w, onAdvance }: { w: W.Wof; onAdvance: () => void }) {
  useWofVersion();
  useRolesVersion();
  const toast = useToast();
  const denial = ROLES.denial('wof.edit');
  const readOnly = !!denial;

  const [f, setF] = useState<W.EventInfoPatch>(() => W.eventInfoOf(w));
  const [tried, setTried] = useState(false);
  const set = <K extends keyof W.EventInfoPatch>(k: K, v: W.EventInfoPatch[K]) => setF((x) => ({ ...x, [k]: v }));

  const saved = W.eventInfoOf(w);
  const dirty = JSON.stringify(f) !== JSON.stringify(saved);
  const errors = W.eventInfoErrors(w, f);
  // Only shout about a field once somebody has tried to save, except the ones
  // that are wrong the moment they are typed (a duplicate code, a bad span).
  const shown = tried ? errors : { jobCode: errors.jobCode, end: errors.end, start: errors.start };

  const datesLock = W.datesLock(w);
  const clientLock = W.clientLock(w);

  const save = () => {
    setTried(true);
    const r = W.updateEventInfo(w, f, ROLES.actingActor());
    if (!r.ok) {
      toast('Some fields need fixing before this can be saved.', { tone: 'critical' });
      return;
    }
    setTried(false);
    setF(W.eventInfoOf(w));
    toast(r.changed.length ? 'Event info saved.' : 'Nothing had changed.', { tone: 'healthy' });
  };

  const setDate = (which: 'start' | 'end', part: 'date' | 'time', v: string) => {
    const cur = f[which];
    const next = part === 'date' ? `${v}T${timePart(cur)}` : `${datePart(cur)}T${v}`;
    // Moving the start past the end drags the end along, the way every
    // calendar does — otherwise a one-day job typed date-first is an error
    // until the second field is touched.
    if (which === 'start' && part === 'date' && f.end && datePart(f.end) < v) {
      setF((x) => ({ ...x, start: next, end: `${v}T${timePart(x.end)}` }));
      return;
    }
    set(which, next);
  };

  const people = (key: keyof W.ResponsiblePeople) => (
    <select
      className="field"
      value={f.people[key] || ''}
      onChange={(e) => set('people', { ...f.people, [key]: e.target.value || null })}
    >
      <option value="">— Not assigned —</option>
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
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] items-start">
      <div className="space-y-4 min-w-0">
        {denial ? (
          <div className="card p-3 text-[12.5px] text-ink-3 flex items-center gap-2">
            <Icon name="ban" decorative className="icon-sm" /> {denial}
          </div>
        ) : null}

        <fieldset disabled={readOnly} className="space-y-4 min-w-0">
          {/* Job ------------------------------------------------------------ */}
          <div className="card p-5">
            <div className={HEAD}>Job</div>
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
                <Field label="Job name" required error={shown.title}>
                  <input className="field" value={f.title} onChange={(e) => set('title', e.target.value)} />
                </Field>
                <Field label="Client" required error={shown.clientId} hint={clientLock || undefined}>
                  <select
                    className="field"
                    value={f.clientId}
                    disabled={!!clientLock}
                    onChange={(e) => set('clientId', e.target.value)}
                  >
                    {CLIENTS.filter((c) => c.status === 'active' || c.id === f.clientId).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
                <Field label="Venue">
                  <input
                    className="field"
                    placeholder="Venue name"
                    value={f.venue}
                    onChange={(e) => set('venue', e.target.value)}
                  />
                </Field>
                <Field label="Event date" required error={shown.start}>
                  <input
                    className="field"
                    type="date"
                    disabled={!!datesLock}
                    value={datePart(f.start)}
                    onChange={(e) => setDate('start', 'date', e.target.value)}
                  />
                </Field>
                <Field label="Start time">
                  <input
                    className="field"
                    type="time"
                    disabled={!!datesLock}
                    value={timePart(f.start)}
                    onChange={(e) => setDate('start', 'time', e.target.value)}
                  />
                </Field>
              </div>

              <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr]">
                <Field label="Event end date" required error={shown.end}>
                  <input
                    className="field"
                    type="date"
                    disabled={!!datesLock}
                    min={datePart(f.start)}
                    value={datePart(f.end)}
                    onChange={(e) => setDate('end', 'date', e.target.value)}
                  />
                </Field>
                <Field label="End time">
                  <input
                    className="field"
                    type="time"
                    disabled={!!datesLock}
                    value={timePart(f.end)}
                    onChange={(e) => setDate('end', 'time', e.target.value)}
                  />
                </Field>
                <div>
                  <span className={LABEL}>Tier / classification</span>
                  <div className="min-h-[38px] flex items-center">
                    <WofTierControl wof={w} />
                  </div>
                </div>
              </div>
              <p className="text-[11.5px] text-ink-3 leading-relaxed -mt-1">
                {datesLock ||
                  'Set the end date for a multi-day deployment to unlock per-day place and headcount planning on the Quote tab.'}
              </p>

              {!datesLock ? (
                <LiveWindowField
                  start={f.start}
                  end={f.end}
                  from={f.liveFrom}
                  to={f.liveTo}
                  onChange={(a, b) => setF((x) => ({ ...x, liveFrom: a, liveTo: b }))}
                />
              ) : null}

              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Job code" required error={shown.jobCode}>
                  <input
                    className="field font-mono text-[12.5px]"
                    value={f.jobCode}
                    onChange={(e) => set('jobCode', e.target.value)}
                  />
                </Field>
                <Field label="Cost code">
                  <input className="field" value={f.costCode} onChange={(e) => set('costCode', e.target.value)} />
                </Field>
                <Field label="Work group">
                  <input className="field" value={f.workGroup} onChange={(e) => set('workGroup', e.target.value)} />
                </Field>
              </div>

              <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
                <Field label="Post code">
                  <input
                    className="field"
                    placeholder="SL5 7JX"
                    autoCapitalize="characters"
                    value={f.postcode}
                    onChange={(e) => set('postcode', e.target.value)}
                  />
                </Field>
                <Field label="Staff meeting point" hint="Workers see this on the shift, so write it as directions.">
                  <input
                    className="field"
                    placeholder="e.g. Steward cabin, Main Car Park Gate C"
                    value={f.staffMeetingPoint}
                    onChange={(e) => set('staffMeetingPoint', e.target.value)}
                  />
                </Field>
              </div>

              <label className="flex items-center gap-2.5">
                <input type="checkbox" checked={f.confirmed} onChange={(e) => set('confirmed', e.target.checked)} />
                <span className="text-[13px] text-ink">Confirmed</span>
                <span className="text-[12px] text-ink-3">— unticked means provisional</span>
              </label>

              <Field label="Notes">
                <textarea
                  className="field"
                  rows={4}
                  value={f.notes}
                  onChange={(e) => set('notes', e.target.value)}
                />
              </Field>
            </div>
          </div>

          {/* Responsible people --------------------------------------------- */}
          <div className="card p-5">
            <div className={HEAD}>Responsible people</div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="WOF owner">
                <select className="field" value={f.ownerId} onChange={(e) => set('ownerId', e.target.value)}>
                  {MANAGERS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} — {m.role}
                    </option>
                  ))}
                </select>
              </Field>
              {W.RESPONSIBLE_ROLES.map((r) => (
                <Field key={r.key} label={r.label}>
                  {people(r.key)}
                </Field>
              ))}
            </div>
          </div>

          {/* Service lines -------------------------------------------------- */}
          <div className="card p-5">
            <div className={HEAD}>Service lines</div>
            <div className="grid gap-x-4 gap-y-2.5 sm:grid-cols-3">
              {SERVICE_TYPES.map((s) => (
                <label key={s.id} className="flex items-center gap-2.5">
                  <input
                    type="checkbox"
                    checked={f.serviceIds.includes(s.id)}
                    onChange={(e) =>
                      set(
                        'serviceIds',
                        e.target.checked ? [...f.serviceIds, s.id] : f.serviceIds.filter((x) => x !== s.id),
                      )
                    }
                  />
                  <span className="text-[13px] text-ink">{s.label}</span>
                </label>
              ))}
            </div>
          </div>
        </fieldset>

        {!readOnly ? (
          <div className="card p-3 flex items-center justify-end gap-2 sticky bottom-3">
            <span className="text-[12px] text-ink-3 mr-auto">
              {dirty ? 'Unsaved changes' : 'All changes saved'}
            </span>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!dirty}
              onClick={() => {
                setF(W.eventInfoOf(w));
                setTried(false);
              }}
            >
              Discard
            </button>
            <button type="button" className="btn btn-primary" disabled={!dirty} onClick={save}>
              <Icon name="checkCircle" decorative /> Save
            </button>
          </div>
        ) : null}
      </div>

      <div className="space-y-4">
        <LifecycleCard w={w} onAdvance={onAdvance} />
        <StatusHistoryCard w={w} />
      </div>
    </div>
  );
}

/** The stage, and the way forward — the same gate the header button uses. */
function LifecycleCard({ w, onAdvance }: { w: W.Wof; onAdvance: () => void }) {
  const next = W.nextStage(w);
  const g = W.gate(w);
  const st = W.stage(w.stage);
  const nextLabel = next ? W.stage(next)?.label || W.TERMINAL[next as W.TerminalId]?.label || next : null;
  return (
    <div className="card p-4">
      <div className={HEAD}>Lifecycle</div>
      <div className="text-[12.5px] text-ink-3 mb-1.5">Current stage</div>
      <StagePill wof={w} />
      {st ? <p className="text-[12.5px] text-ink-2 mt-2 leading-relaxed">{st.blurb}</p> : null}
      {next ? (
        <>
          {g.block.length ? (
            <ul className="mt-3 space-y-1">
              {g.block.map((b, i) => (
                <li key={i} className="text-[12px] leading-relaxed" style={{ color: TONE_HEX.critical }}>
                  {b}
                </li>
              ))}
            </ul>
          ) : null}
          <button
            type="button"
            className="btn btn-primary w-full mt-3"
            disabled={g.block.length > 0}
            onClick={onAdvance}
          >
            <Icon name="chevronRight" decorative /> Move to {nextLabel}
          </button>
        </>
      ) : null}
    </div>
  );
}

function StatusHistoryCard({ w }: { w: W.Wof }) {
  const h = (w.history || []).slice().reverse().slice(0, 6);
  return (
    <div className="card p-4">
      <div className={HEAD}>Status history</div>
      {h.length ? (
        <ol className="space-y-3">
          {h.map((e, i) => {
            const st = W.stage(e.stage) || W.TERMINAL[e.stage as W.TerminalId] || { label: e.stage };
            const who = managerById(e.by)?.name || e.byName;
            return (
              <li key={i} className="text-[12.5px]">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-semibold text-ink">{st.label}</span>
                  <span className="text-[11.5px] text-ink-3 tabular-nums">
                    {fmtDateFull(e.at)}
                    {fmtTime(e.at) ? ` ${fmtTime(e.at)}` : ''}
                  </span>
                </div>
                <div className="text-ink-2 leading-relaxed">{e.note}</div>
                {who ? <div className="text-[11.5px] text-ink-3">{who}</div> : null}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-[12.5px] text-ink-3">Nothing has happened to this WOF yet.</p>
      )}
      {(w.history || []).length > 6 ? (
        <p className="text-[11.5px] text-ink-3 mt-3">The full trail is on the History tab.</p>
      ) : null}
    </div>
  );
}
