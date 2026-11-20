/* ============================================================================
   STATUS BAR
   ----------------------------------------------------------------------------
   The one row at the top of a working tab that says where the thing stands
   and what happens next: a state pill, one sentence, the figures that matter,
   and at most ONE primary action. Used by Quote & variations and Allocation
   so every tab answers "where is this, and what do I do now" in the same
   place and the same shape.

   The card itself is never tinted. Colour lives on the pill, so a tab that is
   simply waiting on its next step does not look like something went wrong;
   anything that needs more than a sentence gets its own card beneath.
   ========================================================================== */

import type { ReactNode } from 'react';
import type { Tone } from '@/data/types';
import { Pill } from '@/components/primitives';

export interface StatusFigure {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
}

export function StatusBar({
  label,
  tone,
  line,
  figures = [],
  actions,
  meta,
}: {
  label: string;
  tone: Tone;
  line: ReactNode;
  figures?: StatusFigure[];
  actions?: ReactNode;
  /** Small print under the row: who did it and when, a permission note. */
  meta?: ReactNode;
}) {
  return (
    <div className="card px-4 py-3 mb-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Pill label={label} tone={tone} hint={false} />
        <p className="text-[12.5px] text-ink-2 leading-relaxed flex-1 min-w-[240px]">{line}</p>
        {figures.map((f) => (
          <div key={f.label} className="text-right shrink-0">
            <div className="text-[11px] text-ink-3">{f.label}</div>
            <div className="text-[15px] font-bold text-ink tabular-nums leading-tight">{f.value}</div>
            {f.sub ? <div className="text-[11px] text-ink-3 tabular-nums">{f.sub}</div> : null}
          </div>
        ))}
        {actions ? <div className="shrink-0 flex items-center gap-2">{actions}</div> : null}
      </div>
      {meta ? <div className="text-[12px] text-ink-3 mt-2 leading-relaxed">{meta}</div> : null}
    </div>
  );
}
