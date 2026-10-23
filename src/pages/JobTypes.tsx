/* ============================================================================
   JOB TYPES + DOCUMENT CHECKLIST CONFIGURATION
   ----------------------------------------------------------------------------
   Briefing §3: "The job documents checklist is configurable by job type. Not
   every job requires every document. The required document list for a given job
   type must be definable WITHOUT DEVELOPER INTERVENTION."

   So this screen exists. Ticking a box here changes what appears on the next
   WOF of that type — and, deliberately, does NOT change the checklist on a WOF
   already in flight, for the same reason a rate change does not re-price a
   signed quote.
   ========================================================================== */

import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader, Pill } from '@/components/primitives';
import { DocChip } from '@/components/wof-ui';
import { useToast } from '@/components/Toast';
import { Modal, ConfirmDestructive } from '@/components/Modal';
import { Icon } from '@/components/Icon';
import { TONE_BG, TONE_HEX } from '@/lib/status';
import { fmtDate } from '@/lib/format';
import { DOCUMENT_TYPES, JOB_TYPES, docType, jobType } from '@/data/db';
import * as W from '@/lib/wof';
import * as JT from '@/lib/jobtypes';
import { useWofs, useJobTypesVersion } from '@/lib/useStore';

export default function JobTypesPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const wofs = useWofs();
  useJobTypesVersion();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const jt = jobType(params.get('id')) || JOB_TYPES[0];
  const selected = jt.id;
  const blocker = JT.deleteBlocker(jt.id);

  const usingIt = wofs.filter((w) => w.jobTypeId === jt.id);
  const live = usingIt.filter((w) => w.stage !== 'complete');

  const toggleDoc = (id: string, on: boolean) => {
    JT.setDocIncluded(jt.id, id, on);
    toast(
      `${docType(id)?.label} ${on ? 'added to' : 'removed from'} ${jt.label}. Applies to new WOFs.`,
      { tone: 'info' },
    );
  };

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Document checklist', to: '/documents' }, { label: 'Configuration' }]}
        title="Checklist configuration"
        subtitle="Which documents each job type requires, who is responsible, and how far ahead of the event they are due. Editable by OPS without a developer."
        actions={
          <Link className="btn btn-secondary" to="/documents/standard">
            <Icon name="fileText" decorative /> Standard documents
          </Link>
        }
      />

      <div className="grid gap-4 lg:grid-cols-4">
        <nav className="card p-2 h-fit" aria-label="Job types">
          {JOB_TYPES.map((j) => (
            <button
              key={j.id}
              type="button"
              className="nav-item w-full"
              style={{ margin: '1px 0' }}
              aria-current={j.id === selected ? 'page' : undefined}
              onClick={() => setParams({ id: j.id })}
            >
              <span className="nav-label flex-1 text-left">
                <span
                  className={`block text-[13px] font-semibold ${j.id === selected ? 'text-ink' : 'text-ink-2'}`}
                >
                  {j.label}
                </span>
                <span className="block text-[11px] text-ink-3">{j.docs.length} documents</span>
              </span>
              {JT.isCustom(j.id) ? (
                <Pill label="Custom" tone="info" variant="quiet" hint={false} />
              ) : null}
            </button>
          ))}
          <button
            type="button"
            className="btn btn-primary w-full justify-center mt-2"
            onClick={() => setCreating(true)}
          >
            <Icon name="plus" decorative /> New job type
          </button>
        </nav>

        <div className="lg:col-span-3 space-y-4">
          <div className="card p-4">
            <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
              <div>
                <h2 className="text-[16px] font-semibold text-ink">{jt.label}</h2>
                <p className="text-[12.5px] text-ink-3 mt-0.5">
                  {usingIt.length} work order{usingIt.length === 1 ? '' : 's'} use this type, {live.length}{' '}
                  still live.
                </p>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm mt-2"
                  disabled={!!blocker}
                  title={blocker || undefined}
                  onClick={() => setDeleting(true)}
                >
                  Delete job type
                </button>
              </div>
              <div className="flex gap-3">
                <label className="block">
                  <span className="block text-[11.5px] text-ink-3 mb-1">Default deposit</span>
                  <div className="flex items-center gap-1.5">
                    <input
                      key={`dep-${jt.id}`}
                      className="field w-20 tabular-nums"
                      type="number"
                      min={0}
                      max={100}
                      defaultValue={jt.depositPct}
                      onBlur={(e) => {
                        const v = Number(e.target.value);
                        if (v === jt.depositPct) return;
                        if (!Number.isFinite(v) || v < 0 || v > 100) {
                          e.target.value = String(jt.depositPct);
                          toast('Deposit must be between 0 and 100%.', { tone: 'critical' });
                          return;
                        }
                        JT.updateJobType(jt.id, { depositPct: v });
                        toast('Default deposit updated.');
                      }}
                    />
                    <span className="text-[13px] text-ink-3">%</span>
                  </div>
                </label>
                <label className="block">
                  <span className="block text-[11.5px] text-ink-3 mb-1">Payment terms</span>
                  <div className="flex items-center gap-1.5">
                    <input
                      key={`terms-${jt.id}`}
                      className="field w-20 tabular-nums"
                      type="number"
                      min={0}
                      defaultValue={jt.termsDays}
                      onBlur={(e) => {
                        const v = Number(e.target.value);
                        if (v === jt.termsDays) return;
                        if (!Number.isInteger(v) || v < 0) {
                          e.target.value = String(jt.termsDays);
                          toast('Payment terms must be whole days, 0 or more.', { tone: 'critical' });
                          return;
                        }
                        JT.updateJobType(jt.id, { termsDays: v });
                        toast('Payment terms updated.');
                      }}
                    />
                    <span className="text-[13px] text-ink-3">days</span>
                  </div>
                </label>
              </div>
            </div>

            <div className="rounded-lg p-3 mb-4" style={{ background: TONE_BG.info }}>
              <p className="text-[12.5px] text-ink-2 leading-relaxed">
                Changes apply to <strong className="text-ink">WOFs raised from now on</strong>. The{' '}
                {live.length} live job{live.length === 1 ? '' : 's'} of this type keep the checklist they
                were created with — the same principle that stops a rate change re-pricing a signed quote.
              </p>
            </div>

            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 44 }}>Include</th>
                  <th>Document</th>
                  <th>Responsible</th>
                  <th style={{ textAlign: 'right' }}>Lead time</th>
                  <th style={{ textAlign: 'center' }}>Mandatory</th>
                </tr>
              </thead>
              <tbody>
                {DOCUMENT_TYPES.map((d) => {
                  const on = jt.docs.includes(d.id);
                  return (
                    <tr key={d.id} className={on ? '' : 'opacity-55'}>
                      <td>
                        <input
                          type="checkbox"
                          checked={on}
                          aria-label={`Include ${d.label} in ${jt.label}`}
                          onChange={(e) => toggleDoc(d.id, e.target.checked)}
                        />
                      </td>
                      <td>
                        <div className="text-[13.5px] text-ink">{d.label}</div>
                      </td>
                      <td>
                        <span className="text-[13px] text-ink-2">{d.owner}</span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <span className="tabular-nums text-ink-2">{d.leadDays} days before</span>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {d.blocking ? (
                          <Pill label="Mandatory" tone="critical" hint="Flagged loudly when outstanding" />
                        ) : (
                          <Pill label="Optional" tone="neutral" hint={false} />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="card p-4">
            <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-3">
              Blocking policy
            </div>
            <p className="text-[13px] text-ink-2 leading-relaxed mb-3">
              The briefing leaves this open: "Outstanding documents should flag or block job progression —
              the exact policy to be confirmed with OPS managers." The prototype currently{' '}
              <strong className="text-ink">warns and records an override</strong>, which is the safe default
              to demonstrate before the decision is made.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="chip"
                aria-pressed={W.DOC_POLICY === 'warn'}
                onClick={() => toast('Already the active policy.', { tone: 'info' })}
              >
                Warn and record an override
              </button>
              <button
                type="button"
                className="chip"
                aria-pressed={false}
                onClick={() =>
                  toast(
                    'Hard-blocking is built but switched off pending the OPS decision. Flip DOC_POLICY to "block" to enable it.',
                    { tone: 'info' },
                  )
                }
              >
                Hard-block progression
              </button>
            </div>
          </div>

          {live.length ? (
            <div className="card p-4">
              <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-3">
                Live jobs of this type
              </div>
              {live.map((w) => {
                const ds = W.docState(w);
                return (
                  <Link
                    key={w.id}
                    to={`/wofs/${w.id}#documents`}
                    className="flex items-center gap-3 py-2 border-b border-surface-line-soft last:border-0 no-underline"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-[13.5px] text-ink">{w.title}</div>
                      <div className="text-[11.5px] text-ink-3 font-mono">
                        {w.ref} · {fmtDate(w.start)}
                      </div>
                    </div>
                    <DocChip wof={w} />
                    <span className="text-[12.5px] text-ink-3 w-24 text-right">
                      {ds.approved}/{ds.total} approved
                    </span>
                  </Link>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>

      {creating ? (
        <CreateJobTypeDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => setParams({ id })}
        />
      ) : null}

      {deleting ? (
        <ConfirmDestructive
          title={`Delete ${jt.label}?`}
          confirmLabel="Delete job type"
          message={
            <>
              {jt.label} disappears from this list and from the job-type pickers on new work orders and
              scheduled events. No work order or scheduled event uses it, so nothing else changes.
            </>
          }
          onClose={() => setDeleting(false)}
          onConfirm={() => {
            const label = jt.label;
            const r = JT.deleteJobType(jt.id);
            if (r.ok) setParams({});
            toast(r.ok ? `${label} deleted.` : r.reason || 'Could not delete that job type.', {
              tone: r.ok ? 'healthy' : 'critical',
            });
          }}
        />
      ) : null}
    </>
  );
}

/* ============================================================================
   NEW JOB TYPE
   ----------------------------------------------------------------------------
   Name, deposit default and payment terms — the three things the right-hand
   panel shows above the checklist. The checklist itself is ticked on that
   panel afterwards, so the dialog only offers a starting point: nothing, or a
   copy of an existing type's documents.
   ========================================================================== */

function CreateJobTypeDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [deposit, setDeposit] = useState('25');
  const [terms, setTerms] = useState('30');
  const [copyFrom, setCopyFrom] = useState('');
  const [errors, setErrors] = useState<JT.JobTypeErrors>({});

  const source = copyFrom ? jobType(copyFrom) : undefined;

  const submit = () => {
    const res = JT.createJobType({
      label,
      depositPct: deposit === '' ? NaN : Number(deposit),
      termsDays: terms === '' ? NaN : Number(terms),
      copyDocsFrom: copyFrom || null,
    });
    if (!res.ok) {
      setErrors(res.errors || {});
      return;
    }
    onClose();
    const n = res.jobType!.docs.length;
    toast(
      <>
        <strong>{res.jobType!.label}</strong> created with {n} document{n === 1 ? '' : 's'}. Tick the
        checklist it needs.
      </>,
      { tone: 'healthy' },
    );
    onCreated(res.jobType!.id);
  };

  const err = (m?: string) =>
    m ? (
      <span className="block text-[12px] mt-1" style={{ color: TONE_HEX.critical }}>
        {m}
      </span>
    ) : null;

  return (
    <Modal
      title="New job type"
      width={520}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit}>
            Create job type
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
            Name <span className="text-status-critical">*</span>
          </span>
          <input
            className="field"
            value={label}
            aria-invalid={!!errors.label}
            placeholder="e.g. Conference / exhibition"
            onChange={(e) => {
              setLabel(e.target.value);
              setErrors((x) => ({ ...x, label: undefined }));
            }}
          />
          {err(errors.label)}
        </label>

        <div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Default deposit (%)</span>
              <input
                className="field tabular-nums"
                type="number"
                min={0}
                max={100}
                value={deposit}
                aria-invalid={!!errors.depositPct}
                onChange={(e) => {
                  setDeposit(e.target.value);
                  setErrors((x) => ({ ...x, depositPct: undefined }));
                }}
              />
              {err(errors.depositPct)}
            </label>
            <label className="block">
              <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Payment terms (days)</span>
              <input
                className="field tabular-nums"
                type="number"
                min={0}
                value={terms}
                aria-invalid={!!errors.termsDays}
                onChange={(e) => {
                  setTerms(e.target.value);
                  setErrors((x) => ({ ...x, termsDays: undefined }));
                }}
              />
              {err(errors.termsDays)}
            </label>
          </div>
          <p className="text-[11.5px] text-ink-3 mt-1.5 leading-relaxed">
            A client's own deposit policy still overrides the default.
          </p>
        </div>

        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Start the checklist from</span>
          <select className="field" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
            <option value="">Nothing (no documents yet)</option>
            {JOB_TYPES.map((j) => (
              <option key={j.id} value={j.id}>
                {j.label} ({j.docs.length} documents)
              </option>
            ))}
          </select>
          <p className="text-[11.5px] text-ink-3 mt-1.5 leading-relaxed">
            {source
              ? `Copies ${source.label}'s ${source.docs.length} documents. You can change them on the next screen.`
              : 'You tick the documents it needs on the next screen.'}
          </p>
        </label>
      </div>
    </Modal>
  );
}
