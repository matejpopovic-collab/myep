/* ============================================================================
   CLIENT PORTAL — set a password from a link
   (/portal/invite/:token and /portal/reset/:token)
   ----------------------------------------------------------------------------
   One page, two doors. An invite and a reset both end in "choose a password,
   then you are signed in"; what differs is the welcome and what to do when
   the link has gone stale. A dead link always says WHY and WHAT NEXT — an
   expired invite needs EP to resend it, an expired reset the person can
   re-request themselves.
   ========================================================================== */

import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useToast } from '@/components/Toast';
import { client as clientById } from '@/data/db';
import * as PU from '@/lib/portalusers';
import * as PORTAL from '@/lib/portal';
import { usePortalUsersVersion } from '@/lib/useStore';
import { AuthLayout, Checklist, Field, PasswordInput } from './AuthLayout';

export default function PortalSetPasswordPage({ kind }: { kind: PU.LinkKind }) {
  usePortalUsersVersion();
  const { token } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  // Read once: setting the password spends the link, and the page should not
  // flip to "already used" under the person's cursor as it does.
  const [info] = useState(() => PU.linkInfo(token));
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [shown, setShown] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const u = info.user;
  const company = u ? clientById(u.clientId)?.name ?? '' : '';
  const ok = info.state === 'ok' && info.kind === kind && !!u;

  if (!ok) return <DeadLink info={info} kind={kind} company={company} />;

  const checks = PU.passwordChecks(pw, confirm, u);
  const ready = checks.every((c) => c.ok);

  const submit = () => {
    const r = kind === 'invite' ? PU.acceptInvite(token!, pw, confirm) : PU.resetPassword(token!, pw, confirm);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    PORTAL.portalSignIn(r.user);
    toast(kind === 'invite' ? `Welcome, ${r.user.name.split(' ')[0]}. Your account is ready.` : 'Password changed. You are signed in.', {
      tone: 'healthy',
    });
    navigate('/client/jobs');
  };

  return (
    <AuthLayout
      title={kind === 'invite' ? `Set up your account` : 'Choose a new password'}
      intro={
        kind === 'invite' ? (
          <>
            {u.invitedBy} at EP Team has invited you to the portal for <strong className="text-ink">{company}</strong>
            {u.role === 'approver' ? ', where you can sign quotes and pay invoices.' : ', where you can follow your jobs, hours and invoices.'}
          </>
        ) : (
          <>For the portal account at {company}.</>
        )
      }
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) submit();
          else setError('The password does not meet every rule yet.');
        }}
      >
        {/* The username field is there for password managers, which save the
            pair against the email rather than against nothing. */}
        <Field label={kind === 'invite' ? 'Your name' : 'Account'}>
          <div className="field bg-surface-raised text-ink-2" aria-readonly="true">
            {u.name}
          </div>
        </Field>
        <Field label="Email" hint="This is what you sign in with.">
          <input className="field bg-surface-raised text-ink-2" type="email" autoComplete="username" value={u.email} readOnly />
        </Field>
        <Field label={kind === 'invite' ? 'Password' : 'New password'}>
          <PasswordInput
            value={pw}
            onChange={(v) => {
              setPw(v);
              setError(null);
            }}
            shown={shown}
            autoComplete="new-password"
            autoFocus
          />
        </Field>
        <Field label="Type it again">
          <PasswordInput
            value={confirm}
            onChange={(v) => {
              setConfirm(v);
              setError(null);
            }}
            shown={shown}
            autoComplete="new-password"
          />
        </Field>
        <label className="flex items-center gap-2 text-[12.5px] text-ink-2 -mt-1 mb-4 cursor-pointer">
          <input type="checkbox" checked={shown} onChange={(e) => setShown(e.target.checked)} />
          Show passwords
        </label>

        <Checklist checks={checks} />

        {error ? (
          <p role="alert" className="text-[13px] text-status-critical mb-4">
            {error}
          </p>
        ) : null}

        <button type="submit" className="btn btn-primary w-full justify-center" aria-disabled={!ready}>
          {kind === 'invite' ? 'Create account and sign in' : 'Save password and sign in'}
        </button>
      </form>
    </AuthLayout>
  );
}

function DeadLink({ info, kind, company }: { info: PU.LinkInfo; kind: PU.LinkKind; company: string }) {
  const at = company ? ` at ${company}` : '';
  const copy: Record<Exclude<PU.LinkState, 'ok'>, { title: string; body: string; cta: 'login' | 'forgot' | 'none' }> = {
    expired:
      kind === 'invite'
        ? {
            title: 'This invite has expired',
            body: `Invites work for ${PU.INVITE_DAYS} days. Ask your contact at EP Team to send you a new one.`,
            cta: 'none',
          }
        : {
            title: 'This link has expired',
            body: `Reset links work for ${PU.RESET_HOURS} hour. You can ask for a new one now.`,
            cta: 'forgot',
          },
    used: {
      title: 'This link has already been used',
      body: 'Each link works once. If you have already set your password, sign in with it.',
      cta: 'login',
    },
    withdrawn: {
      title: 'This link no longer works',
      body: `Your access${at} has been changed since it was sent. If you think you should have access, contact EP Team.`,
      cta: 'login',
    },
    invalid: {
      title: 'This link is not valid',
      body: 'Check it was copied in full from the email — or, if you have already set a password, sign in.',
      cta: 'login',
    },
  };
  const c = copy[info.state === 'ok' ? 'invalid' : info.state];
  return (
    <AuthLayout title={c.title} intro={c.body}>
      <div className="flex gap-2">
        {c.cta === 'forgot' ? (
          <Link to="/portal/forgot" className="btn btn-primary">
            Send a new link
          </Link>
        ) : null}
        <Link to="/portal/login" className={c.cta === 'forgot' ? 'btn btn-secondary' : 'btn btn-primary'}>
          Go to sign in
        </Link>
      </div>
    </AuthLayout>
  );
}
