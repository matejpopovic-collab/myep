/* ============================================================================
   CLIENT PORTAL — sign in  (/portal/login)
   ----------------------------------------------------------------------------
   One refusal for every failure — unknown address, wrong password, disabled,
   invite never accepted — so the form cannot be used to find out who has an
   account. See `PU.signIn` for what the prototype does and does not check.
   ========================================================================== */

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as PU from '@/lib/portalusers';
import * as PORTAL from '@/lib/portal';
import { AuthLayout, Field, PasswordInput, PrototypeNote } from './AuthLayout';

export default function PortalLoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [shown, setShown] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (!email.trim() || !pw) {
      setError('Enter your email and password.');
      return;
    }
    const r = PU.signIn(email, pw);
    if (!r.ok) {
      setError(r.error);
      setPw('');
      return;
    }
    PORTAL.portalSignIn(r.user);
    navigate('/client/jobs');
  };

  return (
    <AuthLayout title="Sign in" intro="Use the email address EP Team invited.">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Email">
          <input
            className="field"
            type="email"
            autoComplete="username"
            autoFocus
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setError(null);
            }}
          />
        </Field>
        <Field
          label="Password"
          right={
            <Link to="/portal/forgot" className="text-[12.5px] text-accent no-underline hover:underline">
              Forgot password?
            </Link>
          }
        >
          <PasswordInput
            value={pw}
            onChange={(v) => {
              setPw(v);
              setError(null);
            }}
            shown={shown}
            autoComplete="current-password"
          />
        </Field>
        <label className="flex items-center gap-2 text-[12.5px] text-ink-2 -mt-1 mb-5 cursor-pointer">
          <input type="checkbox" checked={shown} onChange={(e) => setShown(e.target.checked)} />
          Show password
        </label>

        {error ? (
          <p role="alert" className="text-[13px] text-status-critical mb-4">
            {error}
          </p>
        ) : null}

        <button type="submit" className="btn btn-primary w-full justify-center">
          Sign in
        </button>
      </form>

      <p className="text-[12.5px] text-ink-3 mt-6 leading-relaxed">
        No account? Access is set up by EP Team — ask your account manager to invite you.
      </p>

      <PrototypeNote>
        No passwords are stored, so any password works for someone whose invite has been accepted — try{' '}
        <button
          type="button"
          className="text-accent hover:underline"
          onClick={() => {
            setEmail('dana.reilly@festivalrepublic.com');
            setError(null);
          }}
        >
          dana.reilly@festivalrepublic.com
        </button>
        . Disabled people, unaccepted invites and inactive clients are refused, all with the same message.
      </PrototypeNote>
    </AuthLayout>
  );
}
