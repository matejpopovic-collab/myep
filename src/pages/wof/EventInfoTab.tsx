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

import {
  cloneElement,
  isValidElement,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Icon, type IconName } from '@/components/Icon';
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
const ERR = 'flex items-start gap-1 text-[11.5px] text-status-critical mt-1.5 leading-relaxed';

/* ----------------------------------------------------------------------------
   Section — one card per kind of question (what, when, where, codes, notes).
   A real <section> with a real <h2>, so a screen-reader user can jump between
   them by heading the same way a sighted user scans the cards.
   ------------------------------------------------------------------------- */
function Section({
  icon,
  title,
  description,
  children,
}: {
  icon: IconName;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="card p-5" aria-labelledby={id}>
      <header className="flex items-start gap-3 pb-4 mb-4 border-b border-surface-line-soft">
        <span
          className="shrink-0 grid place-items-center w-8 h-8 rounded-lg bg-accent-soft text-accent"
          aria-hidden="true"
        >
          <Icon name={icon} decorative className="icon-sm" />
        </span>
        <div className="min-w-0">
          <h2 id={id} className="text-[14px] font-semibold text-ink leading-tight">
            {title}
          </h2>
          {description ? <p className="text-[12px] text-ink-3 mt-0.5 leading-relaxed">{description}</p> : null}
        </div>
      </header>
      {children}
    </section>
  );
}

/* ----------------------------------------------------------------------------
   Field — label, control, then one line of help or the error.
   The help and error are tied to the control with aria-describedby rather
   than living inside the <label>, so they are read as a description, not
   folded into the field's name. aria-invalid marks a field that failed.
   ------------------------------------------------------------------------- */
function Field({
  label,
  required,
  error,
  hint,
  hideLabel,
  className = '',
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  hint?: ReactNode;
  hideLabel?: boolean;
  className?: string;
  children: ReactElement<Record<string, unknown>>;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error || hint;
  const control = isValidElement(children)
    ? cloneElement(children, {
        id,
        'aria-required': required || undefined,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': note ? noteId : undefined,
      })
    : children;
  return (
    <div className={`min-w-0 ${className}`}>
      <label htmlFor={id} className={hideLabel ? 'sr-only' : LABEL}>
        {label}
        {required ? (
          <>
            {' '}
            <span className="text-status-critical" aria-hidden="true">
              *
            </span>
            <span className="sr-only">(required)</span>
          </>
        ) : null}
      </label>
      {control}
      {error ? (
        <span id={noteId} className={ERR}>
          <Icon name="alert" decorative className="icon-sm shrink-0 mt-px" />
          {error}
        </span>
      ) : hint ? (
        <span id={noteId} className={HINT}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/** A date + time pair under one caption ("Starts", "Ends"). */
function DateTimeGroup({
  legend,
  required,
  error,
  disabled,
  date,
  time,
  min,
  onDate,
  onTime,
}: {
  legend: string;
  required?: boolean;
  error?: string;
  disabled?: boolean;
  date: string;
  time: string;
  min?: string;
  onDate: (v: string) => void;
  onTime: (v: string) => void;
}) {
  const id = useId();
  return (
    <fieldset className="min-w-0" aria-describedby={error ? `${id}-err` : undefined}>
      <legend className={LABEL}>
        {legend}
        {required ? (
          <>
            {' '}
            <span className="text-status-critical" aria-hidden="true">
              *
            </span>
            <span className="sr-only">(required)</span>
          </>
        ) : null}
      </legend>
      <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-2">
        <input
          className="field"
          type="date"
          aria-label={`${legend} — date`}
          aria-invalid={error ? true : undefined}
          disabled={disabled}
          min={min}
          value={date}
          onChange={(e) => onDate(e.target.value)}
        />
        <input
          className="field"
          type="time"
          aria-label={`${legend} — time`}
          disabled={disabled}
          value={time}
          onChange={(e) => onTime(e.target.value)}
        />
      </div>
      {error ? (
        <span id={`${id}-err`} className={ERR}>
          <Icon name="alert" decorative className="icon-sm shrink-0 mt-px" />
          {error}
        </span>
      ) : null}
    </fieldset>
  );
}

/** Confirmed vs provisional as two named choices, not a lone checkbox. */
function BookingStatus({
  value,
  onChange,
  signedNote,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  /** Set once the client has signed: Confirmed is then fixed, and this says why. */
  signedNote?: string;
}) {
  const name = useId();
  const opts = [
    { v: false, label: 'Provisional', sub: 'Pencilled in' },
    { v: true, label: 'Confirmed', sub: 'Client has committed' },
  ];
  return (
    <fieldset className="min-w-0">
      <legend className={LABEL}>Booking status</legend>
      <div className="grid grid-cols-2 gap-2">
        {opts.map((o) => {
          const on = value === o.v;
          return (
            <label
              key={o.label}
              className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors focus-within:ring-2 focus-within:ring-accent-ring ${
                on ? 'border-accent bg-accent-soft' : 'border-surface-line hover:bg-surface-hover'
              }`}
            >
              <input
                type="radio"
                name={name}
                className="mt-0.5"
                checked={on}
                disabled={!!signedNote && !o.v}
                onChange={() => onChange(o.v)}
              />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-ink leading-tight">{o.label}</span>
                <span className="block text-[11.5px] text-ink-3 leading-snug">{o.sub}</span>
              </span>
            </label>
          );
        })}
      </div>
      {signedNote ? <span className="block text-[11.5px] text-ink-3 mt-1.5">{signedNote}</span> : null}
    </fieldset>
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
  const formRef = useRef<HTMLFieldSetElement>(null);
  const tierId = useId();

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
      // Take the user to the first problem instead of leaving them to hunt.
      requestAnimationFrame(() => {
        formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      });
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
    const start = which === 'start' ? next : f.start;
    const end =
      which === 'start' && part === 'date' && f.end && datePart(f.end) < v ? `${v}T${timePart(f.end)}` : which === 'end' ? next : f.end;
    // The event days are dates to the operator, not day numbers: moving the
    // start a day earlier must not turn the first event day into a build day.
    const live = W.carryLiveWindow(f, start, end);
    setF((x) => ({ ...x, start, end, ...live }));
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
          <div className="card p-3 text-[12.5px] text-ink-3 flex items-center gap-2" role="note">
            <Icon name="ban" decorative className="icon-sm" /> {denial}
          </div>
        ) : null}

        <p className="text-[12px] text-ink-3 px-1">
          Fields marked{' '}
          <span className="text-status-critical" aria-hidden="true">
            *
          </span>
          <span className="sr-only">with an asterisk</span> are required.
        </p>

        <fieldset ref={formRef} disabled={readOnly} className="space-y-4 min-w-0">
          <legend className="sr-only">Event info</legend>

          {/* Job details ---------------------------------------------------- */}
          <Section icon="fileText" title="Job details" description="What the job is, who it is for, and how firm it is.">
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
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

              <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] items-start">
                <BookingStatus
                  value={f.confirmed}
                  onChange={(v) => set('confirmed', v)}
                  signedNote={
                    w.signoff?.signedAt
                      ? `Confirmed by ${w.signoff.signedBy}'s signature on ${fmtDateFull(w.signoff.signedAt)}.`
                      : undefined
                  }
                />
                <div role="group" aria-labelledby={tierId} className="min-w-0">
                  <span id={tierId} className={LABEL}>
                    Tier / classification
                  </span>
                  <div className="min-h-[38px] flex items-center">
                    <WofTierControl wof={w} />
                  </div>
                </div>
              </div>
            </div>
          </Section>

          {/* Dates & times -------------------------------------------------- */}
          <Section
            icon="calendar"
            title="Dates & times"
            description="When the job starts and ends, and which of those days are the event itself."
          >
            <div className="space-y-4">
              {datesLock ? (
                <div className="well p-3 flex items-start gap-2 text-[12.5px] text-ink-2" role="note">
                  <Icon name="info" decorative className="icon-sm shrink-0 mt-0.5" />
                  <span>{datesLock}</span>
                </div>
              ) : null}

              <div className="grid gap-4 sm:grid-cols-2">
                <DateTimeGroup
                  legend="Starts"
                  required
                  error={shown.start}
                  disabled={!!datesLock}
                  date={datePart(f.start)}
                  time={timePart(f.start)}
                  onDate={(v) => setDate('start', 'date', v)}
                  onTime={(v) => setDate('start', 'time', v)}
                />
                <DateTimeGroup
                  legend="Ends"
                  required
                  error={shown.end}
                  disabled={!!datesLock}
                  min={datePart(f.start)}
                  date={datePart(f.end)}
                  time={timePart(f.end)}
                  onDate={(v) => setDate('end', 'date', v)}
                  onTime={(v) => setDate('end', 'time', v)}
                />
              </div>

              {!datesLock ? (
                <>
                  <p className="text-[11.5px] text-ink-3 leading-relaxed -mt-1">
                    A multi-day job unlocks per-day place and headcount planning on the Quote tab.
                  </p>
                  <LiveWindowField
                    start={f.start}
                    end={f.end}
                    from={f.liveFrom}
                    to={f.liveTo}
                    onChange={(a, b) => setF((x) => ({ ...x, liveFrom: a, liveTo: b }))}
                  />
                </>
              ) : null}
            </div>
          </Section>

          {/* Location ------------------------------------------------------- */}
          <Section icon="mapPin" title="Location" description="Where it happens and where the crew should report.">
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <Field label="Venue">
                  <input
                    className="field"
                    placeholder="Venue name"
                    autoComplete="off"
                    value={f.venue}
                    onChange={(e) => set('venue', e.target.value)}
                  />
                </Field>
                <Field label="Post code">
                  <input
                    className="field uppercase"
                    placeholder="SL5 7JX"
                    autoCapitalize="characters"
                    autoComplete="postal-code"
                    value={f.postcode}
                    onChange={(e) => set('postcode', e.target.value)}
                  />
                </Field>
              </div>
              <Field label="Staff meeting point" hint="Workers see this on their shift, so write it as directions.">
                <input
                  className="field"
                  placeholder="e.g. Steward cabin, Main Car Park Gate C"
                  value={f.staffMeetingPoint}
                  onChange={(e) => set('staffMeetingPoint', e.target.value)}
                />
              </Field>
            </div>
          </Section>

          {/* Reference codes ------------------------------------------------ */}
          <Section icon="layers" title="Reference codes" description="How this job is tracked in finance and reporting.">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Job code" required error={shown.jobCode}>
                <input
                  className="field font-mono text-[12.5px]"
                  spellCheck={false}
                  value={f.jobCode}
                  onChange={(e) => set('jobCode', e.target.value)}
                />
              </Field>
              <Field label="Cost code">
                <input
                  className="field"
                  spellCheck={false}
                  value={f.costCode}
                  onChange={(e) => set('costCode', e.target.value)}
                />
              </Field>
              <Field label="Work group">
                <input className="field" value={f.workGroup} onChange={(e) => set('workGroup', e.target.value)} />
              </Field>
            </div>
          </Section>

          {/* Responsible people --------------------------------------------- */}
          <Section icon="users" title="Responsible people" description="Who owns the job and who to call for each part of it.">
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
          </Section>

          {/* Service lines -------------------------------------------------- */}
          <Section icon="check" title="Service lines" description="Tick every service this job includes.">
            <fieldset className="min-w-0">
              <legend className="sr-only">Service lines</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {SERVICE_TYPES.map((s) => {
                  const on = f.serviceIds.includes(s.id);
                  return (
                    <label
                      key={s.id}
                      className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors focus-within:ring-2 focus-within:ring-accent-ring ${
                        on ? 'border-accent bg-accent-soft' : 'border-surface-line hover:bg-surface-hover'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) =>
                          set(
                            'serviceIds',
                            e.target.checked ? [...f.serviceIds, s.id] : f.serviceIds.filter((x) => x !== s.id),
                          )
                        }
                      />
                      <span className="text-[13px] text-ink">{s.label}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          </Section>

          {/* Notes ---------------------------------------------------------- */}
          <Section icon="edit" title="Notes" description="Anything the team should know that does not fit above.">
            <Field label="Notes" hideLabel>
              <textarea
                className="field"
                rows={4}
                value={f.notes}
                onChange={(e) => set('notes', e.target.value)}
              />
            </Field>
          </Section>
        </fieldset>

        {!readOnly ? (
          <div className="card p-3 flex items-center justify-end gap-2 sticky bottom-3">
            <span className="text-[12px] text-ink-3 mr-auto flex items-center gap-1.5" role="status" aria-live="polite">
              <span
                aria-hidden="true"
                className="inline-block w-2 h-2 rounded-full"
                style={{ background: dirty ? TONE_HEX.atRisk : TONE_HEX.healthy }}
              />
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
