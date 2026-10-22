/* ============================================================================
   CLIENT RECORD → PORTAL ACCESS
   ----------------------------------------------------------------------------
   Who at this client can sign in to the portal, and whether they can only look
   or can also say yes. The rules live in `lib/portalusers.ts`; this screen is
   the place EP Team invites people, picks their role and switches them off.

   Two things it insists on that the old screen (a username box and an email
   box) did not:
     · a ROLE per person, because the portal is where quotes are signed and
       deposits paid, and "who can commit this client to money" is the question
       an account manager actually needs answered;
     · a STATUS per person — invited, active, expired, disabled — because
       people leave client companies and their access has to be visibly gone.
   ========================================================================== */

import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { EmptyState } from '@/components/primitives';
import { ConfirmDestructive, MenuButton, type MenuEntry } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { TONE_BG, TONE_HEX, TONE_LINE } from '@/lib/status';
import { dayDiff, fmtDate, fmtDateFull } from '@/lib/format';
import { NOW } from '@/data/db';
import type { Client, Tone } from '@/data/types';
import * as PU from '@/lib/portalusers';
import * as ROLES from '@/lib/roles';
import { usePortalUsersVersion, useRolesVersion } from '@/lib/useStore';

const STATUS: Record<PU.EffectiveStatus, { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'healthy' },
  invited: { label: 'Invited', tone: 'info' },
  expired: { label: 'Invite expired', tone: 'atRisk' },
  disabled: { label: 'Disabled', tone: 'neutral' },
  blocked: { label: 'Blocked', tone: 'neutral' },
};

function Chip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className="pill" style={{ background: TONE_BG[tone], color: TONE_HEX[tone] }}>
      {children}
    </span>
  );
}

/** The prototype's stand-in for the email: open the link in a new tab. */
function openLink(path: string): void {
  window.open(path, '_blank', 'noopener');
}

function statusLine(u: PU.PortalUser, st: PU.EffectiveStatus): string {
  if (st === 'active') return u.lastSignIn ? `Last signed in ${fmtDate(u.lastSignIn)}` : 'Not signed in yet';
  if (st === 'invited') {
    const left = Math.max(0, dayDiff(NOW, PU.inviteExpiresAt(u)));
    return left === 0 ? 'Link expires today' : `Link expires in ${left} day${left === 1 ? '' : 's'}`;
  }
  if (st === 'expired') return 'Link no longer works — resend it';
  if (st === 'blocked') return 'Account is inactive';
  return u.activatedAt ? 'Cannot sign in' : 'Invite withdrawn';
}

export default function PortalTab({ c }: { c: Client }) {
  usePortalUsersVersion();
  useRolesVersion();
  const toast = useToast();

  const canManage = ROLES.can('clients.portal');
  const denied = ROLES.denial('clients.portal');
  const users = PU.forClient(c.id);
  const s = PU.summary(c.id);
  const inactive = c.status !== 'active';

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<PU.PortalRole>('viewer');
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<PU.PortalUser | null>(null);

  const taken = new Set(users.map((u) => u.email.toLowerCase()));
  const suggestions = [
    c.email ? { name: c.contact || '', email: c.email, role: 'approver' as const, why: c.contactRole || 'Main contact' } : null,
    c.billingEmail
      ? { name: c.invoiceContactName || '', email: c.billingEmail, role: 'viewer' as const, why: 'Invoice contact' }
      : null,
  ].filter(
    (x): x is { name: string; email: string; role: PU.PortalRole; why: string } =>
      !!x && !taken.has(x.email.toLowerCase()),
  )
    // The main and invoice addresses are often the same inbox; offer it once.
    .filter((x, i, all) => all.findIndex((y) => y.email.toLowerCase() === x.email.toLowerCase()) === i);

  const mismatch = email.trim() && !PU.validateEmail(email) ? PU.domainMismatch(c.id, email) : null;

  const send = () => {
    const r = PU.invite(c.id, { name, email, role });
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setName('');
    setEmail('');
    setRole('viewer');
    setError(null);
    toast(`Invite sent to ${r.user.email}. The link works for ${PU.INVITE_DAYS} days.`, { tone: 'healthy' });
  };

  const run = (r: PU.Result, ok: string) =>
    r.ok ? toast(ok, { tone: 'healthy' }) : toast(r.error, { tone: 'critical' });

  const menu = (u: PU.PortalUser, st: PU.EffectiveStatus): MenuEntry[] => {
    const other: PU.PortalRole = u.role === 'approver' ? 'viewer' : 'approver';
    const items: MenuEntry[] = [];
    if (st === 'invited' || st === 'expired') {
      items.push({
        label: 'Resend invite',
        icon: 'mail',
        hint: 'Sends a fresh link. The old one stops working.',
        onSelect: () => run(PU.resend(u.id), `New invite sent to ${u.email}.`),
      });
      if (st === 'invited' && u.inviteToken) {
        const token = u.inviteToken;
        items.push({
          label: 'Open invite link',
          icon: 'externalLink',
          badge: 'Prototype',
          hint: 'Opens the page their email links to, so you can set the password as they would.',
          onSelect: () => openLink(PU.invitePath(token)),
        });
      }
    }
    if (st === 'active') {
      items.push({
        label: 'Send password reset',
        icon: 'mail',
        hint: `Emails a link to set a new password. It works once, for ${PU.RESET_HOURS} hour. You never see the password.`,
        onSelect: () => run(PU.sendReset(u.id), `Password reset sent to ${u.email}.`),
      });
      const live = PU.liveReset(u);
      if (live) {
        items.push({
          label: 'Open reset link',
          icon: 'externalLink',
          badge: 'Prototype',
          hint: 'Opens the page the reset email links to.',
          onSelect: () => openLink(PU.resetPath(live)),
        });
      }
    }
    items.push({
      label: `Make ${PU.ROLE_META[other].label.toLowerCase()}`,
      icon: other === 'approver' ? 'edit' : 'staff',
      hint: PU.ROLE_META[other].blurb,
      onSelect: () => run(PU.setRole(u.id, other), `${u.name} is now ${PU.ROLE_META[other].label.toLowerCase()}.`),
    });
    items.push('-');
    if (u.status === 'disabled') {
      items.push({
        label: 'Re-enable access',
        icon: 'checkCircle',
        onSelect: () => run(PU.enable(u.id), `${u.name} has portal access again.`),
      });
    } else {
      items.push({
        label: st === 'active' ? 'Disable sign-in' : 'Withdraw invite',
        icon: 'ban',
        hint: 'Keeps them on the list so it can be undone.',
        onSelect: () =>
          run(PU.disable(u.id), st === 'active' ? `${u.name} can no longer sign in.` : `Invite to ${u.email} withdrawn.`),
      });
    }
    items.push({ label: 'Remove from list', icon: 'trash', danger: true, onSelect: () => setRemoving(u) });
    return items;
  };

  return (
    <>
      <div className="card p-5 mb-4">
        <div className="flex flex-wrap items-start justify-between gap-4 mb-1">
          <div className="min-w-0 max-w-2xl">
            <h2 className="text-[15px] font-semibold text-ink">Portal access</h2>
            <p className="text-[13px] text-ink-2 leading-relaxed mt-1">
              People at {c.name} who can sign in to see their quotes, jobs, hours and invoices. They get an
              email invite and set their own password — EP never sees it.
            </p>
          </div>
          <div className="flex gap-4 text-[12.5px] text-ink-2">
            <span>
              <strong className="text-ink tabular-nums">{s.active}</strong> active
            </span>
            <span>
              <strong className="text-ink tabular-nums">{s.approvers}</strong> can sign &amp; pay
            </span>
            {s.pending ? (
              <span>
                <strong className="text-ink tabular-nums">{s.pending}</strong> invite{s.pending === 1 ? '' : 's'} pending
              </span>
            ) : null}
          </div>
        </div>

        {/* What the two roles mean, said once, where the choice is made. */}
        <div className="grid sm:grid-cols-2 gap-2.5 mt-4">
          {(['approver', 'viewer'] as PU.PortalRole[]).map((r) => (
            <div key={r} className="well p-3">
              <div className="flex items-center gap-2 text-[12.5px] font-semibold text-ink">
                <Icon name={r === 'approver' ? 'edit' : 'staff'} decorative className="icon-sm" />
                {PU.ROLE_META[r].label}
              </div>
              <p className="text-[12px] text-ink-2 leading-relaxed mt-1">{PU.ROLE_META[r].blurb}</p>
            </div>
          ))}
        </div>
      </div>

      {inactive ? (
        <Banner tone="atRisk" icon="ban">
          {c.name} is inactive, so nobody on this list can sign in. Reactivating the account restores their access as
          it was.
        </Banner>
      ) : s.total && !s.approvers ? (
        <Banner tone="atRisk" icon="alert">
          Nobody at {c.name} can sign quotes or pay online yet. Make an active user an approver, or invite one.
        </Banner>
      ) : null}

      {/* --- invite ---------------------------------------------------------- */}
      {!inactive ? (
        <div className="card p-5 mb-4">
          <h3 className="text-[13.5px] font-semibold text-ink mb-3">Invite someone</h3>

          {canManage && suggestions.length ? (
            <div className="flex flex-wrap items-center gap-2 mb-3.5">
              <span className="text-[12px] text-ink-3">From this record:</span>
              {suggestions.map((x) => (
                <button
                  key={x.email}
                  type="button"
                  className="btn btn-secondary btn-sm"
                  title={`${x.why}. Fills the form — nothing is sent until you press Send invite.`}
                  onClick={() => {
                    setName(x.name);
                    setEmail(x.email);
                    setRole(x.role);
                    setError(null);
                  }}
                >
                  <Icon name="userPlus" decorative className="icon-sm" />
                  {x.name ? `${x.name} · ` : ''}
                  {x.email}
                </button>
              ))}
            </div>
          ) : null}

          <form
            className="grid gap-3 md:grid-cols-[1fr_1.3fr_auto_auto] md:items-start"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <label className="block">
              <span className="block text-[12px] font-medium text-ink-2 mb-1">Name</span>
              <input
                className="field"
                value={name}
                placeholder="e.g. Sharon Price"
                disabled={!canManage}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
              />
            </label>
            <label className="block">
              <span className="block text-[12px] font-medium text-ink-2 mb-1">Work email</span>
              <input
                className="field"
                type="email"
                value={email}
                placeholder={c.email ? `name@${c.email.split('@')[1] ?? ''}` : 'name@company.co.uk'}
                disabled={!canManage}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setError(null);
                }}
              />
              {mismatch ? (
                <span className="block text-[11.5px] mt-1" style={{ color: TONE_HEX.atRisk }}>
                  {mismatch}
                </span>
              ) : null}
            </label>
            <label className="block">
              <span className="block text-[12px] font-medium text-ink-2 mb-1">Role</span>
              <select
                className="field"
                value={role}
                disabled={!canManage}
                onChange={(e) => setRole(e.target.value as PU.PortalRole)}
              >
                <option value="viewer">Viewer</option>
                <option value="approver">Approver</option>
              </select>
            </label>
            <div className="md:pt-[22px]">
              <button type="submit" className="btn btn-primary w-full" disabled={!canManage} title={denied || undefined}>
                <Icon name="mail" decorative /> Send invite
              </button>
            </div>
          </form>
          {error ? <p className="text-[12.5px] text-status-critical mt-2.5">{error}</p> : null}
          {!canManage ? (
            <p className="text-[12px] text-ink-3 mt-2.5">{denied}</p>
          ) : (
            <p className="text-[11.5px] text-ink-3 mt-2.5">
              The link works for {PU.INVITE_DAYS} days. One email can only belong to one client.
            </p>
          )}
        </div>
      ) : null}

      {/* --- the list ---------------------------------------------------------- */}
      <div className="card overflow-hidden">
        {users.length ? (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Invited</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const st = PU.effectiveStatus(u);
                  const meta = STATUS[st];
                  const dim = st === 'disabled' || st === 'blocked';
                  return (
                    <tr key={u.id} style={dim ? { opacity: 0.65 } : undefined}>
                      <td>
                        <div className="text-[13.5px] text-ink">{u.name}</div>
                        <a href={`mailto:${u.email}`} className="text-[12px] text-ink-3 no-underline hover:underline">
                          {u.email}
                        </a>
                      </td>
                      <td>
                        <Chip tone={u.role === 'approver' ? 'info' : 'neutral'}>{PU.ROLE_META[u.role].label}</Chip>
                      </td>
                      <td>
                        <div className="flex flex-col items-start gap-1">
                          <Chip tone={meta.tone}>{meta.label}</Chip>
                          <span className="text-[11.5px] text-ink-3">{statusLine(u, st)}</span>
                          {st === 'active' && PU.liveReset(u) && u.reset ? (
                            <span className="text-[11.5px]" style={{ color: TONE_HEX.info }}>
                              Reset link sent {fmtDate(u.reset.at)} by {u.reset.by}
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="text-[12.5px] text-ink-2 whitespace-nowrap">
                        {fmtDateFull(u.invitedAt)}
                        <div className="text-[11.5px] text-ink-3">by {u.invitedBy}</div>
                      </td>
                      <td className="text-right">
                        {canManage && st !== 'blocked' ? (
                          <MenuButton label={`Actions for ${u.name}`} items={menu(u, st)} />
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            iconName="users"
            title="No portal users yet"
            body={`Until someone is invited, ${c.name} cannot see their quotes or sign anything online — EP sends documents by email instead.`}
          />
        )}
      </div>

      {removing ? (
        <ConfirmDestructive
          title={`Remove ${removing.name}?`}
          message={
            <>
              {removing.email} is taken off {c.name}&rsquo;s portal list and can no longer sign in. Their name stays on
              anything they already signed. To keep them on the list but stop them signing in, disable them instead.
            </>
          }
          confirmLabel="Remove access"
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            if (PU.remove(removing.id)) toast(`${removing.name} removed from the portal.`, { tone: 'neutral' });
          }}
        />
      ) : null}
    </>
  );
}

function Banner({ tone, icon, children }: { tone: Tone; icon: string; children: React.ReactNode }) {
  return (
    <div className="well p-3 mb-4 flex items-start gap-2.5" style={{ borderColor: TONE_LINE[tone], background: TONE_BG[tone] }}>
      <span style={{ color: TONE_HEX[tone], marginTop: 1 }}>
        <Icon name={icon} decorative className="icon-sm" />
      </span>
      <p className="text-[12.5px] text-ink-2 leading-relaxed">{children}</p>
    </div>
  );
}
