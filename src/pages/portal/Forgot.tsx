/* ============================================================================
   CLIENT PORTAL — forgot password  (/portal/forgot)
   ----------------------------------------------------------------------------
   The confirmation is the same sentence whether or not the address has an
   account. Only the prototype box below it differs, standing in for the email.
   ========================================================================== */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import * as PU from '@/lib/portalusers';
import { AuthLayout, Field, PrototypeNote } from './AuthLayout';

export default function PortalForgotPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ email: string; link: string | null } | null>(null);

  if (sent) {
    return (
      <AuthLayout
        title="Check your email"
        intro={
          <>
            If <strong className="text-ink">{sent.email}</strong> has an account, we have sent it a link to set a new
            password. The link works once, for {PU.RESET_HOURS} hour.
          </>
        }
      >
        <p className="text-[13px] text-ink-2 leading-relaxed">
          Nothing there after a few minutes? Check your spam folder, or ask your contact at EP Team.
        </p>
        <div className="flex gap-2 mt-6">
          <Link to="/portal/login" className="btn btn-primary">
            Back to sign in
          </Link>
          <button type="button" className="btn btn-secondary" onClick={() => setSent(null)}>
            Use another email
          </button>
        </div>
        <PrototypeNote>
          {sent.link ? (
            <>
              This is the link the email would contain:{' '}
              <Link to={sent.link} className="text-accent hover:underline">
                set a new password
              </Link>
              .
            </>
          ) : (
            <>No active portal user has that address, so no email would be sent. The screen says the same thing either way.</>
          )}
        </PrototypeNote>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Reset your password" intro="Enter the email you sign in with and we'll send you a link.">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const v = email.trim();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) {
            setError('Enter the email address you sign in with.');
            return;
          }
          setSent({ email: v, link: PU.requestReset(v) });
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
        {error ? (
          <p role="alert" className="text-[13px] text-status-critical mb-4">
            {error}
          </p>
        ) : null}
        <button type="submit" className="btn btn-primary w-full justify-center">
          Send reset link
        </button>
      </form>
      <p className="text-[12.5px] mt-6">
        <Link to="/portal/login" className="text-accent no-underline hover:underline">
          Back to sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
