import type { ReactNode } from 'react';
import { useStatusLabel } from '../../../shared/i18n/index';
import { IconButton } from '../../../shared/ui/index';
import { useBoardT } from '../i18n';

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
  const t = useBoardT();
  const statusLabel = useStatusLabel();
  const name = statusLabel(status);
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
      aria-label={t('column.label', { status: name, count })}
      ref={columnRef}
      data-status={status}
    >
      <header className="column__head">
        <h2 className="column__title">{name}</h2>
        <span className="column__count">{count}</span>
        <IconButton label={t('column.add', { status: name })} onClick={() => onAdd(status)}>
          +
        </IconButton>
      </header>
      <ul className="column__cards">{cards}</ul>
      {children.length === 0 ? <p className="column__empty">{t('column.empty')}</p> : null}
    </section>
  );
}
