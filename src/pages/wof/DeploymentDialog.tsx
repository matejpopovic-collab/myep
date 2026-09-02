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
import { charge as chargeById, client as clientById, NOW, tieredCharge } from '@/data/db';
import * as RATES from '@/lib/rates';
import * as W from '@/lib/wof';
import * as ROLES from '@/lib/roles';
import * as CHARGES_LIB from '@/lib/charges';
import * as HOP from '@/lib/hop';
import type { Charge, ChargeKind } from '@/data/types';

const NEW_PLACE = ' new';
/* Same sentinel, different picker. The area is free text on the model, but
   it is the client document's grouping key (`quotedoc.ts` bands area first),
   so two spellings of one band silently split it on the printed quote. The
   list is the job's own areas; naming a new one is a deliberate step. */
const NEW_AREA = ' new';

/** How an item's hire window is chosen. `custom` reveals two day numbers. */
type ItemWhen = 'deployed' | 'build' | 'event' | 'break' | 'whole' | 'custom';

/* The three things a place can be sold: the people standing in it, the kit
   sitting in it, and the services bought for it. One picker, because that is
   one question - "what is at this car park" - and asking it in two dialogs is
   what had operators adding stewards here and their radios somewhere else. */
const TABS: { kind: ChargeKind; label: string; hint: string }[] = [
  { kind: 'staff', label: 'Staff', hint: 'Charged per person per hour, against the windows above.' },
  { kind: 'kit', label: 'Kit', hint: 'Charged per item per day, on hire for the days this place is worked.' },
  { kind: 'service', label: 'Services', hint: 'Charged once, or per day - no shift and no headcount.' },
];

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

  const [area, setArea] = useState(areas[0] || NEW_AREA);
  const [newArea, setNewArea] = useState('');
  const [placeId, setPlaceId] = useState(places[0]?.id || '');
  const [newPlace, setNewPlace] = useState('');
  const [cols, setCols] = useState<string[]>([]);
  const [days, setDays] = useState<Record<string, number[]>>({});
  const [roles, setRoles] = useState<string[]>([]);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState('');
  const [custom, setCustom] = useState<{ start: string; end: string } | null>(null);
  const [tab, setTab] = useState<ChargeKind>('staff');
  /** Kit and services picked here, by charge id, with the quantity as typed. */
  const [things, setThings] = useState<string[]>([]);
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [subHire, setSubHire] = useState<Record<string, boolean>>({});
  /**
   * Which days each item is wanted, as a phase rather than two numbers.
   * `deployed` - the default - means the days this place is worked, which is
   * right for the kit the stewards are holding and wrong for everything that
   * goes out with the build crew.
   */
  const [when, setWhen] = useState<Record<string, ItemWhen>>({});
  const [range, setRange] = useState<Record<string, { from: string; to: string }>>({});

  // `quotable()`, not `CHARGES` - a retired rate is still on every job that
  // used it and still resolves everywhere it is read, but it is not offered on
  // anything new. Replacement charges are kept off for the reason `hop.ts`
  // gives: they price kit that did not come back, not kit you can hire.
  const offered = CHARGES_LIB.quotable().filter((c) => !HOP.isReplacementCharge(c.id));
  const shown = offered.filter(
    (c) => c.kind === tab && c.name.toLowerCase().includes(filter.trim().toLowerCase()),
  );
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

  // Kit and services are picked from the same list and land in a different
  // place, because they are priced differently. A radio has no window to sit
  // in and no headcount to carry - it has a quantity and a number of days.
  const toggleThing = (chargeId: string) =>
    setThings((prev) =>
      prev.includes(chargeId) ? prev.filter((x) => x !== chargeId) : [...prev, chargeId],
    );
  const isPicked = (c: { id: string; kind: ChargeKind }) =>
    c.kind === 'staff' ? roles.includes(c.id) : things.includes(c.id);
  const togglePicked = (c: { id: string; kind: ChargeKind }) =>
    c.kind === 'staff' ? toggleRole(c.id) : toggleThing(c.id);
  const pickedIn = (kind: ChargeKind) =>
    kind === 'staff'
      ? roles.length
      : things.filter((id) => chargeById(id)?.kind === kind).length;
  const qtyOf = (id: string) => Number(qtys[id]) || 0;

  const hire = W.itemHire(w, cols.map((id) => ({ days: days[id] || [] })));
  const allDays = W.eventDays(w);

  /* The window each item is actually wanted for. The deployment's own span is
     the default and the right answer for the kit the stewards are holding;
     everything that goes out with the build crew or comes off at breakdown
     says so here, so the warehouse is told rather than guessing. */
  const windowFor = (id: string): { from: number; to: number } => {
    const choice = when[id] || 'deployed';
    if (choice === 'custom') {
      const r = range[id] || { from: '', to: '' };
      const from = Math.min(Math.max(Number(r.from) || 1, 1), allDays);
      const to = Math.min(Math.max(Number(r.to) || from, from), allDays);
      return { from, to };
    }
    if (choice !== 'deployed') {
      return W.phaseWindow(w, choice === 'whole' ? 'whole' : choice) || { from: 1, to: allDays };
    }
    return hire || { from: 1, to: allDays };
  };


  /** The band as it will be stored: the one picked, or the one being named. */
  const areaName = (area === NEW_AREA ? newArea : area).trim();

  /* The spec the module will be handed, rebuilt on every keystroke so the
     matrix totals and the refusal message can never disagree with what the
     button is about to commit. */
  const spec: W.DeploymentSpec = useMemo(
    () => ({
      area: areaName || 'Unassigned',
      placeId: placeId === NEW_PLACE ? null : placeId || null,
      columns: cols.map((id) => ({ shiftPatternId: id, days: days[id] || [] })),
      cells: cols.flatMap((id) =>
        roles.map((ch) => ({
          shiftPatternId: id,
          chargeId: ch,
          perDay: (days[id] || []).map(() => countOf(id, ch)),
        })),
      ),
      items: things.map((id) => ({
        chargeId: id,
        qty: qtyOf(id),
        hire: windowFor(id),
        ...(subHire[id] ? { subHire: true } : {}),
      })),
    }),
    [areaName, placeId, cols, days, roles, counts, things, qtys, subHire, when, range],
  );

  const block = W.deploymentBlock(w, spec);

  /* Totals, per role and overall. The same arithmetic the module runs, done
     here so the operator can check the multiplication they used to do in their
     head before the numbers become a quote. */
  /* Every price on this screen is what THIS ACCOUNT pays — their agreed price,
     their card, or the published rate, in that order, exactly as `W.line()`
     will resolve it when the button is pressed. Priced from `rateAt` the
     preview would total one figure and the quote another, and the operator
     would find out on the document. */
  const priced = (id: string) => RATES.rateFor(id, w.clientId, NOW);
  const basisOf = (id: string) => priced(id)?.basis || 'standard';

  /* Said once, under the list, rather than on every row. The rows carry the
     figure; this says whose figure it is — because "£17.39" with no owner is
     the number an operator later swears the rate card does not have. */
  const agreedCount = RATES.clientPrices(w.clientId).length;
  const clientRateNote = (() => {
    const card = RATES.clientCard(w.clientId);
    const who = clientById(w.clientId)?.name || 'this client';
    const cardPart =
      card.factor === 1
        ? `Prices are what ${who} pays: the published rate`
        : `Prices are what ${who} pays: the ${card.label} card`;
    return agreedCount
      ? `${cardPart}, with ${countLabel(agreedCount, 'line')} at a rate agreed with them.`
      : `${cardPart}.`;
  })();

  const rows = roles.map((ch) => {
    const c = chargeById(ch)!;
    const rate = priced(ch);
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
  const staffTotals = rows.reduce(
    (a, r) => ({ shifts: a.shifts + r.shifts, hours: a.hours + r.hours, value: a.value + r.value }),
    { shifts: 0, hours: 0, value: 0 },
  );

  /* Kit and services. The days come from the windows worked here - the first
     day anybody is on this car park to the last - because that is how long the
     barriers are standing in it. An `each` charge bills once however long the
     job runs: a traffic management plan is written one time. */
  const itemRows = things.map((id) => {
    const c = chargeById(id)!;
    const rate = priced(id);
    const qty = qtyOf(id);
    const win = windowFor(id);
    const units = c.unit === 'each' ? 1 : win.to - win.from + 1;
    return {
      charge: c,
      qty,
      units,
      win,
      sub: !!subHire[id],
      value: qty * units * tieredCharge(rate, qty),
    };
  });
  const itemValue = itemRows.reduce((s, r) => s + r.value, 0);
  const totals = { ...staffTotals, value: staffTotals.value + itemValue };
  const lineCount =
    cols.reduce((n, id) => n + roles.filter((ch) => countOf(id, ch) > 0).length, 0) +
    itemRows.filter((r) => r.qty > 0).length;

  /* ------------------------------------------------------------ the shelf ---
     The same rule the add-line dialog runs, for the same reason: the Order gate
     checks the yard once, on the way into Order, and a deployment added to a
     signed job passes it from behind. Past Order this refuses; before it, it
     says the same sentence and lets the operator carry on pricing.
     Sub-hire clears it - that line is somebody else's stock. -------------- */
  const shortfalls = itemRows
    .filter((r) => r.charge.kind === 'kit' && r.qty > 0 && !r.sub)
    .map((r) => HOP.prospectiveShortfall(w, r.charge.id, r.qty))
    .filter((s): s is NonNullable<typeof s> => !!s);
  const committed = W.atLeast(w, 'order') && !W.isTerminal(w.stage) && w.active;
  const stockBlock =
    committed && shortfalls.length
      ? `Not enough ${shortfalls[0].name} in stock - ${HOP.describeShortfall(shortfalls[0], { name: false })}`
      : null;

  const commit = () => {
    if (block || stockBlock) return;
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
            disabled={!!block || !!stockBlock}
            title={block || stockBlock || undefined}
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
              <select className="field" value={area} onChange={(e) => setArea(e.target.value)}>
                {areas.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
                <option value={NEW_AREA}>+ New area...</option>
              </select>
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
          {area === NEW_AREA ? (
            <input
              className="field mt-2"
              autoFocus
              placeholder="Name the area, e.g. White - Maple Durham"
              value={newArea}
              onChange={(e) => setNewArea(e.target.value)}
            />
          ) : null}
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

        {/* 3 - WHO AND WHAT ----------------------------------------------- */}
        <Step n={3} title="Who and what">
          <div className="rounded-[10px] border overflow-hidden" style={{ borderColor: 'var(--surface-line)' }}>
            <div
              className="flex items-stretch border-b"
              style={{ background: 'var(--surface-high)', borderColor: 'var(--surface-line)' }}
              role="tablist"
              aria-label="What is at this place"
            >
              {TABS.map((t) => {
                const on = tab === t.kind;
                const n = pickedIn(t.kind);
                return (
                  <button
                    key={t.kind}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => setTab(t.kind)}
                    className="flex items-center gap-1.5 px-3 py-2 text-[12.5px] font-semibold border-0 cursor-pointer"
                    style={{
                      background: on ? 'var(--surface)' : 'transparent',
                      color: on ? 'var(--ink)' : 'var(--ink-3)',
                      borderBottom: `2px solid ${on ? 'var(--accent)' : 'transparent'}`,
                    }}
                  >
                    {t.label}
                    {n ? (
                      <span
                        className="pill tabular-nums"
                        style={{ background: TONE_BG.info, color: TONE_HEX.info, padding: '0 5px', fontSize: 10.5 }}
                      >
                        {n}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            <div
              className="flex items-center gap-2 px-2.5 py-1.5 border-b"
              style={{ background: 'var(--surface-high)', borderColor: 'var(--surface-line)' }}
            >
              <span className="text-ink-3">
                <Icon name="search" decorative className="icon-sm" />
              </span>
              <input
                className="flex-1 bg-transparent border-0 outline-none text-[13px] text-ink"
                placeholder={tab === 'staff' ? 'Filter roles' : 'Filter the rate card'}
                aria-label={tab === 'staff' ? 'Filter roles' : 'Filter the rate card'}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <div style={{ maxHeight: 160, overflowY: 'auto' }}>
              {shown.map((c) => {
                const on = isPicked(c);
                return (
                  <label
                    key={c.id}
                    className="flex items-center gap-2.5 px-2.5 py-1.5 cursor-pointer border-b last:border-b-0"
                    style={{
                      borderColor: 'var(--surface-line-soft)',
                      background: on ? 'var(--accent-soft)' : undefined,
                    }}
                  >
                    <input type="checkbox" checked={on} onChange={() => togglePicked(c)} />
                    <span className="flex-1 text-[13.5px] text-ink">{c.name}</span>
                    <span
                      className={`text-[12px] tabular-nums ${basisOf(c.id) === 'standard' ? 'text-ink-3' : 'tip'}`}
                      tabIndex={basisOf(c.id) === 'standard' ? undefined : 0}
                      data-tip={
                        basisOf(c.id) === 'standard'
                          ? undefined
                          : `${basisOf(c.id) === 'client' ? 'Agreed with this client' : `${RATES.clientCard(w.clientId).label} card`} — published ${money(c.charge)}`
                      }
                      style={basisOf(c.id) === 'standard' ? undefined : { color: TONE_HEX.info }}
                    >
                      {money(priced(c.id)?.charge ?? c.charge)}/{c.unit}
                    </span>
                  </label>
                );
              })}
              {!shown.length ? (
                <p className="text-[13px] text-ink-3 px-2.5 py-3">
                  {filter.trim() ? 'Nothing on the rate card matches that.' : 'Nothing on the rate card to offer here.'}
                </p>
              ) : null}
            </div>
          </div>
          <p className="text-[11.5px] text-ink-3 mt-2">
            {TABS.find((t) => t.kind === tab)?.hint}{' '}
            {clientRateNote}
          </p>
        </Step>

        {/* 4 - THE MATRIX ------------------------------------------------- */}
        <Step n={4} title="How many, and on which days">
          {!cols.length && !things.length ? (
            <div className="well p-4 text-center">
              <p className="text-[13px] text-ink-3">Pick the shift patterns worked at this place.</p>
            </div>
          ) : null}
          {cols.length > 0 && !roles.length && !things.length ? (
            <div className="well p-4 text-center">
              <p className="text-[13px] text-ink-3">
                Tick the roles standing here, or the kit that sits here.
              </p>
            </div>
          ) : null}
          {cols.length > 0 && roles.length > 0 ? (
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
                        {/* Named for what this table actually adds up. With kit
                            below it, "Deployment" against the staff subtotal
                            would be a figure the operator could not reconcile
                            with the button. */}
                        {things.length ? 'Staff' : 'Deployment'}
                      </td>
                      <td className="px-2.5 py-2 text-right tabular-nums font-semibold text-ink">
                        {staffTotals.shifts}
                      </td>
                      <td className="px-2.5 py-2 text-right tabular-nums font-semibold text-ink">
                        {Math.round(staffTotals.hours * 10) / 10}
                      </td>
                      <td className="px-2.5 py-2 text-right tabular-nums font-semibold text-ink">
                        {money(staffTotals.value, { pence: false })}
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
          ) : null}
          {things.length > 0 ? <ItemTable
              w={w}
              rows={itemRows}
              qtys={qtys}
              setQtys={setQtys}
              subHire={subHire}
              setSubHire={setSubHire}
              hire={hire}
              when={when}
              setWhen={setWhen}
              range={range}
              setRange={setRange}
            /> : null}
        </Step>

        {shortfalls.length ? (
          <div
            className="rounded-[10px] p-3"
            style={{ background: stockBlock ? TONE_BG.critical : TONE_BG.atRisk }}
            role="alert"
          >
            <div className="flex gap-2">
              <span style={{ color: stockBlock ? TONE_HEX.critical : TONE_HEX.atRisk }}>
                <Icon name="alert" decorative className="icon-sm" />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] text-ink font-semibold mb-1">
                  Not enough {shortfalls[0].name} in stock
                </p>
                <p className="text-[13px] text-ink-2 leading-relaxed">
                  {HOP.describeShortfall(shortfalls[0], { name: false })}{' '}
                  {stockBlock
                    ? 'This job is already ordered, so the line is a promise rather than a price. Reduce the quantity, or tick sub-hired.'
                    : 'You can still quote it - the shelf is checked again when the job goes to Order.'}
                </p>
                {shortfalls.length > 1 ? (
                  <p className="text-[12px] text-ink-3 mt-1">
                    {countLabel(shortfalls.length - 1, 'other line')} on this deployment{' '}
                    {shortfalls.length === 2 ? 'is' : 'are'} short too.
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {block && (cols.length || roles.length || things.length) ? (
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

interface ItemRow {
  charge: Charge;
  qty: number;
  units: number;
  /** The days this item is wanted for, resolved from its phase choice. */
  win: { from: number; to: number };
  sub: boolean;
  value: number;
}

/* ------------------------------------------------------------- when picker ---
   Phases, not two day numbers. "The radios go out with the build crew" is the
   sentence the warehouse already says, and a phase keeps saying it correctly
   after the dates move - two numbers typed today would still read 1-2 when the
   build grows to three days.                                             --- */
function WhenPicker({
  w, id, name, when, setWhen, range, setRange, deployed, win,
}: {
  w: W.Wof;
  id: string;
  name: string;
  when: ItemWhen;
  setWhen: (v: ItemWhen) => void;
  range: { from: string; to: string } | undefined;
  setRange: (v: { from: string; to: string }) => void;
  deployed: { from: number; to: number } | null;
  win: { from: number; to: number };
}) {
  const allDays = W.eventDays(w);
  const dep = deployed || { from: 1, to: allDays };
  const say = (r: { from: number; to: number } | null) =>
    r ? (r.from === r.to ? `day ${r.from}` : `days ${r.from}-${r.to}`) : '';

  // A phase the job does not have is not offered. A one-day job has no build,
  // and an option that resolves to the whole span is a lie in a dropdown.
  const opts: { value: ItemWhen; label: string }[] = [
    { value: 'deployed', label: `As deployed (${say(dep)})` },
    ...(W.phaseWindow(w, 'build')
      ? [{ value: 'build' as ItemWhen, label: `Build (${say(W.phaseWindow(w, 'build'))})` }] : []),
    { value: 'event', label: `Event (${say(W.phaseWindow(w, 'event'))})` },
    ...(W.phaseWindow(w, 'break')
      ? [{ value: 'break' as ItemWhen, label: `Breakdown (${say(W.phaseWindow(w, 'break'))})` }] : []),
    { value: 'whole', label: `Whole job (${say({ from: 1, to: allDays })})` },
    { value: 'custom', label: 'Custom days...' },
  ];

  return (
    <>
      <select
        className="field"
        style={{ minWidth: 178 }}
        aria-label={`When ${name} is wanted`}
        value={when}
        onChange={(e) => setWhen(e.target.value as ItemWhen)}
      >
        {opts.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {when === 'custom' ? (
        <span className="flex items-center gap-1 mt-1 text-[11px] text-ink-3">
          day
          <input
            type="text"
            inputMode="numeric"
            className="field text-center tabular-nums"
            style={{ width: 40, padding: '2px 0' }}
            aria-label={`${name}, first day`}
            value={range?.from ?? String(win.from)}
            onChange={(e) =>
              setRange({ from: e.target.value.replace(/[^0-9]/g, ''), to: range?.to ?? String(win.to) })
            }
          />
          to
          <input
            type="text"
            inputMode="numeric"
            className="field text-center tabular-nums"
            style={{ width: 40, padding: '2px 0' }}
            aria-label={`${name}, last day`}
            value={range?.to ?? String(win.to)}
            onChange={(e) =>
              setRange({ from: range?.from ?? String(win.from), to: e.target.value.replace(/[^0-9]/g, '') })
            }
          />
        </span>
      ) : null}
      <span className="sr-only" data-item={id} />
    </>
  );
}

/* ------------------------------------------------------ kit and services ---
   The matrix above is people against windows. This is not that table with
   different rows: kit has no window and no headcount, and pretending it does
   is how a radio ends up billed by the hour. One quantity, the days this place
   is worked, and the price that falls out of the two.                    --- */
function ItemTable({
  w,
  rows,
  qtys,
  setQtys,
  subHire,
  setSubHire,
  hire,
  when,
  setWhen,
  range,
  setRange,
}: {
  w: W.Wof;
  rows: ItemRow[];
  qtys: Record<string, string>;
  setQtys: (v: Record<string, string>) => void;
  subHire: Record<string, boolean>;
  setSubHire: (v: Record<string, boolean>) => void;
  hire: { from: number; to: number } | null;
  when: Record<string, ItemWhen>;
  setWhen: (v: Record<string, ItemWhen>) => void;
  range: Record<string, { from: string; to: string }>;
  setRange: (v: Record<string, { from: string; to: string }>) => void;
}) {
  const total = rows.reduce((s, r) => s + r.value, 0);
  return (
    <div className="mt-3">
      <div className="overflow-x-auto rounded-[10px] border" style={{ borderColor: 'var(--surface-line)' }}>
        <table className="w-full text-[12.5px]" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'var(--surface-high)' }}>
              {['Kit and services here', 'Quantity', 'Wanted', 'Billed', 'Value'].map((h, i) => (
                <th
                  key={h}
                  className={`px-2.5 py-2 text-[9.5px] uppercase tracking-[0.11em] text-ink-3 font-semibold ${
                    i === 0 ? 'text-left' : i === 1 ? 'text-center' : 'text-right'
                  }`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.charge.id} style={{ borderTop: '1px solid var(--surface-line-soft)' }}>
                <td className="px-2.5 py-1.5">
                  <span className="block text-ink">{r.charge.name}</span>
                  {r.charge.kind === 'kit' ? (
                    <label className="flex items-center gap-1.5 mt-1 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={r.sub}
                        onChange={(e) => setSubHire({ ...subHire, [r.charge.id]: e.target.checked })}
                      />
                      <span
                        className="text-[11px] text-ink-3 tip"
                        data-tip="Supplied by a third party, so it draws nothing from the yard and can never be short"
                      >
                        Sub-hired - not from the yard
                      </span>
                    </label>
                  ) : null}
                </td>
                <td className="px-2 py-1.5 text-center">
                  <input
                    type="text"
                    inputMode="numeric"
                    className="field text-center tabular-nums"
                    style={{ width: 56, padding: '4px 0' }}
                    placeholder="-"
                    aria-label={`${r.charge.name}, quantity`}
                    value={qtys[r.charge.id] ?? ''}
                    onChange={(e) =>
                      setQtys({ ...qtys, [r.charge.id]: e.target.value.replace(/[^0-9]/g, '') })
                    }
                  />
                </td>
                <td className="px-2 py-1.5">
                  <WhenPicker
                    w={w}
                    id={r.charge.id}
                    name={r.charge.name}
                    when={when[r.charge.id] || 'deployed'}
                    setWhen={(v) => setWhen({ ...when, [r.charge.id]: v })}
                    range={range[r.charge.id]}
                    setRange={(v) => setRange({ ...range, [r.charge.id]: v })}
                    deployed={hire}
                    win={r.win}
                  />
                </td>
                <td className="px-2.5 py-1.5 text-right tabular-nums text-ink-2">
                  {r.charge.unit === 'each'
                    ? 'once'
                    : `${r.units} ${r.charge.unit}${r.units === 1 ? '' : 's'}`}
                </td>
                <td className="px-2.5 py-1.5 text-right tabular-nums text-ink font-semibold">
                  {r.value ? money(r.value, { pence: false }) : '-'}
                </td>
              </tr>
            ))}
            <tr style={{ background: 'var(--surface-high)', borderTop: '1px solid var(--surface-line)' }}>
              <td
                className="px-2.5 py-2 text-right text-[9.5px] uppercase tracking-[0.11em] text-ink-3 font-semibold"
                colSpan={4}
              >
                Kit and services
              </td>
              <td className="px-2.5 py-2 text-right tabular-nums font-semibold text-ink">
                {money(total, { pence: false })}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-[11.5px] text-ink-3 mt-2">
        {hire
          ? `"As deployed" is days ${hire.from} to ${hire.to} - the days this place is worked.`
          : `"As deployed" is the whole ${countLabel(W.eventDays(w), 'day')} of the job.`}{' '}
        Say when each item is wanted and the warehouse picks it in that wave, rather than pulling
        everything on the first day.
      </p>
    </div>
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
