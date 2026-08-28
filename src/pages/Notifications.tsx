/* ============================================================================
   NOTIFICATIONS
   ----------------------------------------------------------------------------
   Fixes:
     · two entry points (top-bar bell + this page) with no stated relationship
       -> the bell links here, and this page says so. Bell = jump point,
          page = full history with filters.
     · empty state was an 800px alert-styled slab containing three words
       -> a real centred empty state that explains what will appear here
     · unlabelled refresh button isolated in the corner
       -> labelled, grouped with the other controls
   ========================================================================== */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { EmptyState, PageHeader } from '@/components/primitives';
import { MenuButton } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { TONE_HEX } from '@/lib/status';
import { fmtDateFull, fmtTime } from '@/lib/format';
import { NOTIFICATIONS, NOW } from '@/data/db';
import type { AppNotification, NotificationType } from '@/data/types';

type Filter = 'all' | NotificationType;

const TYPES: [Filter, string][] = [
  ['all', 'All'],
  ['staffing', 'Staffing gaps'],
  ['checkin', 'Check-ins'],
  ['confirmation', 'Confirmations'],
  ['approval', 'Quote approvals'],
  ['staff', 'Staff'],
];

const TYPE_ICON: Record<NotificationType, string> = {
  staffing: 'alert',
  checkin: 'checkin',
  confirmation: 'clock',
  approval: 'checkCircle',
  staff: 'staff',
};

function relative(at: string): string {
  const mins = Math.round((+NOW - +new Date(at)) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(h / 24);
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
}

export default function NotificationsPage() {
  const toast = useToast();
  const [type, setType] = useState<Filter>('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  // Local so "Mark all read" can actually empty the list and reveal the empty
  // state, which the live app never designed.
  const [read, setRead] = useState<Set<string>>(
    () => new Set(NOTIFICATIONS.filter((n) => !n.unread).map((n) => n.id)),
  );
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [refreshing, setRefreshing] = useState(false);

  const live = NOTIFICATIONS.filter((n) => !dismissed.has(n.id));
  const rows = live
    .filter((n) => type === 'all' || n.type === type)
    .filter((n) => !unreadOnly || !read.has(n.id));
  const unread = live.filter((n) => !read.has(n.id)).length;

  const filtered = unreadOnly || type !== 'all';

  const toggleRead = (id: string, isRead: boolean) =>
    setRead((s) => {
      const next = new Set(s);
      if (isRead) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle="Full history of staffing alerts, check-in flags and confirmation changes. The bell in the top bar links here."
        actions={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={refreshing}
              onClick={() => {
                setRefreshing(true);
                window.setTimeout(() => {
                  setRefreshing(false);
                  toast('Notifications refreshed.', { tone: 'healthy' });
                }, 400);
              }}
            >
              <Icon name="refresh" decorative /> Refresh
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!unread}
              onClick={() => {
                setRead(new Set(NOTIFICATIONS.map((n) => n.id)));
                toast('All notifications marked as read.', { tone: 'healthy' });
              }}
            >
              <Icon name="check" decorative /> Mark all read{unread ? ` (${unread})` : ''}
            </button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {TYPES.map(([v, l]) => {
          const n = live.filter((x) => v === 'all' || x.type === v).length;
          return (
            <button key={v} type="button" className="chip" aria-pressed={type === v} onClick={() => setType(v)}>
              {l}
              <span className="text-2xs opacity-70">{n}</span>
            </button>
          );
        })}
        <div className="h-5 w-px bg-surface-line mx-1" />
        <button
          type="button"
          className="chip"
          aria-pressed={unreadOnly}
          onClick={() => setUnreadOnly((u) => !u)}
        >
          Unread only{unread ? <span className="text-2xs opacity-70">{unread}</span> : null}
        </button>
      </div>

      <section className="card overflow-hidden">
        {rows.length ? (
          rows.map((n) => (
            <NotificationRow
              key={n.id}
              n={n}
              isRead={read.has(n.id)}
              onToggleRead={() => toggleRead(n.id, read.has(n.id))}
              onDismiss={() => {
                setDismissed((s) => new Set(s).add(n.id));
                toast('Notification dismissed.');
              }}
            />
          ))
        ) : (
          <EmptyState
            iconName="bell"
            title={filtered ? 'Nothing here' : 'No notifications yet'}
            body={
              filtered
                ? 'Nothing matches this filter. Clear it to see the full history.'
                : `This is where shift confirmations, check-in flags and staffing alerts appear — for
                   example when an event is running short with days to go, or a worker misses a
                   clock-in.`
            }
            action={
              filtered ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setType('all');
                    setUnreadOnly(false);
                  }}
                >
                  Clear filters
                </button>
              ) : undefined
            }
          />
        )}
      </section>
    </>
  );
}

function NotificationRow({
  n,
  isRead,
  onToggleRead,
  onDismiss,
}: {
  n: AppNotification;
  isRead: boolean;
  onToggleRead: () => void;
  onDismiss: () => void;
}) {
  return (
    <article
      className={`flex items-start gap-3 px-4 py-3.5 border-b border-surface-line-soft last:border-0 relative group ${
        isRead ? '' : 'bg-accent-soft'
      }`}
    >
      <span className="mt-0.5 shrink-0" style={{ color: TONE_HEX[n.severity] }}>
        <Icon name={TYPE_ICON[n.type] || 'bell'} decorative className="icon-lg" />
      </span>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-0.5">
          {!isRead ? (
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ background: TONE_HEX.info }}
              aria-label="Unread"
            />
          ) : null}
          <Link
            to={n.link}
            className={`text-[14px] font-semibold no-underline hover:text-accent hover:underline ${
              isRead ? 'text-ink-2' : 'text-ink'
            }`}
          >
            {n.title}
          </Link>
        </div>
        <p className="text-[13px] text-ink-2 leading-relaxed">{n.body}</p>
        <div className="flex items-center gap-2 mt-1.5">
          <span className="text-[11.5px] text-ink-3">{relative(n.at)}</span>
          <span className="text-ink-3">·</span>
          <span className="text-[11.5px] text-ink-3">
            {fmtDateFull(n.at)} {fmtTime(n.at) || ''}
          </span>
        </div>
      </div>

      <MenuButton
        className="btn-icon shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        label={`Actions for notification: ${n.title}`}
        items={[
          { label: isRead ? 'Mark as unread' : 'Mark as read', icon: isRead ? 'bell' : 'check', onSelect: onToggleRead },
          '-',
          { label: 'Dismiss', icon: 'close', onSelect: onDismiss },
        ]}
      />
    </article>
  );
}
