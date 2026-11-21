import { Button } from '../../../shared/ui/index';
import { useBoardT } from '../i18n';

/** What the main area shows. The archive is reached from the header, so it has no button here. */
export type View = 'board' | 'blocks' | 'archive';

export interface ViewSwitchProps {
  value: View;
  onChange: (view: 'board' | 'blocks') => void;
}

const VIEWS = [
  { view: 'board', label: 'view.board' },
  { view: 'blocks', label: 'view.blocks' },
] as const;

/** Which way the main area shows the tasks: in columns by status, or in blocks by topic. */
export function ViewSwitch({ value, onChange }: ViewSwitchProps) {
  const t = useBoardT();
  return (
    <nav className="view-switch" aria-label={t('view.label')}>
      {VIEWS.map(({ view, label }) => (
        <Button
          key={view}
          size="small"
          aria-current={view === value ? 'page' : undefined}
          onClick={() => onChange(view)}
        >
          {t(label)}
        </Button>
      ))}
    </nav>
  );
}
