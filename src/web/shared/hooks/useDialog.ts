import { useEffect, useRef, type RefObject } from 'react';

const TABBABLE = 'a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])';

/** Where the keyboard should start in a `Modal`: the first thing to fill in, else the safest button. */
export function firstStop(panel: HTMLElement): HTMLElement {
  return (
    panel.querySelector<HTMLElement>('.modal__body :is(input, textarea, select):enabled') ??
    panel.querySelector<HTMLElement>('.modal__footer button:enabled') ??
    panel.querySelector<HTMLElement>('.modal__body button:enabled') ??
    panel
  );
}

interface StackEntry {
  container: HTMLElement;
  close: () => void;
}

// Open dialogs in the order they were opened, not in the order they sit in the DOM: a dialog
// inside another one is in its DOM, a dialog beside it is not, and either may be on top.
const stack: StackEntry[] = [];
let savedOverflow: string | null = null;

function onKeyDown(event: KeyboardEvent): void {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (event.key === 'Escape') {
    top.close();
    return;
  }
  if (event.key !== 'Tab') return;
  const { container } = top;
  const stops = [...container.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (stop) => !(stop as HTMLButtonElement).disabled,
  );
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!first || !last) return;
  const inside = container.contains(document.activeElement);
  // The dialog itself holds the focus when it starts there (the window of a task): Shift+Tab
  // from it would leave for the page behind, so it counts as the start, like the first stop.
  const atStart = document.activeElement === first || document.activeElement === container;
  if (event.shiftKey && (atStart || !inside)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !inside)) {
    event.preventDefault();
    first.focus();
  }
}

function push(entry: StackEntry): void {
  if (stack.length === 0) {
    document.addEventListener('keydown', onKeyDown);
    savedOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
  }
  stack.push(entry);
}

function remove(entry: StackEntry): void {
  const index = stack.indexOf(entry);
  if (index !== -1) stack.splice(index, 1);
  if (stack.length === 0 && savedOverflow !== null) {
    document.removeEventListener('keydown', onKeyDown);
    document.documentElement.style.overflow = savedOverflow;
    savedOverflow = null;
  }
}

export interface UseDialogOptions {
  /** The dialog's element: the one the keyboard is kept inside. */
  ref: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** A dialog that is not active holds no focus, answers no key and locks no scrolling. */
  active?: boolean;
  /** Where the focus starts; by default `firstStop`. */
  initialFocus?: (container: HTMLElement) => HTMLElement;
}

/**
 * What makes an element a dialog for the keyboard: the focus starts inside it, Escape closes
 * it and Tab cycles through it — only for the topmost open dialog — the page behind does not
 * scroll, and closing hands the focus back to whatever opened it.
 */
export function useDialog({
  ref,
  onClose,
  active = true,
  initialFocus = firstStop,
}: UseDialogOptions): void {
  // The latest values without re-running the effect below: a parent that re-renders (the
  // board does, whenever an agent changes it) must not take the focus back from the field.
  const closeRef = useRef(onClose);
  const initialFocusRef = useRef(initialFocus);
  useEffect(() => {
    closeRef.current = onClose;
    initialFocusRef.current = initialFocus;
  }, [onClose, initialFocus]);

  useEffect(() => {
    const container = ref.current;
    if (!active || !container) return undefined;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const entry: StackEntry = { container, close: () => closeRef.current() };
    push(entry);
    initialFocusRef.current(container).focus();
    return () => {
      remove(entry);
      // Focus on the body was lost with the dialog. Focus anywhere else was put there on
      // purpose — the panel a new task opens, say — and stays.
      if (document.activeElement === document.body && opener?.isConnected === true) opener.focus();
    };
  }, [active, ref]);
}
