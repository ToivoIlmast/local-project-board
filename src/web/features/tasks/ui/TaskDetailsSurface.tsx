import { useEffect, useRef, type ReactNode } from 'react';
import { useDialog } from '../../../shared/hooks/useDialog';

/** How the details of a task are shown: a window over the board, or the column beside it. */
export type TaskDetailsLayout = 'modal' | 'panel';

export interface TaskDetailsSurfaceProps {
  layout: TaskDetailsLayout;
  /** The accessible name, the same in both layouts. */
  label: string;
  /** Escape and a press on the backdrop of the window ask for this. */
  onClose: () => void;
  /** The header: pinned above the scrolling body in the window. */
  head?: ReactNode;
  children: ReactNode;
}

/** Where the dialog starts: on the window itself, not on the first field inside it. */
const windowItself = (container: HTMLElement): HTMLElement => container;

/**
 * The one root of the details of a task, in both layouts. It renders the same elements in the
 * same order and changes only their attributes and classes, so that moving the task from the
 * window to the panel (and back) does not remount what is inside it: the chosen version, the
 * draft of the AI settings and the scroll position all stay.
 *
 * As a window it is a dialog for the keyboard (`useDialog`); as a panel it is the column
 * beside the board, and takes the focus the way `Panel` does.
 */
export function TaskDetailsSurface({
  layout,
  label,
  onClose,
  head,
  children,
}: TaskDetailsSurfaceProps) {
  const modal = layout === 'modal';
  const containerRef = useRef<HTMLDivElement>(null);
  useDialog({ ref: containerRef, onClose, active: modal, initialFocus: windowItself });

  useEffect(() => {
    const container = containerRef.current;
    if (modal || !container) return undefined;
    const opener = document.activeElement;
    // Nothing focused: the page was loaded on this task, not asked for. Focus already inside:
    // the person switched here from the window with the button, and is left where they are.
    if (!(opener instanceof HTMLElement) || opener === document.body) return undefined;
    if (container.contains(opener)) return undefined;
    container.focus();
    return () => {
      if (document.activeElement === document.body && opener.isConnected) opener.focus();
    };
  }, [modal]);

  return (
    <div
      className={modal ? 'task-modal' : 'task-modal task-modal--inline'}
      onMouseDown={modal ? (event) => event.target === event.currentTarget && onClose() : undefined}
    >
      <div
        className={modal ? 'task-modal__dialog' : 'panel'}
        role={modal ? 'dialog' : 'complementary'}
        aria-modal={modal ? true : undefined}
        aria-label={label}
        tabIndex={-1}
        ref={containerRef}
      >
        {head}
        <div className="task-modal__body">{children}</div>
      </div>
    </div>
  );
}
