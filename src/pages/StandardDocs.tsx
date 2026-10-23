/* ============================================================================
   STANDARD DOCUMENTS — the library page
   ----------------------------------------------------------------------------
   One row per document EP provides. Each can hold a standard file that every
   new WOF picks up automatically. The rules live in `lib/standarddocs.ts`;
   this page is the place OPS keeps the files current.
   ========================================================================== */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader, Pill } from '@/components/primitives';
import { Icon } from '@/components/Icon';
import { FileDrop } from '@/components/FileDrop';
import { Modal, MenuButton, ConfirmDestructive, type MenuEntry } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { TONE_BG } from '@/lib/status';
import { fmtDate } from '@/lib/format';
import type { DocumentType } from '@/data/types';
import * as SD from '@/lib/standarddocs';
import * as JF from '@/lib/jobfiles';
import * as ROLES from '@/lib/roles';
import { useStandardDocsVersion, useJobFilesVersion } from '@/lib/useStore';

export default function StandardDocsPage() {
  useStandardDocsVersion();
  useJobFilesVersion();
  const toast = useToast();
  const [dialog, setDialog] = useState<{ kind: 'upload' | 'settings' | 'withdraw'; d: DocumentType } | null>(null);
  const types = SD.eligibleTypes();
  const held = types.filter((d) => SD.current(d.id)).length;

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Document checklist', to: '/documents' }, { label: 'Standard documents' }]}
        title="Standard documents"
        subtitle="Files EP sends with every job, such as insurance certificates and the house method statement. Upload one here and every new work order gets it attached automatically."
        actions={
          <Link className="btn btn-secondary" to="/job-types">
            <Icon name="settings" decorative /> Configure checklists
          </Link>
        }
      />

      <div className="rounded-lg p-3 mb-4" style={{ background: TONE_BG.info }}>
        <p className="text-[12.5px] text-ink-2 leading-relaxed">
          <strong className="text-ink">{held} of {types.length}</strong> EP documents have a standard file. When a
          WOF is raised, each one goes onto its checklist if the job needs it and the file is valid through the
          event&rsquo;s last day. Files marked <strong className="text-ink">Approved on attach</strong> count as
          approved straight away; the rest wait for review like any upload. Jobs keep their own copy, so
          replacing a file here does not change jobs already raised.
        </p>
      </div>

      <div className="card p-4">
        <table className="tbl">
          <thead>
            <tr>
              <th>Document</th>
              <th>Standard file</th>
              <th>Valid until</th>
              <th>When attached</th>
              <th style={{ width: 150 }} />
            </tr>
          </thead>
          <tbody>
            {types.map((d) => (
              <Row key={d.id} d={d} onDialog={(kind) => setDialog({ kind, d })} />
            ))}
          </tbody>
        </table>
        <p className="text-[11.5px] text-ink-3 mt-3 leading-relaxed">
          Client documents (site plan, event licence, signed brief and so on) are not listed: the client sends
          those for each job through their portal.
        </p>
      </div>

      {dialog?.kind === 'upload' ? <UploadDialog d={dialog.d} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'settings' ? <SettingsDialog d={dialog.d} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'withdraw' ? (
        <ConfirmDestructive
          title={`Stop using the standard ${dialog.d.label}?`}
          confirmLabel="Stop using it"
          message={
            <>
              New work orders will ask for their own {dialog.d.label} again. Jobs that already have this file
              keep it, and the file stays in this document&rsquo;s history.
            </>
          }
          onClose={() => setDialog(null)}
          onConfirm={() => {
            SD.withdraw(dialog.d.id);
            toast(`Standard ${dialog.d.label} withdrawn.`, { tone: 'info' });
          }}
        />
      ) : null}
    </>
  );
}

function Row({ d, onDialog }: { d: DocumentType; onDialog: (k: 'upload' | 'settings' | 'withdraw') => void }) {
  const toast = useToast();
  const [showAll, setShowAll] = useState(false);
  const gate = ROLES.gate('wof.edit');
  const c = SD.current(d.id);
  const all = SD.versions(d.id);
  const earlier = c ? all.slice(1) : all;
  const left = c ? SD.daysLeft(c) : null;

  const open = async (sd: SD.StandardDoc) => {
    if (!(await SD.openFile(sd))) toast('That file is not held in this browser.', { tone: 'critical' });
  };

  const items: MenuEntry[] = c
    ? [
        { label: 'Edit expiry and approval', icon: 'edit', onSelect: () => onDialog('settings') },
        '-',
        { label: 'Stop using it', icon: 'ban', danger: true, onSelect: () => onDialog('withdraw') },
      ]
    : [];

  return (
    <tr>
      <td>
        <div className="text-[13.5px] text-ink">{d.label}</div>
        <div className="text-[11.5px] text-ink-3">{d.owner}</div>
      </td>
      <td>
        {c ? (
          <>
            <div className="text-[13px] text-ink-2 flex items-start gap-1.5">
              <span className="text-ink-3 mt-px">
                <Icon name="fileText" decorative className="icon-sm" />
              </span>
              {c.stored ? (
                <button type="button" className="text-accent hover:underline text-left" onClick={() => open(c)}>
                  {c.name}
                </button>
              ) : (
                <span title="The file was not kept by this browser">{c.name}</span>
              )}
            </div>
            <div className="text-[11.5px] text-ink-3">
              {JF.fmtSize(c.size)} · {c.uploadedBy} · {fmtDate(c.uploadedAt)} · on{' '}
              {JF.standardUses(c.id)} job{JF.standardUses(c.id) === 1 ? '' : 's'}
            </div>
          </>
        ) : (
          <span className="text-[12.5px] text-ink-3">None. Each job uploads its own.</span>
        )}
        {earlier.length ? (
          <>
            <button
              type="button"
              className="block text-[11.5px] text-accent hover:underline mt-1"
              aria-expanded={showAll}
              onClick={() => setShowAll((s) => !s)}
            >
              {showAll ? 'Hide earlier files' : `${earlier.length} earlier file${earlier.length === 1 ? '' : 's'}`}
            </button>
            {showAll ? (
              <ol className="mt-1 grid gap-1 pl-4 border-l border-surface-line-soft">
                {earlier.map((v) => (
                  <li key={v.id} className="text-[11.5px] text-ink-3">
                    {v.stored ? (
                      <button type="button" className="text-accent hover:underline" onClick={() => open(v)}>
                        {v.name}
                      </button>
                    ) : (
                      v.name
                    )}{' '}
                    · {v.uploadedBy} · {fmtDate(v.uploadedAt)}
                    {v.withdrawnAt ? ` · withdrawn ${fmtDate(v.withdrawnAt)}` : ''}
                  </li>
                ))}
              </ol>
            ) : null}
          </>
        ) : null}
      </td>
      <td>
        {!c ? (
          <span className="text-ink-3">—</span>
        ) : left == null ? (
          <span className="text-[13px] text-ink-2">Does not expire</span>
        ) : (
          <>
            <div className="text-[13px] text-ink-2 tabular-nums">{fmtDate(c.validUntil!)}</div>
            {left < 0 ? (
              <Pill label="Expired" tone="critical" hint="Not attached to new jobs until it is replaced" />
            ) : left <= 30 ? (
              <Pill label={`${left} day${left === 1 ? '' : 's'} left`} tone="atRisk" hint="Upload the renewal soon" />
            ) : null}
          </>
        )}
      </td>
      <td>
        {c ? (
          c.autoApprove ? (
            <Pill label="Approved on attach" tone="healthy" variant="quiet" hint={false} />
          ) : (
            <Pill label="Needs review" tone="neutral" variant="quiet" hint={false} />
          )
        ) : (
          <span className="text-ink-3">—</span>
        )}
      </td>
      <td style={{ textAlign: 'right' }}>
        <div className="flex items-center justify-end gap-1.5">
          <button
            type="button"
            className={`btn btn-sm ${c ? 'btn-secondary' : 'btn-primary'}`}
            {...gate}
            onClick={() => onDialog('upload')}
          >
            {c ? 'Replace' : 'Upload'}
          </button>
          {c && !gate.disabled ? <MenuButton label={`More for ${d.label}`} items={items} /> : null}
        </div>
      </td>
    </tr>
  );
}

function ApprovalChoice({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start gap-2.5 mt-3">
      <input type="checkbox" className="mt-0.5" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="block text-[13px] text-ink">Counts as approved when attached to a job</span>
        <span className="block text-[11.5px] text-ink-3 leading-relaxed">
          Tick for paperwork that is the same on every job, like a certificate. Leave it off for templates that
          need checking against each site, like a risk assessment.
        </span>
      </span>
    </label>
  );
}

function ValidUntil({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="block mt-3">
      <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
        Valid until <span className="font-normal text-ink-3">Optional</span>
      </span>
      <input className="field" type="date" min={SD.today()} value={value} onChange={(e) => onChange(e.target.value)} />
      <span className="block text-[11.5px] text-ink-3 mt-1.5 leading-relaxed">
        Leave empty if it does not expire. It is not attached to an event that ends after this date.
      </span>
    </label>
  );
}

function UploadDialog({ d, onClose }: { d: DocumentType; onClose: () => void }) {
  const toast = useToast();
  const c = SD.current(d.id);
  const [file, setFile] = useState<File | null>(null);
  const [validUntil, setValidUntil] = useState('');
  const [autoApprove, setAutoApprove] = useState(c ? c.autoApprove : false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    if (!file) return setError('Choose a file first.');
    setBusy(true);
    const r = await SD.upload(d.id, file, { validUntil, autoApprove, actor: ROLES.actingActor() });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onClose();
    toast(
      r.doc.stored
        ? `Standard ${d.label} saved. New work orders will get it.`
        : `Standard ${d.label} recorded, but this browser could not keep the file.`,
      { tone: r.doc.stored ? 'healthy' : 'atRisk' },
    );
  };

  return (
    <Modal
      title={`${c ? 'Replace' : 'Upload'} standard ${d.label}`}
      width={520}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} aria-disabled={!file} onClick={go}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <FileDrop
        file={file}
        onFile={(f) => {
          setFile(f);
          setError(null);
        }}
        check={JF.uploadBlocker}
        accept={JF.ACCEPT_ATTR}
        hint={`Up to ${JF.fmtSize(JF.MAX_BYTES)}. PDF, Word, Excel, a drawing or an image.`}
      />
      <ValidUntil value={validUntil} onChange={setValidUntil} />
      <ApprovalChoice value={autoApprove} onChange={setAutoApprove} />
      {error ? (
        <p role="alert" className="text-[12.5px] text-status-critical mt-2">
          {error}
        </p>
      ) : null}
      {c ? (
        <p className="text-[12px] text-ink-3 mt-3">
          {c.name} moves to this document&rsquo;s history. Jobs that already have it keep it.
        </p>
      ) : null}
    </Modal>
  );
}

function SettingsDialog({ d, onClose }: { d: DocumentType; onClose: () => void }) {
  const toast = useToast();
  const c = SD.current(d.id)!;
  const [validUntil, setValidUntil] = useState(c.validUntil || '');
  const [autoApprove, setAutoApprove] = useState(c.autoApprove);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      title={`Standard ${d.label}`}
      width={500}
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
              const r = SD.updateCurrent(d.id, { validUntil: validUntil || null, autoApprove });
              if (!r.ok) return setError(r.error);
              onClose();
              toast('Saved. Applies to work orders raised from now on.', { tone: 'healthy' });
            }}
          >
            Save
          </button>
        </>
      }
    >
      <p className="text-[13px] text-ink-2">{c.name}</p>
      <ValidUntil value={validUntil} onChange={setValidUntil} />
      <ApprovalChoice value={autoApprove} onChange={setAutoApprove} />
      {error ? (
        <p role="alert" className="text-[12.5px] text-status-critical mt-2">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
