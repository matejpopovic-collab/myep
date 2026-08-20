/* ============================================================================
   EPROSTA — modal, destructive confirm, overflow menu
   ----------------------------------------------------------------------------
   The modal traps focus, closes on Escape and on a backdrop click, and restores
   focus to whatever opened it.

   ConfirmDestructive can demand the operator type an exact name. That is used
   for Delete Event, which in the live app was one click away from destroying a
   running event with 15 confirmed staff.

   The overflow menu is where every demoted secondary action goes, so screens
   stop showing nine peer buttons in five colours.
   ========================================================================== */

import {
  useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

/* -------------------------------------------------------------------- modal */

export interface ModalProps {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  onClose: () => void;
}

export function Modal({ title, children, footer, width = 520, onClose }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'Tab') trapFocus(e, panelRef.current);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      restoreRef.current?.focus?.();
    };
  }, [onClose]);

  useLayoutEffect(() => {
    const root = panelRef.current;
    if (!root) return;
    const first = root.querySelector<HTMLElement>(
      'input,select,textarea,button:not([data-close])',
    );
    (first || root.querySelector<HTMLElement>('[data-close]'))?.focus();
  }, []);

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ maxWidth: width }}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-surface-line">
          <h2 className="text-[15px] font-semibold text-ink leading-snug">{title}</h2>
          <button type="button" className="btn-icon" data-close aria-label="Close dialog" onClick={onClose}>
            <Icon name="close" decorative />
          </button>
        </div>
        <div className="px-5 py-4 overflow-y-auto flex-1">{children}</div>
        {footer ? (
          <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-surface-line">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

function trapFocus(e: KeyboardEvent, root: HTMLElement | null): void {
  if (!root) return;
  const f = [
    ...root.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])',
    ),
  ].filter((el) => el.offsetParent !== null);
  if (!f.length) return;
  const first = f[0];
  const last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/* ------------------------------------------------------ destructive confirm */

export function ConfirmDestructive({
  title,
  message,
  confirmLabel = 'Delete',
  typeToConfirm,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  /** When set, the operator must type this exact string to enable the button. */
  typeToConfirm?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const armed = !typeToConfirm || typed.trim() === typeToConfirm;

  const go = () => {
    onClose();
    onConfirm();
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" disabled={!armed} onClick={go}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-[13.5px] text-ink-2 leading-relaxed">{message}</p>
      {typeToConfirm ? (
        <label className="block mt-4">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
            Type <span className="font-mono font-semibold text-ink">{typeToConfirm}</span> to confirm
          </span>
          <input
            className="field"
            autoComplete="off"
            spellCheck={false}
            aria-label={`Type ${typeToConfirm} to confirm deletion`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && armed) go();
            }}
          />
        </label>
      ) : null}
    </Modal>
  );
}

/* ------------------------------------------------------------ overflow menu */

export interface MenuItem {
  label: string;
  icon?: string;
  hint?: string;
  badge?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
}

export type MenuEntry = MenuItem | '-';

/**
 * Anchored popup menu. Renders into a portal and flips above the anchor when
 * there is no room below, so an action at the bottom of a long table is still
 * reachable.
 */
export function OverflowMenu({
  anchor,
  items,
  align = 'right',
  onClose,
}: {
  anchor: HTMLElement | null;
  items: MenuEntry[];
  align?: 'left' | 'right';
  onClose: () => void;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight?: number } | null>(null);

  const place = useCallback(() => {
    const pop = popRef.current;
    if (!pop || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;

    let left = align === 'left' ? r.left : r.right - w;
    if (left < 8) left = 8;
    if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;

    const spaceBelow = Math.max(120, window.innerHeight - r.bottom - 16);
    const spaceAbove = Math.max(120, r.top - 16);

    let top = r.bottom + 6;
    let maxHeight = spaceBelow;

    // Flip upward only if anchor is low on screen and there is significantly more room above than below
    if (top + h > window.innerHeight - 8) {
      if (r.top > window.innerHeight / 2 && spaceAbove > spaceBelow) {
        top = Math.max(8, r.top - h - 6);
        maxHeight = spaceAbove;
      } else {
        top = r.bottom + 6;
        maxHeight = spaceBelow;
      }
    }

    setPos({ left: left + window.scrollX, top: top + window.scrollY, maxHeight });
  }, [anchor, align]);

  useLayoutEffect(place, [place]);

  useEffect(() => {
    const outside = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const t = window.setTimeout(() => {
      document.addEventListener('mousedown', outside);
      document.addEventListener('keydown', onKey);
    }, 0);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [onClose, place]);

  return createPortal(
    <div
      ref={popRef}
      className="menu-pop"
      role="menu"
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        maxHeight: pos?.maxHeight,
        overflowY: 'auto',
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {items.map((it, i) =>
        it === '-' ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`menu-item${it.danger ? ' is-danger' : ''}`}
            disabled={it.disabled}
            style={it.disabled ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
            title={it.hint}
            onClick={() => {
              onClose();
              it.onSelect?.();
            }}
          >
            {it.icon ? <Icon name={it.icon} decorative /> : <span style={{ width: 16 }} />}
            <span className="flex-1">{it.label}</span>
            {it.badge ? <span className="text-2xs text-ink-3">{it.badge}</span> : null}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/** Convenience wrapper: a `⋯` button that owns its own menu state. */
export function MenuButton({
  items,
  label = 'More actions',
  align = 'right',
  className = 'btn-icon',
  children,
}: {
  items: MenuEntry[];
  label?: string;
  align?: 'left' | 'right';
  className?: string;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={className}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
      >
        {children ?? <Icon name="more" decorative />}
      </button>
      {open ? (
        <OverflowMenu anchor={ref.current} items={items} align={align} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
