/* ============================================================================
   EPROSTA — toasts
   ----------------------------------------------------------------------------
   A polite live region, mounted once by the shell. Anything that changes state
   confirms in words: the vanilla build proved how easily an action can fire a
   confirmation and change nothing, so the toast text says what actually
   happened rather than "Done".
   ========================================================================== */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { TONE_HEX } from '@/lib/status';
import type { Tone } from '@/data/types';

/**
 * An optional button on the toast.
 *
 * Earns its place on two flows. After a create, "Open" saves the operator
 * hunting the list for the thing they just made. After a destructive action,
 * "Undo" is the difference between a confirmation dialog being a safety net and
 * being a speed bump — and it is the only honest answer to a delete that turns
 * out to have been the wrong row.
 */
export interface ToastAction {
  label: string;
  onSelect: () => void;
}

interface ToastRecord {
  id: number;
  message: ReactNode;
  tone: Tone;
  action?: ToastAction;
}

type ToastFn = (
  message: ReactNode,
  opts?: { tone?: Tone; duration?: number; action?: ToastAction },
) => void;

const ToastContext = createContext<ToastFn>(() => {});

export const useToast = (): ToastFn => useContext(ToastContext);

let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastRecord[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback<ToastFn>(
    (message, opts = {}) => {
      const id = ++seq;
      setItems((list) => [...list, { id, message, tone: opts.tone || 'info', action: opts.action }]);
      // A toast carrying an action has to outlive the reading of it — four
      // seconds is not long enough to notice an Undo, decide, and reach it.
      window.setTimeout(() => dismiss(id), opts.duration || (opts.action ? 9000 : 4200));
    },
    [dismiss],
  );

  const value = useMemo(() => toast, [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className="toast">
            <span style={{ color: TONE_HEX[t.tone], marginTop: 1 }}>
              <Icon
                name={t.tone === 'critical' ? 'alert' : t.tone === 'healthy' ? 'checkCircle' : 'info'}
                decorative
              />
            </span>
            <div className="flex-1 leading-snug">{t.message}</div>
            {t.action ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm shrink-0"
                onClick={() => {
                  dismiss(t.id);
                  t.action!.onSelect();
                }}
              >
                {t.action.label}
              </button>
            ) : null}
            <button
              type="button"
              className="btn-icon"
              style={{ width: 24, height: 24 }}
              aria-label="Dismiss notification"
              onClick={() => dismiss(t.id)}
            >
              <Icon name="close" decorative className="icon-sm" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
