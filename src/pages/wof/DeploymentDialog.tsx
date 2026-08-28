/* ============================================================================
   ADD A DEPLOYMENT — one place, the windows worked there, and who stands there
   ----------------------------------------------------------------------------
   The Add-a-line dialog asks for one charge, a quantity and a pair of numbers.
   On a real festival quote that is the wrong unit of work: the Reading sheet
   puts Car Park Steward on 38 rows across 12 windows and 16 location labels,
   and typing that one line at a time is 60 trips through a modal.

   So this dialog's unit is a DEPLOYMENT: a place, the shift patterns worked
   there, the roles standing in them, and a headcount per day for each.

   Three decisions worth not re-litigating:

     - PATTERNS ARE PICKED, NOT TYPED. Twelve named windows cover 70% of the
       Reading sheet. A pair of time inputs per pass is what this replaces.

     - A BLANK CELL IS AN ANSWER. It means "this role does not work that window
       here" - a supervisor on days but not nights is one empty cell, not a
       second trip through the dialog.

     - DAYS BELONG TO THE COLUMN. At Lilley Farm the early cover starts in the
       build and the nights stop before the last event day. One shared day strip
       would flatten that silently.
   ========================================================================== */

import { useMemo, useState } from 'react';
import { Modal } from '@/components/Modal';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/Toast';
import { TONE_BG, TONE_HEX } from '@/lib/status';
import { countLabel, money } from '@/lib/format';
import { CHARGES, charge as chargeById, NOW, rateAt, tieredCharge } from '@/data/db';
import * as W from '@/lib/wof';
import * as ROLES from '@/lib/roles';

const NEW_PLACE = ' new';

/** The day squares under a pattern's column header. */
function DayDots({ w, days, onToggle }: { w: W.Wof; days: number[]; onToggle: (d: number) => void }) {
  const total = W.eventDays(w);
  const windows = W.spanWindowsOf(w.start, w.end);
  return (
    <div className="flex gap-[2px] justify-center">
      {Array.from({ length: total }, (_, i) => i + 1).map((d) => {
        const on = days.includes(d);
        const kind = W.dayKind(w, d);
        const date = windows[d - 1]?.start;
        const label = date
          ? date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
          : `Day ${d}`;
        return (
          <button
            key={d}
            type="button"
            aria-pressed={on}
            aria-label={`${label}, ${kind} day`}
            title={`${label} - ${kind}`}
            onClick={() => onToggle(d)}
            className="rounded-[2px] border transition-colors"
            style={{
              width: 11,
              height: 15,
              padding: 0,
              background: on
                ? kind === 'build'
                  ? TONE_HEX.atRisk
                  : kind === 'break'
                    ? 'var(--ink-3)'
                    : 'var(--accent)'
                : 'var(--well)',
              borderColor: on ? 'transparent' : 'var(--surface-line)',
            }}
          />
        );
      })}
    </div>
  );
}

export function DeploymentDialog({ w, onClose }: { w: W.Wof; onClose: () => void }) {
  const toast = useToast();
  const isVar = !!w.signoff;
  const during = isVar && new Date(w.start) <= NOW && NOW <= new Date(w.end);

  const library = W.ensureShiftPatterns(w);
  const places = w.places || [];
  const areas = [...new Set((w.patterns || []).map((p) => p.area))].filter(Boolean);
  const eventDays = Array.from({ length: W.eventDays(w) }, (_, i) => i + 1)
    .filter((d) => W.dayKind(w, d) === 'event');

  const [area, setArea] = useState(areas[0] || '');
  const [placeId, setPlaceId] = useState(places[0]?.id || '');
  const [newPlace, setNewPlace] = useState('');
  const [cols, setCols] = useState<string[]>([]);
  const [days, setDays] = useState<Record<string, number[]>>({});
  const [roles, setRoles] = useState<string[]>([]);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState('');
  const [custom, setCustom] = useState<{ start: string; end: string } | null>(null);

  const staff = CHARGES.filter((c) => c.kind === 'staff');
  const shown = staff.filter((c) => c.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const cellKey = (sp: string, ch: string) => `${sp}|${ch}`;
  const countOf = (sp: string, ch: string) => Number(counts[cellKey(sp, ch)]) || 0;

  const toggleCol = (id: string) =>
    setCols((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      // A new column defaults to the event days. Build and breakdown cover is
      // the exception on every quote in the book, and defaulting to the whole
      // span would have an operator un-ticking two days on every pattern.
      setDays((d) => (d[id] ? d : { ...d, [id]: eventDays }));
      return [...prev, id];
    });

  const toggleDay = (spId: string, day: number) =>
    setDays((prev) => {
      const cur = prev[spId] || [];
      return {
        ...prev,
        [spId]: cur.includes(day) ? cur.filter((x) => x !== day) : [...cur, day].sort((a, b) => a - b),
      };
    });

  const toggleRole = (chargeId: string) =>
    setRoles((prev) =>
      prev.includes(chargeId) ? prev.filter((x) => x !== chargeId) : [...prev, chargeId],
    );

  /* The spec the module will be handed, rebuilt on every keystroke so the
     matrix totals and the refusal message can never disagree with what the
     button is about to commit. */
  const spec: W.DeploymentSpec = useMemo(
    () => ({
      area: area.trim() || 'Unassigned',
      placeId: placeId === NEW_PLACE ? null : placeId || null,
      columns: cols.map((id) => ({ shiftPatternId: id, days: days[id] || [] })),
      cells: cols.flatMap((id) =>
        roles.map((ch) => ({
          shiftPatternId: id,
          chargeId: ch,
          perDay: (days[id] || []).map(() => countOf(id, ch)),
        })),
      ),
    }),
    [area, placeId, cols, days, roles, counts],
  );

  const block = W.deploymentBlock(w, spec);

  /* Totals, per role and overall. The same arithmetic the module runs, done
     here so the operator can check the multiplication they used to do in their
     head before the numbers become a quote. */
  const rows = roles.map((ch) => {
    const c = chargeById(ch)!;
    const rate = rateAt(ch, NOW);
    let shifts = 0;
    let hours = 0;
    let value = 0;
    cols.forEach((id) => {
      const n = countOf(id, ch);
      if (!n) return;
      const sp = library.find((s) => s.id === id);
      const sh = n * (days[id] || []).length;
      shifts += sh;
      hours += sh * W.patternHours(sp);
      value += sh * W.patternHours(sp) * tieredCharge(rate, sh);
    });
    return { charge: c, shifts, hours, value };
  });
  const totals = rows.reduce(
    (a, r) => ({ shifts: a.shifts + r.shifts, hours: a.hours + r.hours, value: a.value + r.value }),
    { shifts: 0, hours: 0, value: 0 },
  );
  const lineCount = cols.reduce(
    (n, id) => n + roles.filter((ch) => countOf(id, ch) > 0).length,
    0,
  );

  const commit = () => {
    if (block) return;
    let pid = spec.placeId;
    if (placeId === NEW_PLACE && newPlace.trim()) pid = W.addPlace(w, newPlace).id;
    const made = W.addDeployment(w, { ...spec, placeId: pid }, ROLES.actingActor());
    if (!made) {
      toast('That deployment could not be added.', { tone: 'critical' });
      return;
    }
    onClose();
    toast(
      `${countLabel(made.length, 'line')} added - ${countLabel(totals.shifts, 'shift')}, ${money(totals.value, { pence: false })}.`,
      { tone: 'healthy' },
    );
  };

  return (
    <Modal
      title={isVar ? 'Add a deployment as a variation' : 'Add a deployment'}
      width={760}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!!block}
            title={block || undefined}
            onClick={commit}
          >
            {lineCount
              ? `Add ${countLabel(lineCount, 'line')} - ${money(totals.value, { pence: false })}`
              : 'Add lines'}
          </button>
        </>
      }
    >
      {isVar ? (
        <p className="text-[13px] text-ink-2 leading-relaxed mb-4">
          The client has already signed, so this is billed on top of the agreed quote.{' '}
          {during ? (
            <>
              <strong className="text-ink">This event is running right now</strong> - the lines will be
              marked as added during the event so they are easy to justify on the invoice.
            </>
          ) : null}
        </p>
      ) : null}

      <div className="space-y-5">
        {/* 1 - WHERE ------------------------------------------------------ */}
        <Step n={1} title="Where">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Area</span>
              <input
                className="field"
                list="dep-areas"
                placeholder="e.g. White - Maple Durham"
                value={area}
                onChange={(e) => setArea(e.target.value)}
              />
              <datalist id="dep-areas">
                {areas.map((a) => (
                  <option key={a} value={a} />
                ))}
              </datalist>
            </label>
            <label className="block">
              <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Place</span>
              <select className="field" value={placeId} onChange={(e) => setPlaceId(e.target.value)}>
                {places.map((pl) => (
                  <option key={pl.id} value={pl.id}>
                    {pl.name}
                  </option>
                ))}
                <option value="">Across the site (no one place)</option>
                <option value={NEW_PLACE}>+ New place...</option>
              </select>
            </label>
          </div>
          {placeId === NEW_PLACE ? (
            <input
              className="field mt-2"
              autoFocus
              placeholder="Name the place, e.g. Alley Farm"
              value={newPlace}
              onChange={(e) => setNewPlace(e.target.value)}
            />
          ) : null}
        </Step>

        {/* 2 - SHIFT PATTERNS --------------------------------------------- */}
        <Step n={2} title="Shift patterns">
          <div className="flex flex-wrap gap-1.5">
            {library.map((sp) => (
              <button
                key={sp.id}
                type="button"
                className="chip"
                aria-pressed={cols.includes(sp.id)}
                onClick={() => toggleCol(sp.id)}
              >
                <span className="font-semibold">{sp.name}</span>
                <span className="tabular-nums text-[11px] text-ink-3">
                  {sp.start}-{sp.end} · {W.patternHours(sp)}h
                </span>
              </button>
            ))}
            <button
              type="button"
              className="chip border-dashed"
              onClick={() => setCustom(custom ? null : { start: '08:00', end: '17:00' })}
            >
              <Icon name="plus" decorative className="icon-sm" /> Custom
            </button>
          </div>

          {custom ? (
            <div className="well p-3 mt-2.5 flex items-end gap-2.5 flex-wrap">
              <label className="block">
                <span className="block text-[11.5px] text-ink-3 mb-1">From</span>
                <input
                  type="time"
                  className="field tabular-nums"
                  style={{ width: 110 }}
                  value={custom.start}
                  onChange={(e) => setCustom({ ...custom, start: e.target.value })}
                />
              </label>
              <label className="block">
                <span className="block text-[11.5px] text-ink-3 mb-1">To</span>
                <input
                  type="time"
                  className="field tabular-nums"
                  style={{ width: 110 }}
                  value={custom.end}
                  onChange={(e) => setCustom({ ...custom, end: e.target.value })}
                />
              </label>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  const sp = W.addJobPattern(w, '', custom.start, custom.end);
                  toggleCol(sp.id);
                  setCustom(null);
                }}
              >
                Add to this job
              </button>
              <p className="text-[11.5px] text-ink-3 basis-full">
                Saved against this quote only, and offered alongside the standard patterns for the rest of it.
              </p>
            </div>
          ) : null}

          <p className="text-[11.5px] text-ink-3 mt-2">
            Twelve patterns cover about 70% of a festival quote. Pick them rather than retyping the times.
          </p>
        </Step>

        {/* 3 - WHO -------------------------------------------------------- */}
        <Step n={3} title="Who">
          <div className="rounded-[10px] border overflow-hidden" style={{ borderColor: 'var(--surface-line)' }}>
            <div
              className="flex items-center gap-2 px-2.5 py-1.5 border-b"
              style={{ background: 'var(--surface-high)', borderColor: 'var(--surface-line)' }}
            >
              <span className="text-ink-3">
                <Icon name="search" decorative className="icon-sm" />
              </span>
              <input
                className="flex-1 bg-transparent border-0 outline-none text-[13px] text-ink"
                placeholder="Filter roles"
                aria-label="Filter roles"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <div style={{ maxHeight: 160, overflowY: 'auto' }}>
              {shown.map((c) => {
                const on = roles.includes(c.id);
                return (
                  <label
                    key={c.id}
                    className="flex items-center gap-2.5 px-2.5 py-1.5 cursor-pointer border-b last:border-b-0"
                    style={{
                      borderColor: 'var(--surface-line-soft)',
                      background: on ? 'var(--accent-soft)' : undefined,
                    }}
                  >
                    <input type="checkbox" checked={on} onChange={() => toggleRole(c.id)} />
                    <span className="flex-1 text-[13.5px] text-ink">{c.name}</span>
                    <span className="text-[12px] text-ink-3 tabular-nums">
                      {money(c.charge)}/{c.unit}
                    </span>
                  </label>
                );
              })}
              {!shown.length ? (
                <p className="text-[13px] text-ink-3 px-2.5 py-3">No role matches that.</p>
              ) : null}
            </div>
          </div>
        </Step>

        {/* 4 - THE MATRIX ------------------------------------------------- */}
        <Step n={4} title="How many, and on which days">
          {!cols.length || !roles.length ? (
            <div className="well p-4 text-center">
              <p className="text-[13px] text-ink-3">
                {!cols.length ? 'Pick the shift patterns worked at this place.' : 'Tick the roles standing here.'}
              </p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto rounded-[10px] border" style={{ borderColor: 'var(--surface-line)' }}>
                <table className="w-full text-[12.5px]" style={{ borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: 'var(--surface-high)' }}>
                      <th className="text-left px-2.5 py-2 text-[9.5px] uppercase tracking-[0.11em] text-ink-3 font-semibold">
                        Role
                      </th>
                      {cols.map((id) => {
                        const sp = library.find((s) => s.id === id)!;
                        return (
                          <th key={id} className="px-2 py-1.5 align-bottom" style={{ minWidth: 96 }}>
                            <div className="flex flex-col gap-1 items-center">
                              <span className="text-[11.5px] font-semibold text-ink">{sp.name}</span>
                              <span className="text-[10px] text-ink-3 tabular-nums">
                                {sp.start}-{sp.end}
                              </span>
                              <DayDots w={w} days={days[id] || []} onToggle={(d) => toggleDay(id, d)} />
                            </div>
                          </th>
                        );
                      })}
                      {['Shifts', 'Hours', 'Value'].map((h) => (
                        <th
                          key={h}
                          className="text-right px-2.5 py-2 text-[9.5px] uppercase tracking-[0.11em] text-ink-3 font-semibold"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.charge.id} style={{ borderTop: '1px solid var(--surface-line-soft)' }}>
                        <td className="px-2.5 py-1.5 text-ink whitespace-nowrap">{r.charge.name}</td>
                        {cols.map((id) => (
                          <td key={id} className="px-2 py-1.5 text-center">
                            <input
                              type="text"
                              inputMode="numeric"
                              className="field text-center tabular-nums"
                              style={{ width: 46, padding: '4px 0' }}
                              placeholder="-"
                              aria-label={`${r.charge.name}, ${library.find((s) => s.id === id)?.name}`}
                              value={counts[cellKey(id, r.charge.id)] ?? ''}
                              onChange={(e) =>
                                setCounts({
                                  ...counts,
                                  [cellKey(id, r.charge.id)]: e.target.value.replace(/[^0-9]/g, ''),
                                })
                              }
                            />
                          </td>
                        ))}
                        <td className="px-2.5 py-1.5 text-right tabular-nums text-ink-2">{r.shifts || '-'}</td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums text-ink-2">
                          {r.hours ? Math.round(r.hours * 10) / 10 : '-'}
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums text-ink font-semibold">
                          {r.value ? money(r.value, { pence: false }) : '-'}
                        </td>
                      </tr>
                    ))}
                    <tr style={{ background: 'var(--surface-high)', borderTop: '1px solid var(--surface-line)' }}>
                      <td
                        className="px-2.5 py-2 text-right text-[9.5px] uppercase tracking-[0.11em] text-ink-3 font-semibold"
                        colSpan={cols.length + 1}
                      >
                        Deployment
                      </td>
                      <td className="px-2.5 py-2 text-right tabular-nums font-semibold text-ink">{totals.shifts}</td>
                      <td className="px-2.5 py-2 text-right tabular-nums font-semibold text-ink">
                        {Math.round(totals.hours * 10) / 10}
                      </td>
                      <td className="px-2.5 py-2 text-right tabular-nums font-semibold text-ink">
                        {money(totals.value, { pence: false })}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="text-[11.5px] text-ink-3 mt-2">
                A blank cell means that role does not work that pattern here. Click a day square to add or
                remove a day from that pattern.
              </p>
            </>
          )}
        </Step>

        {block && (cols.length || roles.length) ? (
          <div className="rounded-[10px] p-3" style={{ background: TONE_BG.critical }} role="alert">
            <div className="flex gap-2">
              <span style={{ color: TONE_HEX.critical }}>
                <Icon name="alert" decorative className="icon-sm" />
              </span>
              <p className="text-[13px] text-ink-2 leading-relaxed">{block}</p>
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/** A numbered step. The number is the order of work, not decoration. */
function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-2.5">
        <span
          className="grid place-items-center text-[10.5px] font-semibold text-white rounded-[4px]"
          style={{ width: 17, height: 17, background: 'var(--accent)' }}
          aria-hidden="true"
        >
          {n}
        </span>
        <h3 className="text-[10.5px] uppercase tracking-[0.13em] text-ink-2 font-semibold">{title}</h3>
      </div>
      {children}
    </section>
  );
}

/* ------------------------------------------------------ copy to places ---
   The strongest repetition on a real quote is one pattern across many car
   parks: `06:00-15:00` appears at twelve different places on the Reading
   sheet.

   Copy AFTER verify, deliberately. Making step 1 of the builder a multi-select
   of places would generate a places x windows x roles matrix full of cells
   that were never real, and deleting seven wrong lines is worse work than
   adding eleven right ones. Here the operator duplicates a block they have
   already checked.                                                      --- */

export function CopyDeploymentDialog({
  w,
  deploymentKey,
  onClose,
}: {
  w: W.Wof;
  deploymentKey: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const view = W.deployments(w).find((d) => d.key === deploymentKey);
  const [picked, setPicked] = useState<string[]>([]);
  const [newPlace, setNewPlace] = useState('');

  if (!view) {
    onClose();
    return null;
  }

  const others = (w.places || []).filter((pl) => pl.id !== view.placeId);
  const toggle = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const perPlace = view.value;
  const commit = () => {
    const ids = [...picked];
    if (newPlace.trim()) ids.push(W.addPlace(w, newPlace).id);
    if (!ids.length) return;
    const made = W.copyDeploymentToPlaces(w, deploymentKey, ids, ROLES.actingActor());
    onClose();
    toast(
      made.length
        ? `Copied to ${countLabel(ids.length, 'place')} - ${countLabel(made.length, 'line')} added.`
        : 'Nothing was copied.',
      { tone: made.length ? 'healthy' : 'critical' },
    );
  };

  const total = (picked.length + (newPlace.trim() ? 1 : 0)) * perPlace;

  return (
    <Modal
      title="Copy this deployment"
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
            disabled={!picked.length && !newPlace.trim()}
            onClick={commit}
          >
            {total ? `Copy - ${money(total, { pence: false })}` : 'Copy'}
          </button>
        </>
      }
    >
      <div className="well p-3 mb-4">
        <p className="text-[13px] text-ink">
          <strong>{view.area}</strong> - {view.placeName}
        </p>
        <p className="text-[12px] text-ink-3 mt-0.5">
          {countLabel(view.columns.length, 'shift pattern')} ·{' '}
          {countLabel(view.lines.length, 'line')} · {countLabel(view.shifts, 'shift')} ·{' '}
          {money(view.value, { pence: false })}
        </p>
      </div>

      <p className="text-[13px] text-ink-2 leading-relaxed mb-3">
        The same patterns, roles, days and headcounts, at another place. Adjust the counts afterwards in the
        quote - copying gets the shape right, and the shape is most of the typing.
      </p>
      {others.length ? (
        <div
          className="rounded-[10px] border overflow-hidden mb-3"
          style={{ borderColor: 'var(--surface-line)' }}
        >
          {others.map((pl) => (
            <label
              key={pl.id}
              className="flex items-center gap-2.5 px-3 py-2 cursor-pointer border-b last:border-b-0"
              style={{
                borderColor: 'var(--surface-line-soft)',
                background: picked.includes(pl.id) ? 'var(--accent-soft)' : undefined,
              }}
            >
              <input type="checkbox" checked={picked.includes(pl.id)} onChange={() => toggle(pl.id)} />
              <span className="flex-1 text-[13.5px] text-ink">{pl.name}</span>
              <span className="text-[12px] text-ink-3 tabular-nums">
                {money(perPlace, { pence: false })}
              </span>
            </label>
          ))}
        </div>
      ) : (
        <p className="text-[13px] text-ink-3 mb-3">
          This job has no other places yet. Name one below and it will be added to the register.
        </p>
      )}

      <label className="block">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Or a new place</span>
        <input
          className="field"
          placeholder="e.g. Gravel Track"
          value={newPlace}
          onChange={(e) => setNewPlace(e.target.value)}
        />
      </label>
    </Modal>
  );
}

/* -------------------------------------------------------- clone last year ---
   Reading 2026 is Reading 2025 with new dates and adjusted counts. This is the
   largest single saving in the whole model, and it is one dialog with a list in
   it.                                                                     --- */

export function CloneDeploymentsDialog({ w, onClose }: { w: W.Wof; onClose: () => void }) {
  const toast = useToast();
  const sources = W.cloneSources(w);
  const [fromId, setFromId] = useState(sources[0]?.id || '');
  const from = sources.find((x) => x.id === fromId);

  /* What it would land as, worked out before the operator commits. Days are
     remapped through their PHASE, so a shorter run genuinely loses days rather
     than folding two of them onto one. */
  const preview = from
    ? (() => {
        let kept = 0;
        let dropped = 0;
        (from.patterns || []).forEach((pat) =>
          pat.days.forEach((d) => (W.remapDay(from, w, d) === null ? dropped++ : kept++)),
        );
        return { blocks: W.deployments(from).length, kept, dropped };
      })()
    : null;

  return (
    <Modal
      title="Start from a previous job"
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
            disabled={!from}
            onClick={() => {
              if (!from) return;
              const r = W.cloneDeployments(from, w, ROLES.actingActor());
              onClose();
              toast(
                r.lines
                  ? `Copied ${countLabel(r.lines, 'line')} from ${from.ref} - ${money(r.value, { pence: false })}.` +
                    (r.droppedDays ? ` ${countLabel(r.droppedDays, 'day')} had nowhere to land on this run.` : '')
                  : 'Nothing was copied.',
                { tone: r.lines ? 'healthy' : 'critical' },
              );
            }}
          >
            Copy the deployments
          </button>
        </>
      }
    >
      {!sources.length ? (
        <p className="text-[13px] text-ink-2 leading-relaxed">
          This client has no earlier job with deployments on it. Build the first one and next year starts from
          this quote.
        </p>
      ) : (
        <>
          <p className="text-[13px] text-ink-2 leading-relaxed mb-4">
            Areas, places, shift patterns, roles and headcounts, copied across.{' '}
            <strong className="text-ink">Priced at today&rsquo;s rate card</strong>, not last year&rsquo;s, and
            days are matched by phase - build stays build, event day 3 stays event day 3.
          </p>

          <label className="block mb-3">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Copy from</span>
            <select className="field" value={fromId} onChange={(e) => setFromId(e.target.value)}>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.ref} - {s.title}
                </option>
              ))}
            </select>
          </label>

          {from && preview ? (
            <div className="well p-3">
              <p className="text-[13px] text-ink">
                {countLabel(preview.blocks, 'deployment')} · {countLabel(preview.kept, 'day')} of cover lands
                on this run
              </p>
              <p className="text-[12px] text-ink-3 mt-0.5">
                {from.title} runs {W.phaseSummary(from) || countLabel(W.eventDays(from), 'day')}; this job runs{' '}
                {W.phaseSummary(w) || countLabel(W.eventDays(w), 'day')}.
              </p>
              {preview.dropped ? (
                <p className="text-[12px] mt-1.5" style={{ color: TONE_HEX.atRisk }}>
                  {countLabel(preview.dropped, 'day')} of cover has nowhere to land and will be dropped. Check
                  those blocks afterwards.
                </p>
              ) : null}
            </div>
          ) : null}

          {W.deployments(w).length ? (
            <p className="text-[12px] text-ink-3 mt-3">
              This quote already has {countLabel(W.deployments(w).length, 'deployment')}. Copying adds to them
              rather than replacing them.
            </p>
          ) : null}
        </>
      )}
    </Modal>
  );
}
