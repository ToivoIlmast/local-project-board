import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IconButton } from './IconButton';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  tone?: 'normal' | 'danger';
  disabled?: boolean;
}

export interface MenuProps {
  label: string;
  items: (MenuItem | 'separator')[];
  children?: ReactNode;
}

/** Separators have no name of their own; the item above one names it. */
function separatorKey(items: (MenuItem | 'separator')[], index: number): string {
  const above = items.slice(0, index).findLast((item) => item !== 'separator');
  return `separator-after-${above?.label ?? 'nothing'}`;
}

/**
 * A button and the things it can do. Every item is a real button, so the keyboard works;
 * the focus goes back to the button when the menu closes, so it is never left on an item
 * that is no longer there.
 */
export function Menu({ label, items, children = '⋯' }: MenuProps) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: Event): void => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div
      className="menu"
      ref={boxRef}
      // Tabbing past the last item leaves the menu; it does not stay open behind the focus.
      // A blur to nowhere (a click that does not focus, another window) is not leaving it.
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (open && next !== null && !boxRef.current?.contains(next)) setOpen(false);
      }}
    >
      <IconButton
        label={label}
        aria-expanded={open}
        ref={triggerRef}
        onClick={() => setOpen(!open)}
      >
        {children}
      </IconButton>
      {!open ? null : (
        <ul className="menu__list">
          {items.map((item, index) =>
            item === 'separator' ? (
              <li key={separatorKey(items, index)} className="menu__separator" aria-hidden="true" />
            ) : (
              <li key={item.label}>
                <button
                  type="button"
                  className={`menu__item menu__item--${item.tone ?? 'normal'}`}
                  disabled={item.disabled === true}
                  onClick={() => {
                    setOpen(false);
                    triggerRef.current?.focus();
                    item.onSelect();
                  }}
                >
                  {item.label}
                </button>
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}
