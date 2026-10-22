/* ============================================================================
   CLIENT PORTAL USERS — who at a client can sign in, and what they may do
   ----------------------------------------------------------------------------
   The portal (`/client/*`) already shows a client their quotes, jobs, hours and
   invoices, and it is where a quote is signed and a deposit paid. Until now the
   only way in was the prototype "Viewing as" switcher. This module is the real
   list behind it: named people, per client, each with a role.

   Rules worth keeping when a backend replaces the localStorage journal:

     · INVITE, never create. EP enters a name and an email; the person sets
       their own password from the invite link. Nobody at EP ever holds a
       client's password, so there is no password field anywhere in here.

     · TWO ROLES, because the portal does two kinds of thing.
         viewer    reads quotes, jobs, hours and invoices.
         approver  also signs quotes, accepts variations and pays online.
       Signing commits the client to money. The question that matters is not
       "who can look" but "who can say yes", and the list has to answer it.

     · ONE ORGANISATION PER EMAIL. A login that sees two clients' work is a
       leak waiting to happen, so an address already on another account is
       refused rather than shared.

     · ACCESS FOLLOWS THE ACCOUNT. A deactivated or deleted client's users are
       blocked at read time (`effectiveStatus`) rather than rewritten, so
       reactivating the account restores exactly who had access before.

     · INVITES EXPIRE after INVITE_DAYS. A link that works forever is a
       credential sitting in someone's inbox.

   PASSWORDS
   ---------
   The person sets one from an invite link (`acceptInvite`), from a reset link
   (`resetPassword`), or on their account page (`changePassword`). Every one of
   those runs the same checks (`passwordChecks`).

   NOTHING ABOUT A PASSWORD IS STORED HERE — not the password, not a hash.
   A prototype that kept passwords in localStorage would be teaching the wrong
   lesson, and checking one properly needs a server. So `signIn` accepts any
   password for an active user, and says so in its doc comment; what IS real is
   who may sign in at all, the generic refusal, and the one-use, expiring links.
   ========================================================================== */

import { client as clientById } from '@/data/db';
import * as ROLES from './roles';
import * as HISTORY from './clienthistory';

/** Log a portal change against the client. Their own actions are signed by them. */
function log(u: PortalUser, title: string, opts: { changes?: HISTORY.Change[]; sensitive?: boolean; self?: boolean } = {}): void {
  HISTORY.record({
    clientId: u.clientId,
    area: 'portal',
    title,
    changes: opts.changes ?? [],
    sensitive: opts.sensitive,
    by: opts.self ? `${u.name} (${clientById(u.clientId)?.name ?? 'client'})` : undefined,
  });
}

const KEY = 'eprosta.portalusers.v1';
export const INVITE_DAYS = 7;
export const RESET_HOURS = 1;
export const MIN_PASSWORD = 10;

/** Local wall-clock ISO without a zone, the shape every other date here uses. */
function localIso(t: number): string {
  const d = new Date(t);
  return new Date(t - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}

/** An unguessable link token. The link IS the credential until it is used. */
function newToken(): string {
  const bytes = new Uint8Array(18);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export type PortalRole = 'approver' | 'viewer';
export type PortalStatus = 'invited' | 'active' | 'disabled';
/** What the record says, plus what the account and the clock say about it. */
export type EffectiveStatus = PortalStatus | 'expired' | 'blocked';

export interface PortalUser {
  id: string;
  clientId: string;
  name: string;
  email: string;
  role: PortalRole;
  status: PortalStatus;
  invitedAt: string;
  invitedBy: string;
  activatedAt: string | null;
  lastSignIn: string | null;
  /** The live invite link's token; null once accepted or never sent. */
  inviteToken: string | null;
  /** A password reset in flight, if any. One at a time — a new one replaces it. */
  reset: { token: string; at: string; by: string; expiresAt: string } | null;
  /** When they last set a password. The password itself is never held. */
  passwordSetAt: string | null;
}

export const ROLE_META: Record<PortalRole, { label: string; blurb: string }> = {
  approver: {
    label: 'Approver',
    blurb: 'Sees everything, and can sign quotes, accept variations and pay invoices.',
  },
  viewer: {
    label: 'Viewer',
    blurb: 'Sees quotes, jobs, hours and invoices. Cannot sign or pay.',
  },
};

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

/* Festival Republic is the account the portal opens on, so it ships with a
   realistic team: the named contact as approver, a viewer from the site team,
   and an invite nobody has picked up yet. Every other client starts empty. */
const DAY = 86400000;
/** Seed dates sit relative to today, so the demo invite is never born expired. */
const ago = (days: number, hour = 10): string => {
  const d = new Date(Date.now() - days * DAY);
  d.setHours(hour, 0, 0, 0);
  return localIso(+d);
};

function seed(): PortalUser[] {
  return [
    {
      id: 'pu-1', clientId: 'c-19', name: 'Dana Reilly', email: 'dana.reilly@festivalrepublic.com',
      role: 'approver', status: 'active', invitedAt: ago(220), invitedBy: 'Colin Harding',
      activatedAt: ago(220, 15), lastSignIn: ago(1, 9), inviteToken: null, reset: null, passwordSetAt: ago(220, 15),
    },
    {
      id: 'pu-2', clientId: 'c-19', name: 'Tom Akers', email: 'tom.akers@festivalrepublic.com',
      role: 'viewer', status: 'active', invitedAt: ago(150), invitedBy: 'Colin Harding',
      activatedAt: ago(149, 8), lastSignIn: ago(15, 16), inviteToken: null, reset: null, passwordSetAt: ago(149, 8),
    },
    {
      id: 'pu-3', clientId: 'c-19', name: 'Priya Shah', email: 'ap@festivalrepublic.com',
      role: 'approver', status: 'invited', invitedAt: ago(4, 15), invitedBy: 'Colin Harding',
      activatedAt: null, lastSignIn: null, inviteToken: newToken(), reset: null, passwordSetAt: null,
    },
  ];
}

interface Journal {
  v: 1;
  users: PortalUser[];
  /** Tokens that have been used. A spent link says "already used", not "invalid". */
  spent: string[];
}

function load(): Journal {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null') as Journal | null;
    if (raw && raw.v === 1 && Array.isArray(raw.users)) {
      // Lists saved before links existed: give a pending invite a live link.
      raw.users.forEach((u) => {
        u.reset ??= null;
        u.passwordSetAt ??= u.activatedAt ?? null;
        if (u.inviteToken === undefined) u.inviteToken = u.status === 'invited' ? newToken() : null;
      });
      raw.spent = Array.isArray(raw.spent) ? raw.spent : [];
      return raw;
    }
  } catch {
    /* private mode or junk — fall back to the seed */
  }
  // Saved straight away: the seeded invite's token is random, and a link has
  // to keep working across reloads before anyone has changed anything.
  const fresh: Journal = { v: 1, users: seed(), spent: [] };
  try {
    localStorage.setItem(KEY, JSON.stringify(fresh));
  } catch {
    /* private mode — in-memory only */
  }
  return fresh;
}

let JOURNAL: Journal = load();

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(JOURNAL));
  } catch {
    /* private mode — degrades to in-memory */
  }
  emit();
}

export function resetPortalUsers(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  JOURNAL = { v: 1, users: seed(), spent: [] };
  emit();
}

/* ------------------------------------------------------------------ reads */

const clock = (): number => Date.now();
const nowIso = (): string => localIso(clock());

export const user = (id: string): PortalUser | undefined => JOURNAL.users.find((u) => u.id === id);

export function forClient(clientId: string): PortalUser[] {
  const order: Record<EffectiveStatus, number> = { active: 0, invited: 1, expired: 2, disabled: 3, blocked: 4 };
  return JOURNAL.users
    .filter((u) => u.clientId === clientId)
    .sort(
      (a, b) =>
        order[effectiveStatus(a)] - order[effectiveStatus(b)] ||
        (a.role === b.role ? 0 : a.role === 'approver' ? -1 : 1) ||
        a.name.localeCompare(b.name),
    );
}

export function inviteExpiresAt(u: PortalUser): number {
  return +new Date(u.invitedAt) + INVITE_DAYS * 86400000;
}

export function effectiveStatus(u: PortalUser): EffectiveStatus {
  const c = clientById(u.clientId);
  if (!c || c.status !== 'active') return 'blocked';
  if (u.status === 'invited' && inviteExpiresAt(u) < clock()) return 'expired';
  return u.status;
}

/** People who can sign in right now. */
export const activeFor = (clientId: string): PortalUser[] =>
  forClient(clientId).filter((u) => effectiveStatus(u) === 'active');

export interface Summary {
  active: number;
  approvers: number;
  pending: number;
  expired: number;
  total: number;
}

export function summary(clientId: string): Summary {
  const all = forClient(clientId);
  const s = all.map(effectiveStatus);
  return {
    active: s.filter((x) => x === 'active').length,
    approvers: all.filter((u) => effectiveStatus(u) === 'active' && u.role === 'approver').length,
    pending: s.filter((x) => x === 'invited').length,
    expired: s.filter((x) => x === 'expired').length,
    total: all.length,
  };
}

/* ----------------------------------------------------------------- writes */

export type Result = { ok: true; user: PortalUser } | { ok: false; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateEmail(email: string, ignoreId?: string): string | null {
  const e = email.trim().toLowerCase();
  if (!e) return 'An email address is needed — the invite goes there.';
  if (!EMAIL_RE.test(e)) return 'That does not look like an email address.';
  const clash = JOURNAL.users.find((u) => u.email.toLowerCase() === e && u.id !== ignoreId);
  if (clash) {
    const other = clientById(clash.clientId);
    return other
      ? `${e} already has portal access at ${other.name}. One login sees one organisation.`
      : `${e} already has a portal login.`;
  }
  return null;
}

/** A soft check, never a block: agencies and finance houses use other domains. */
export function domainMismatch(clientId: string, email: string): string | null {
  const c = clientById(clientId);
  const at = (s: string | null | undefined) => (s && s.includes('@') ? s.split('@')[1].toLowerCase() : null);
  const theirs = at(c?.email);
  const mine = at(email.trim());
  if (!c || !theirs || !mine || theirs === mine) return null;
  return `Not an @${theirs} address. Check this person works for ${c.name}.`;
}

function guard(): string | null {
  return ROLES.denial('clients.portal');
}

function actorName(): string {
  return ROLES.acting().name;
}

export function invite(clientId: string, input: { name: string; email: string; role: PortalRole }): Result {
  const denied = guard();
  if (denied) return { ok: false, error: denied };
  const c = clientById(clientId);
  if (!c) return { ok: false, error: 'That client no longer exists.' };
  if (c.status !== 'active') return { ok: false, error: `${c.name} is inactive. Reactivate the account before inviting anyone.` };
  const name = input.name.trim();
  if (!name) return { ok: false, error: 'Add their name, so the invite and the history say who it is.' };
  const bad = validateEmail(input.email);
  if (bad) return { ok: false, error: bad };

  const u: PortalUser = {
    id: `pu-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    clientId,
    name,
    email: input.email.trim().toLowerCase(),
    role: input.role,
    status: 'invited',
    invitedAt: nowIso(),
    invitedBy: actorName(),
    activatedAt: null,
    lastSignIn: null,
    inviteToken: newToken(),
    reset: null,
    passwordSetAt: null,
  };
  JOURNAL.users.push(u);
  persist();
  log(u, `Portal invite sent to ${u.name}`, {
    changes: [
      { label: 'Role', from: '—', to: ROLE_META[u.role].label },
      { label: 'Email', from: '—', to: u.email },
    ],
    // A new approver can commit the client to money: worth a second look.
    sensitive: u.role === 'approver',
  });
  return { ok: true, user: u };
}

function patch(id: string, p: Partial<PortalUser>): Result {
  const denied = guard();
  if (denied) return { ok: false, error: denied };
  const u = user(id);
  if (!u) return { ok: false, error: 'That portal user no longer exists.' };
  Object.assign(u, p);
  persist();
  return { ok: true, user: u };
}

/** A fresh link with a fresh expiry. The old one stops working. */
export function resend(id: string): Result {
  const u = user(id);
  if (u?.inviteToken) JOURNAL.spent.push(u.inviteToken);
  const r = patch(id, { invitedAt: nowIso(), invitedBy: actorName(), inviteToken: newToken() });
  if (r.ok) log(r.user, `Invite resent to ${r.user.name}`, { changes: [{ label: 'Old link', from: 'Live', to: 'Cancelled' }] });
  return r;
}

export function setRole(id: string, role: PortalRole): Result {
  const was = user(id)?.role;
  const r = patch(id, { role });
  if (r.ok && was && was !== role) {
    log(r.user, `${r.user.name} made ${ROLE_META[role].label.toLowerCase()}`, {
      changes: [{ label: 'Role', from: ROLE_META[was].label, to: ROLE_META[role].label }],
      sensitive: role === 'approver',
    });
  }
  return r;
}

/** Disabling also kills any reset link in flight — it would be a way back in. */
export function disable(id: string): Result {
  const wasActive = user(id)?.status === 'active';
  const r = patch(id, { status: 'disabled', reset: null });
  if (r.ok) {
    log(r.user, wasActive ? `${r.user.name}'s sign-in disabled` : `Invite to ${r.user.name} withdrawn`, {
      changes: [{ label: 'Access', from: wasActive ? 'Active' : 'Invited', to: wasActive ? 'Disabled' : 'Withdrawn' }],
    });
  }
  return r;
}

/** Back to how they were before: active if they had ever signed in, else invited. */
export function enable(id: string): Result {
  const u = user(id);
  if (!u) return { ok: false, error: 'That portal user no longer exists.' };
  const r = u.activatedAt
    ? patch(id, { status: 'active' })
    : patch(id, { status: 'invited', invitedAt: nowIso(), invitedBy: actorName(), inviteToken: newToken() });
  if (r.ok) {
    log(r.user, u.activatedAt ? `${r.user.name}'s sign-in re-enabled` : `Invite to ${r.user.name} sent again`, {
      changes: [{ label: 'Access', from: 'Disabled', to: u.activatedAt ? 'Active' : 'Invited' }],
      sensitive: r.user.role === 'approver',
    });
  }
  return r;
}

export function remove(id: string): boolean {
  if (guard()) return false;
  const gone = user(id);
  if (!gone) return false;
  JOURNAL.users = JOURNAL.users.filter((u) => u.id !== id);
  persist();
  log(gone, `${gone.name} removed from the portal`, {
    changes: [{ label: 'Email', from: gone.email, to: '—' }, { label: 'Role', from: ROLE_META[gone.role].label, to: '—' }],
  });
  return true;
}

/** Drop every login for a client that is being deleted outright. */
export function removeAllFor(clientId: string): void {
  const before = JOURNAL.users.length;
  JOURNAL.users = JOURNAL.users.filter((u) => u.clientId !== clientId);
  if (JOURNAL.users.length !== before) persist();
}

/* ------------------------------------------------------------------ links */

export type LinkKind = 'invite' | 'reset';
export type LinkState = 'ok' | 'expired' | 'used' | 'withdrawn' | 'invalid';

export interface LinkInfo {
  state: LinkState;
  kind: LinkKind | null;
  user: PortalUser | null;
}

export const invitePath = (token: string): string => `/portal/invite/${token}`;
export const resetPath = (token: string): string => `/portal/reset/${token}`;

/**
 * What a link is, and whether it still works. Reads only — opening a link does
 * not spend it; setting a password does.
 */
export function linkInfo(token: string | undefined): LinkInfo {
  if (!token) return { state: 'invalid', kind: null, user: null };
  const inv = JOURNAL.users.find((u) => u.inviteToken === token);
  if (inv) {
    const st = effectiveStatus(inv);
    if (st === 'expired') return { state: 'expired', kind: 'invite', user: inv };
    if (st !== 'invited') return { state: 'withdrawn', kind: 'invite', user: inv };
    return { state: 'ok', kind: 'invite', user: inv };
  }
  const rst = JOURNAL.users.find((u) => u.reset?.token === token);
  if (rst && rst.reset) {
    if (effectiveStatus(rst) !== 'active') return { state: 'withdrawn', kind: 'reset', user: rst };
    if (+new Date(rst.reset.expiresAt) < clock()) return { state: 'expired', kind: 'reset', user: rst };
    return { state: 'ok', kind: 'reset', user: rst };
  }
  if (JOURNAL.spent.includes(token)) return { state: 'used', kind: null, user: null };
  return { state: 'invalid', kind: null, user: null };
}

/* -------------------------------------------------------------- passwords */

export interface Check {
  id: string;
  label: string;
  ok: boolean;
}

const COMMON = ['password', 'qwerty', '123456', 'letmein', 'welcome', 'iloveyou', 'abc123', 'football', 'monkey'];

/** The rules, as a checklist the form can show while they type. */
export function passwordChecks(pw: string, confirm: string, u: Pick<PortalUser, 'name' | 'email'> | null): Check[] {
  const low = pw.toLowerCase();
  const personal = u
    ? [...u.name.toLowerCase().split(/\s+/), u.email.toLowerCase().split('@')[0]].filter((x) => x.length >= 3)
    : [];
  return [
    { id: 'length', label: `At least ${MIN_PASSWORD} characters`, ok: pw.length >= MIN_PASSWORD },
    {
      id: 'personal',
      label: 'Not your name, your email or a common password',
      ok: !!pw && !personal.some((x) => low.includes(x)) && !COMMON.some((x) => low.includes(x)),
    },
    { id: 'match', label: 'Both passwords match', ok: !!pw && pw === confirm },
  ];
}

const passes = (pw: string, confirm: string, u: PortalUser | null): boolean =>
  passwordChecks(pw, confirm, u).every((c) => c.ok);

const LINK_ERROR: Record<Exclude<LinkState, 'ok'>, string> = {
  expired: 'This link has expired.',
  used: 'This link has already been used.',
  withdrawn: 'This link is no longer valid.',
  invalid: 'This link is not valid.',
};

/** From the invite email: set a password, become active, and be signed in. */
export function acceptInvite(token: string, pw: string, confirm: string): Result {
  const info = linkInfo(token);
  if (info.state !== 'ok' || info.kind !== 'invite' || !info.user) {
    return { ok: false, error: LINK_ERROR[info.state === 'ok' ? 'invalid' : info.state] };
  }
  const u = info.user;
  if (!passes(pw, confirm, u)) return { ok: false, error: 'The password does not meet every rule yet.' };
  const at = nowIso();
  JOURNAL.spent.push(token);
  Object.assign(u, { status: 'active' as const, activatedAt: at, lastSignIn: at, passwordSetAt: at, inviteToken: null });
  persist();
  log(u, `${u.name} accepted the invite and set a password`, { self: true });
  return { ok: true, user: u };
}

/** From a reset email: set a new password and be signed in. One use only. */
export function resetPassword(token: string, pw: string, confirm: string): Result {
  const info = linkInfo(token);
  if (info.state !== 'ok' || info.kind !== 'reset' || !info.user) {
    return { ok: false, error: LINK_ERROR[info.state === 'ok' ? 'invalid' : info.state] };
  }
  const u = info.user;
  if (!passes(pw, confirm, u)) return { ok: false, error: 'The password does not meet every rule yet.' };
  const at = nowIso();
  JOURNAL.spent.push(token);
  Object.assign(u, { reset: null, passwordSetAt: at, lastSignIn: at });
  persist();
  log(u, `${u.name} set a new password from a reset link`, { self: true });
  return { ok: true, user: u };
}

function issueReset(u: PortalUser, by: string): string {
  if (u.reset) JOURNAL.spent.push(u.reset.token);
  const token = newToken();
  u.reset = { token, at: nowIso(), by, expiresAt: localIso(clock() + RESET_HOURS * 3600000) };
  persist();
  return token;
}

/**
 * "Forgot password". Says nothing about whether the address exists — the
 * screen shows the same sentence either way. Returns the link only so the
 * PROTOTYPE can offer it in place of the email it cannot send.
 */
export function requestReset(email: string): string | null {
  const e = email.trim().toLowerCase();
  const u = JOURNAL.users.find((x) => x.email.toLowerCase() === e);
  if (!u || effectiveStatus(u) !== 'active') return null;
  const path = resetPath(issueReset(u, 'Self-service'));
  log(u, `${u.name} asked for a password reset`, { self: true });
  return path;
}

/** The reset token if one is still usable, else null. */
export function liveReset(u: PortalUser): string | null {
  return u.reset && +new Date(u.reset.expiresAt) >= clock() ? u.reset.token : null;
}

/** EP Team sends someone a reset link. EP still never sees the password. */
export function sendReset(id: string): Result {
  const denied = guard();
  if (denied) return { ok: false, error: denied };
  const u = user(id);
  if (!u) return { ok: false, error: 'That portal user no longer exists.' };
  if (effectiveStatus(u) !== 'active') return { ok: false, error: 'Only someone who can sign in can be sent a reset link.' };
  issueReset(u, actorName());
  log(u, `Password reset sent to ${u.name}`, { changes: [{ label: 'Sent to', from: '—', to: u.email }] });
  return { ok: true, user: u };
}

/** The one refusal sign-in ever gives, so it cannot be used to test addresses. */
export const SIGN_IN_REFUSED = 'Email or password not recognised.';

/**
 * Sign in to the portal.
 *
 * PROTOTYPE: any non-empty password is accepted for an active user, because no
 * password is stored to check against (see the header). Everything else is
 * real: disabled, blocked, expired and never-accepted users are refused, and
 * every refusal reads the same.
 */
export function signIn(email: string, pw: string): Result {
  const e = email.trim().toLowerCase();
  const u = JOURNAL.users.find((x) => x.email.toLowerCase() === e);
  if (!u || !pw || effectiveStatus(u) !== 'active') return { ok: false, error: SIGN_IN_REFUSED };
  u.lastSignIn = nowIso();
  persist();
  return { ok: true, user: u };
}

/**
 * Change password from the account page. The current password is required by
 * the form; as with sign-in, the prototype cannot verify it.
 */
export function changePassword(id: string, current: string, pw: string, confirm: string): Result {
  const u = user(id);
  if (!u || effectiveStatus(u) !== 'active') return { ok: false, error: 'You are not signed in.' };
  if (!current) return { ok: false, error: 'Enter your current password.' };
  if (current === pw) return { ok: false, error: 'The new password has to be different from the current one.' };
  if (!passes(pw, confirm, u)) return { ok: false, error: 'The new password does not meet every rule yet.' };
  if (u.reset) JOURNAL.spent.push(u.reset.token);
  Object.assign(u, { passwordSetAt: nowIso(), reset: null });
  persist();
  log(u, `${u.name} changed their password`, { self: true });
  return { ok: true, user: u };
}

/** Called by the portal when the acting user changes — the prototype's "sign-in". */
export function touchSignIn(id: string): void {
  const u = user(id);
  if (!u || u.status !== 'active') return;
  u.lastSignIn = nowIso();
  try {
    localStorage.setItem(KEY, JSON.stringify(JOURNAL));
  } catch {
    /* ignore */
  }
  emit();
}
