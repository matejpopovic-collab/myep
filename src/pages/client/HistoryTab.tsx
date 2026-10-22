/* ============================================================================
   CLIENT RECORD → HISTORY
   ----------------------------------------------------------------------------
   Every change to the account, newest first, with what changed IN the row.
   Filtered by area rather than by free text, because the real questions are
   "show me bank changes" and "show me rate changes", not a word search.
   Read-only for everyone: the store has no edit or delete.
   ========================================================================== */

import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { EmptyState } from '@/components/primitives';
import { TONE_BG, TONE_HEX, TONE_LINE } from '@/lib/status';
import { fmtDateFull, fmtTime } from '@/lib/format';
import type { Client } from '@/data/types';
import * as H from '@/lib/clienthistory';
import { useClientHistoryVersion } from '@/lib/useStore';

export default function HistoryTab({ c }: { c: Client }) {
  useClientHistoryVersion();
  const [area, setArea] = useState<H.Area | 'all'>('all');
  const [sensitiveOnly, setSensitiveOnly] = useState(false);

  const counts = H.counts(c.id);
  const all = H.forClient(c.id);
  const entries = H.forClient(c.id, area).filter((e) => !sensitiveOnly || e.sensitive);
  const sensitiveCount = H.forClient(c.id, area).filter((e) => e.sensitive).length;
  const oldest = all[all.length - 1];

  // Group by calendar day so a run of edits reads as one sitting.
  const days: { day: string; items: H.Entry[] }[] = [];
  entries.forEach((e) => {
    const day = e.at.slice(0, 10);
    const last = days[days.length - 1];
    if (last && last.day === day) last.items.push(e);
    else days.push({ day, items: [e] });
  });

  const chip = (id: H.Area | 'all', label: string, n: number) => (
    <button
      key={id}
      type="button"
      className="btn btn-sm"
      aria-pressed={area === id}
      style={
        area === id
          ? { background: TONE_BG.info, color: TONE_HEX.info, borderColor: TONE_LINE.info }
          : { background: 'var(--surface)', borderColor: 'var(--surface-line)' }
      }
      onClick={() => setArea(id)}
    >
      {label}
      <span className="tabular-nums opacity-70">{n}</span>
    </button>
  );

  return (
    <>
      <div className="card p-5 mb-4">
        <h2 className="text-[15px] font-semibold text-ink">History</h2>
        <p className="text-[13px] text-ink-2 leading-relaxed mt-1 max-w-2xl">
          Every change to {c.name}&rsquo;s account — who made it, when, and what it was before. Nothing here can be
          edited or deleted. Quotes, signatures and payments are on each job&rsquo;s own History tab.
        </p>
        {oldest ? (
          <p className="text-[12px] text-ink-3 mt-1.5">
            Recorded since {fmtDateFull(oldest.at)}. Changes made in the old system are not included.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 mt-4">
          {chip('all', 'All', counts.all)}
          {H.AREAS.map((a) => chip(a.id, a.label, counts[a.id]))}
          <span className="mx-1 h-5 w-px bg-surface-line hidden sm:block" aria-hidden="true" />
          <label className="flex items-center gap-2 text-[12.5px] text-ink-2 cursor-pointer">
            <input type="checkbox" checked={sensitiveOnly} onChange={(e) => setSensitiveOnly(e.target.checked)} />
            Sensitive only <span className="text-ink-3 tabular-nums">({sensitiveCount})</span>
          </label>
        </div>
      </div>

      {days.length ? (
        <div className="grid gap-4">
          {days.map((d) => (
            <section key={d.day} className="card overflow-hidden">
              <h3 className="px-5 py-2.5 text-[12px] font-bold uppercase tracking-wider text-ink-3 border-b border-surface-line-soft bg-surface-raised">
                {fmtDateFull(d.items[0].at)}
              </h3>
              <ol>
                {d.items.map((e) => (
                  <Row key={e.id} e={e} />
                ))}
              </ol>
            </section>
          ))}
        </div>
      ) : (
        <div className="card">
          <EmptyState
            iconName="clock"
            title={all.length ? 'Nothing matches this filter' : 'No changes recorded yet'}
            body={
              all.length
                ? 'Try another area, or turn off “Sensitive only”.'
                : `The first edit to ${c.name} — details, bank, rates, documents or portal access — will appear here.`
            }
            action={
              all.length ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setArea('all');
                    setSensitiveOnly(false);
                  }}
                >
                  Show everything
                </button>
              ) : undefined
            }
          />
        </div>
      )}
    </>
  );
}

function Row({ e }: { e: H.Entry }) {
  const meta = H.AREAS.find((a) => a.id === e.area)!;
  return (
    <li
      className="px-5 py-3.5 border-b border-surface-line-soft last:border-0"
      style={e.sensitive ? { boxShadow: `inset 3px 0 0 ${TONE_HEX.atRisk}` } : undefined}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <span className="text-[12.5px] text-ink-3 tabular-nums w-11 shrink-0 pt-px">{fmtTime(e.at) ?? '00:00'}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13.5px] font-medium text-ink">{e.title}</span>
            <span className="pill" style={{ background: TONE_BG.neutral, color: TONE_HEX.neutral }}>
              <Icon name={meta.icon} decorative className="icon-sm" /> {meta.label}
            </span>
            {e.sensitive ? (
              <span className="pill" style={{ background: TONE_BG.atRisk, color: TONE_HEX.atRisk }}>
                Sensitive
              </span>
            ) : null}
            {e.alerted ? (
              <span
                className="pill tip"
                tabIndex={0}
                data-tip="Raised in the notification feed so someone other than the editor checks it."
                style={{ background: TONE_BG.info, color: TONE_HEX.info }}
              >
                <Icon name="bell" decorative className="icon-sm" /> Finance alerted
              </span>
            ) : null}
          </div>
          <div className="text-[12px] text-ink-3 mt-0.5">by {e.by}</div>

          {e.changes.length ? (
            <dl className="mt-2 grid gap-1">
              {e.changes.map((ch, i) => (
                <div key={i} className="grid grid-cols-[minmax(120px,180px)_1fr] gap-3 text-[12.5px]">
                  <dt className="text-ink-3">{ch.label}</dt>
                  <dd className="text-ink-2 min-w-0 break-words">
                    {ch.from !== '—' ? (
                      <>
                        <span className="line-through decoration-ink-3/60">{ch.from}</span>
                        <span className="text-ink-3 mx-1.5" aria-label="changed to">
                          →
                        </span>
                      </>
                    ) : null}
                    <span className="text-ink">{ch.to}</span>
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          {e.note ? <p className="text-[12px] text-ink-3 italic mt-1.5">“{e.note}”</p> : null}
        </div>
      </div>
    </li>
  );
}
