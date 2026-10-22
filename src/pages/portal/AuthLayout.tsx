/* ============================================================================
   CLIENT PORTAL — the frame around sign-in, invite, forgot and reset
   ----------------------------------------------------------------------------
   These pages sit OUTSIDE the app shell: someone arriving from an email link is
   not signed in yet, so there is no sidebar to show them and no tier to guard.

   Two panels on a wide screen — the brand on the dark rail colour (the logo is
   white and needs it), the form on the light surface — collapsing to a dark
   band above the form on a phone, which is where most invite emails get opened.
   ========================================================================== */

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '@/components/Icon';

export function AuthLayout({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-canvas">
      <aside className="theme-dark bg-surface text-ink lg:w-[420px] lg:min-h-screen flex-none flex flex-col px-6 py-5 lg:px-10 lg:py-10">
        <Link to="/portal/login" className="inline-flex items-center gap-3 no-underline">
          <img src="/logo.png" alt="EP Team" className="h-8 w-auto block" />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Client portal</span>
        </Link>
        <div className="hidden lg:block mt-auto mb-auto pt-16">
          <h2 className="text-[22px] font-semibold leading-snug text-ink">
            Your bookings with EP, in one place.
          </h2>
          <ul className="mt-6 grid gap-3.5 text-[13.5px] text-ink-2">
            {[
              ['fileText', 'Read and sign quotes'],
              ['calendar', 'See every event and who is staffing it'],
              ['clock', 'Check the hours delivered'],
              ['trendUp', 'Pay deposits and invoices'],
            ].map(([icon, label]) => (
              <li key={label} className="flex items-center gap-3">
                <span className="text-ink-3">
                  <Icon name={icon} decorative />
                </span>
                {label}
              </li>
            ))}
          </ul>
        </div>
        <p className="hidden lg:block text-[11.5px] text-ink-3">EP Event Services</p>
      </aside>

      <main className="flex-1 flex items-start lg:items-center justify-center px-4 py-8 sm:py-12">
        <div className="w-full max-w-[420px]">
          <h1 className="text-[22px] font-semibold text-ink leading-tight">{title}</h1>
          {intro ? <div className="text-[13.5px] text-ink-2 leading-relaxed mt-2">{intro}</div> : null}
          <div className="mt-6">{children}</div>
        </div>
      </main>
    </div>
  );
}

/** A labelled field. The label wraps the input, so clicking it focuses. */
export function Field({
  label,
  hint,
  children,
  right,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  right?: ReactNode;
}) {
  // `right` (e.g. "Forgot password?") sits beside the label, not inside it —
  // a link inside a <label> becomes part of the field's accessible name.
  return (
    <div className="relative mb-4">
      {right ? <div className="absolute right-0 top-0 leading-none">{right}</div> : null}
      <label className="block">
        <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">{label}</span>
        {children}
        {hint ? <span className="block text-[11.5px] text-ink-3 mt-1">{hint}</span> : null}
      </label>
    </div>
  );
}

/** The dashed box that stands in for an email the prototype cannot send. */
export function PrototypeNote({ children }: { children: ReactNode }) {
  return (
    <div className="mt-6 rounded-lg border border-dashed border-surface-line px-3.5 py-3 text-[12px] text-ink-3 leading-relaxed">
      <span className="font-semibold text-ink-2">Prototype · </span>
      {children}
    </div>
  );
}

/** Password input with a show/hide toggle; the toggle is a real button. */
export function PasswordInput({
  value,
  onChange,
  shown,
  autoComplete,
  autoFocus,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  shown: boolean;
  autoComplete: 'current-password' | 'new-password';
  autoFocus?: boolean;
  id?: string;
}) {
  return (
    <input
      id={id}
      className="field"
      type={shown ? 'text' : 'password'}
      value={value}
      autoComplete={autoComplete}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function Checklist({ checks }: { checks: { id: string; label: string; ok: boolean }[] }) {
  return (
    <ul className="grid gap-1.5 mb-5" aria-live="polite">
      {checks.map((c) => (
        <li key={c.id} className={`flex items-center gap-2 text-[12.5px] ${c.ok ? 'text-status-healthy' : 'text-ink-3'}`}>
          <Icon name={c.ok ? 'checkCircle' : 'close'} decorative className="icon-sm" />
          <span>{c.label}</span>
          <span className="sr-only">{c.ok ? '— done' : '— not yet'}</span>
        </li>
      ))}
    </ul>
  );
}
