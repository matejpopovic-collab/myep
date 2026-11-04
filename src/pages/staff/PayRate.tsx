/* ============================================================================
   STAFF RECORD — pay
   ----------------------------------------------------------------------------
   The Pay card on /staff/:id and the "Set pay rate" dialog. The rules live in
   `lib/payrates.ts`; this file only asks them.

   Who sees what:
     · the card needs `pay.view` — Recruitment and Scheduling never see it.
     · changing the rate needs `pay.view` AND `staff.edit`. Nobody should set a
       number they are not allowed to read, and the payroll clerk, who runs the
       payment file, deliberately does not set its inputs.
   ========================================================================== */

import { useState } from 'react';
import { Pill } from '@/components/primitives';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { countLabel, fmtDateFull, money, round2 } from '@/lib/format';
import type { Employee } from '@/data/types';
import * as PAYRATES from '@/lib/payrates';
import * as ROLES from '@/lib/roles';
import * as W from '@/lib/wof';
import * as WAGES from '@/lib/wages';

/** Why the acting member cannot change pay, or null. */
export const payEditDenial = (): string | null => ROLES.denial('pay.view') || ROLES.denial('staff.edit');

const upliftLabel = (e: Employee): string =>
  e.tags.includes('supervisor') ? 'Supervisor uplift' : e.tags.includes('sia') ? 'SIA uplift' : 'Uplift';

const dayAfter = (d: string): string => {
  const x = new Date(`${d}T12:00:00`);
  x.setDate(x.getDate() + 1);
  return PAYRATES.ymd(x);
};

export function PayCard({ emp, onEdit }: { emp: Employee; onEdit: () => void }) {
  if (!ROLES.can('pay.view')) return null;
  const today = PAYRATES.today();
  const custom = PAYRATES.current(emp.id);
  const next = PAYRATES.scheduled(emp.id);
  const band = PAYRATES.bandRate(emp);
  const base = PAYRATES.baseOn(emp, today);
  const hourly = PAYRATES.rateOn(emp, today);
  const log = PAYRATES.history(emp.id).slice().reverse();
  const why = payEditDenial();

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-[15px] font-semibold text-ink">Pay</h2>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={!!why}
          title={why || undefined}
          onClick={onEdit}
        >
          Set pay rate
        </button>
      </div>

      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-[24px] font-bold text-ink tabular-nums leading-none">{money(hourly)}</span>
        <span className="text-[13px] text-ink-3">/hr</span>
        <span className="ml-1">
          {custom ? (
            <Pill
              label="Custom rate"
              tone="info"
              variant="quiet"
              hint={`Set by ${custom.by} — ${custom.note}`}
            />
          ) : (
            <Pill label="Band rate" tone="neutral" variant="quiet" hint={false} />
          )}
        </span>
      </div>
      <div className="text-[12.5px] text-ink-3 mb-3">
        {emp.employmentType} · {emp.department}
      </div>

      <div className="well p-3 grid gap-1.5 text-[12.5px]">
        <div className="flex justify-between gap-3">
          <span className="text-ink-2">
            Base rate
            {custom ? <span className="text-ink-3"> · custom since {fmtDateFull(custom.from)}</span> : null}
          </span>
          <span className="tabular-nums text-ink">{money(base)}</span>
        </div>
        {custom ? (
          <div className="flex justify-between gap-3">
            <span className="text-ink-3">Band rate it replaces</span>
            <span className="tabular-nums text-ink-3">{money(band)}</span>
          </div>
        ) : null}
        <div className="flex justify-between gap-3">
          <span className="text-ink-2">{upliftLabel(emp)}</span>
          <span className="tabular-nums text-ink">{emp.payUplift ? `+${money(emp.payUplift)}` : '—'}</span>
        </div>
      </div>

      <p className="text-[11.5px] text-ink-3 mt-2 leading-relaxed">
        Never paid below the job's wage framework: at least {money(WAGES.floorOn('nlw', today))}/hr (National
        Living Wage) on any job, {money(WAGES.floorOn('rlw', today))} on real Living Wage jobs and{' '}
        {money(WAGES.floorOn('llw', today))} on London Living Wage jobs.
        {base < WAGES.floorOn('nlw', today) ? ' Their base rate is below the National Living Wage, so it is lifted on every shift.' : ''}
      </p>

      {next ? (
        <p className="text-[12px] text-ink-2 mt-2.5 leading-relaxed">
          <strong className="text-ink">From {fmtDateFull(next.from)}:</strong>{' '}
          {next.rate === null ? `back to the band rate (${money(band)})` : `${money(next.rate)} base`} — {next.note}
        </p>
      ) : null}

      {log.length ? (
        <>
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1.5 mt-4">Rate history</div>
          <div className="grid gap-1.5">
            {log.map((h) => (
              <div key={`${h.from}-${h.at}`} className="text-[12px] leading-snug">
                <div className="flex justify-between gap-3">
                  <span className="text-ink-2">{fmtDateFull(h.from)}</span>
                  <span className="tabular-nums text-ink">{h.rate === null ? 'Band rate' : money(h.rate)}</span>
                </div>
                <div className="text-ink-3">
                  {h.note} · {h.by}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function SetPayRate({ emp, by, onClose }: { emp: Employee; by: string; onClose: () => void }) {
  const toast = useToast();
  const today = PAYRATES.today();
  const paid = W.paidThrough(emp.id);
  const earliest = paid ? dayAfter(paid) : null;
  const band = PAYRATES.bandRate(emp);
  const custom = PAYRATES.current(emp.id);
  const hasAny = PAYRATES.history(emp.id).length > 0;

  const [mode, setMode] = useState<'custom' | 'band'>('custom');
  const [rate, setRate] = useState(String(PAYRATES.baseOn(emp, today).toFixed(2)));
  const [from, setFrom] = useState(earliest && earliest > today ? earliest : today);
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);

  const value = mode === 'band' ? null : Number(rate);
  const err = PAYRATES.problem(emp, { rate: value, from, note, paidThrough: paid });
  const newBase = value === null ? band : Number.isFinite(value) ? value : 0;
  const newHourly = round2(newBase + (emp.payUplift || 0));

  /* What this does to shifts already approved but not yet paid, from `from`. */
  const affected = W.allTimesheets().filter(
    (t) => t.employeeId === emp.id && t.hours > 0 && PAYRATES.ymd(t.date) >= from && !W.atLeast(t.wof, 'invoice'),
  );
  const delta = round2(affected.reduce((s, t) => s + t.hours * newHourly - t.gross, 0));

  const save = () => {
    setTried(true);
    if (err) return;
    PAYRATES.set(emp.id, { rate: value, from, note, by, paidThrough: paid });
    onClose();
    toast(
      value === null
        ? `${emp.name} goes back to the band rate from ${fmtDateFull(from)}.`
        : `${emp.name} is paid ${money(newHourly)}/hr from ${fmtDateFull(from)}.`,
      { tone: 'healthy' },
    );
  };

  const label = (text: string, req = true) => (
    <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
      {text} {req ? <span className="text-status-critical">*</span> : null}
    </span>
  );

  return (
    <Modal
      title={`Pay rate · ${emp.name}`}
      width={500}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={save}>
            {mode === 'band' ? 'Return to band rate' : 'Set custom rate'}
          </button>
        </>
      }
    >
      {hasAny ? (
        <div className="flex gap-4 mb-4 text-[13px]">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="radio" name="pay-mode" checked={mode === 'custom'} onChange={() => setMode('custom')} />
            Custom rate
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="radio" name="pay-mode" checked={mode === 'band'} onChange={() => setMode('band')} />
            Back to band rate ({money(band)})
          </label>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          {label('Base rate per hour')}
          <input
            className="field"
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            value={mode === 'band' ? band.toFixed(2) : rate}
            disabled={mode === 'band'}
            onChange={(ev) => setRate(ev.target.value)}
          />
        </label>
        <label className="block">
          {label('Takes effect from')}
          <input
            className="field"
            type="date"
            min={earliest || undefined}
            value={from}
            onChange={(ev) => setFrom(ev.target.value)}
          />
        </label>
      </div>
      <p className="text-[11.5px] text-ink-3 mt-1.5 leading-relaxed">
        Replaces the {emp.department} {emp.employmentType} band of {money(band)}.
        {emp.payUplift ? ` The ${upliftLabel(emp).toLowerCase()} (+${money(emp.payUplift)}) still applies on top.` : ''}{' '}
        Shifts before this date keep the rate they were worked at
        {paid ? `; anything up to ${fmtDateFull(paid)} is already paid and cannot move` : ''}.
      </p>

      <label className="block mt-4">
        {label('Reason')}
        <textarea
          className="field"
          rows={2}
          placeholder="e.g. Agreed on rehire as gate team lead"
          value={note}
          onChange={(ev) => setNote(ev.target.value)}
        />
      </label>

      <div className="well p-3 mt-4">
        <div className="flex items-center justify-between">
          <span className="text-[13px] text-ink-2">New hourly rate</span>
          <span className="text-[15px] font-bold text-ink tabular-nums">{money(newHourly)}/hr</span>
        </div>
        <p className="text-[12px] text-ink-3 mt-1">
          {money(newBase)} base{emp.payUplift ? ` + ${money(emp.payUplift)} uplift` : ''}
          {value !== null && Number.isFinite(value) && value !== band
            ? ` · ${value > band ? '+' : '−'}${money(Math.abs(round2(value - band)))} against band`
            : ''}
          {custom && mode === 'custom' ? ` · currently ${money(custom.rate!)} base` : ''}
        </p>
        {affected.length ? (
          <p className="text-[12px] text-ink-2 mt-1.5">
            Re-prices {countLabel(affected.length, 'approved shift')} not yet paid:{' '}
            <strong className="tabular-nums">
              {delta >= 0 ? '+' : '−'}
              {money(Math.abs(delta))}
            </strong>
          </p>
        ) : null}
        {value !== null && Number.isFinite(value) && value > 0 && value < band ? (
          <p className="text-[12px] text-status-at-risk mt-1.5">
            This is below their band rate. Check it is still at or above the legal minimum for them.
          </p>
        ) : null}
      </div>

      {tried && err ? <p className="text-[12px] text-status-critical mt-2.5">{err}</p> : null}
    </Modal>
  );
}
