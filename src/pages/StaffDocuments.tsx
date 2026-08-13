/* ============================================================================
   STAFF PORTAL — MY DOCUMENTS
   ----------------------------------------------------------------------------
   Compliance, written as a to-do list rather than a status field.

   The register already knows this worker's right-to-work state, employment type
   and qualifications. This page does not store a second copy of any of it —
   portal.staffDocs() derives the list from the register, so the two can never
   drift. A second document system that disagrees with the first is the exact
   failure the briefing describes.

   Each item says what it is FOR. "SIA licence — expiring" tells a worker
   nothing they can act on; "security roles cannot be filled without a valid
   licence on the day, and yours runs out before the Reggaeland weekend" tells
   them why it is worth twenty minutes this afternoon.
   ========================================================================== */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import {
  EmptyState, Kpi, PageHeader, Pill, Provenance, Section,
} from '@/components/primitives';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { TONE_BG, TONE_HEX, TONE_LINE } from '@/lib/status';
import { countLabel, fmtDate } from '@/lib/format';
import { NOW, tag as tagById } from '@/data/db';
import * as PORTAL from '@/lib/portal';
import { usePortalVersion } from '@/lib/useStore';

const ACCEPTED: Record<string, string> = {
  rtw: 'A share code from the Home Office, or your passport plus proof of address. A visa must be valid for the whole of any shift you work.',
  'photo-id': 'Passport, driving licence, or a national ID card. It has to be in date and the photo has to look like you.',
  bank: 'A screenshot or photo of your bank details showing sort code, account number and the name on the account.',
  sia: 'A photo of the front and back of the licence, clear enough to read the number and the expiry date.',
  licence: 'Your photocard licence plus a DVLA check code, which you can generate free on gov.uk. The code lasts 21 days.',
  'first-aid': 'The certificate from the course provider, showing the award, the date and the three-year expiry.',
  uniform: 'Signed digitally here — nothing to upload.',
  supervisor: 'Booked and recorded by EP Compliance. You do not need to do anything.',
};

type DialogState = { kind: 'upload' | 'help'; doc: PORTAL.StaffDoc } | null;

export default function StaffDocumentsPage() {
  const toast = useToast();
  usePortalVersion();

  const me = PORTAL.actingEmployee();
  const ds = PORTAL.staffDocs();
  const [dialog, setDialog] = useState<DialogState>(null);

  const outstanding = ds.docs.filter((d) => d.status !== 'approved');
  const valid = ds.docs.filter((d) => d.status === 'approved');

  // Which booked shifts this actually puts at risk — the reason to care.
  const atRisk = ds.blocking
    ? PORTAL.myAssignments().filter((a) => new Date(a.shift.start) >= NOW)
    : [];

  const rtwLabel =
    ({ verified: 'Verified', pending: 'Being checked', expiring: 'Expiring' } as Record<string, string>)[
      me.rtw
    ] || me.rtw;

  return (
    <>
      <PageHeader
        title="My documents"
        subtitle="What EP Team holds for you, what is running out, and what that stops you doing. Everything here is checked before you can be confirmed onto a shift, so it is worth keeping ahead of."
        actions={
          <Link className="btn btn-secondary" to="/my/jobs">
            <Icon name="search" decorative className="icon-sm" /> Open jobs
          </Link>
        }
      />

      <div className="flex flex-wrap gap-3 mb-5">
        <Kpi
          label="Up to date"
          value={`${ds.approved}/${ds.total}`}
          sub={ds.outstanding ? `${ds.outstanding} ${ds.outstanding === 1 ? 'needs' : 'need'} attention` : 'Nothing outstanding'}
          tone={ds.tone}
        />
        <Kpi
          label="Right to work"
          value={rtwLabel}
          sub={me.rtwExpiry ? `Expires ${fmtDate(me.rtwExpiry)}` : 'No expiry recorded'}
          tone={me.rtw === 'verified' ? 'healthy' : me.rtw === 'pending' ? 'info' : 'atRisk'}
        />
        <Kpi
          label="Qualifications"
          value={me.qualifications.length}
          sub={
            me.qualifications.length
              ? me.qualifications.map((t) => tagById(t)?.label || t).join(', ')
              : 'None on file — these are what unlock better-paid roles'
          }
          tone="neutral"
        />
        <Kpi
          label="Strikes"
          value={me.strikes}
          sub={me.strikes ? 'From no-shows or dropping out close to an event' : 'Clean record'}
          tone={me.strikes >= 3 ? 'critical' : me.strikes ? 'atRisk' : 'healthy'}
        />
      </div>

      {ds.blocking ? (
        <div
          className="card p-3.5 mb-5"
          style={{ borderColor: TONE_LINE.critical, background: TONE_BG.critical }}
        >
          <div className="flex items-start gap-2.5">
            <span style={{ color: TONE_HEX.critical, marginTop: 1 }}>
              <Icon name="alert" decorative />
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold text-ink mb-0.5">
                {countLabel(ds.blocking, 'item')} is stopping you being booked
              </div>
              <p className="text-[12.5px] text-ink-2 leading-relaxed">
                {atRisk.length
                  ? `This affects ${countLabel(atRisk.length, 'shift')} you are already down for — the next is ${atRisk[0].split.role} on ${fmtDate(atRisk[0].shift.start)}.`
                  : 'You can still apply for work, but staffing cannot confirm you until it is cleared.'}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {outstanding.length ? (
        <>
          <Section title="Needs attention" />
          <div className="grid gap-3">
            {outstanding.map((d) => (
              <DocCard key={d.id} d={d} onOpen={(kind) => setDialog({ kind, doc: d })} />
            ))}
          </div>
        </>
      ) : (
        <div className="card p-0 mb-2">
          <EmptyState
            iconName="checkCircle"
            title="Everything is in order"
            body="Nothing is expiring in the next month and nothing is waiting on you. You will get a reminder here and by email 30 days before anything runs out."
          />
        </div>
      )}

      {valid.length ? (
        <>
          <Section title="On file and valid" />
          <div className="grid gap-3">
            {valid.map((d) => (
              <DocCard key={d.id} d={d} onOpen={(kind) => setDialog({ kind, doc: d })} />
            ))}
          </div>
        </>
      ) : null}

      <Provenance>
        This list is built from your record on the staff register — your employment type, right-to-work
        check and the qualifications recorded against you. There is no second document system holding a
        different answer. Uploads are reviewed by EP Compliance, usually within two working days.
      </Provenance>

      {dialog?.kind === 'upload' ? (
        <Modal
          title={`Upload ${dialog.doc.label.toLowerCase()}`}
          width={480}
          onClose={() => setDialog(null)}
          footer={
            <>
              <button type="button" className="btn btn-secondary" data-close onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setDialog(null);
                  toast(
                    'File upload is not wired up in this prototype — in the live system this sends the document to EP Compliance for review.',
                    { tone: 'info' },
                  );
                }}
              >
                Choose a file
              </button>
            </>
          }
        >
          <p className="text-[13.5px] text-ink-2 leading-relaxed mb-3">
            {ACCEPTED[dialog.doc.id] || dialog.doc.why}
          </p>
          <div className="well p-6 text-center">
            <div className="text-ink-3 mb-2 flex justify-center">
              <Icon name="fileText" decorative className="icon-xl" />
            </div>
            <p className="text-[13px] text-ink-2">Drag a photo or PDF here, or choose a file.</p>
            <p className="text-[12px] text-ink-3 mt-1">Up to 10 MB. JPG, PNG or PDF.</p>
          </div>
          <p className="text-[12px] text-ink-3 mt-3 leading-relaxed">
            EP Compliance reviews uploads, usually within two working days. You will see the status change
            on this page and you do not need to chase it.
          </p>
        </Modal>
      ) : null}

      {dialog?.kind === 'help' ? (
        <Modal
          title={`What counts as ${dialog.doc.label.toLowerCase()}?`}
          width={460}
          onClose={() => setDialog(null)}
          footer={
            <button type="button" className="btn btn-secondary" data-close onClick={() => setDialog(null)}>
              Close
            </button>
          }
        >
          <p className="text-[13.5px] text-ink-2 leading-relaxed">
            {ACCEPTED[dialog.doc.id] || dialog.doc.why}
          </p>
          <p className="text-[13px] text-ink-3 mt-3 leading-relaxed">{dialog.doc.why}</p>
        </Modal>
      ) : null}
    </>
  );
}

function DocCard({ d, onOpen }: { d: PORTAL.StaffDoc; onOpen: (kind: 'upload' | 'help') => void }) {
  const tone = PORTAL.DOC_TONE[d.status];
  const label = PORTAL.DOC_LABEL[d.status];
  const urgent = d.status === 'expired' || d.status === 'expiring';
  const daysLeft = d.daysLeft ?? 0;

  return (
    <article className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-1.5">
            <Pill
              status={d.id}
              label={label}
              tone={tone}
              hint={d.blocking ? 'Required before any shift can be confirmed' : 'Not blocking, but chased'}
            />
            {d.blocking ? (
              <Pill
                label="Required"
                tone="neutral"
                hint="You cannot be confirmed onto a shift without this"
              />
            ) : null}
            {d.owner !== 'You' ? (
              <Pill
                label={`Held by ${d.owner}`}
                tone="neutral"
                hint="Someone at EP Team is responsible for this one, not you"
              />
            ) : null}
          </div>

          <h3 className="text-[15px] font-semibold text-ink leading-tight">{d.label}</h3>
          <p className="text-[12.5px] text-ink-2 mt-1 leading-relaxed max-w-xl">{d.why}</p>
          {d.note ? <p className="text-[12.5px] text-ink-3 mt-1.5">{d.note}</p> : null}
        </div>

        <div className="shrink-0 sm:text-right">
          {d.expires ? (
            <>
              <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1">
                {daysLeft < 0 ? 'Expired' : 'Expires'}
              </div>
              <div
                className="text-[15px] font-semibold tabular-nums"
                style={{ color: TONE_HEX[urgent ? tone : 'neutral'] }}
              >
                {fmtDate(d.expires)}
              </div>
              <div className="text-[12px] text-ink-3 mt-0.5">
                {daysLeft < 0 ? `${Math.abs(daysLeft)} days ago` : `${daysLeft} days left`}
              </div>
            </>
          ) : (
            <div className="text-[12.5px] text-ink-3">No expiry</div>
          )}
        </div>
      </div>

      {d.status !== 'approved' && d.owner === 'You' ? (
        <div className="flex flex-wrap items-center gap-2 mt-3.5 pt-3.5 border-t border-surface-line-soft">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onOpen('upload')}>
            <Icon name="plus" decorative className="icon-sm" />
            {d.status === 'pending' ? 'Replace what I sent' : 'Upload a new one'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpen('help')}>
            What counts?
          </button>
        </div>
      ) : null}
    </article>
  );
}
