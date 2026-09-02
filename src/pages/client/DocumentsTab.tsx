/* ============================================================================
   CLIENT RECORD — DOCUMENTS
   ----------------------------------------------------------------------------
   The account's own paperwork, as opposed to a job's: the insurance
   certificate, the signed framework, the purchase-order template, the supplier
   form their finance team insists on. Kept once, against the account, because
   that is what they are facts about — see the header of `lib/clientfiles.ts`
   for why they were being re-typed eleven times a year before this existed.

   Three things this screen refuses to do:

     · claim a file is held when the browser would not keep it. `stored: false`
       is shown as a warning on the row, not swallowed.
     · treat "expires" as decoration. An expired EL certificate is the single
       document that stops a job at the gate, so it is a status, sorted first,
       and counted in the header.
     · overwrite. Replacing a document is a new upload; the old one stays
       until somebody deletes it deliberately, because "which version did they
       send us in March" is a question that gets asked.
   ========================================================================== */

import { useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { EmptyState, Provenance } from '@/components/primitives';
import { ConfirmDestructive, MenuButton, Modal } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { TONE_BG, TONE_HEX, TONE_LINE } from '@/lib/status';
import { countLabel, fmtDate, fmtDateFull } from '@/lib/format';
import { NOW } from '@/data/db';
import type { Client, Tone } from '@/data/types';
import * as FILES from '@/lib/clientfiles';
import * as ROLES from '@/lib/roles';
import { useClientDocsVersion } from '@/lib/useStore';

const STATE_TONE: Record<FILES.ExpiryState, Tone> = {
  expired: 'critical',
  expiring: 'atRisk',
  valid: 'healthy',
  none: 'neutral',
};

/**
 * The app drops the year everywhere else, because everywhere else is talking
 * about a job in the next few weeks. A certificate valid to "Thu, 2 Sep" is a
 * different sentence depending on which September, and that is precisely the
 * document nobody wants to be wrong about at a gate — so a date outside this
 * year carries its year.
 */
const dated = (iso: string): string =>
  new Date(iso).getFullYear() === new Date(NOW).getFullYear() ? fmtDate(iso) : fmtDateFull(iso);

function expiryLabel(d: FILES.ClientDoc): string {
  const st = FILES.expiryState(d);
  if (st === 'none') return 'No expiry';
  if (st === 'expired') return `Expired ${dated(d.expires!)}`;
  if (st === 'expiring') return `Expires ${dated(d.expires!)}`;
  return `Valid to ${dated(d.expires!)}`;
}

export default function DocumentsTab({ c }: { c: Client }) {
  const toast = useToast();
  useClientDocsVersion();
  const input = useRef<HTMLInputElement>(null);

  const [pending, setPending] = useState<File | null>(null);
  const [editing, setEditing] = useState<FILES.ClientDoc | null>(null);
  const [deleting, setDeleting] = useState<FILES.ClientDoc | null>(null);
  const [dragging, setDragging] = useState(false);

  const docs = FILES.forClient(c.id);
  const attention = FILES.needsAttention(c.id);
  const canEdit = ROLES.can('clients.edit');

  const take = (file: File | null | undefined) => {
    if (!file) return;
    const blocker = FILES.uploadBlocker(file);
    if (blocker) return toast(blocker, { tone: 'critical' });
    setPending(file);
  };

  return (
    <>
      {/* --- the drop zone -------------------------------------------------- */}
      <div
        className="card p-5 mb-4 text-center"
        style={dragging ? { borderColor: TONE_LINE.info, background: TONE_BG.info } : undefined}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!canEdit) return toast(ROLES.denial('clients.edit') || 'Not allowed.', { tone: 'critical' });
          take(e.dataTransfer.files?.[0]);
        }}
      >
        <div className="flex justify-center mb-2" style={{ color: TONE_HEX.info }}>
          <Icon name="fileText" decorative className="icon-lg" />
        </div>
        <div className="text-[13.5px] text-ink mb-1">
          Drop a document here, or
          <button
            type="button"
            className="btn btn-secondary btn-sm ml-2"
            {...ROLES.gate('clients.edit')}
            onClick={() => input.current?.click()}
          >
            choose a file
          </button>
        </div>
        <p className="text-[11.5px] text-ink-3 leading-relaxed">
          Filed against {c.name} and available on every job they book. Up to {FILES.fmtSize(FILES.MAX_BYTES)}{' '}
          each, held in this browser.
        </p>
        <input
          ref={input}
          type="file"
          hidden
          onChange={(e) => {
            take(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>

      {/* --- what needs chasing --------------------------------------------- */}
      {attention.length ? (
        <div
          className="card p-4 mb-4"
          style={{ background: TONE_BG.atRisk, borderColor: TONE_LINE.atRisk }}
        >
          <div className="flex items-start gap-2.5">
            <span style={{ color: TONE_HEX.atRisk, marginTop: 1 }}>
              <Icon name="alert" decorative />
            </span>
            <div className="flex-1">
              <div className="text-[13px] font-semibold text-ink mb-1">
                {countLabel(attention.length, 'document needs', 'documents need')} attention
              </div>
              <ul className="grid gap-0.5">
                {attention.map((d) => (
                  <li key={d.id} className="text-[12.5px] text-ink-2">
                    <strong className="text-ink">{FILES.typeLabel(d.docTypeId) || d.name}</strong> —{' '}
                    {!d.stored
                      ? 'the record is here but this browser would not keep the file itself.'
                      : expiryLabel(d).toLowerCase()}
                    .
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      ) : null}

      {/* --- the register ---------------------------------------------------- */}
      {docs.length ? (
        <table className="tbl">
          <thead>
            <tr>
              <th>Document</th>
              <th>Type</th>
              <th>Status</th>
              <th>Filed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => {
              const st = FILES.expiryState(d);
              return (
                <tr key={d.id}>
                  <td>
                    <div className="text-[13.5px] text-ink">{d.name}</div>
                    <div className="text-[11.5px] text-ink-3">
                      {FILES.fmtSize(d.size)}
                      {d.note ? ` · ${d.note}` : ''}
                      {!d.stored ? ' · file not held in this browser' : ''}
                    </div>
                  </td>
                  <td className="text-[13px] text-ink-2">
                    {d.docTypeId ? FILES.typeLabel(d.docTypeId) : <span className="italic text-ink-3">Not set</span>}
                  </td>
                  <td>
                    <span
                      className="pill"
                      style={{ background: TONE_BG[STATE_TONE[st]], color: TONE_HEX[STATE_TONE[st]] }}
                    >
                      {expiryLabel(d)}
                    </span>
                  </td>
                  <td className="text-[12.5px] text-ink-3">
                    {fmtDate(d.uploadedAt)}
                    <div>{d.uploadedBy}</div>
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={!d.stored}
                      onClick={async () => {
                        const got = await FILES.download(d.id);
                        if (!got)
                          toast('That file is no longer in this browser — only its record is.', {
                            tone: 'critical',
                          });
                      }}
                    >
                      <Icon name="download" decorative /> Download
                    </button>
                    <span className="ml-1.5 inline-block align-middle">
                      <MenuButton
                        label={`Actions for ${d.name}`}
                        items={[
                          {
                            label: 'Edit details',
                            icon: 'edit',
                            disabled: !canEdit,
                            hint: ROLES.denial('clients.edit') || undefined,
                            onSelect: () => setEditing(d),
                          },
                          {
                            label: 'Upload a newer version',
                            icon: 'plus',
                            disabled: !canEdit,
                            hint: ROLES.denial('clients.edit') || undefined,
                            onSelect: () => input.current?.click(),
                          },
                          '-',
                          {
                            label: 'Delete document',
                            icon: 'trash',
                            danger: true,
                            disabled: !canEdit,
                            hint: ROLES.denial('clients.edit') || undefined,
                            onSelect: () => setDeleting(d),
                          },
                        ]}
                      />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <EmptyState
          title="No documents filed against this account"
          body="Their insurance certificate, signed framework and purchase-order template belong here rather than on one job — filed once, they are on every job they book."
        />
      )}

      <Provenance>
        These are the account's documents. A job's own paperwork — this event's risk assessment, this
        event's site plan — stays on the job's checklist, where its due date is worked back from the event
        date. Files are held in this browser only; nothing is uploaded anywhere.
      </Provenance>

      {pending ? (
        <FileDetails
          client={c}
          file={pending}
          onClose={() => setPending(null)}
          onDone={(msg, tone) => {
            setPending(null);
            toast(msg, { tone });
          }}
        />
      ) : null}

      {editing ? (
        <FileDetails
          client={c}
          doc={editing}
          onClose={() => setEditing(null)}
          onDone={(msg, tone) => {
            setEditing(null);
            toast(msg, { tone });
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmDestructive
          title={`Delete “${deleting.name}”?`}
          confirmLabel="Delete document"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            const d = deleting;
            setDeleting(null);
            const r = await FILES.remove(d.id);
            toast(r.ok ? `${d.name} deleted.` : r.reason || 'That did not work.', {
              tone: r.ok ? 'neutral' : 'critical',
            });
          }}
          message="This removes the record and the file itself. Nothing else in the system points at it, so there is no history to keep — but there is also no undo."
        />
      ) : null}
    </>
  );
}

/* ---------------------------------------------------------- upload / edit -- */
/*
   One form for both, because they ask the same three questions. The difference
   is only whether there are bytes waiting to be written.
*/

function FileDetails({
  client,
  file,
  doc,
  onClose,
  onDone,
}: {
  client: Client;
  file?: File;
  doc?: FILES.ClientDoc;
  onClose: () => void;
  onDone: (msg: string, tone: Tone) => void;
}) {
  const [docTypeId, setDocTypeId] = useState(doc?.docTypeId || '');
  const [expires, setExpires] = useState(doc?.expires?.slice(0, 10) || '');
  const [note, setNote] = useState(doc?.note || '');
  const [busy, setBusy] = useState(false);

  const name = file?.name || doc?.name || '';
  const size = file?.size ?? doc?.size ?? 0;

  const pickType = (id: string) => {
    setDocTypeId(id);
    // Only ever FILLS an empty date. Overwriting a date somebody typed because
    // they then corrected the type would be the form arguing with its user.
    if (!expires) {
      const s = FILES.suggestedExpiry(id);
      if (s) setExpires(s);
    }
  };

  const save = async () => {
    setBusy(true);
    if (doc) {
      const r = FILES.update(doc.id, { docTypeId, expires: expires || null, note });
      setBusy(false);
      return onDone(r.ok ? `${name} updated.` : r.reason || 'That did not work.', r.ok ? 'healthy' : 'critical');
    }
    const r = await FILES.upload(client.id, file!, { docTypeId, expires: expires || null, note });
    setBusy(false);
    if (!r.ok) return onDone(r.reason || 'That did not work.', 'critical');
    onDone(
      r.recordOnly
        ? `${name} is recorded, but this browser would not store the file itself — the row says so.`
        : `${name} filed against ${client.name}.`,
      r.recordOnly ? 'atRisk' : 'healthy',
    );
  };

  return (
    <Modal
      title={doc ? `Edit ${name}` : `File ${name} against ${client.name}`}
      width={520}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>
            {doc ? 'Save changes' : 'File it'}
          </button>
        </>
      }
    >
      {!doc ? (
        <div className="well p-3 mb-4 flex items-center gap-2.5">
          <span style={{ color: TONE_HEX.info }}>
            <Icon name="fileText" decorative />
          </span>
          <span className="text-[13px] text-ink flex-1 truncate">{name}</span>
          <span className="text-[12px] text-ink-3 tabular-nums">{FILES.fmtSize(size)}</span>
        </div>
      ) : null}

      <label className="block">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">What is it</span>
        <select className="field" value={docTypeId} onChange={(e) => pickType(e.target.value)}>
          <option value="">Not set</option>
          {FILES.DOC_TYPES().map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </label>

      <label className="block mt-3.5">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Expires</span>
        <input
          className="field"
          type="date"
          value={expires}
          onChange={(e) => setExpires(e.target.value)}
        />
        <p className="text-[11.5px] text-ink-3 mt-1.5 leading-relaxed">
          Leave it empty for anything that does not expire — an agreement, a purchase-order template. A
          certificate that does is chased from {FILES.EXPIRY_WARNING_DAYS} days out.
        </p>
      </label>

      <label className="block mt-3.5">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Note</span>
        <input
          className="field"
          placeholder="e.g. covers all sites; £10m public liability"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
    </Modal>
  );
}
