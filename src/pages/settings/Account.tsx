/* ============================================================================
   EPROSTA — ACCOUNT SETTINGS
   ----------------------------------------------------------------------------
   The menu item existed and fired a toast saying personal settings were not
   part of the prototype. Four things belong here, and each one already had
   real state behind it that had nowhere to be edited from.

   WHOSE SETTINGS, EXACTLY
   -----------------------
   This page is YOURS. `Team & roles` is the administrator's page — who has
   access and what each role can do. Mixing the two is how settings screens end
   up with a "Users" tab a user cannot use. The dividing line is simple: if
   changing it affects somebody else, it is not on this page.

   That is why the role panel here is read-only. You can see exactly what your
   role lets you do — which is the question behind most "why is that greyed
   out" support tickets — but changing it is a Super Admin's decision about
   you, not your decision about yourself. The panel links to the page where
   that decision is made, and says who can make it.

   IT ADAPTS TO THE TIER RATHER THAN LOCKING THE TIER OUT
   -----------------------------------------------------
   A client contact and a worker both have a name, an email and an opinion
   about dark mode. What they do not have is a console role or an operator's
   notification stream. So those two panels are absent for them rather than
   present-and-empty, and the account menu stops being a dead end.

   EVERY CONTROL WRITES
   --------------------
   There is not one decorative toggle on this page. Profile edits go through
   `roles.updateProfile` and are journalled like every other team change; the
   theme and the mutes go through `prefs.ts` and survive a reload. A settings
   screen full of switches that do nothing is worse than no settings screen,
   because it teaches people the product lies.
   ========================================================================== */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { ConfirmDestructive } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { Avatar, PageHeader, Pill, Provenance, Section } from '@/components/primitives';
import { TONE_BG, TONE_HEX } from '@/lib/status';
import * as PORTAL from '@/lib/portal';
import * as PREFS from '@/lib/prefs';
import * as ROLES from '@/lib/roles';
import * as NOTIFICATIONS from '@/lib/notifications';
import * as WOF from '@/lib/wof';
import { clockNote, reanchor, seedDrift, seedToday } from '@/data/clock';
import { fmtDate } from '@/lib/format';
import {
  useNotificationsVersion, usePrefsVersion, useRolesVersion, useTier,
} from '@/lib/useStore';

/* ------------------------------------------------------------------ shell */

/** One bordered block with a heading and an explanation above the controls. */
function Panel({
  title,
  blurb,
  children,
  right,
}: {
  title: string;
  blurb: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="card p-5 mb-4">
      <div className="flex items-start justify-between gap-4 mb-1">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {right ? <div className="flex-none">{right}</div> : null}
      </div>
      <p className="text-[12.5px] text-ink-3 leading-relaxed mb-4 max-w-2xl">{blurb}</p>
      {children}
    </div>
  );
}

/** Label, control, and a line under it saying what the control costs. */
function SettingRow({
  label,
  hint,
  control,
}: {
  label: string;
  hint: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-3 border-b border-surface-line-soft last:border-0">
      <div className="min-w-0">
        <div className="text-[13.5px] text-ink font-medium">{label}</div>
        <div className="text-[12px] text-ink-3 leading-relaxed mt-0.5 max-w-xl">{hint}</div>
      </div>
      <div className="flex-none pt-0.5">{control}</div>
    </div>
  );
}

/* ---------------------------------------------------------------- profile */

/**
 * Your name, email and job title.
 *
 * Dirty-tracked rather than saving on every keystroke: an email is not valid
 * halfway through being typed, and a store that emits on each character would
 * re-render the avatar in the sidebar letter by letter. Save is disabled until
 * something has actually changed, so the button is never a no-op.
 */
function ProfilePanel({ member }: { member: ROLES.Member }) {
  const toast = useToast();
  const [name, setName] = useState(member.name);
  const [email, setEmail] = useState(member.email);
  const [jobTitle, setJobTitle] = useState(member.jobTitle);
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});

  // Re-seed when the acting member changes underneath us — switching who you
  // are acting as while this page is open must not leave the last person's
  // details in the form.
  useEffect(() => {
    setName(member.name);
    setEmail(member.email);
    setJobTitle(member.jobTitle);
    setErrors({});
  }, [member.id, member.name, member.email, member.jobTitle]);

  const dirty =
    name !== member.name || email !== member.email || jobTitle !== member.jobTitle;

  const save = () => {
    const r = ROLES.updateProfile(member.id, { name, email, jobTitle });
    if (!r.ok) {
      setErrors(r.errors || {});
      if (r.reason) toast(r.reason, { tone: 'critical' });
      return;
    }
    setErrors({});
    toast('Your details are updated everywhere they appear.', { tone: 'healthy' });
  };

  return (
    <Panel
      title="Your details"
      blurb="Shown on every screen that names you — the sidebar, the WOF history, and any job you own. Your initials follow your name; your colour does not, so people who know you by it still will."
    >
      <div className="flex items-start gap-5">
        <div className="flex-none pt-1">
          <Avatar initials={ROLES.initialsPreview(name) || member.initials} hue={member.hue} size={56} />
        </div>

        <div className="flex-1 min-w-0 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
                Name <span className="text-status-critical">*</span>
              </span>
              <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
              {errors.name ? (
                <span className="block text-[11.5px] text-status-critical mt-1">{errors.name}</span>
              ) : null}
            </label>
            <label className="block">
              <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Job title</span>
              <input
                className="field"
                value={jobTitle}
                placeholder={ROLES.role(member.roleId)?.label || ''}
                onChange={(e) => setJobTitle(e.target.value)}
              />
              <span className="block text-[11.5px] text-ink-3 mt-1">
                What you do, not what you may do. Leave it blank and it falls back to your role.
              </span>
            </label>
          </div>

          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
              Email <span className="text-status-critical">*</span>
            </span>
            <input
              className="field"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <span
              className={`block text-[11.5px] mt-1 ${errors.email ? 'text-status-critical' : 'text-ink-3'}`}
            >
              {errors.email ?? 'This is the address that identifies your account. It has to be unique.'}
            </span>
          </label>

          <div className="flex items-center gap-2 pt-1">
            <button type="button" className="btn btn-primary" disabled={!dirty} onClick={save}>
              Save changes
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!dirty}
              onClick={() => {
                setName(member.name);
                setEmail(member.email);
                setJobTitle(member.jobTitle);
                setErrors({});
              }}
            >
              Discard
            </button>
            {!dirty ? <span className="text-[12px] text-ink-3">No unsaved changes.</span> : null}
          </div>
        </div>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------- role */

/**
 * What your role lets you do — read-only, grouped exactly as the sidebar is.
 *
 * Answering "why is that button greyed out" is the whole job of this panel, so
 * it lists what you DO have rather than a matrix of ticks and crosses. The
 * denied capabilities are collapsed behind a toggle: seeing them is
 * occasionally useful, and putting them on equal footing with the granted ones
 * would make a permissions summary read as a list of things you cannot do.
 */
function RolePanel({ member }: { member: ROLES.Member }) {
  const [showDenied, setShowDenied] = useState(false);
  const role = ROLES.role(member.roleId);
  if (!role) return null;

  const granted = new Set(role.caps);
  const groups = ROLES.CAP_GROUPS.map((g) => ({
    group: g.group,
    yes: g.caps.filter((c) => granted.has(c.id)),
    no: g.caps.filter((c) => !granted.has(c.id)),
  })).filter((g) => (showDenied ? g.yes.length || g.no.length : g.yes.length));

  const admins = ROLES.superAdmins();

  return (
    <Panel
      title="Your role"
      blurb="Set by a Super Admin, not by you. This is what it currently lets you do — if a screen is missing from the sidebar or a button is greyed out, the reason is here."
      right={
        <div className="flex items-center gap-2">
          <Pill label={role.label} tone={role.locked ? 'healthy' : 'info'} />
          {ROLES.can('team.view') ? (
            <Link className="btn btn-secondary btn-sm" to="/settings/team">
              Team &amp; roles
            </Link>
          ) : null}
        </div>
      }
    >
      <p className="text-[13px] text-ink-2 leading-relaxed mb-4">{role.blurb}</p>

      <div className="grid grid-cols-2 gap-x-6 gap-y-4">
        {groups.map((g) => (
          <div key={g.group}>
            <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2">
              {g.group}
            </div>
            <ul className="space-y-1.5">
              {g.yes.map((c) => (
                <li key={c.id} className="flex items-start gap-2">
                  <span className="flex-none mt-px" style={{ color: TONE_HEX.healthy }}>
                    <Icon name="checkCircle" decorative className="icon-sm" />
                  </span>
                  <span className="text-[12.5px] text-ink-2 leading-snug">
                    {c.label}
                    {c.sensitive ? (
                      <span className="text-[11px] text-ink-3"> · sensitive</span>
                    ) : null}
                  </span>
                </li>
              ))}
              {showDenied
                ? g.no.map((c) => (
                    <li key={c.id} className="flex items-start gap-2 opacity-55">
                      <span className="flex-none mt-px text-ink-3">
                        <Icon name="ban" decorative className="icon-sm" />
                      </span>
                      <span className="text-[12.5px] text-ink-3 leading-snug line-through">
                        {c.label}
                      </span>
                    </li>
                  ))
                : null}
            </ul>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-4 mt-5 pt-4 border-t border-surface-line-soft">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setShowDenied((s) => !s)}
        >
          <Icon name={showDenied ? 'chevronUp' : 'chevronDown'} decorative />
          {showDenied
            ? 'Hide what this role cannot do'
            : `Show the ${ROLES.ALL_CAPS.length - role.caps.length} things it cannot do`}
        </button>
        <p className="text-[11.5px] text-ink-3 text-right">
          {admins.length === 1
            ? `Ask ${admins[0].name} to change it.`
            : `Ask any of the ${admins.length} Super Admins to change it.`}
        </p>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------- appearance */

const THEMES: { id: PREFS.ThemeChoice; label: string; hint: string }[] = [
  { id: 'system', label: 'Match my system', hint: 'Follows your operating system, including a scheduled switch at dusk.' },
  { id: 'light', label: 'Light', hint: 'The default. Content light, navigation dark.' },
  { id: 'dark', label: 'Dark', hint: 'Dark throughout. Useful in a control room at night.' },
];

function AppearancePanel() {
  const toast = useToast();
  const prefs = PREFS.get();
  const resolved = PREFS.resolvedTheme();

  return (
    <Panel
      title="Appearance"
      blurb="Applies to this browser only, and takes effect as you choose it. Nobody else sees the change."
    >
      <div
        className="flex gap-2 mb-1"
        role="radiogroup"
        aria-label="Theme"
      >
        {THEMES.map((t) => {
          const on = prefs.theme === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={on}
              className="card p-3 flex-1 text-left"
              style={{
                borderColor: on ? TONE_HEX.info : undefined,
                background: on ? TONE_BG.info : undefined,
                cursor: 'pointer',
              }}
              onClick={() => PREFS.setTheme(t.id)}
            >
              <div className="flex items-center gap-2 mb-1">
                <span style={{ color: on ? TONE_HEX.info : 'var(--ink-3)' }}>
                  <Icon name={on ? 'checkCircle' : 'ban'} decorative className="icon-sm" />
                </span>
                <span className="text-[13px] font-semibold text-ink">{t.label}</span>
              </div>
              <span className="block text-[11.5px] text-ink-3 leading-snug">{t.hint}</span>
            </button>
          );
        })}
      </div>
      <p className="text-[11.5px] text-ink-3 mt-2">
        {prefs.theme === 'system'
          ? `Your system is currently ${resolved}, so the app is ${resolved}.`
          : `Fixed to ${prefs.theme}, whatever your system does.`}
      </p>

      <div className="mt-4">
        <SettingRow
          label="Denser tables"
          hint="Tightens row padding and type on every table in the app. Roughly a third more rows per screen; nothing is hidden, so the venue under a job name and the countdown under a date both stay."
          control={
            <label className="flex items-center gap-2.5" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={prefs.denseTables}
                onChange={(e) => {
                  PREFS.setDenseTables(e.target.checked);
                  toast(e.target.checked ? 'Tables are denser.' : 'Tables are back to normal.');
                }}
              />
              <span className="text-[13px] text-ink-2">{prefs.denseTables ? 'On' : 'Off'}</span>
            </label>
          }
        />
      </div>
    </Panel>
  );
}

/* ---------------------------------------------------------- notifications */

function NotificationsPanel() {
  const toast = useToast();
  const prefs = PREFS.get();
  const muted = prefs.mutedTypes.length;
  const unread = NOTIFICATIONS.unreadCount();

  return (
    <Panel
      title="What you are notified about"
      blurb="Muting a type takes it out of your list and your unread count. It does not stop it happening, and it does not unsend anything — everything muted is still recorded, and reappears the moment you unmute it."
      right={
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={!unread}
            onClick={() => {
              NOTIFICATIONS.markAllRead();
              toast('Everything you can see is marked read.');
            }}
          >
            Mark all read
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              NOTIFICATIONS.restoreDismissed();
              toast('Dismissed notifications are back in the list.', { tone: 'info' });
            }}
          >
            Restore dismissed
          </button>
        </div>
      }
    >
      {PREFS.NOTIFICATION_TYPES.map((t) => {
        const off = prefs.mutedTypes.includes(t.id);
        return (
          <SettingRow
            key={t.id}
            label={t.label}
            hint={off ? t.cost : t.blurb}
            control={
              <label className="flex items-center gap-2.5" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={!off}
                  onChange={(e) => PREFS.setMuted(t.id, !e.target.checked)}
                />
                <span
                  className="text-[13px] w-14"
                  style={{ color: off ? 'var(--ink-3)' : 'var(--ink-2)' }}
                >
                  {off ? 'Muted' : 'On'}
                </span>
              </label>
            }
          />
        );
      })}

      {muted ? (
        <div className="rounded-lg p-3 mt-4" style={{ background: TONE_BG.atRisk }}>
          <div className="text-[12.5px] text-ink-2 leading-relaxed">
            <strong className="text-ink">
              {muted} {muted === 1 ? 'type is' : 'types are'} muted.
            </strong>{' '}
            The bell counts only what is left. Nothing is deleted — unmute and the missed items are
            all still there, at the dates they were raised.
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

/* ------------------------------------------------------------- session -- */

/**
 * Sign out, and the demo-data reset.
 *
 * The reset lived on the WOF pipeline page, which is the wrong home for it —
 * it discards check-ins, team changes, notifications and preferences too, not
 * just work orders. Somebody clicking a button on the pipeline screen has no
 * reason to expect it to reset their theme. Here, under a heading that says
 * so, it is at least honest about its scope.
 */
function SessionPanel() {
  const toast = useToast();
  const [resetting, setResetting] = useState(false);
  const [removing, setRemoving] = useState(false);

  // Re-anchoring rewrites a module-level constant that the seed was already
  // loaded against, so nothing short of a real page load will show the moved
  // dates. `navigate` is not enough here.
  const hardReload = () => window.location.assign(`${import.meta.env.BASE_URL || '/'}`);

  const drift = seedDrift();
  const stale = drift >= 7;

  return (
    <>
      <Panel
        title="Session and local data"
        blurb="Everything this prototype stores lives in this browser. There is no server behind it, so nothing here affects anybody else and nothing leaves this machine."
      >
        <SettingRow
          label="Sign out"
          hint="Ends this session. In the prototype there is nothing to sign back in to, so you land back where you started."
          control={
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => toast('Signed out.', { tone: 'info' })}
            >
              <Icon name="logout" decorative /> Sign out
            </button>
          }
        />
        <SettingRow
          label="Sample data dates"
          hint={
            stale
              ? `${clockNote()} That was ${Math.round(drift / 7)} ${Math.round(drift / 7) === 1 ? 'week' : 'weeks'} ago, so the demo jobs are posed around ${fmtDate(seedToday())} rather than today — which is why live jobs read as finished. Moving them forward re-seeds from scratch, so anything you have changed in this browser goes with it.`
              : `${clockNote()} The demo jobs are posed around today, so nothing needs moving.`
          }
          control={
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!stale}
              onClick={() => setRemoving(true)}
            >
              <Icon name="refresh" decorative /> Move to today
            </button>
          }
        />
        <SettingRow
          label="Reset all local data"
          hint="Discards every change made in this browser — stage moves, quotes and variations, document ticks, deposits, team and role edits, check-in approvals, notifications and these preferences — and reloads the shipped demo data, re-dated around today."
          control={
            <button type="button" className="btn btn-danger" onClick={() => setResetting(true)}>
              <Icon name="refresh" decorative /> Reset everything
            </button>
          }
        />
      </Panel>

      {resetting ? (
        <ConfirmDestructive
          title="Reset all local data?"
          confirmLabel="Reset everything"
          typeToConfirm="reset"
          onClose={() => setResetting(false)}
          onConfirm={() => {
            // A reset is a fresh install, so it re-anchors too: reloading a
            // months-old seed against its months-old clock is how you end up
            // back on this page wondering why every job already ended.
            WOF.reset();
            ROLES.resetAll();
            NOTIFICATIONS.resetNotifications();
            PREFS.reset();
            reanchor();
            hardReload();
          }}
          message="Every change made in this browser is discarded and the seeded pipeline, team, roles and notifications are reloaded, re-dated to sit around today. Your theme and notification preferences go back to their defaults too. Nothing on a server is affected, because there is not one."
        />
      ) : null}

      {removing ? (
        <ConfirmDestructive
          title="Move the sample data to today?"
          confirmLabel="Move to today"
          typeToConfirm="move"
          onClose={() => setRemoving(false)}
          onConfirm={() => {
            // The seed moves; records created in this browser would not, and
            // two frames of reference is worse than one stale one. So this is
            // the full reset with a different name on the button — the name
            // that matches the problem people actually arrive with.
            WOF.reset();
            ROLES.resetAll();
            NOTIFICATIONS.resetNotifications();
            reanchor();
            hardReload();
          }}
          message="The demo jobs move forward in whole weeks, so festivals stay on their Friday and race days stay on their Saturday. Everything you have changed in this browser is discarded in the process — the seed can move or your records can stay, not both. Your theme and notification preferences are kept."
        />
      ) : null}
    </>
  );
}

/* ==================================================================== page */

export default function AccountSettingsPage() {
  useRolesVersion();
  usePrefsVersion();
  useNotificationsVersion();

  const tier = useTier();
  const who = PORTAL.acting();
  const isOperator = tier === 'admin';
  const member = ROLES.acting();

  return (
    <>
      <PageHeader
        title="Account settings"
        subtitle={
          isOperator
            ? 'Your details, your role, and how this console behaves for you. Anything that affects somebody else lives on Team & roles instead.'
            : 'Your details and how this console behaves for you. Changes are yours alone — nobody else sees them.'
        }
      />

      {/* Who is actually acting. Worth stating outright: the tier switcher in
          the top bar means the person reading this page is not necessarily the
          person whose settings are on it. */}
      <div className="card p-4 mb-5 flex items-center gap-3.5">
        <Avatar initials={who.initials} hue={who.hue} size={40} />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-ink">{who.name}</div>
          <div className="text-[12.5px] text-ink-3">{who.detail}</div>
        </div>
        <Pill label={PORTAL.tier().label} tone={isOperator ? 'info' : 'neutral'} />
      </div>

      {isOperator ? (
        <>
          <ProfilePanel member={member} />
          <RolePanel member={member} />
        </>
      ) : (
        <Panel
          title="Your details"
          blurb="Held on the record EP Team keeps for you, so they are changed by your account manager rather than here. That is deliberate: the name on a booking and the name on an accreditation list have to match."
        >
          <div className="text-[13px] text-ink-2 leading-relaxed">
            You are signed in as <strong className="text-ink">{who.name}</strong> — {who.detail}. Ask
            your EP Team contact to correct anything that is wrong.
          </div>
        </Panel>
      )}

      <AppearancePanel />

      {isOperator ? <NotificationsPanel /> : null}

      <Section title="Danger zone" />
      <SessionPanel />

      <Provenance>
        {isOperator
          ? 'Profile changes are journalled alongside every other team change and replay over the seeded data on load, so they survive a reload. Theme and notification preferences are stored separately, because they belong to this browser rather than to the account.'
          : 'Your preferences are stored in this browser only. Nothing here is sent to EP Team.'}
      </Provenance>
    </>
  );
}
