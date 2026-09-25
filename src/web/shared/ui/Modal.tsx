import { useEffect, useId, useRef, type ReactNode } from 'react';
import { IconButton } from './IconButton';

export interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'normal' | 'wide';
}

const TABBABLE = 'a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])';

/** Where the keyboard should start: the first thing to fill in, else the safest button. */
function firstStop(panel: HTMLElement): HTMLElement {
  return (
    panel.querySelector<HTMLElement>('.modal__body :is(input, textarea, select):enabled') ??
    panel.querySelector<HTMLElement>('.modal__footer button:enabled') ??
    panel.querySelector<HTMLElement>('.modal__body button:enabled') ??
    panel
  );
}

/**
 * A dialog that behaves like one: it is announced, Escape closes it, and the keyboard stays
 * inside it — the focus starts on the first field, Tab cycles through the dialog and not the
 * page behind it, and closing hands the focus back to whatever opened it.
 */
export function Modal({ title, onClose, children, footer, width = 'normal' }: ModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  // The latest onClose without re-running the effect below: a parent that re-renders (the
  // board does, whenever an agent changes it) must not take the focus back from the field.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return undefined;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    firstStop(panel).focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const stops = [...panel.querySelectorAll<HTMLElement>(TABBABLE)].filter(
        (stop) => !(stop as HTMLButtonElement).disabled,
      );
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (!first || !last) return;
      const inside = panel.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      // Focus on the body was lost with the dialog. Focus anywhere else was put there on
      // purpose — the panel a new task opens, say — and stays.
      if (document.activeElement === document.body && opener?.isConnected === true) opener.focus();
    };
  }, []);

  return (
    <div
      className="modal"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className={`modal__panel modal__panel--${width}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panelRef}
      >
        {/* Plain divs: a header or footer outside a section is a second page banner. */}
        <div className="modal__header">
          <h2 id={titleId} className="modal__title">
            {title}
          </h2>
          <IconButton label="Close" onClick={onClose}>
            ✕
          </IconButton>
        </div>
        <div className="modal__body">{children}</div>
        {footer === undefined ? null : <div className="modal__footer">{footer}</div>}
      </div>
    </div>
  );
}
