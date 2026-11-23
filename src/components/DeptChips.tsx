/* The Department chip row from the deployment builder's kit picker, for any
   list of charges. Renders nothing when there is only one department to pick:
   a filter with one option is noise. */

import { DEPARTMENTS } from '@/data/catalogue';

export function DeptChips({
  depts,
  value,
  onChange,
}: {
  /** `DEPARTMENTS` keys present in the list being filtered. */
  depts: string[];
  value: string | null;
  onChange: (d: string | null) => void;
}) {
  if (depts.length < 2) return null;
  const chip = (key: string, label: string, on: boolean, onClick: () => void) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className="px-2.5 py-[3px] rounded-full text-[12px] border cursor-pointer whitespace-nowrap"
      style={{
        background: on ? 'var(--accent-soft)' : 'var(--surface)',
        borderColor: on ? 'var(--accent)' : 'var(--surface-line)',
        color: on ? 'var(--ink)' : 'var(--ink-2)',
        fontWeight: on ? 600 : 400,
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label="Filter by department">
      <span className="text-[11.5px] text-ink-3 mr-0.5">Department</span>
      {chip('__all', 'All', !value, () => onChange(null))}
      {depts.map((d) => chip(d, DEPARTMENTS[d] || d, value === d, () => onChange(value === d ? null : d)))}
    </div>
  );
}
