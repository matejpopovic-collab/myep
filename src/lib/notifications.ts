/* ============================================================================
   EPROSTA — NOTIFICATIONS
   ----------------------------------------------------------------------------
   Two problems, one module.

   1. The notifications page kept "read" and "dismissed" in component state, so
      marking twelve things read and navigating away un-marked all twelve. The
      bell in the top bar counted from the raw seed and never agreed with the
      page it links to.

   2. Half the product's actions are *messages* — send a callout, notify the
      selected workers, message one worker, tell a client their job is confirmed
      — and every one of them fired a toast and vanished. There was nowhere for
      a sent message to go, so there was no way to check whether the thing you
      just sent said what you meant.

   Giving sent messages a real destination fixes both. A callout is a
   notification with a known audience; putting it in the same list the operator
   already reads means "did that send?" is answerable, and the read state is
   worth persisting because it now describes something that happened.

   WHAT THIS DOES NOT DO
   ---------------------
   It does not send email, SMS or push. There is no service behind it and
   pretending otherwise would be the same lie in a new place. What it records is
   that EP *raised* the message, to whom, and when — which is the part the ops
   console is the system of record for anyway.
   ========================================================================== */

import { NOTIFICATIONS, NOW, employee as employeeById } from '@/data/db';
import { SHIFT_DAYS } from '@/data/clock';
import * as PREFS from './prefs';
import type { AppNotification, NotificationType, Tone } from '@/data/types';

const KEY = 'eprosta.notifications.v1';

/* ------------------------------------------------------------------ store */

const listeners = new Set<() => void>();
let version = 0;

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export const getVersion = (): number => version;
function emit(): void {
  version += 1;
  listeners.forEach((fn) => fn());
}

interface Journal {
  v: 1;
  shift: number;
  /** Notifications raised by something the operator did. */
  added: AppNotification[];
  /** Ids explicitly marked read, and ids explicitly marked unread. */
  read: string[];
  unread: string[];
  dismissed: string[];
}

const empty = (): Journal => ({ v: 1, shift: SHIFT_DAYS, added: [], read: [], unread: [], dismissed: [] });

function readJournal(): Journal {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!raw || raw.v !== 1 || raw.shift !== SHIFT_DAYS) return empty();
    const arr = (x: unknown): string[] => (Array.isArray(x) ? x : []);
    return {
      v: 1,
      shift: SHIFT_DAYS,
      added: Array.isArray(raw.added) ? raw.added : [],
      read: arr(raw.read),
      unread: arr(raw.unread),
      dismissed: arr(raw.dismissed),
    };
  } catch {
    return empty();
  }
}

let journal = readJournal();

/* ------------------------------------------------------------ seed clamp */

/**
 * Pull the seed back so nothing is dated in the future.
 *
 * The seed offset is rounded to the nearest whole week, which can leave the
 * seed sitting up to three days ahead of real time. Harmless for an event —
 * being three days early is a real state — but not for a notification, which
 * describes something that has already happened. Left alone, every seed row
 * outranks anything the operator does today: send a callout and the
 * confirmation of it appears below a week-old staffing alert, which reads
 * exactly like the send having failed.
 *
 * The whole seed moves by one constant, so the gaps between rows — and with
 * them the "2 hours ago, then yesterday" shape of the list — are preserved.
 */
function clampSeedToNow(): void {
  const now = Date.now();
  const latest = NOTIFICATIONS.reduce((m, n) => Math.max(m, +new Date(n.at)), 0);
  const overshoot = latest - now;
  if (overshoot <= 0) return;
  // A minute's headroom, so a notification raised in the same tick as this
  // runs still sorts above the newest seed row rather than tying with it.
  NOTIFICATIONS.forEach((n) => {
    n.at = new Date(+new Date(n.at) - overshoot - 60_000).toISOString();
  });
}

clampSeedToNow();

/**
 * Muting a type changes what `all()` returns, so it has to move this store's
 * version too. Without this the bell keeps its old count until something
 * unrelated happens to bump it, and the settings page appears not to work.
 */
PREFS.subscribe(() => emit());

function write(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(journal));
  } catch {
    /* private mode */
  }
  emit();
}

/* -------------------------------------------------------------- selectors */

/**
 * The live list: seed plus everything raised since, newest first, minus
 * anything dismissed.
 *
 * `unread` is resolved here rather than stored on the record, because the seed
 * ships its own value and the user's decision has to win without editing the
 * seed. Explicit read and explicit unread are tracked separately so that
 * "mark all read" followed by "mark this one unread" survives a reload.
 */
export function all(): AppNotification[] {
  const dismissed = new Set(journal.dismissed);
  const read = new Set(journal.read);
  const unread = new Set(journal.unread);

  return [...journal.added, ...NOTIFICATIONS]
    .filter((n) => !dismissed.has(n.id))
    // Muted types are filtered on the way OUT, never on the way in. `raise()`
    // still records them, because the console is the system of record for
    // messages EP sent and a preference about your own attention must not edit
    // that history. Unmute and everything you missed is there.
    .filter((n) => !PREFS.isMuted(n.type))
    .map((n) => ({
      ...n,
      unread: unread.has(n.id) ? true : read.has(n.id) ? false : n.unread,
    }))
    .sort((a, b) => +new Date(b.at) - +new Date(a.at));
}

export const unreadCount = (): number => all().filter((n) => n.unread).length;

/* ------------------------------------------------------------- read state */

export function markRead(id: string): void {
  journal.unread = journal.unread.filter((x) => x !== id);
  if (!journal.read.includes(id)) journal.read.push(id);
  write();
}

export function markUnread(id: string): void {
  journal.read = journal.read.filter((x) => x !== id);
  if (!journal.unread.includes(id)) journal.unread.push(id);
  write();
}

/**
 * Mark everything the person can currently see.
 *
 * Two subtleties, both about muted types. `all()` is already filtered, so this
 * only ever reads what is on screen — muting a type then unmuting it must not
 * silently have read the lot on your behalf. And the lists are MERGED rather
 * than replaced: assigning `journal.read` the visible ids would drop the
 * already-read ids inside a muted type, and they would come back unread the
 * moment you unmuted it.
 */
export function markAllRead(): void {
  const visible = all().map((n) => n.id);
  const seen = new Set(visible);
  journal.read = [...new Set([...journal.read, ...visible])];
  journal.unread = journal.unread.filter((id) => !seen.has(id));
  write();
}

export function dismiss(id: string): void {
  if (!journal.dismissed.includes(id)) journal.dismissed.push(id);
  write();
}

export function restoreDismissed(): void {
  journal.dismissed = [];
  write();
}

/* ----------------------------------------------------------------- raising */

export interface RaiseInput {
  type: NotificationType;
  severity?: Tone;
  title: string;
  body: string;
  link: string;
}

/** Record that EP raised a message. Returns the record so callers can link it. */
export function raise(input: RaiseInput): AppNotification {
  const n: AppNotification = {
    id: `nt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    type: input.type,
    severity: input.severity || 'info',
    unread: true,
    title: input.title,
    body: input.body,
    at: new Date().toISOString(),
    link: input.link,
  };
  journal.added.unshift(n);
  write();
  return n;
}

/* ------------------------------------------------- typed helpers per action */

/** "Callout sent" — the audience is stated because that is the decision made. */
export function callout(opts: {
  eventId: string;
  eventName: string;
  role: string | null;
  gap: number;
  audience: string;
  recipients: number;
}): AppNotification {
  const scope = opts.role ? `${opts.role} · ${opts.eventName}` : opts.eventName;
  return raise({
    type: 'staffing',
    severity: opts.gap > 0 ? 'atRisk' : 'info',
    title: `Callout sent · ${scope}`,
    body: `${opts.gap} ${opts.gap === 1 ? 'role' : 'roles'} advertised to ${opts.recipients} ${
      opts.recipients === 1 ? 'worker' : 'workers'
    } — ${opts.audience}.`,
    link: `/events/${opts.eventId}`,
  });
}

export function workersNotified(opts: {
  eventId: string;
  shiftLabel: string;
  employeeIds: string[];
  message: string;
}): AppNotification {
  const names = opts.employeeIds
    .map((id) => employeeById(id)?.name)
    .filter(Boolean)
    .slice(0, 3)
    .join(', ');
  const extra = opts.employeeIds.length - 3;
  return raise({
    type: 'confirmation',
    title: `Message sent to ${opts.employeeIds.length} on ${opts.shiftLabel}`,
    body: `${names}${extra > 0 ? ` and ${extra} more` : ''} — “${truncate(opts.message, 120)}”`,
    link: `/events/${opts.eventId}`,
  });
}

/**
 * A quote is over the threshold and waiting on a senior manager.
 *
 * Raised as `atRisk` rather than `info` because nothing else moves until
 * somebody acts on it: the client cannot see the job, and the person who
 * priced it has done all they can.
 */
export function quoteApprovalRequested(opts: {
  wofId: string;
  ref: string;
  title: string;
  client: string;
  value: string;
  requestedBy: string;
}): AppNotification {
  return raise({
    type: 'approval',
    severity: 'atRisk',
    title: `Approval needed on ${opts.ref} — ${opts.value}`,
    body: `${opts.requestedBy} has sent ${opts.title} (${opts.client}) up for approval. It cannot go to the client until a senior manager approves the figure.`,
    link: `/wofs/${opts.wofId}`,
  });
}

/** The decision, back to the person who asked. */
export function quoteApprovalDecided(opts: {
  wofId: string;
  ref: string;
  approved: boolean;
  by: string;
  value: string;
  reason?: string;
}): AppNotification {
  return raise({
    type: 'approval',
    severity: opts.approved ? 'healthy' : 'atRisk',
    title: opts.approved
      ? `${opts.ref} approved at ${opts.value}`
      : `${opts.ref} sent back by ${opts.by}`,
    body: opts.approved
      ? `${opts.by} approved the quote. It can now be sent to the client.`
      : `${opts.by} did not approve the quote at ${opts.value}${opts.reason ? ` — “${opts.reason}”` : ''}.`,
    link: `/wofs/${opts.wofId}`,
  });
}

/**
 * The client has come back on a quote. Raised as `atRisk`: a job with an open
 * query is a job nobody should be staffing yet.
 */
export function quoteQueried(opts: {
  wofId: string;
  ref: string;
  version: string;
  client: string;
  note: string;
  /** How many things they say the quote is missing. */
  missing?: number;
}): AppNotification {
  const n = opts.missing || 0;
  const asked = n ? `${n} thing${n === 1 ? '' : 's'} missing` : '';
  const said = opts.note.trim() ? `“${truncate(opts.note.trim(), 160)}”` : '';
  return raise({
    type: 'confirmation',
    severity: 'atRisk',
    title: n
      ? `${opts.client} sent back ${opts.ref} ${opts.version} — ${asked}`
      : `${opts.client} queried ${opts.ref} ${opts.version}`,
    body: `${
      said && asked ? `${said} and ${asked}` : said || (asked ? `They listed ${asked}` : 'Sent back with no detail')
    } — amend the quote and send it again; the query closes when they have a newer version.`,
    link: `/wofs/${opts.wofId}`,
  });
}

export function assignmentsMade(opts: {
  eventId: string;
  role: string;
  count: number;
}): AppNotification {
  return raise({
    type: 'staffing',
    title: `${opts.count} assigned to ${opts.role}`,
    body: `Placed directly onto the shift and asked to confirm. They are not counted as filled until they do.`,
    link: `/events/${opts.eventId}`,
  });
}

export function staffingGap(opts: {
  eventId: string;
  eventName: string;
  gap: number;
  start: string;
}): AppNotification {
  const days = Math.max(0, Math.round((+new Date(opts.start) - +NOW) / 86_400_000));
  return raise({
    type: 'staffing',
    severity: days <= 3 ? 'critical' : 'atRisk',
    title: `${opts.eventName} is ${opts.gap} short`,
    body: `${opts.gap} unfilled ${opts.gap === 1 ? 'role' : 'roles'} with ${days} ${
      days === 1 ? 'day' : 'days'
    } to go.`,
    link: `/events/${opts.eventId}`,
  });
}

const truncate = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;

/* ------------------------------------------------------------------ resets */

export function resetNotifications(): void {
  journal = empty();
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  emit();
}
