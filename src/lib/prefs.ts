/* ============================================================================
   EPROSTA — PERSONAL PREFERENCES
   ----------------------------------------------------------------------------
   Settings that belong to the person at the keyboard rather than to the
   business. Kept apart from `roles.ts` deliberately: that module answers "what
   is this account allowed to do", which is an administrator's decision and is
   audited. This one answers "how do you like it", which is nobody's business
   but yours and is not.

   TWO PREFERENCES, TWO DIFFERENT KINDS OF THING
   ---------------------------------------------
   TABLE DENSITY is a rendering choice. It changes nothing about what the app
   does, so it applies instantly and needs no confirmation. (There is no theme
   choice: the app ships light only, with the navigation rail dark.)

   NOTIFICATION MUTES change what you are told. That is not cosmetic — muting
   staffing alerts means an unfilled shift stops shouting at you — so the page
   says what each one costs, and a mute is scoped to a *type*, never to a
   severity. "Don't tell me about critical things" is not a preference this
   product offers, because the person who wants it is the person who most needs
   the alert.

   MUTING DOES NOT UNSEND
   ----------------------
   A muted type still records what EP raised; it just stays out of your list and
   your unread count. The console is the system of record for messages it sent,
   and a preference about your own attention must not edit that history — a
   callout that went to forty workers happened whether or not you wanted to see
   the confirmation. `notifications.all()` filters on read; `raise()` still
   writes.
   ========================================================================== */

import type { NotificationType } from '@/data/types';

const KEY = 'eprosta.prefs.v1';

/* ------------------------------------------------------------------ shape */

export interface Prefs {
  /** Notification types the person has muted. Empty is the default. */
  mutedTypes: NotificationType[];
  /**
   * Show the density-reduced table layout.
   *
   * Named for what it does rather than "compact", because on the payroll and
   * costing tables it removes the second line from a row, and somebody
   * choosing it should know that is what they are giving up.
   */
  denseTables: boolean;
}

export const NOTIFICATION_TYPES: {
  id: NotificationType;
  label: string;
  blurb: string;
  /** What you stop being told. Written as a loss, because that is what it is. */
  cost: string;
}[] = [
  {
    id: 'staffing',
    label: 'Staffing and callouts',
    blurb: 'Unfilled roles, callouts you have sent, and workers assigned to a shift.',
    cost: 'You will not be told when an event is short, however close it is.',
  },
  {
    id: 'checkin',
    label: 'Check-ins and timesheets',
    blurb: 'Workers checking in on site, and timesheets waiting for approval.',
    cost: 'Timesheets will still queue for approval — nothing will point you at them.',
  },
  {
    id: 'confirmation',
    label: 'Confirmations',
    blurb: 'Messages sent to workers and clients, and their replies.',
    cost: 'Sent messages are still recorded; you just will not see them arrive.',
  },
  {
    id: 'approval',
    label: 'Quote approvals',
    blurb: 'Quotes over the approval threshold waiting on a senior manager, and the decisions made on them.',
    cost: 'A large quote can sit unsent with nobody told it is waiting on you.',
  },
  {
    id: 'staff',
    label: 'Worker records',
    blurb: 'Right-to-work expiries, licence renewals and account flags.',
    cost: 'An expiring SIA licence will pass without notice until it blocks a shift.',
  },
];

const DEFAULTS: Prefs = { mutedTypes: [], denseTables: false };

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

const VALID_TYPES = new Set<string>(NOTIFICATION_TYPES.map((t) => t.id));

function read(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
    // A `theme` key saved by an earlier version is ignored, not migrated —
    // dark mode was removed and the app is light for everyone.
    return {
      // Filtered through the known list so a type removed from the product does
      // not survive in storage as a string nothing understands — the same
      // treatment `roles.ts` gives saved capabilities.
      mutedTypes: Array.isArray(raw.mutedTypes)
        ? (raw.mutedTypes.filter((t: unknown) => typeof t === 'string' && VALID_TYPES.has(t)) as NotificationType[])
        : [],
      denseTables: raw.denseTables === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

let prefs = read();

function write(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* private mode — degrades to in-memory, same as every other store here */
  }
  emit();
}

/* --------------------------------------------------------------- reading */

export const get = (): Prefs => ({ ...prefs, mutedTypes: [...prefs.mutedTypes] });
export const isMuted = (t: NotificationType): boolean => prefs.mutedTypes.includes(t);
export const denseTables = (): boolean => prefs.denseTables;


/* --------------------------------------------------------------- writing */

export function setMuted(t: NotificationType, muted: boolean): void {
  const has = prefs.mutedTypes.includes(t);
  if (has === muted) return;
  prefs.mutedTypes = muted ? [...prefs.mutedTypes, t] : prefs.mutedTypes.filter((x) => x !== t);
  write();
}

export function setDenseTables(on: boolean): void {
  if (prefs.denseTables === on) return;
  prefs.denseTables = on;
  write();
}

/** Back to shipped defaults. Does not touch anything else in storage. */
export function reset(): void {
  prefs = { ...DEFAULTS };
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  emit();
}

