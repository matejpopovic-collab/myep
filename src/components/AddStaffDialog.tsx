/* ============================================================================
   ADD STAFF — the dialog behind the Staff register's "Add staff" button.

   Asks only what is needed to offer someone a shift: who they are, how to
   reach them, where they sit and what they are qualified for. Everything else
   — documents, right to work, photo, NI number — is done on their profile,
   which is where this dialog sends you once the record exists.
   ========================================================================== */

import { useState } from 'react';
import { Modal } from '@/components/Modal';
import { PAY_BANDS, TAGS } from '@/data/db';
import type { Employee } from '@/data/types';
import { money } from '@/lib/format';
import * as STAFF from '@/lib/staff';

export function AddStaffDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (e: Employee) => void }) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [office, setOffice] = useState('');
  const [department, setDepartment] = useState('');
  const [employmentType, setEmploymentType] = useState<STAFF.EmploymentType>('PAYE');
  const [tags, setTags] = useState<Set<string>>(new Set());
  const [tried, setTried] = useState(false);

  const input = (): STAFF.StaffInput => ({
    firstName, lastName, email, phone, office, department, employmentType, tags: [...tags],
  });

  // Errors appear after the first attempt, then follow the typing — not while
  // somebody is still on the first field of an empty form.
  const errors: STAFF.StaffErrors = tried ? STAFF.validateStaff(input()) : {};

  const submit = () => {
    setTried(true);
    const r = STAFF.createStaff(input());
    if (r.ok) onCreated(r.employee);
  };

  const enter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };

  const err = (m?: string) =>
    m ? <span className="block text-[11.5px] text-status-critical mt-1">{m}</span> : null;

  const label = (text: string, required = true) => (
    <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
      {text} {required ? <span className="text-status-critical">*</span> : null}
    </span>
  );

  const band = department ? PAY_BANDS[department] : null;
  const rate = band ? (employmentType === 'Self-employed' ? band.se : band.paye) : null;

  return (
    <Modal
      title="Add staff"
      width={560}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit}>
            Add to register
          </button>
        </>
      }
    >
      <div className="grid gap-3.5">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            {label('First name')}
            <input className="field" autoFocus placeholder="e.g. Priya" value={firstName}
              onChange={(e) => setFirstName(e.target.value)} onKeyDown={enter} />
            {err(errors.firstName)}
          </label>
          <label className="block">
            {label('Last name')}
            <input className="field" placeholder="e.g. Shah" value={lastName}
              onChange={(e) => setLastName(e.target.value)} onKeyDown={enter} />
            {err(errors.lastName)}
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            {label('Email')}
            <input className="field" type="email" placeholder="name@example.com" value={email}
              onChange={(e) => setEmail(e.target.value)} onKeyDown={enter} />
            {err(errors.email)}
          </label>
          <label className="block">
            {label('Mobile')}
            <input className="field" type="tel" placeholder="07700 900000" value={phone}
              onChange={(e) => setPhone(e.target.value)} onKeyDown={enter} />
            {err(errors.phone)}
          </label>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <label className="block">
            {label('Office')}
            <select className="field" value={office} onChange={(e) => setOffice(e.target.value)}>
              <option value="">Choose…</option>
              {STAFF.STAFF_OFFICES.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            {err(errors.office)}
          </label>
          <label className="block">
            {label('Department')}
            <select className="field" value={department} onChange={(e) => setDepartment(e.target.value)}>
              <option value="">Choose…</option>
              {STAFF.STAFF_DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            {err(errors.department)}
          </label>
          <label className="block">
            {label('Employment')}
            <select className="field" value={employmentType}
              onChange={(e) => setEmploymentType(e.target.value as STAFF.EmploymentType)}>
              {STAFF.EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
        </div>

        <div>
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2 mt-1">Requirements held</div>
          <div className="flex items-center gap-2 flex-wrap">
            {TAGS.map((t) => (
              <button
                key={t.id}
                type="button"
                className="chip"
                aria-pressed={tags.has(t.id)}
                onClick={() =>
                  setTags((s) => {
                    const next = new Set(s);
                    if (next.has(t.id)) next.delete(t.id);
                    else next.add(t.id);
                    return next;
                  })
                }
              >
                {t.label}
              </button>
            ))}
          </div>
          <p className="text-[11.5px] text-ink-3 mt-1.5 leading-relaxed">
            Tick only what they can show proof of — you upload the certificates on their profile next.
          </p>
        </div>

        <div className="well p-3 text-[12.5px] text-ink-2 leading-relaxed">
          <div className="flex items-baseline gap-3">
            <span>They join as <strong>Pending</strong>, in the <strong>New</strong> rating band, with right to work not yet checked.</span>
            <span className="ml-auto tabular-nums whitespace-nowrap font-semibold text-ink">
              {rate != null ? `${money(rate)}/hr` : '—'}
            </span>
          </div>
          <div className="text-[11.5px] text-ink-3 mt-1">
            Pay comes from the {department || 'department'} band. Supervisor or SIA adds the usual uplift per shift.
          </div>
        </div>
      </div>
    </Modal>
  );
}
