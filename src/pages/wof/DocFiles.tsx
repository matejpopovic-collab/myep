/* ============================================================================
   WOF → DOCUMENTS: the files behind each checklist row
   ----------------------------------------------------------------------------
   What EP sees per row: the latest file (who sent it, when, open it), every
   earlier version on request, and the decision to make on it — Approve, or
   Send back with a reason the sender will read. EP can also attach a file
   itself: its own documents, or one a client emailed instead of uploading.

   The old status dropdown survives only as "without a file" menu items, for
   the jobs whose paperwork was handled before files could be attached.
   ========================================================================== */

import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { MenuButton, Modal, type MenuEntry } from '@/components/Modal';
import { FileDrop } from '@/components/FileDrop';
import { useToast } from '@/components/Toast';
import { TONE_BG, TONE_HEX } from '@/lib/status';
import { fmtDate, fmtTime } from '@/lib/format';
import * as W from '@/lib/wof';
import * as JF from '@/lib/jobfiles';
import * as ROLES from '@/lib/roles';
import * as SD from '@/lib/standarddocs';
import { useStandardDocsVersion } from '@/lib/useStore';

function OpenLink({ f, children }: { f: JF.JobFile; children: React.ReactNode }) {
  const toast = useToast();
  if (!f.stored) return <span title="The file was not kept by this browser">{children}</span>;
  return (
    <button
      type="button"
      className="text-accent hover:underline text-left"
      onClick={async () => {
        if (!(await JF.openFile(f))) toast('That file is not held in this browser.', { tone: 'critical' });
      }}
    >
      {children}
    </button>
  );
}

// A client's name already carries their company — "Dana Reilly (Festival Republic Ltd)".
const who = (f: JF.JobFile) => f.uploadedBy;

/** Under the document's name: the latest file, any send-back, and older versions. */
export function DocFileLine({ w, d }: { w: W.Wof; d: W.WofDocView }) {
  const [showAll, setShowAll] = useState(false);
  const all = JF.versions(w.id, d.docId);
  const f = all[0];
  if (!f) {
    return d.status === 'required' ? null : (
      <div className="text-[11.5px] text-ink-3 mt-1 italic">
        {d.status === 'approved' ? 'Approved' : 'Marked received'} without a file attached
      </div>
    );
  }
  const back = d.status === 'required' && f.review?.decision === 'returned' ? f.review : null;
  return (
    <div className="mt-1.5">
      <div className="text-[12px] text-ink-2 flex items-start gap-1.5">
        <span className="text-ink-3 mt-px">
          <Icon name="fileText" decorative className="icon-sm" />
        </span>
        <span className="min-w-0">
          <OpenLink f={f}>{f.name}</OpenLink>
          <span className="text-ink-3">
            {' '}
            · {JF.fmtSize(f.size)} · {who(f)} · {fmtDate(f.uploadedAt)} {fmtTime(f.uploadedAt)}
          </span>
          {f.standardId ? (
            <span className="block text-ink-3">From standard documents{f.note ? ` · ${f.note.replace(/^Standard document,?\s*/, '')}` : ''}</span>
          ) : f.note ? (
            <span className="block text-ink-3 italic">“{f.note}”</span>
          ) : null}
        </span>
      </div>
      {back ? (
        <div className="text-[12px] mt-1" style={{ color: TONE_HEX.atRisk }}>
          Sent back by {back.by}: {back.reason}
        </div>
      ) : null}
      {all.length > 1 ? (
        <>
          <button
            type="button"
            className="text-[11.5px] text-accent hover:underline mt-1"
            aria-expanded={showAll}
            onClick={() => setShowAll((s) => !s)}
          >
            {showAll ? 'Hide earlier versions' : `${all.length - 1} earlier version${all.length > 2 ? 's' : ''}`}
          </button>
          {showAll ? (
            <ol className="mt-1 grid gap-1 pl-4 border-l border-surface-line-soft">
              {all.slice(1).map((v) => (
                <li key={v.id} className="text-[11.5px] text-ink-3">
                  <OpenLink f={v}>{v.name}</OpenLink> · {who(v)} · {fmtDate(v.uploadedAt)}
                  {v.review ? (
                    <span>
                      {' '}
                      — {v.review.decision === 'approved' ? 'approved' : `sent back: ${v.review.reason}`}
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** The right-hand action for a row. One obvious button, everything else in the menu. */
export function DocActions({
  w,
  d,
  onUpload,
  onSendBack,
}: {
  w: W.Wof;
  d: W.WofDocView;
  onUpload: () => void;
  onSendBack: () => void;
}) {
  const toast = useToast();
  useStandardDocsVersion();
  const gate = ROLES.gate('wof.edit');
  const f = JF.latest(w.id, d.docId);
  const std = SD.current(d.docId);
  const stdBlocker = std ? SD.attachBlocker(w, d.docId) : null;
  const canUseStd = !!std && !stdBlocker;
  const useStandard = async () => {
    const r = await SD.attachTo(w, d.docId);
    if (!r.ok) return toast(r.error, { tone: 'critical' });
    toast(
      r.approved ? `Standard ${d.label} attached and approved.` : `Standard ${d.label} attached — it is waiting for approval.`,
      { tone: 'healthy' },
    );
  };

  const approve = () => {
    const r = JF.review(w, d.docId, 'approved');
    if (r.ok) toast(`${d.label} approved.`, { tone: 'healthy' });
    else toast(r.error, { tone: 'critical' });
  };
  const manual = (status: W.DocStatusId, msg: string) => {
    W.setDocStatus(w, d.docId, status, undefined, ROLES.actingActor());
    toast(msg, { tone: status === 'approved' ? 'healthy' : 'info' });
  };

  const items: MenuEntry[] = [];
  if (d.status === 'submitted') {
    items.push({ label: 'Send back…', icon: 'arrowLeft', hint: 'Ask for a new version, saying why', onSelect: onSendBack });
  }
  if (canUseStd) {
    items.push({
      label: 'Use standard document',
      icon: 'fileText',
      hint: `${std!.name}${std!.autoApprove ? ' — counts as approved' : ''}`,
      onSelect: useStandard,
    });
  }
  items.push({
    label: f ? 'Upload a new version' : 'Upload a file',
    icon: 'download',
    hint: d.owner === 'Client' ? 'For a file the client emailed rather than uploading' : undefined,
    onSelect: onUpload,
  });
  items.push('-');
  if (d.status !== 'approved') {
    items.push({
      label: 'Mark approved without a file',
      icon: 'checkCircle',
      hint: 'For paperwork checked outside the system. The row will say no file is attached.',
      onSelect: () => manual('approved', `${d.label} marked approved without a file.`),
    });
  }
  if (d.status === 'required') {
    items.push({
      label: 'Mark received without a file',
      icon: 'inbox',
      onSelect: () => manual('submitted', `${d.label} marked received without a file.`),
    });
  }
  if (d.status !== 'required') {
    items.push({
      label: 'Reopen — needed again',
      icon: 'refresh',
      hint: 'Back to Required, e.g. when the event changes',
      onSelect: () => manual('required', `${d.label} reopened.`),
    });
  }

  return (
    <div className="flex items-center justify-end gap-1.5">
      {d.status === 'submitted' ? (
        <button type="button" className="btn btn-primary btn-sm" {...gate} onClick={approve}>
          Approve
        </button>
      ) : d.status === 'required' && canUseStd ? (
        <button type="button" className="btn btn-secondary btn-sm" {...gate} onClick={useStandard} title={std!.name}>
          Use standard
        </button>
      ) : d.status === 'required' ? (
        <button type="button" className="btn btn-secondary btn-sm" {...gate} onClick={onUpload}>
          Upload
        </button>
      ) : null}
      {gate.disabled ? null : <MenuButton label={`More for ${d.label}`} items={items} />}
    </div>
  );
}

export function UploadJobDocDialog({ w, d, onClose }: { w: W.Wof; d: W.WofDocView; onClose: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const replacing = !!JF.latest(w.id, d.docId);

  const go = async () => {
    if (!file) return setError('Choose a file first.');
    setBusy(true);
    const r = await JF.submit(w, d.docId, file, { note, actor: ROLES.actingActor(), side: 'ep' });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onClose();
    toast(
      r.file.stored ? `${d.label} attached — it is waiting for approval.` : `${d.label} recorded, but this browser could not keep the file.`,
      { tone: r.file.stored ? 'healthy' : 'atRisk' },
    );
  };

  return (
    <Modal
      title={`${replacing ? 'New version of' : 'Attach'} ${d.label}`}
      width={520}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} aria-disabled={!file} onClick={go}>
            {busy ? 'Attaching…' : 'Attach file'}
          </button>
        </>
      }
    >
      {d.owner === 'Client' ? (
        <p className="text-[13px] text-ink-2 leading-relaxed mb-3">
          This is the client&rsquo;s to send. Attach it here if it reached you another way — by email, say. It is
          recorded as uploaded by you.
        </p>
      ) : null}
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
      <label className="block mt-3">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
          Note <span className="font-normal text-ink-3">Optional</span>
        </span>
        <textarea className="field" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {error ? (
        <p role="alert" className="text-[12.5px] text-status-critical mt-2">
          {error}
        </p>
      ) : null}
      <p className="text-[12px] text-ink-3 mt-3">
        It lands as <strong className="text-ink-2">Submitted</strong>
        {replacing ? '; the earlier version is kept' : ''}. Approving is a separate step.
      </p>
    </Modal>
  );
}

const REASONS = ['It is out of date', 'It is for a different event or site', 'It is missing pages or details', 'It is not signed'];

export function SendBackDialog({ w, d, onClose }: { w: W.Wof; d: W.WofDocView; onClose: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const toClient = d.owner === 'Client';

  return (
    <Modal
      title={`Send back the ${d.label.toLowerCase()}`}
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
              const r = JF.review(w, d.docId, 'returned', reason);
              if (!r.ok) return setError(r.error);
              onClose();
              toast(`${d.label} sent back${toClient ? ' — the client sees why in their portal' : ''}.`, { tone: 'info' });
            }}
          >
            Send back
          </button>
        </>
      }
    >
      <p className="text-[13px] text-ink-2 leading-relaxed mb-3">
        The row goes back to <strong className="text-ink">Required</strong> and counts as still owed.
        {toClient ? ' The client sees your reason next to the document and can send a new version.' : ''}
      </p>
      <div className="flex flex-wrap gap-1.5 mb-2.5">
        {REASONS.map((r) => (
          <button key={r} type="button" className="chip" onClick={() => setReason(r)}>
            {r}
          </button>
        ))}
      </div>
      <label className="block">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">What needs changing</span>
        <textarea
          className="field"
          rows={3}
          autoFocus
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setError(null);
          }}
          placeholder="e.g. The plan does not show the north car park."
        />
      </label>
      {error ? (
        <p role="alert" className="text-[12.5px] text-status-critical mt-2">
          {error}
        </p>
      ) : null}
      <div className="rounded-lg p-2.5 mt-3 text-[12px] text-ink-2" style={{ background: TONE_BG.info }}>
        Be specific — this is the only thing they will read.
      </div>
    </Modal>
  );
}
