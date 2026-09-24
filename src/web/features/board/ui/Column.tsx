import type { ReactNode } from 'react';
import { IconButton } from '../../../shared/ui/index';

export interface ColumnProps {
  status: string;
  count: number;
  /** Where a dragged card would land, or null when nothing is over this column. */
  dropIndex: number | null;
  onAdd: (status: string) => void;
  children: ReactNode[];
  columnRef: (element: HTMLElement | null) => void;
}

export function Column({ status, count, dropIndex, onAdd, children, columnRef }: ColumnProps) {
  const cards: ReactNode[] = [];
  children.forEach((card, index) => {
    if (dropIndex === index) cards.push(<li key="drop-line" className="drop-line" />);
    cards.push(card);
  });
  if (dropIndex !== null && dropIndex >= children.length) {
    cards.push(<li key="drop-line" className="drop-line" />);
  }

  return (
    <section
      className="column"
      aria-label={`${status} (${count})`}
      ref={columnRef}
      data-status={status}
    >
      <header className="column__head">
        <h2 className="column__title">{status}</h2>
        <span className="column__count">{count}</span>
        <IconButton label={`Add a task to ${status}`} onClick={() => onAdd(status)}>
          +
        </IconButton>
      </header>
      <ul className="column__cards">{cards}</ul>
      {children.length === 0 ? <p className="column__empty">Nothing here yet</p> : null}
    </section>
  );
}
