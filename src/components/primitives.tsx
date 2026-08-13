/* ============================================================================
   EPROSTA — shared presentational primitives
   ----------------------------------------------------------------------------
   The small pieces every screen repeats. Two rules are enforced here rather
   than trusted to call sites:

     · a status is never colour alone — Pill always carries a dot AND text
       (WCAG 1.4.1);
     · an avatar receives only a hue, and the theme supplies saturation and
       lightness, so the same person is legible dark-on-pale in the content area
       and pale-on-dark in the sidebar without this component knowing which
       context it was called from.
   ========================================================================== */

import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icon';
import { TONE_BG, TONE_HEX, TONE_LINE, statusMeta } from '@/lib/status';
import { pct as coveragePct, type Coverage } from '@/lib/coverage';
import { tag as tagById } from '@/data/db';
import type { Employee, Tone } from '@/data/types';
import * as RATING from '@/lib/rating';

/* -------------------------------------------------------------------- pill */

export interface PillProps {
  /** Key into STATUS_META, or any string when `label` is supplied. */
  status?: string;
  label?: string;
  tone?: Tone;
  /** `false` suppresses the tooltip entirely. */
  hint?: string | false;
}

/** Status pill: colour + dot + TEXT. Never colour alone (WCAG 1.4.1). */
export function Pill({ status = '', label, tone, hint }: PillProps) {
  const meta = statusMeta(status);
  const t = tone || meta.tone;
  const text = label || meta.label;
  const tip = hint === false ? '' : hint || meta.hint;
  return (
    <span
      className={`pill${tip ? ' tip' : ''}`}
      {...(tip ? { 'data-tip': tip, tabIndex: 0 } : {})}
      style={{ background: TONE_BG[t], color: TONE_HEX[t] }}
    >
      <span className="pill-dot" style={{ background: TONE_HEX[t] }} />
      {text}
    </span>
  );
}

export function TagPill({ tagId }: { tagId: string }) {
  const t = tagById(tagId);
  if (!t) return null;
  return (
    <span className="pill" style={{ background: TONE_BG[t.tone], color: TONE_HEX[t.tone] }}>
      {t.label}
    </span>
  );
}

/* ------------------------------------------------------------------ avatar */

export function Avatar({
  hue,
  initials,
  size = 32,
}: {
  hue: number;
  initials: string;
  size?: number;
}) {
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={
        {
          '--av-hue': `${hue}deg`,
          width: size,
          height: size,
          fontSize: Math.round(size * 0.38),
        } as CSSProperties
      }
    >
      {initials}
    </span>
  );
}

/* ------------------------------------------------------------------ rating */

/**
 * Stars PLUS the numeric value PLUS an accessible sentence. The live app showed
 * unlabelled stars that were identical on every row.
 *
 * The tooltip used to claim this was a supervisor's average. It is not — it is
 * earned from the attendance record, and saying so is the difference between a
 * number operators trust and one they work around.
 */
export function Rating({ emp }: { emp: Employee }) {
  const v = emp.rating;
  const full = Math.floor(v);
  const half = v - full >= 0.5;
  const tip = `Earned from ${emp.ratedShifts} rated shift${emp.ratedShifts === 1 ? '' : 's'}. ${RATING.summary(emp)}`;

  return (
    <span
      className="inline-flex items-center gap-1.5 tip"
      tabIndex={0}
      data-tip={tip}
      role="img"
      aria-label={`Rated ${v} out of 5 from ${emp.ratedShifts} shifts`}
    >
      <span className="inline-flex gap-px" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((i) => {
          const on = i <= full;
          const isHalf = !on && i === full + 1 && half;
          return (
            <svg
              key={i}
              viewBox="0 0 24 24"
              aria-hidden="true"
              fill={on ? 'var(--tone-at-risk)' : 'none'}
              stroke={on || isHalf ? 'var(--tone-at-risk)' : 'var(--star-off)'}
              strokeWidth="1.6"
              strokeLinejoin="round"
              style={{ width: 13, height: 13, flex: 'none' }}
            >
              <path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
            </svg>
          );
        })}
      </span>
      <span className="text-[12.5px] font-semibold text-ink-2" aria-hidden="true">
        {v.toFixed(1)}
      </span>
    </span>
  );
}

/* ---------------------------------------------------------------- coverage */

/** Coverage bar. Hero element wherever it appears. */
export function CoverageBar({
  cov,
  tone,
  height = 8,
}: {
  cov: Coverage;
  tone: Tone;
  height?: number;
}) {
  const p = coveragePct(cov);
  const awaitingPct = cov.required ? Math.round((cov.awaiting / cov.required) * 100) : 0;

  // Nothing required is not the same as everything filled. `pct()` returns 100
  // for an empty split so percentages stay finite, but painting a full green
  // bar for a job with no roles reads as an achievement rather than an absence.
  if (!cov.required) {
    return (
      <div
        className="coverage-track"
        style={{ height }}
        role="progressbar"
        aria-valuenow={0}
        aria-valuemin={0}
        aria-valuemax={0}
        aria-label="No roles required"
      />
    );
  }

  return (
    <div
      className="coverage-track"
      style={{ height }}
      role="progressbar"
      aria-valuenow={cov.filled}
      aria-valuemin={0}
      aria-valuemax={cov.required}
      aria-label={`${cov.filled} of ${cov.required} roles filled`}
    >
      <div style={{ height: '100%', display: 'flex' }}>
        <div className="coverage-fill" style={{ width: `${p}%`, background: TONE_HEX[tone] }} />
        {awaitingPct > 0 && (
          <div
            className="coverage-fill"
            style={{
              width: `${awaitingPct}%`,
              background: `repeating-linear-gradient(135deg,${TONE_LINE.atRisk} 0 5px,transparent 5px 10px)`,
            }}
          />
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- KPI */

export interface KpiProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  to?: string;
  hint?: string;
}

/** Big number for a KPI tile. Tabular figures so columns line up. */
export function Kpi({ label, value, sub, tone = 'neutral', to, hint }: KpiProps) {
  const body = (
    <>
      <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-1.5">{label}</div>
      <div className="text-[26px] font-bold leading-none tabular-nums" style={{ color: TONE_HEX[tone] }}>
        {value}
      </div>
      {sub ? <div className="text-[12.5px] text-ink-2 mt-1.5 leading-snug">{sub}</div> : null}
    </>
  );
  const cls = 'card p-4 flex-1 min-w-[180px]';
  return to ? (
    <Link to={to} className={`${cls} no-underline block hover:border-surface-line transition-colors`} title={hint}>
      {body}
    </Link>
  ) : (
    <div className={cls} title={hint}>
      {body}
    </div>
  );
}

/* ------------------------------------------------------------ empty state */

export function EmptyState({
  iconName = 'inbox',
  title,
  body,
  action,
}: {
  iconName?: string;
  title: string;
  body: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-14">
      <div className="w-14 h-14 rounded-full bg-surface-high border border-surface-line flex items-center justify-center text-ink-3 mb-4">
        <Icon name={iconName} decorative className="icon-xl" />
      </div>
      <h3 className="text-[15px] font-semibold text-ink mb-1.5">{title}</h3>
      <p className="text-[13.5px] text-ink-2 max-w-md leading-relaxed">{body}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/* ----------------------------------------------------------- page furniture */

export interface Crumb {
  label: string;
  to?: string;
}

export function Breadcrumb({ trail }: { trail: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[12.5px] mb-2.5">
      {trail.map((t, i) =>
        i === trail.length - 1 || !t.to ? (
          <span key={i} className="text-ink-3" aria-current="page">
            {t.label}
          </span>
        ) : (
          <span key={i} className="flex items-center gap-1.5">
            <Link to={t.to} className="text-ink-2 no-underline hover:text-ink hover:underline">
              {t.label}
            </Link>
            <span className="text-ink-3" aria-hidden="true">
              <Icon name="chevronRight" decorative className="icon-sm" />
            </span>
          </span>
        ),
      )}
    </nav>
  );
}

/** Page header: real H1, actions that never clip off the viewport. */
export function PageHeader({
  title,
  subtitle,
  actions,
  crumbs,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  crumbs?: Crumb[];
}) {
  return (
    <>
      {crumbs ? <Breadcrumb trail={crumbs} /> : null}
      <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
        <div className="min-w-0">
          <h1 className="text-[22px] font-bold text-ink leading-tight tracking-tight">{title}</h1>
          {subtitle ? (
            <p className="text-[13.5px] text-ink-2 mt-1 max-w-2xl leading-relaxed">{subtitle}</p>
          ) : null}
        </div>
        {actions ? <div className="flex items-center gap-2 flex-wrap shrink-0">{actions}</div> : null}
      </div>
    </>
  );
}

/** Section heading inside a page. */
export function Section({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4 mt-7 mb-3">
      <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
      {right ? <div className="flex items-center gap-2">{right}</div> : null}
    </div>
  );
}

/** Standard "where does this number come from" footnote. */
export function Provenance({ children }: { children: ReactNode }) {
  return (
    <p className="text-[12px] text-ink-3 mt-3 leading-relaxed flex items-start gap-1.5">
      <span className="mt-px">
        <Icon name="info" decorative className="icon-sm" />
      </span>
      <span>{children}</span>
    </p>
  );
}

/** Segmented control — the one filter pattern used across every list screen. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: [T, string][];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map(([v, l]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

/** Search field with the magnifier inside it. */
export function SearchField({
  value,
  onChange,
  placeholder,
  ariaLabel,
  className = 'w-60',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div className={`relative max-w-full ${className}`}>
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none">
        <Icon name="search" decorative />
      </span>
      <input
        className="field pl-9"
        type="search"
        placeholder={placeholder}
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
