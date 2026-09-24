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

/** A button and the things it can do. Every item is a real button, so the keyboard works. */
export function Menu({ label, items, children = '⋯' }: MenuProps) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: Event): void => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="menu" ref={boxRef}>
      <IconButton label={label} aria-expanded={open} onClick={() => setOpen(!open)}>
        {children}
      </IconButton>
      {!open ? null : (
        <ul className="menu__list">
          {items.map((item, index) =>
            item === 'separator' ? (
              <li key={separatorKey(items, index)} className="menu__separator" role="separator" />
            ) : (
              <li key={item.label}>
                <button
                  type="button"
                  className={`menu__item menu__item--${item.tone ?? 'normal'}`}
                  disabled={item.disabled === true}
                  onClick={() => {
                    setOpen(false);
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
