import { useId, useRef, type ReactNode } from 'react';
import { useDialog } from '../hooks/useDialog';
import { useT } from '../i18n/common';
import { IconButton } from './IconButton';

export interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'normal' | 'wide';
}

/**
 * A dialog that behaves like one: it is announced, Escape closes it, and the keyboard stays
 * inside it — the focus starts on the first field, Tab cycles through the dialog and not the
 * page behind it, and closing hands the focus back to whatever opened it.
 */
export function Modal({ title, onClose, children, footer, width = 'normal' }: ModalProps) {
  const t = useT();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  useDialog({ ref: panelRef, onClose });

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
          <IconButton label={t('ui.close')} onClick={onClose}>
            ✕
          </IconButton>
        </div>
        <div className="modal__body">{children}</div>
        {footer === undefined ? null : <div className="modal__footer">{footer}</div>}
      </div>
    </div>
  );
}
