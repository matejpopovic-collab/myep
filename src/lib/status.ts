/* ============================================================================
   EPROSTA — status vocabulary and tone tokens
   ----------------------------------------------------------------------------
   ONE glossary, per the critique's terminology-drift finding. The people on a
   shift are ASSIGNED STAFF. Not applicants, not recipients, not
   employees-in-this-context.

   TONE TOKENS
   -----------
   These are CSS `var()` references, not hex. Inline styles accept them exactly
   like a literal colour, and because the value is resolved by the browser
   against the nearest theme scope, a status pill rendered in the dark sidebar
   and the same pill rendered in the light page body each pick the variant that
   actually clears 4.5:1 on the surface behind it.

   TONE_LINE exists because several banners need a translucent hairline of the
   same hue. Concatenating an alpha suffix onto a hex silently produces garbage
   once the value is a var() — ask for the token you want instead.
   ========================================================================== */

import type { Tone } from '@/data/types';

export const GLOSSARY = {
  assignedStaff: 'Assigned staff',
  assignedStaffOne: 'assigned worker',
  callout: 'Send callout', // was "Fill Shift"
  manualAssign: 'Assign manually', // was "Assign Employee"
  roleGroup: 'Role group', // was "Shift Split #130015"
} as const;

export interface StatusMeta {
  label: string;
  tone: Tone;
  hint: string;
}

export const STATUS_META: Record<string, StatusMeta> = {
  // assignment confirmation
  confirmed: { label: 'Confirmed', tone: 'healthy', hint: 'Worker has confirmed they are attending' },
  awaiting: { label: 'Awaiting confirmation', tone: 'atRisk', hint: 'Accepted the shift but has not confirmed attendance' },
  declined: { label: 'Declined', tone: 'critical', hint: 'Worker declined the shift' },
  invited: { label: 'Invited', tone: 'neutral', hint: 'Callout sent, no response yet' },
  accepted: { label: 'Accepted', tone: 'info', hint: 'Worker accepted the shift' },
  // employee vetting
  verified: { label: 'Verified', tone: 'healthy', hint: 'Documents checked and right-to-work verified' },
  flagged: { label: 'Flagged', tone: 'critical', hint: 'Has active strikes — review before assigning' },
  pending: { label: 'Pending', tone: 'atRisk', hint: 'Onboarding complete, documents not yet verified' },
  // client
  active: { label: 'Active', tone: 'healthy', hint: '' },
  inactive: { label: 'Inactive', tone: 'neutral', hint: '' },
  // attendance outcomes
  worked: { label: 'Worked', tone: 'healthy', hint: 'Clocked in and out within tolerance' },
  late: { label: 'Late', tone: 'atRisk', hint: 'Clocked in more than 30 minutes after shift start' },
  overtime: { label: 'Overtime', tone: 'info', hint: 'Clocked out more than 30 minutes after shift end' },
  'no-show': { label: 'No show', tone: 'critical', hint: 'No clock-in recorded' },
  cancelled: { label: 'Cancelled', tone: 'neutral', hint: 'Shift cancelled before it started' },
  // event phase
  live: { label: 'Live', tone: 'critical', hint: 'Running right now' },
  upcoming: { label: 'Upcoming', tone: 'info', hint: '' },
  complete: { label: 'Complete', tone: 'neutral', hint: '' },
  // right to work
  expiring: { label: 'Expiring', tone: 'atRisk', hint: 'Right-to-work document expires soon' },
};

export const TONE_HEX: Record<Tone, string> = {
  critical: 'var(--tone-critical)',
  atRisk: 'var(--tone-at-risk)',
  healthy: 'var(--tone-healthy)',
  info: 'var(--tone-info)',
  neutral: 'var(--tone-neutral)',
};

export const TONE_BG: Record<Tone, string> = {
  critical: 'var(--tone-critical-soft)',
  atRisk: 'var(--tone-at-risk-soft)',
  healthy: 'var(--tone-healthy-soft)',
  info: 'var(--tone-info-soft)',
  neutral: 'var(--tone-neutral-soft)',
};

export const TONE_LINE: Record<Tone, string> = {
  critical: 'var(--tone-critical-line)',
  atRisk: 'var(--tone-at-risk-line)',
  healthy: 'var(--tone-healthy-line)',
  info: 'var(--tone-info-line)',
  neutral: 'var(--tone-neutral-line)',
};

export const statusMeta = (key: string): StatusMeta =>
  STATUS_META[key] || { label: key, tone: 'neutral', hint: '' };
