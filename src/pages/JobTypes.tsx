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
import { TONE_BG } from '@/lib/status';
import { fmtDate } from '@/lib/format';
import { DOCUMENT_TYPES, JOB_TYPES, docType, jobType } from '@/data/db';
import * as W from '@/lib/wof';
import { useWofs } from '@/lib/useStore';

export default function JobTypesPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const wofs = useWofs();
  const [, force] = useState(0);

  const selected = params.get('id') || JOB_TYPES[0].id;
  const jt = jobType(selected) || JOB_TYPES[0];

  const usingIt = wofs.filter((w) => w.jobTypeId === jt.id);
  const live = usingIt.filter((w) => w.stage !== 'complete');

  const toggleDoc = (id: string, on: boolean) => {
    if (on) {
      if (!jt.docs.includes(id)) jt.docs.push(id);
    } else {
      jt.docs = jt.docs.filter((x) => x !== id);
    }
    force((n) => n + 1);
    toast(
      `${docType(id)?.label} ${on ? 'added to' : 'removed from'} ${jt.label}. Applies to new WOFs.`,
      { tone: 'info' },
    );
  };

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Document checklist', to: '/reports/documents' }, { label: 'Configuration' }]}
        title="Checklist configuration"
        subtitle="Which documents each job type requires, who is responsible, and how far ahead of the event they are due. Editable by OPS without a developer."
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
            </button>
          ))}
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
              </div>
              <div className="flex gap-3">
                <label className="block">
                  <span className="block text-[11.5px] text-ink-3 mb-1">Default deposit</span>
                  <div className="flex items-center gap-1.5">
                    <input
                      className="field w-20 tabular-nums"
                      type="number"
                      min={0}
                      max={100}
                      defaultValue={jt.depositPct}
                      onChange={(e) => {
                        jt.depositPct = Number(e.target.value);
                      }}
                      onBlur={() => toast('Default deposit updated.')}
                    />
                    <span className="text-[13px] text-ink-3">%</span>
                  </div>
                </label>
                <label className="block">
                  <span className="block text-[11.5px] text-ink-3 mb-1">Payment terms</span>
                  <div className="flex items-center gap-1.5">
                    <input
                      className="field w-20 tabular-nums"
                      type="number"
                      min={0}
                      defaultValue={jt.termsDays}
                      onChange={(e) => {
                        jt.termsDays = Number(e.target.value);
                      }}
                      onBlur={() => toast('Payment terms updated.')}
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
    </>
  );
}
