import { useEffect, useRef, type ReactNode } from 'react';

export interface PanelProps {
  label: string;
  children: ReactNode;
}

/**
 * The column beside the board for whatever is being looked at. It comes after every card in
 * the page, so a keyboard user who opened it would otherwise have to Tab through the whole
 * board to reach it: when it opens because of something they did, the focus moves in, and
 * when it closes, the focus goes back to where they were.
 */
export function Panel({ label, children }: PanelProps) {
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const opener = document.activeElement;
    // Nothing focused means the page was loaded on this panel, not that it was asked for.
    if (!(opener instanceof HTMLElement) || opener === document.body) return undefined;
    panelRef.current?.focus();
    return () => {
      // Focus on the body means it was lost with the panel. Focus anywhere else means the
      // person has already gone on — to another card, say — and is not pulled back.
      if (document.activeElement === document.body && opener.isConnected) opener.focus();
    };
  }, []);

  return (
    <aside className="panel" aria-label={label} tabIndex={-1} ref={panelRef}>
      {children}
    </aside>
  );
}
