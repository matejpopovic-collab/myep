/* ============================================================================
   EPROSTA — ACCOUNT SETTINGS ▸ TEAM & ROLES
   ----------------------------------------------------------------------------
   Two tabs, because there are two questions and mixing them is what makes
   permission screens unreadable:

     PEOPLE — who has access, and which role they hold. This is the tab that
              gets used weekly. Assigning a role is one click from the row.

     ROLES  — what each role can do. This is the tab that gets used twice a
              year, so it is deliberately the second one.

   THE MATRIX IS NOT A GRID OF EIGHT COLUMNS
   -----------------------------------------
   The obvious design is roles across the top, capabilities down the side. With
   eight roles and twenty-six capabilities that is 208 checkboxes on one screen,
   horizontally scrolling, with the row label out of view by the third column —
   and every one of them is a decision about who can see what people earn.

   So permissions are edited one role at a time, in a dialog that names the role
   and shows the capabilities grouped exactly as the sidebar groups them. You
   can only ever be answering "what should Payroll be able to do", which is the
   question an administrator actually has.

   WHAT EVERY REFUSAL SAYS
   -----------------------
   `roles.ts` returns a reason, never a bare false. Every disabled control here
   carries that reason as its hint, because a greyed-out button with no
   explanation is the single most common support ticket a permissions screen
   generates.
   ========================================================================== */

import { useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { Modal, ConfirmDestructive, MenuButton, type MenuEntry } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { DataTable, useSort, sortRows, type Column } from '@/components/DataTable';
import {
  Avatar, EmptyState, Kpi, PageHeader, Pill, Provenance, SearchField, Section, Segmented,
} from '@/components/primitives';
import { TONE_BG, TONE_HEX } from '@/lib/status';
import { NOW } from '@/data/db';
import * as ROLES from '@/lib/roles';
import { useRolesVersion } from '@/lib/useStore';
import type { Tone } from '@/data/types';

const iso = (d: Date): string => d.toISOString().slice(0, 10);

const STATUS_TONE: Record<ROLES.MemberStatus, Tone> = {
  active: 'healthy',
  invited: 'info',
  suspended: 'neutral',
};

const STATUS_LABEL: Record<ROLES.MemberStatus, string> = {
  active: 'Active',
  invited: 'Invite sent',
  suspended: 'Suspended',
};

/** "Never" beats an empty cell — an empty cell reads as data we lost. */
function lastActiveLabel(m: ROLES.Member): string {
  if (m.status === 'invited') return `Invited ${m.invitedAt ?? 'recently'}`;
  if (!m.lastActive) return 'Never signed in';
  const days = Math.round((NOW.getTime() - new Date(m.lastActive).getTime()) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 14) return `${days} days ago`;
  return m.lastActive;
}

/* ========================================================================== */

export default function TeamPage() {
  useRolesVersion();
  const toast = useToast();

  const [tab, setTab] = useState<'people' | 'roles'>('people');
  const [q, setQ] = useState('');
  const [inviting, setInviting] = useState(false);
  const [editingRole, setEditingRole] = useState<ROLES.RoleId | null>(null);
  const [creatingRole, setCreatingRole] = useState(false);
  const [removing, setRemoving] = useState<ROLES.Member | null>(null);

  const canManage = ROLES.can('team.manage');
  const me = ROLES.acting();
  const all = ROLES.members();

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return all;
    return all.filter(
      (m) =>
        m.name.toLowerCase().includes(s) ||
        m.email.toLowerCase().includes(s) ||
        m.jobTitle.toLowerCase().includes(s) ||
        (ROLES.role(m.roleId)?.label || '').toLowerCase().includes(s),
    );
  }, [all, q]);

  const { sort, toggle } = useSort({ key: 'role', dir: 1 });

  const sorted = sortRows(rows, sort.key, sort.dir, (m, key) => {
    if (key === 'name') return m.name;
    if (key === 'role') return ROLES.ROLE_ORDER.indexOf(m.roleId);
    if (key === 'status') return m.status;
    if (key === 'active') return m.lastActive || '';
    return null;
  });

  const pending = all.filter((m) => m.status === 'invited').length;
  const admins = ROLES.superAdmins().length;
  const edited = ROLES.ROLE_ORDER.filter(ROLES.isRoleEdited).length;

  /* ------------------------------------------------------------- actions */

  const assign = (m: ROLES.Member, next: ROLES.RoleId) => {
    const r = ROLES.assignRole(m.id, next);
    if (!r.ok) return toast(r.reason || 'Could not change that role.', { tone: 'critical' });
    toast(
      <>
        <strong>{m.name}</strong> is now <strong>{ROLES.role(next)?.label}</strong>. Their sidebar
        and their permissions change the next time they load the console.
      </>,
      { tone: 'healthy' },
    );
  };

  const setStatus = (m: ROLES.Member, status: ROLES.MemberStatus) => {
    const r = ROLES.setStatus(m.id, status);
    if (!r.ok) return toast(r.reason || 'Could not do that.', { tone: 'critical' });
    toast(
      status === 'suspended'
        ? `${m.name} can no longer sign in. Their record and history are untouched.`
        : `${m.name} can sign in again.`,
      { tone: status === 'suspended' ? 'atRisk' : 'healthy' },
    );
  };

  const rowMenu = (m: ROLES.Member): MenuEntry[] => {
    const isMe = m.id === me.id;
    const removeWhy = ROLES.removeBlocker(m.id);

    const roleItems: MenuEntry[] = ROLES.roleList().map((r) => {
      const why = ROLES.assignBlocker(m.id, r.id);
      return {
        label: r.label,
        icon: r.icon,
        badge: r.id === m.roleId ? 'Current' : '',
        hint: why || r.blurb,
        disabled: r.id === m.roleId || !!why,
        onSelect: () => assign(m, r.id),
      };
    });

    return [
      { label: 'Assign role', disabled: true, hint: isMe ? 'You cannot change your own role' : undefined },
      ...roleItems,
      '-',
      m.status === 'invited'
        ? {
            label: 'Resend invite',
            icon: 'mail',
            disabled: !canManage,
            onSelect: () => toast(`Invite re-sent to ${m.email}.`, { tone: 'info' }),
          }
        : {
            label: m.status === 'suspended' ? 'Restore access' : 'Suspend access',
            icon: m.status === 'suspended' ? 'check' : 'ban',
            disabled: !canManage || isMe,
            hint: isMe ? 'You cannot suspend your own account' : undefined,
            onSelect: () => setStatus(m, m.status === 'suspended' ? 'active' : 'suspended'),
          },
      {
        label: 'Remove from EP Team',
        icon: 'trash',
        danger: true,
        disabled: !!removeWhy,
        hint: removeWhy || undefined,
        onSelect: () => setRemoving(m),
      },
    ];
  };

  const columns: Column<ROLES.Member>[] = [
    {
      key: 'name',
      label: 'Person',
      sortKey: 'name',
      cell: (m) => (
        <div className="flex items-center gap-2.5 min-w-0">
          <Avatar hue={m.hue} initials={m.initials} size={30} />
          <div className="min-w-0">
            <div className="text-[13.5px] font-semibold text-ink truncate flex items-center gap-1.5">
              {m.name}
              {m.id === me.id ? (
                <span className="text-[10.5px] font-bold uppercase tracking-wider text-ink-3">You</span>
              ) : null}
            </div>
            <div className="text-[12px] text-ink-3 truncate">{m.email}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'title',
      label: 'Job title',
      cell: (m) => <span className="text-[13px] text-ink-2">{m.jobTitle}</span>,
    },
    {
      key: 'role',
      label: 'Role',
      sortKey: 'role',
      nowrap: true,
      cell: (m) => {
        const r = ROLES.role(m.roleId);
        return (
          <span
            className="pill tip"
            tabIndex={0}
            data-tip={r?.blurb}
            style={{
              background: m.roleId === 'owner' ? TONE_BG.atRisk : TONE_BG.info,
              color: m.roleId === 'owner' ? TONE_HEX.atRisk : TONE_HEX.info,
            }}
          >
            <Icon name={r?.icon || 'staff'} decorative className="icon-sm" />
            {r?.label || m.roleId}
          </span>
        );
      },
    },
    {
      key: 'perms',
      label: 'Permissions',
      align: 'right',
      nowrap: true,
      cell: (m) => {
        const r = ROLES.role(m.roleId);
        return (
          <span className="text-[12.5px] text-ink-2 tabular-nums">
            {r?.caps.length ?? 0}
            <span className="text-ink-3"> of {ROLES.ALL_CAPS.length}</span>
          </span>
        );
      },
    },
    {
      key: 'status',
      label: 'Status',
      sortKey: 'status',
      nowrap: true,
      cell: (m) => <Pill label={STATUS_LABEL[m.status]} tone={STATUS_TONE[m.status]} hint={false} />,
    },
    {
      key: 'active',
      label: 'Last active',
      sortKey: 'active',
      nowrap: true,
      cell: (m) => <span className="text-[12.5px] text-ink-2">{lastActiveLabel(m)}</span>,
    },
    {
      key: 'actions',
      label: '',
      align: 'right',
      cell: (m) => <MenuButton items={rowMenu(m)} label={`Actions for ${m.name}`} />,
    },
  ];

  /* ---------------------------------------------------------------- render */

  return (
    <>
      <PageHeader
        title="Team & roles"
        crumbs={[{ label: 'Account settings' }, { label: 'Team & roles' }]}
        subtitle={
          <>
            Everyone with access to the EP Team console, and what their role lets them touch. A role
            is not a job title — it is the list of things the software will let that person do.
          </>
        }
        actions={
          <>
            <Segmented
              ariaLabel="Team settings section"
              value={tab}
              onChange={setTab}
              options={[
                ['people', 'People'],
                ['roles', 'Roles & permissions'],
              ]}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canManage}
              title={canManage ? undefined : 'Only a role with “Manage team & roles” can invite people.'}
              onClick={() => setInviting(true)}
            >
              <Icon name="userPlus" decorative /> Invite person
            </button>
          </>
        }
      />

      {!canManage ? (
        <div className="well mb-5 flex items-start gap-2.5">
          <span className="mt-px" style={{ color: TONE_HEX.info }}>
            <Icon name="info" decorative />
          </span>
          <p className="text-[13px] text-ink-2 leading-relaxed">
            You can see who has access, but not change it. Your role (
            <strong>{ROLES.actingRole().label}</strong>) does not include “Manage team &amp; roles”.
            Ask a Super Admin — {ROLES.superAdmins().map((s) => s.name).join(', ') || 'none assigned'}.
          </p>
        </div>
      ) : null}

      <div className="flex gap-3 flex-wrap mb-5">
        <Kpi label="With access" value={all.length} sub={`${all.filter((m) => m.status === 'active').length} active`} />
        <Kpi
          label="Super Admins"
          value={admins}
          tone={admins === 1 ? 'atRisk' : 'healthy'}
          sub={admins === 1 ? 'Only one. If they leave, nobody can grant access.' : 'More than one way back in.'}
        />
        <Kpi
          label="Invites outstanding"
          value={pending}
          tone={pending ? 'info' : 'neutral'}
          sub={pending ? 'Sent, not yet accepted' : 'Nobody waiting'}
        />
        <Kpi
          label="Roles changed"
          value={edited}
          tone={edited ? 'info' : 'neutral'}
          sub={edited ? 'Differ from the shipped defaults' : 'All on shipped defaults'}
        />
      </div>

      {tab === 'people' ? (
        <>
          <Section
            title={`${rows.length} ${rows.length === 1 ? 'person' : 'people'}`}
            right={
              <SearchField
                value={q}
                onChange={setQ}
                placeholder="Filter by name, email or role…"
                ariaLabel="Filter team members"
              />
            }
          />
          <DataTable
            columns={columns}
            rows={sorted}
            rowKey={(m) => m.id}
            sort={sort}
            onSort={toggle}
            empty={
              <div className="card">
                <EmptyState
                  iconName="users"
                  title="Nobody matches that"
                  body="Clear the filter to see everyone with access to the console."
                />
              </div>
            }
          />
          <Provenance>
            Seeded from the people named in the developer briefing. Changing a role here changes what
            that person sees the moment they next load the console — including the sidebar, which is
            built from the same permission list rather than filtered afterwards.
          </Provenance>
        </>
      ) : (
        <RolesTab onEdit={setEditingRole} onCreate={() => setCreatingRole(true)} canManage={canManage} />
      )}

      {inviting ? <InviteDialog onClose={() => setInviting(false)} /> : null}

      {editingRole ? (
        <PermissionsDialog roleId={editingRole} onClose={() => setEditingRole(null)} />
      ) : null}

      {creatingRole ? (
        <CreateRoleDialog
          onClose={() => setCreatingRole(false)}
          onCreated={(id) => setEditingRole(id)}
        />
      ) : null}

      {removing ? (
        <ConfirmDestructive
          title={`Remove ${removing.name}?`}
          confirmLabel="Remove access"
          typeToConfirm={removing.name}
          message={
            <>
              {removing.name} loses access to the console immediately. Work orders they raised, shifts
              they allocated and check-ins they approved keep their name on them — this removes the
              login, not the history. If they are only leaving for a while,{' '}
              <strong>suspend</strong> instead.
            </>
          }
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            const name = removing.name;
            const r = ROLES.removeMember(removing.id);
            toast(
              r.ok ? `${name} no longer has access.` : r.reason || 'Could not remove that person.',
              { tone: r.ok ? 'healthy' : 'critical' },
            );
          }}
        />
      ) : null}
    </>
  );
}

/* ==========================================================================
   ROLES TAB
   --------------------------------------------------------------------------
   Cards rather than a table: a role's blurb is the thing that stops it being
   assigned wrong, and a blurb does not fit in a table cell.
   ========================================================================== */

function RolesTab({
  onEdit,
  onCreate,
  canManage,
}: {
  onEdit: (id: ROLES.RoleId) => void;
  onCreate: () => void;
  canManage: boolean;
}) {
  const toast = useToast();
  const [removingRole, setRemovingRole] = useState<ROLES.Role | null>(null);

  return (
    <>
      <Section
        title="Roles"
        right={
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!canManage}
            title={canManage ? undefined : 'Only a role with “Manage team & roles” can create a role.'}
            onClick={onCreate}
          >
            <Icon name="plus" decorative /> New role
          </button>
        }
      />
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(320px,1fr))' }}>
        {ROLES.roleList().map((r) => {
          const holders = ROLES.membersWithRole(r.id);
          const editedRole = ROLES.isRoleEdited(r.id);
          const sensitive = r.caps.filter((c) => ROLES.capMeta(c)?.sensitive).length;
          const deleteWhy = r.custom ? ROLES.deleteRoleBlocker(r.id) : null;

          return (
            <div key={r.id} className="card p-4 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span style={{ color: r.locked ? TONE_HEX.atRisk : TONE_HEX.info }}>
                      <Icon name={r.icon} decorative />
                    </span>
                    <h3 className="text-[14.5px] font-semibold text-ink">{r.label}</h3>
                    {r.locked ? <Pill label="Locked" tone="atRisk" hint={false} /> : null}
                    {r.custom ? <Pill label="Custom" tone="info" hint={false} /> : null}
                    {editedRole ? <Pill label="Edited" tone="info" hint={false} /> : null}
                  </div>
                  <p className="text-[12.5px] text-ink-2 mt-1.5 leading-relaxed">{r.blurb}</p>
                </div>
              </div>

              <div className="flex items-center gap-4 text-[12.5px] text-ink-2 tabular-nums">
                <span>
                  <strong className="text-ink">{r.caps.length}</strong>
                  <span className="text-ink-3"> / {ROLES.ALL_CAPS.length} permissions</span>
                </span>
                <span style={{ color: sensitive ? TONE_HEX.atRisk : undefined }}>
                  <strong>{sensitive}</strong> sensitive
                </span>
              </div>

              <div className="flex items-center gap-1.5 flex-wrap min-h-[30px]">
                {holders.length ? (
                  holders.map((m) => (
                    <span key={m.id} className="tip" tabIndex={0} data-tip={`${m.name} — ${m.jobTitle}`}>
                      <Avatar hue={m.hue} initials={m.initials} size={26} />
                    </span>
                  ))
                ) : (
                  <span className="text-[12px] text-ink-3">Nobody holds this role</span>
                )}
              </div>

              <div className="flex items-center gap-2 mt-auto pt-1">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => onEdit(r.id)}
                >
                  <Icon name={r.locked || !canManage ? 'search' : 'edit'} decorative />
                  {r.locked || !canManage ? 'View permissions' : 'Edit permissions'}
                </button>
                {editedRole && canManage ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      const res = ROLES.resetRoleCaps(r.id);
                      toast(
                        res.ok
                          ? `${r.label} is back on the shipped defaults.`
                          : res.reason || 'Could not reset.',
                        { tone: res.ok ? 'healthy' : 'critical' },
                      );
                    }}
                  >
                    <Icon name="refresh" decorative /> Reset
                  </button>
                ) : null}
                {r.custom && canManage ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={!!deleteWhy}
                    title={deleteWhy || undefined}
                    onClick={() => setRemovingRole(r)}
                  >
                    <Icon name="trash" decorative /> Delete
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <Provenance>
        Super Admin is locked at every permission on purpose: it is the way back in when a role has
        been edited into a corner. The last active Super Admin cannot be demoted or removed, and
        nobody can change their own role.
      </Provenance>

      {removingRole ? (
        <ConfirmDestructive
          title={`Delete ${removingRole.label}?`}
          confirmLabel="Delete role"
          typeToConfirm={removingRole.label}
          message={
            <>
              Nobody currently holds <strong>{removingRole.label}</strong>, so nothing is reassigned —
              this only removes the role and the permission set attached to it. It cannot be undone.
            </>
          }
          onClose={() => setRemovingRole(null)}
          onConfirm={() => {
            const label = removingRole.label;
            const res = ROLES.deleteRole(removingRole.id);
            toast(
              res.ok ? `${label} deleted.` : res.reason || 'Could not delete that role.',
              { tone: res.ok ? 'healthy' : 'critical' },
            );
          }}
        />
      ) : null}
    </>
  );
}

/* ==========================================================================
   PERMISSIONS DIALOG
   ========================================================================== */

function PermissionsDialog({ roleId, onClose }: { roleId: ROLES.RoleId; onClose: () => void }) {
  const toast = useToast();
  const r = ROLES.role(roleId)!;
  const readOnly = !!r.locked || !ROLES.can('team.manage');

  const [draft, setDraft] = useState<Set<ROLES.Capability>>(() => new Set(r.caps));

  const toggleCap = (c: ROLES.Capability) => {
    if (readOnly) return;
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(c)) {
        next.delete(c);
        // Managing the team without seeing it is not a state anyone means to
        // create. Mirrors the same rule in setRoleCaps().
        if (c === 'team.view') next.delete('team.manage');
      } else {
        next.add(c);
        if (c === 'team.manage') next.add('team.view');
      }
      return next;
    });
  };

  const changed = draft.size !== r.caps.length || r.caps.some((c) => !draft.has(c));
  const holders = ROLES.membersWithRole(roleId);
  const defaults = ROLES.defaultCaps(roleId);

  const save = () => {
    const res = ROLES.setRoleCaps(roleId, [...draft]);
    if (!res.ok) return toast(res.reason || 'Could not save.', { tone: 'critical' });
    onClose();
    toast(
      <>
        <strong>{r.label}</strong> now has {draft.size} of {ROLES.ALL_CAPS.length} permissions.
        {holders.length ? ` ${holders.length} ${holders.length === 1 ? 'person is' : 'people are'} affected.` : ' Nobody holds this role yet.'}
      </>,
      { tone: 'healthy' },
    );
  };

  return (
    <Modal
      title={`${r.label} — permissions`}
      width={720}
      onClose={onClose}
      footer={
        <>
          <span className="text-[12px] text-ink-3 mr-auto tabular-nums">
            {draft.size} of {ROLES.ALL_CAPS.length} selected
          </span>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            {readOnly ? 'Close' : 'Cancel'}
          </button>
          {!readOnly ? (
            <button type="button" className="btn btn-primary" disabled={!changed} onClick={save}>
              Save permissions
            </button>
          ) : null}
        </>
      }
    >
      <p className="text-[13px] text-ink-2 leading-relaxed">{r.blurb}</p>

      {r.locked ? (
        <div className="well mt-3 text-[12.5px] text-ink-2 leading-relaxed">
          Super Admin always holds every permission and cannot be edited. That is what makes it the
          way back in after a role has been narrowed too far.
        </div>
      ) : !ROLES.can('team.manage') ? (
        <div className="well mt-3 text-[12.5px] text-ink-2 leading-relaxed">
          Read-only: your role does not include “Manage team &amp; roles”.
        </div>
      ) : holders.length ? (
        <div className="well mt-3 text-[12.5px] text-ink-2 leading-relaxed">
          {holders.length === 1 ? '1 person holds' : `${holders.length} people hold`} this role —{' '}
          {holders.map((m) => m.name).join(', ')}. Saving changes what they can do immediately.
        </div>
      ) : null}

      <div className="mt-4 flex flex-col gap-5">
        {ROLES.CAP_GROUPS.map((g) => {
          const on = g.caps.filter((c) => draft.has(c.id)).length;
          return (
            <fieldset key={g.group} className="min-w-0">
              <legend className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2">
                {g.group}
                <span className="ml-2 font-semibold normal-case tracking-normal text-ink-3 tabular-nums">
                  {on}/{g.caps.length}
                </span>
              </legend>

              <div className="flex flex-col gap-px">
                {g.caps.map((c) => {
                  const checked = draft.has(c.id);
                  const isDefault = defaults.includes(c.id);
                  return (
                    <label
                      key={c.id}
                      className="flex items-start gap-2.5 px-2 py-2 rounded-md hover:bg-surface-high"
                      style={{ cursor: readOnly ? 'default' : 'pointer' }}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={checked}
                        disabled={readOnly}
                        onChange={() => toggleCap(c.id)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 flex-wrap">
                          <span className="text-[13px] font-medium text-ink">{c.label}</span>
                          {c.sensitive ? (
                            <span
                              className="pill"
                              style={{ background: TONE_BG.atRisk, color: TONE_HEX.atRisk }}
                            >
                              Sensitive
                            </span>
                          ) : null}
                          {!r.locked && !r.custom && checked !== isDefault ? (
                            <span className="text-[11px] text-ink-3">
                              {checked ? 'added' : 'removed'} vs default
                            </span>
                          ) : null}
                        </span>
                        <span className="block text-[12px] text-ink-3 leading-snug mt-0.5">
                          {c.blurb}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          );
        })}
      </div>
    </Modal>
  );
}

/* ==========================================================================
   INVITE DIALOG
   --------------------------------------------------------------------------
   The role is chosen at invite time and the dialog shows what that role can
   reach, because "we'll sort permissions out later" is how everyone ends up a
   Super Admin.
   ========================================================================== */

function InviteDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [roleId, setRoleId] = useState<ROLES.RoleId>('readonly');
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});

  const r = ROLES.role(roleId)!;
  const sensitive = r.caps.filter((c) => ROLES.capMeta(c)?.sensitive);

  const submit = () => {
    const res = ROLES.inviteMember({ name, email, jobTitle, roleId }, iso(NOW));
    if (!res.ok) {
      if (res.errors) setErrors(res.errors);
      if (res.reason) toast(res.reason, { tone: 'critical' });
      return;
    }
    onClose();
    toast(
      <>
        Invite sent to <strong>{res.member!.email}</strong> as <strong>{r.label}</strong>. They
        appear in the list as “Invite sent” until they accept.
      </>,
      { tone: 'healthy' },
    );
  };

  return (
    <Modal
      title="Invite someone to EP Team"
      width={560}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit}>
            Send invite
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Full name</span>
          <input
            className="field"
            value={name}
            aria-invalid={!!errors.name}
            onChange={(e) => {
              setName(e.target.value);
              setErrors((x) => ({ ...x, name: undefined }));
            }}
          />
          {errors.name ? (
            <span className="block text-[12px] mt-1" style={{ color: TONE_HEX.critical }}>
              {errors.name}
            </span>
          ) : null}
        </label>

        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Work email</span>
          <input
            className="field"
            type="email"
            autoComplete="off"
            value={email}
            aria-invalid={!!errors.email}
            onChange={(e) => {
              setEmail(e.target.value);
              setErrors((x) => ({ ...x, email: undefined }));
            }}
          />
          {errors.email ? (
            <span className="block text-[12px] mt-1" style={{ color: TONE_HEX.critical }}>
              {errors.email}
            </span>
          ) : (
            <span className="block text-[12px] text-ink-3 mt-1">The invite goes here.</span>
          )}
        </label>

        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
            Job title <span className="text-ink-3 font-normal">— optional</span>
          </span>
          <input
            className="field"
            placeholder={r.label}
            value={jobTitle}
            onChange={(e) => setJobTitle(e.target.value)}
          />
          <span className="block text-[12px] text-ink-3 mt-1">
            What is on their contract. It does not affect what they can do.
          </span>
        </label>

        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Role</span>
          <select
            className="field"
            value={roleId}
            onChange={(e) => setRoleId(e.target.value as ROLES.RoleId)}
          >
            {ROLES.roleList().map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
        </label>

        <div className="well text-[12.5px] text-ink-2 leading-relaxed">
          <p className="mb-2">{r.blurb}</p>
          <p className="tabular-nums">
            <strong className="text-ink">{r.caps.length}</strong> of {ROLES.ALL_CAPS.length}{' '}
            permissions
            {sensitive.length ? (
              <>
                , including{' '}
                <strong style={{ color: TONE_HEX.atRisk }}>{sensitive.length} sensitive</strong>:{' '}
                {sensitive.slice(0, 3).map((c) => ROLES.capMeta(c)?.label).join(', ')}
                {sensitive.length > 3 ? ` and ${sensitive.length - 3} more` : ''}.
              </>
            ) : (
              '. Nothing sensitive.'
            )}
          </p>
        </div>
      </div>
    </Modal>
  );
}

/* ==========================================================================
   CREATE ROLE DIALOG
   --------------------------------------------------------------------------
   No "start from nothing" option. A role with zero permissions is a role
   nobody can do their job with, and the administrator would just tick every
   box a normal role already has ticked — copying one and adjusting the copy
   is the same outcome with less chance of forgetting `staff.view`.

   Saving hands straight to `PermissionsDialog` for the new role id, because
   the copy is a starting point, not the destination.
   ========================================================================== */

function CreateRoleDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: ROLES.RoleId) => void;
}) {
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [blurb, setBlurb] = useState('');
  const [copyFrom, setCopyFrom] = useState<ROLES.RoleId>('readonly');
  const [error, setError] = useState<string | undefined>();

  const source = ROLES.role(copyFrom)!;

  const submit = () => {
    if (!label.trim()) {
      setError('Name the role.');
      return;
    }
    const res = ROLES.createRole({ label, blurb, copyFrom });
    if (!res.ok) {
      setError(undefined);
      toast(res.reason || 'Could not create that role.', { tone: 'critical' });
      return;
    }
    onClose();
    toast(
      <>
        <strong>{res.role!.label}</strong> created with {res.role!.caps.length} of{' '}
        {ROLES.ALL_CAPS.length} permissions, copied from {source.label}. Adjust them now.
      </>,
      { tone: 'healthy' },
    );
    onCreated(res.role!.id);
  };

  return (
    <Modal
      title="New role"
      width={520}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit}>
            Create role
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Role name</span>
          <input
            className="field"
            value={label}
            aria-invalid={!!error}
            placeholder="e.g. Warehouse Supervisor"
            onChange={(e) => {
              setLabel(e.target.value);
              setError(undefined);
            }}
          />
          {error ? (
            <span className="block text-[12px] mt-1" style={{ color: TONE_HEX.critical }}>
              {error}
            </span>
          ) : null}
        </label>

        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
            Description <span className="text-ink-3 font-normal">— optional</span>
          </span>
          <input
            className="field"
            value={blurb}
            placeholder={`Copied from ${source.label}.`}
            onChange={(e) => setBlurb(e.target.value)}
          />
        </label>

        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Start from</span>
          <select
            className="field"
            value={copyFrom}
            onChange={(e) => setCopyFrom(e.target.value as ROLES.RoleId)}
          >
            {ROLES.roleList().map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
          <span className="block text-[12px] text-ink-3 mt-1">
            Copies {source.caps.length} of {ROLES.ALL_CAPS.length} permissions from {source.label} as a
            starting point. You will adjust them on the next screen before anyone is assigned.
          </span>
        </label>
      </div>
    </Modal>
  );
}
