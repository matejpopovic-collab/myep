/* ============================================================================
   WOF DETAIL — dialogs
   ----------------------------------------------------------------------------
   Every one of these writes to the WOF history. That is the point of routing
   them through `lib/wof` rather than mutating fields inline: an audit trail of
   who moved what, and past which warning.
   ========================================================================== */

import { useState } from 'react';
import { ConfirmDestructive, Modal } from '@/components/Modal';
import { Icon } from '@/components/Icon';
import { ChargePicker } from '@/components/wof-ui';
import { useToast } from '@/components/Toast';
import { TONE_BG, TONE_HEX, TONE_LINE } from '@/lib/status';
import { countLabel, fmtRange, money } from '@/lib/format';
import {
  DEPARTMENTS, MANAGERS, NOW,
  charge as chargeById, client as clientById, event as eventById, rateAt, tieredCharge,
} from '@/data/db';
import * as W from '@/lib/wof';
import * as CHARGES_LIB from '@/lib/charges';
import * as RATES from '@/lib/rates';
import * as HOP from '@/lib/hop';
import * as ROLES from '@/lib/roles';
import * as NOTIFY from '@/lib/notifications';
import { LiveWindowField } from './LiveWindowField';

/* ------------------------------------------------------------- advance -- */

export function AdvanceDialog({ w, onClose }: { w: W.Wof; onClose: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const g = W.gate(w);
  const target = g.target as string;
  const st = W.stage(target) || W.TERMINAL[target as W.TerminalId] || { label: target, blurb: '' };
  // Only a job with people on it seeds a staffing record. A kit hire becomes an
  // order without creating an empty rota for Jake's team to stare at.
  const staffLines = w.lines.filter((l) => l.kind === 'staff').length;
  const willSeed = target === 'order' && !w.eventId && staffLines > 0;
  const kitOnlyOrder = target === 'order' && !w.eventId && staffLines === 0;
  const willInvoice = target === 'invoice' && !w.invoice;
  const dep = W.deposit(w);

  return (
    <Modal
      title={`Move to ${st.label}`}
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
            onClick={() => {
              const r = W.advance(w, { note: note.trim() || undefined });
              onClose();
              if (r.ok) {
                toast(
                  `Moved to ${st.label}.${r.gate.warn.length ? ' Overrides recorded in the history.' : ''}`,
                  { tone: r.gate.warn.length ? 'atRisk' : 'healthy' },
                );
              } else {
                toast(r.gate.block[0], { tone: 'critical' });
              }
            }}
          >
            {g.warn.length ? 'Continue anyway' : `Move to ${st.label}`}
          </button>
        </>
      }
    >
      <p className="text-[13.5px] text-ink-2 leading-relaxed">{'blurb' in st ? st.blurb : ''}</p>

      {g.warn.length ? (
        <div className="mt-4 rounded-lg p-3" style={{ background: TONE_BG.atRisk }}>
          <div className="text-[13px] font-semibold text-ink mb-1.5">
            {g.warn.length} thing{g.warn.length > 1 ? 's' : ''} to note before you continue
          </div>
          <ul className="text-[13px] text-ink-2 leading-relaxed space-y-1">
            {g.warn.map((m, i) => (
              <li key={i}>· {m}</li>
            ))}
          </ul>
          <p className="text-[11.5px] text-ink-3 mt-2">
            Continuing is allowed. It will be written into the WOF history as an override.
          </p>
        </div>
      ) : null}

      {willSeed ? (
        <div className="mt-4 rounded-lg p-3" style={{ background: TONE_BG.info }}>
          <div className="text-[13px] font-semibold text-ink mb-1">This creates the event</div>
          <p className="text-[13px] text-ink-2 leading-relaxed">
            Confirming the order seeds an entry on the event calendar and creates {staffLines} shift role
            group{staffLines === 1 ? '' : 's'} in the staff allocation tool, ready for Jake's team to fill.
          </p>
        </div>
      ) : null}

      {kitOnlyOrder ? (
        <div className="mt-4 rounded-lg p-3" style={{ background: TONE_BG.info }}>
          <div className="text-[13px] font-semibold text-ink mb-1">No staffing on this job</div>
          <p className="text-[13px] text-ink-2 leading-relaxed">
            Nothing on the quote needs people, so no shifts are created and the job will not appear on the
            staffing screen. It stays on the event calendar and in the pipeline.
          </p>
        </div>
      ) : null}

      {willInvoice ? (
        <div className="mt-4 rounded-lg p-3" style={{ background: TONE_BG.info }}>
          <div className="text-[13px] font-semibold text-ink mb-1">This raises an invoice</div>
          <p className="text-[13px] text-ink-2 leading-relaxed">
            For {money(W.contractValue(w) - dep.due, { pence: false })} — contract value of{' '}
            {money(W.contractValue(w), { pence: false })}
            {dep.due > 0 ? ` net of the ${dep.pct}% deposit` : ''} — due in{' '}
            {clientById(w.clientId)?.termsDays} days.
          </p>
        </div>
      ) : null}

      <label className="block mt-4">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Note (optional)</span>
        <input
          className="field"
          placeholder="Anything the next person should know"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
    </Modal>
  );
}

/* --------------------------------------------------------- step back -- */

/**
 * Correcting a stage that was moved by mistake.
 *
 * Two things make this safe rather than a second way to break a job: the reason
 * is required and goes in the history, and the dialog lists every side effect
 * that will survive the move. A stage is a marker, not a transaction log —
 * stepping back from Order does not un-assign the fifteen people already on the
 * shifts it seeded.
 */
export function RevertStageDialog({ w, onClose }: { w: W.Wof; onClose: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const preview = W.revertPreview(w);

  if (!preview) return null;

  const fromLabel = W.stage(preview.from)?.label ?? preview.from;
  const toLabel = W.stage(preview.to)?.label ?? preview.to;

  return (
    <Modal
      title={`Step back to ${toLabel}`}
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
            disabled={!reason.trim()}
            onClick={() => {
              W.revertStage(w, reason);
              onClose();
              toast(`Moved back to ${toLabel}. The reason is on the WOF history.`, { tone: 'info' });
            }}
          >
            Step back
          </button>
        </>
      }
    >
      <p className="text-[13.5px] text-ink-2 leading-relaxed mb-4">
        This moves the job from <strong className="text-ink">{fromLabel}</strong> back to{' '}
        <strong className="text-ink">{toLabel}</strong>. Use it to correct a stage moved by mistake — not to
        cancel a job, which is a different decision.
      </p>

      {preview.keeps.length ? (
        <div className="rounded-lg p-3 mb-4" style={{ background: TONE_BG.atRisk }}>
          <div className="text-[13px] font-semibold text-ink mb-1.5">
            What this does <em>not</em> undo
          </div>
          <ul className="text-[12.5px] text-ink-2 leading-relaxed space-y-1">
            {preview.keeps.map((k, i) => (
              <li key={i}>· {k}</li>
            ))}
          </ul>
          <p className="text-[11.5px] text-ink-3 mt-2">
            Undo any of these separately if that is what you meant.
          </p>
        </div>
      ) : null}

      <label className="block">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
          Why are you stepping back? <span className="font-normal text-ink-3">Required</span>
        </span>
        <textarea
          className="field"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Moved to Job by mistake — the event does not run until September."
        />
        <span className="block text-[11.5px] text-ink-3 mt-1.5">
          Goes on the history with your name. A stage that moves backwards without a reason is
          indistinguishable from a bug six months later.
        </span>
      </label>
    </Modal>
  );
}

/* ------------------------------------------------------------ add line -- */

export function AddLineDialog({
  w,
  kind,
  onClose,
}: {
  w: W.Wof;
  kind: 'quote' | 'variation';
  onClose: () => void;
}) {
  const toast = useToast();
  const isVar = kind === 'variation';
  const during = isVar && new Date(w.start) <= NOW && NOW <= new Date(w.end);

  const [chargeId, setChargeId] = useState(CHARGES_LIB.quotable()[0].id);
  const [qty, setQty] = useState('1');
  const [units, setUnits] = useState('1');
  const [desc, setDesc] = useState('');
  const [note, setNote] = useState('');
  const [subHire, setSubHire] = useState(false);

  const ch = chargeById(chargeId)!;
  /* THIS ACCOUNT's rate, not the published one. The line about to be created
     resolves through the client's card and price list, so a preview built from
     `rateAt` would quote one number on screen and another onto the job — the
     exact class of lie this whole rebuild exists to remove. */
  const rate = RATES.rateFor(ch.id, w.clientId, NOW)!;
  const published = rateAt(ch.id, NOW)!;
  const q = Number(qty) || 0;
  // `each` is a count of things, not a duration — there is nothing for a
  // second number to multiply, and leaving the input live invited exactly the
  // bug this locks shut: type a stray 2 or 3 into it and the line silently
  // doubles or triples, with no guard to catch it (`spanBlock` below only
  // fires for day/hour charges, on purpose — see its own comment). So `each`
  // charges never read the typed field at all; they bill qty x 1.
  const isEach = ch.unit === 'each';
  const u = isEach ? 1 : Number(units) || 0;
  const applied = tieredCharge(rate, q);
  const unitsLabel = ch.unit === 'hour' ? 'Hours' : ch.unit === 'day' ? 'Days' : 'Units';
  // Refused, not warned — see `spanBlock`. A line billing time the job does not
  // have is over-quoting the client, and shortening it is always available.
  const overrun = W.spanBlock(w, ch.id, u);

  /* ------------------------------------------------------------ the shelf ---
     What this line would be short IF it were added, computed as the quantity is
     typed rather than discovered afterwards.

     The Order gate already refuses a job the yard cannot cover, and that is
     still where a QUOTE meets the shelf — blocking an operator from pricing
     work on a warehouse constraint is how people go back to the spreadsheet.
     But a variation is added to a job that is already ordered, so it passes
     that gate from behind and never meets it again. Hence the split: past
     Order this refuses, before Order it says the same sentence and lets you
     carry on.

     Sub-hire clears it, because a sub-hired line is supplied by somebody else
     and draws no EP stock. The checkbox is here rather than only on the line
     afterwards so the refusal has an escape in the same dialog that raises it.
     ------------------------------------------------------------------------ */
  const isKit = ch.kind === 'kit';
  const shortfall = subHire ? null : HOP.prospectiveShortfall(w, ch.id, q);
  const committed = W.atLeast(w, 'order') && !W.isTerminal(w.stage) && w.active;
  const stockBlock =
    shortfall && committed
      ? `Not enough ${shortfall.name} in stock — ${HOP.describeShortfall(shortfall, { name: false })}`
      : null;

  return (
    <Modal
      title={isVar ? 'Add a variation' : 'Add a quote line'}
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
            disabled={!!overrun || !!stockBlock}
            title={overrun || stockBlock || undefined}
            onClick={() => {
              if (overrun || stockBlock) return;
              const added = W.addLine(w, ch.id, {
                qty: q || 1,
                units: u || 1,
                description: desc.trim() || ch.name,
                note: note.trim(),
                // Whoever is signed in, not the seed's default author. The
                // approval gate reads this to work out who may NOT approve.
                addedBy: ROLES.actingId(),
              });
              // After the line exists, because `setSubHire` is the only writer
              // of that flag and it wants a line to write it on.
              if (isKit && subHire) W.setSubHire(w, added.id, true, ROLES.actingActor());
              onClose();
              toast(isVar ? 'Variation added. It will be invoiced with the job.' : 'Line added to the quote.', {
                tone: 'healthy',
              });
            }}
          >
            {isVar ? 'Add variation' : 'Add line'}
          </button>
        </>
      }
    >
      {isVar ? (
        <p className="text-[13px] text-ink-2 leading-relaxed mb-4">
          The client has already signed, so this is billed on top of the agreed quote.{' '}
          {during ? (
            <>
              <strong className="text-ink">This event is running right now</strong> — the line will be marked
              as added during the event so it is easy to justify on the invoice.
            </>
          ) : null}
        </p>
      ) : null}

      <div className="space-y-4">
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">From the table of charges</span>
          <ChargePicker value={chargeId} onChange={setChargeId} clientId={w.clientId} />
        </label>
        <div className={isEach ? '' : 'grid grid-cols-2 gap-3'}>
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Quantity</span>
            <input className="field" type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} />
          </label>
          {isEach ? null : (
            <label className="block">
              <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">{unitsLabel}</span>
              <input
                className="field"
                type="number"
                min={1}
                step={0.5}
                value={units}
                onChange={(e) => setUnits(e.target.value)}
              />
            </label>
          )}
        </div>

        {overrun ? (
          <div
            className="rounded-lg p-3"
            style={{ background: TONE_BG.critical }}
            role="alert"
          >
            <div className="flex gap-2">
              <span style={{ color: TONE_HEX.critical }}>
                <Icon name="alert" decorative className="icon-sm" />
              </span>
              <p className="text-[13px] text-ink-2 leading-relaxed">{overrun}</p>
            </div>
          </div>
        ) : null}

        {shortfall ? (
          <div
            className="rounded-lg p-3"
            style={{ background: stockBlock ? TONE_BG.critical : TONE_BG.atRisk }}
            role="alert"
          >
            <div className="flex gap-2">
              <span style={{ color: stockBlock ? TONE_HEX.critical : TONE_HEX.atRisk }}>
                <Icon name="alert" decorative className="icon-sm" />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] text-ink font-semibold mb-1">
                  Not enough {shortfall.name} in stock
                </p>
                <p className="text-[13px] text-ink-2 leading-relaxed">
                  {HOP.describeShortfall(shortfall, { name: false })}{' '}
                  {stockBlock
                    ? 'This job is already ordered, so the line is a promise rather than a price. Reduce the quantity, or mark it sub-hire.'
                    : 'You can still quote it — the shelf is checked again when the job goes to Order.'}
                </p>
              </div>
            </div>
          </div>
        ) : null}

        {isKit ? (
          <label className="flex items-start gap-2.5">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={subHire}
              onChange={(e) => setSubHire(e.target.checked)}
            />
            <span className="min-w-0">
              <span className="block text-[12.5px] font-medium text-ink-2">Sub-hire this line</span>
              <span className="block text-[11.5px] text-ink-3 leading-relaxed">
                Supplied by a third party, so it draws nothing from the yard and can never be short. What
                EP already does when the shelf is empty — not a way round the check.
              </span>
            </span>
          </label>
        ) : null}

        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Description</span>
          <input
            className="field"
            placeholder="Defaults to the charge name"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
        </label>
        {isVar ? (
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Reason for the variation</span>
            <input
              className="field"
              placeholder="e.g. Client requested extra lighting on site"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        ) : null}

        <div className="well p-3">
          <div className="flex items-baseline justify-between text-[12.5px] text-ink-3 mb-1">
            <span>
              {q} × {u} {ch.unit}
              {u === 1 ? '' : 's'} @ {money(applied)}{' '}
              {applied !== rate.charge ? (
                <span style={{ color: TONE_HEX.healthy }}>(volume tier, from {money(rate.charge)})</span>
              ) : null}
              {rate.basis && rate.basis !== 'standard' ? (
                <span style={{ color: TONE_HEX.info }}>
                  ({rate.basis === 'client' ? 'agreed with this client' : `${RATES.clientCard(w.clientId).label} card`}
                  , published {money(published.charge)})
                </span>
              ) : null}
            </span>
            <span>cost {money(q * u * rate.cost, { pence: false })}</span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-[13px] text-ink">Line value</span>
            <span className="text-[17px] font-bold text-ink tabular-nums">
              {money(q * u * applied, { pence: false })}
            </span>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------- event info -- */

/** Edit the event info captured at creation. */
export function EventInfoDialog({ w, onClose }: { w: W.Wof; onClose: () => void }) {
  const toast = useToast();
  const ev = w.eventId ? eventById(w.eventId) : null;

  const [title, setTitle] = useState(w.title);
  const [code, setCode] = useState(w.jobCode || w.ref);
  const [dept, setDept] = useState(w.departmentId);
  const live = W.liveWindow(w);
  const [liveFrom, setLiveFrom] = useState(live.from);
  const [liveTo, setLiveTo] = useState(live.to);
  const [owner, setOwner] = useState(w.ownerId);
  const [venue, setVenue] = useState(w.venue || '');
  const [postcode, setPostcode] = useState(w.postcode || '');
  const [meet, setMeet] = useState(w.staffMeetingPoint || '');

  const codeError = !code.trim() ? 'Required' : W.jobCodeInUse(code.trim(), w.id) ? 'Already used by another job' : '';

  const save = () => {
    if (codeError) return;
    const before = { code: w.jobCode, venue: w.venue, meet: w.staffMeetingPoint };
    w.title = title.trim() || w.title;
    w.jobCode = code.trim();
    w.departmentId = dept;
    w.liveFrom = liveFrom;
    w.liveTo = liveTo;
    w.ownerId = owner;
    w.venue = venue.trim();
    w.postcode = postcode.trim().toUpperCase();
    w.staffMeetingPoint = meet.trim();

    // Keep the seeded event in step rather than letting the two drift.
    if (ev) {
      ev.name = w.title;
      if (ev.locations.length) {
        ev.locations[0].name = w.venue || ev.locations[0].name;
        ev.locations[0].note = w.staffMeetingPoint ? `Staff meeting point: ${w.staffMeetingPoint}` : '';
      }
    }

    const changed: string[] = [];
    if (before.code !== w.jobCode) changed.push(`job code → ${w.jobCode}`);
    if (before.venue !== w.venue) changed.push(`venue → ${w.venue || 'not set'}`);
    if (before.meet !== w.staffMeetingPoint) changed.push('staff meeting point updated');
    if (changed.length) {
      w.history.push({
        at: new Date(NOW).toISOString(), by: 'm-jake', stage: w.stage,
        note: `Event info edited: ${changed.join(', ')}`,
      });
    }
    W.save();
    onClose();
    toast(ev ? 'Event info updated on the WOF and the event.' : 'Event info updated.', { tone: 'healthy' });
  };

  return (
    <Modal
      title="Event info"
      width={600}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={save}>
            Save
          </button>
        </>
      }
    >
      {ev ? (
        <div className="rounded-lg p-3 mb-4" style={{ background: TONE_BG.info }}>
          <p className="text-[12.5px] text-ink-2 leading-relaxed">
            This job has already seeded an event in the staffing tool. Changes here update both — the venue
            and meeting point are held once, not twice.
          </p>
        </div>
      ) : null}

      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <label className="block col-span-2">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Event name</span>
            <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Job code</span>
            <input
              className="field font-mono text-[12.5px]"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <span className="block text-[11px] mt-1 text-status-critical">{codeError}</span>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Department</span>
            <select className="field" value={dept} onChange={(e) => setDept(e.target.value)}>
              {DEPARTMENTS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Manager</span>
            <select className="field" value={owner} onChange={(e) => setOwner(e.target.value)}>
              {MANAGERS.filter((m) => m.id !== 'm-fd').map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Dates are not editable here, so the day numbers this offers cannot
            go stale under it — it reads the job's own span. */}
        <LiveWindowField
          start={w.start}
          end={w.end}
          from={liveFrom}
          to={liveTo}
          onChange={(f, t) => {
            setLiveFrom(f);
            setLiveTo(t);
          }}
        />

        <div className="grid grid-cols-3 gap-3">
          <label className="block col-span-2">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Venue</span>
            <input className="field" value={venue} onChange={(e) => setVenue(e.target.value)} />
          </label>
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Post code</span>
            <input className="field" value={postcode} onChange={(e) => setPostcode(e.target.value)} />
          </label>
        </div>

        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Staff meeting point</span>
          <input
            className="field"
            value={meet}
            placeholder="e.g. Steward cabin, Main Car Park Gate C"
            onChange={(e) => setMeet(e.target.value)}
          />
          <span className="block text-[11px] text-ink-3 mt-1">Workers see this on the shift.</span>
        </label>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------- sign -- */

/**
 * What the signature is about to build, shown before it is recorded.
 *
 * A signature is now a confirmation — it walks the job to Order, seeds the
 * rota and prepares the kit list. That is a lot to happen behind one button,
 * and a control that does more than it says is the failure this rebuild
 * exists to remove. So it says it, with the numbers.
 */
function ConfirmationPreview({ w }: { w: W.Wof }) {
  if (W.atLeast(w, 'order')) return null;
  const p = W.orderPreview(w);
  const nothing = !p.roles && !p.kitLines;

  return (
    <div
      className="rounded-lg p-3 mb-4"
      style={{ background: TONE_BG.info, border: `1px solid ${TONE_LINE.info}` }}
    >
      <div className="text-[12.5px] font-semibold text-ink mb-1.5">
        Recording this confirms the order
      </div>
      {nothing ? (
        <p className="text-[12px] text-ink-2 leading-relaxed">
          The job moves to Order. There are no staff lines to roster and no kit lines to pick, so
          nothing is seeded — add them to the quote first if that is wrong.
        </p>
      ) : (
        <ul className="text-[12px] text-ink-2 leading-relaxed space-y-0.5">
          {p.roles ? (
            <li>
              ·{' '}
              {p.alreadySeeded
                ? `The staffing event already exists — ${countLabel(p.shifts, 'shift')}, ${countLabel(p.roles, 'role')}`
                : `Seeds ${countLabel(p.shifts, 'shift')} in the staffing tool, ${countLabel(p.roles, 'role')} to fill`}
            </li>
          ) : (
            <li>· No staff lines on the quote, so no rota is created</li>
          )}
          {p.kitLines ? (
            <li>
              · Prepares {countLabel(p.kitLines, 'kit line')} ({p.kitItems} items) for the warehouse.
              Nothing goes to Hire Hop until Picking
            </li>
          ) : (
            <li>· No kit lines on the quote, so nothing is prepared for the warehouse</li>
          )}
        </ul>
      )}
    </div>
  );
}

export function SignDialog({ w, onClose }: { w: W.Wof; onClose: () => void }) {
  const toast = useToast();
  const client = clientById(w.clientId)!;
  const [signer, setSigner] = useState(client.contact || '');
  const [role, setRole] = useState(client.contactRole || '');
  const [method, setMethod] = useState('DocuSign');

  return (
    <Modal
      title="Record client sign-off"
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
              if (!signer.trim()) {
                toast('Enter the name of the person who signed.', { tone: 'critical' });
                return;
              }
              const c = W.signQuoteAndConfirm(w, {
                signedBy: signer.trim(),
                signedByRole: role.trim(),
                method,
              });
              onClose();
              toast(W.describeConfirmation(c), { tone: c.ordered ? 'healthy' : 'atRisk' });
            }}
          >
            Record signature
          </button>
        </>
      }
    >
      <p className="text-[13px] text-ink-2 leading-relaxed mb-4">
        The briefing requires a digital signature at this stage. In production this is a DocuSign (or
        equivalent) envelope; here it records who signed, when, and by what method, so the audit trail is the
        same shape.
      </p>

      <ConfirmationPreview w={w} />

      <div className="space-y-4">
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Signed by</span>
          <input
            className="field"
            value={signer}
            placeholder="Name of the client signatory"
            onChange={(e) => setSigner(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Role</span>
          <input className="field" value={role} onChange={(e) => setRole(e.target.value)} />
        </label>
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Method</span>
          <select className="field" value={method} onChange={(e) => setMethod(e.target.value)}>
            <option>DocuSign</option>
            <option>Adobe Sign</option>
            <option>Signed PDF returned by email</option>
            <option>Wet signature, scanned</option>
          </select>
        </label>
        <div className="well p-3">
          <div className="flex items-baseline justify-between">
            <span className="text-[13px] text-ink-2">Value being accepted</span>
            <span className="text-[17px] font-bold text-ink tabular-nums">
              {money(W.quoteValue(w), { pence: false })}
            </span>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* --------------------------------------------------- quote approval -- */

/**
 * The three sides of a high-value quote's approval: asking for one, giving
 * one, and refusing one.
 *
 * One dialog rather than three because they are the same conversation about
 * the same figure, and the figure is the thing that has to be identical on
 * every screen it appears on.
 */
export function QuoteApprovalDialog({
  w,
  mode,
  override = false,
  onClose,
}: {
  w: W.Wof;
  mode: 'request' | 'approve' | 'refuse';
  /** Deciding despite having priced it. Set by the card, never by the user. */
  override?: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const actor = ROLES.actingActor();
  const value = W.quoteValue(w);
  const client = clientById(w.clientId);
  const req = w.quoteApprovalRequest;

  // Named, because "somebody else has to approve this" is not actionable and
  // the person reading it has to know whose door to knock on.
  const others = ROLES.approvers().filter((m) => !W.quotePricedBy(w).includes(m.id));
  const pricedBy = W.quotePricedBy(w)
    .map((id) => ROLES.member(id)?.name || id)
    .join(', ');

  const block = mode === 'request' ? null : W.approveQuoteBlock(w, actor, { override });
  // What the override is setting aside, in the words the rule uses. Shown on
  // the dialog rather than only on the card, because this is the screen where
  // the decision is actually made.
  const setAside = override ? W.approveQuoteBlock(w, actor) : null;

  const send = () => {
    if (mode === 'request') {
      if (!W.requestQuoteApproval(w, note, actor)) {
        toast('This quote no longer needs an approval.', { tone: 'info' });
        onClose();
        return;
      }
      NOTIFY.quoteApprovalRequested({
        wofId: w.id,
        ref: w.jobCode || w.ref,
        title: w.title,
        client: client?.name || 'client',
        value: money(value, { pence: false }),
        requestedBy: actor.name,
      });
      onClose();
      toast(
        others.length
          ? `Sent for approval. ${others.map((m) => m.name.split(' ')[0]).join(' and ')} can sign it off.`
          : 'Sent for approval.',
        { tone: 'healthy' },
      );
      return;
    }

    if (mode === 'approve') {
      if (!W.approveQuote(w, note, actor, { override })) {
        toast(W.approveQuoteBlock(w, actor, { override }) || 'That approval could not be recorded.', {
          tone: 'critical',
        });
        return;
      }
      NOTIFY.quoteApprovalDecided({
        wofId: w.id,
        ref: w.jobCode || w.ref,
        approved: true,
        by: actor.name,
        value: money(value, { pence: false }),
      });
      onClose();
      toast(`Approved at ${money(value, { pence: false })}. The quote can now be sent to the client.`, {
        tone: 'healthy',
      });
      return;
    }

    if (!note.trim()) {
      toast('Say why you are sending it back — that is the part they can act on.', { tone: 'critical' });
      return;
    }
    if (!W.refuseQuoteApproval(w, note, actor, { override })) {
      toast(W.approveQuoteBlock(w, actor, { override }) || 'That could not be recorded.', {
        tone: 'critical',
      });
      return;
    }
    NOTIFY.quoteApprovalDecided({
      wofId: w.id,
      ref: w.jobCode || w.ref,
      approved: false,
      by: actor.name,
      value: money(value, { pence: false }),
      reason: note.trim(),
    });
    onClose();
    toast('Sent back with your reason. The quote cannot go out until it is approved.', { tone: 'atRisk' });
  };

  const title =
    mode === 'request'
      ? 'Send this quote for approval'
      : mode === 'approve'
        ? 'Approve this quote'
        : 'Send this quote back';

  return (
    <Modal
      title={title}
      width={520}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${mode === 'refuse' ? 'btn-danger' : 'btn-primary'}`}
            disabled={!!block}
            title={block || undefined}
            onClick={send}
          >
            {mode === 'request'
              ? 'Send for approval'
              : mode === 'approve'
                ? `${setAside ? 'Approve anyway' : 'Approve'} ${money(value, { pence: false })}`
                : 'Send back'}
          </button>
        </>
      }
    >
      {block ? (
        <div className="card p-3 mb-4" style={{ background: TONE_BG.atRisk, borderColor: TONE_LINE.atRisk }}>
          <p className="text-[13px] text-ink-2 leading-relaxed">{block}</p>
        </div>
      ) : setAside ? (
        <div className="card p-3 mb-4" style={{ background: TONE_BG.atRisk, borderColor: TONE_LINE.atRisk }}>
          <p className="text-[13px] text-ink-2 leading-relaxed">
            {setAside} You can still {mode === 'approve' ? 'approve' : 'send back'} it — the job would
            otherwise have no move available — and it is recorded as an override against your name.
          </p>
        </div>
      ) : null}

      <p className="text-[13px] text-ink-2 leading-relaxed mb-4">
        {mode === 'request' ? (
          <>
            {money(value, { pence: false })} is over the{' '}
            {money(W.QUOTE_APPROVAL_THRESHOLD, { pence: false })} approval threshold, so it needs a senior
            manager's sign-off before {client?.name || 'the client'} can see it. Nothing is sent to them by
            this — it goes to{' '}
            {others.length ? others.map((m) => m.name).join(' or ') : 'a senior manager'}.
          </>
        ) : mode === 'approve' ? (
          <>
            You are agreeing that {money(value, { pence: false })} is the right figure to put in front of{' '}
            {client?.name || 'the client'}. It is recorded against your name, and if the quote goes up from
            here it comes back to you.
          </>
        ) : (
          <>
            The quote stays where it is and cannot be sent. Your reason is recorded in the job history and
            shown to whoever priced it.
          </>
        )}
      </p>

      <div className="well p-3 mb-4">
        <div className="flex items-baseline justify-between">
          <span className="text-[13px] text-ink-2">Quote value</span>
          <span className="text-[17px] font-bold text-ink tabular-nums">
            {money(value, { pence: false })}
          </span>
        </div>
        <div className="flex items-baseline justify-between mt-1.5">
          <span className="text-[12.5px] text-ink-3">
            {countLabel(W.quoteLines(w).length, 'line')}, priced by
          </span>
          <span className="text-[12.5px] text-ink-2">{pricedBy || '—'}</span>
        </div>
        {req && mode !== 'request' ? (
          <div className="flex items-baseline justify-between mt-1.5">
            <span className="text-[12.5px] text-ink-3">Sent up by</span>
            <span className="text-[12.5px] text-ink-2">
              {req.byName}
              {req.note ? ` — “${req.note}”` : ''}
            </span>
          </div>
        ) : null}
      </div>

      <label className="block">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
          {mode === 'refuse' ? 'Why it is going back' : 'Note'}
          {mode === 'refuse' ? '' : ' (optional)'}
        </span>
        <textarea
          className="field"
          rows={3}
          value={note}
          placeholder={
            mode === 'request'
              ? 'Anything the approver should know — a tier, a discount, an unusual quantity.'
              : mode === 'approve'
                ? 'Anything worth recording alongside the approval.'
                : 'What has to change before this can go out.'
          }
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
    </Modal>
  );
}

/* ------------------------------------------------------------- deposit -- */

export function DepositDialog({ w, onClose }: { w: W.Wof; onClose: () => void }) {
  const toast = useToast();
  const dep = W.deposit(w);
  const [amount, setAmount] = useState(String(dep.due));
  const [ref, setRef] = useState('');

  return (
    <Modal
      title="Record deposit received"
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
              W.recordDeposit(w, { amount: Number(amount), ref: ref.trim() || 'Manual entry' });
              onClose();
              toast('Deposit recorded.', { tone: 'healthy' });
            }}
          >
            Record deposit
          </button>
        </>
      }
    >
      <p className="text-[13px] text-ink-2 leading-relaxed mb-4">
        {dep.pct}% of the quote under {clientById(w.clientId)?.name}'s terms. Recording it here updates the
        cash flow forecast immediately.
      </p>
      <div className="space-y-4">
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Amount</span>
          <input
            className="field"
            type="number"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Reference</span>
          <input className="field" placeholder="e.g. BACS 884120" value={ref} onChange={(e) => setRef(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}

/* --------------------------------------------------- staffing event link -- */

/**
 * Give an ordered job the staffing event it never got.
 *
 * Two ways in, and the dialog offers whichever apply: seed a fresh event from
 * the staff lines on the quote, or adopt an event somebody already built by
 * hand. Both matter because both gaps are real — a kit-only quote that later
 * grew staff, and an operator who went to the calendar before the pipeline.
 *
 * The client-facing consequence is said out loud, because it is the reason
 * anybody opens this: an unlinked event is invisible to the client, and nothing
 * on the event itself explains why.
 */
export function StaffingEventDialog({ w, onClose }: { w: W.Wof; onClose: () => void }) {
  const toast = useToast();
  const staffLines = w.lines.filter((l) => l.kind === 'staff');
  const options = W.adoptableEvents(w);

  const [mode, setMode] = useState<'seed' | 'adopt'>(staffLines.length ? 'seed' : 'adopt');
  const [pick, setPick] = useState(options[0]?.id || '');

  const canSeed = staffLines.length > 0;
  const canAdopt = options.length > 0;
  const ready = mode === 'seed' ? canSeed : !!pick;

  const go = () => {
    const ev = W.ensureStaffingEvent(w, mode === 'adopt' ? { adopt: pick } : {});
    if (!ev) {
      toast('Could not link an event — it may have been claimed by another job.', { tone: 'critical' });
      return;
    }
    onClose();
    toast(
      mode === 'adopt'
        ? `${ev.name} is now linked to ${w.ref} — ${clientById(w.clientId)?.name} can see it in their portal.`
        : `Staffing event created from the quote — ${countLabel(ev.shifts[0].splits.length, 'role group')} to fill.`,
      { tone: 'healthy' },
    );
  };

  return (
    <Modal
      title="Create staffing event"
      width={560}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!ready} onClick={go}>
            {mode === 'adopt' ? 'Link this event' : 'Create event'}
          </button>
        </>
      }
    >
      <p className="text-[13px] text-ink-2 leading-relaxed mb-4">
        This job is confirmed but has no staffing event behind it. Until it has one,{' '}
        {clientById(w.clientId)?.name} sees nothing under My events — the portal counts a booking as real
        by the work order attached to it.
      </p>

      <div className="space-y-3">
        <label className={`block rounded-xl border p-3 ${canSeed ? 'cursor-pointer' : 'opacity-55'} ${
          mode === 'seed' ? 'border-accent bg-accent-soft' : 'border-surface-line-soft'
        }`}>
          <div className="flex items-start gap-2.5">
            <input
              type="radio"
              className="mt-1"
              checked={mode === 'seed'}
              disabled={!canSeed}
              onChange={() => setMode('seed')}
            />
            <div>
              <div className="text-[13.5px] font-semibold text-ink">Create from the quote</div>
              <div className="text-[12.5px] text-ink-2 mt-0.5">
                {canSeed
                  ? `One shift spanning the job, with a role group per staff line — ${countLabel(
                      staffLines.length,
                      'role group',
                    )}, ${staffLines.reduce((n, l) => n + l.qty, 0)} people. The numbers match what was quoted.`
                  : 'Not available — this quote has no staff lines, so there is nothing to roster. Add one on the Quote tab, or link an event below.'}
              </div>
            </div>
          </div>
        </label>

        <label className={`block rounded-xl border p-3 ${canAdopt ? 'cursor-pointer' : 'opacity-55'} ${
          mode === 'adopt' ? 'border-accent bg-accent-soft' : 'border-surface-line-soft'
        }`}>
          <div className="flex items-start gap-2.5">
            <input
              type="radio"
              className="mt-1"
              checked={mode === 'adopt'}
              disabled={!canAdopt}
              onChange={() => setMode('adopt')}
            />
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-semibold text-ink">Link an event that already exists</div>
              <div className="text-[12.5px] text-ink-2 mt-0.5">
                {canAdopt
                  ? `Keeps the shifts and anyone already assigned. Only ${
                      clientById(w.clientId)?.name
                    }'s own unclaimed events are listed.`
                  : 'Not available — this client has no unclaimed events.'}
              </div>
              {canAdopt ? (
                <select
                  className="field mt-2.5"
                  value={pick}
                  disabled={mode !== 'adopt'}
                  onChange={(e) => setPick(e.target.value)}
                >
                  {options.map((ev) => (
                    <option key={ev.id} value={ev.id}>
                      {ev.name} · {fmtRange(ev.start, ev.end, ev.allDay)} ·{' '}
                      {countLabel(ev.shifts.length, 'shift')}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
          </div>
        </label>
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------------- delete -- */

/**
 * DELETE A WORK ORDER
 * ----------------------------------------------------------------------------
 * The escape hatch for a job raised in error. Not a lifecycle stage — a job
 * that really happened and then fell through should be cancelled, which leaves
 * the history intact and keeps it out of the reports that matter.
 *
 * Two things this does that a bare "are you sure?" does not:
 *
 *   · It NAMES the collateral. A WOF is rarely alone by the time anyone wants
 *     it gone: it may own a staffing event with people rostered onto it, hours
 *     already logged, an invoice number. Listing them is the difference between
 *     a confirmed decision and a confirmed reflex.
 *   · It REFUSES on seeded jobs rather than appearing to work. `load()` rebuilds
 *     the seeded pipeline on every boot, so deleting one of those would undo
 *     itself at the next reload — the worst kind of failure, because it looks
 *     like success until tomorrow.
 *
 * The typed confirmation is the job code rather than the word "delete". Typing
 * a code you have to read off the job first is a check that you are deleting
 * the job you think you are; typing "delete" only proves you can type.
 */
export function DeleteWofDialog({
  w,
  onClose,
  onDeleted,
}: {
  w: W.Wof;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const toast = useToast();
  const d = W.deletable(w);

  if (!d.ok) {
    return (
      <Modal
        title="This job cannot be deleted"
        width={520}
        onClose={onClose}
        footer={
          <button type="button" className="btn btn-primary" data-close onClick={onClose}>
            Close
          </button>
        }
      >
        <p className="text-[13.5px] text-ink-2 leading-relaxed">{d.reason}</p>
        <p className="text-[12.5px] text-ink-3 leading-relaxed mt-3">
          Cancelling keeps the job and its history but takes it out of the live pipeline, which is what you
          almost always want for a job that existed and then did not happen.
        </p>
      </Modal>
    );
  }

  return (
    <ConfirmDestructive
      title={`Delete ${w.ref}?`}
      confirmLabel="Delete this job"
      typeToConfirm={w.jobCode}
      onClose={onClose}
      onConfirm={() => {
        const title = w.title;
        if (!W.remove(w)) {
          toast('Could not delete this job.', { tone: 'critical' });
          return;
        }
        toast(`Deleted “${title}”. Nothing on a server was affected.`, { tone: 'info' });
        onDeleted?.();
      }}
      message={
        <>
          <strong className="text-ink">{w.title}</strong> is removed for good. There is no undo, and the
          history goes with it — if this job happened and then fell through, cancel it instead.
          <span
            className="block rounded-lg p-3 mt-3.5"
            style={{ background: TONE_BG.critical }}
          >
            <span className="block text-[13px] font-semibold text-ink mb-1.5">What this destroys</span>
            <span className="block text-[12.5px] text-ink-2 leading-relaxed space-y-1">
              {d.destroys.map((x, i) => (
                <span className="block" key={i}>
                  · {x}
                </span>
              ))}
            </span>
          </span>
        </>
      }
    />
  );
}
