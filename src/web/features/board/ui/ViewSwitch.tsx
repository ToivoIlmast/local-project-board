import { Button } from '../../../shared/ui/index';

export type View = 'board' | 'blocks';

export interface ViewSwitchProps {
  value: View;
  onChange: (view: View) => void;
}

const VIEWS: { view: View; label: string }[] = [
  { view: 'board', label: 'Board' },
  { view: 'blocks', label: 'Blocks' },
];

/** Which way the main area shows the tasks: in columns by status, or in blocks by topic. */
export function ViewSwitch({ value, onChange }: ViewSwitchProps) {
  return (
    <nav className="view-switch" aria-label="View">
      {VIEWS.map(({ view, label }) => (
        <Button
          key={view}
          size="small"
          aria-current={view === value ? 'page' : undefined}
          onClick={() => onChange(view)}
        >
          {label}
        </Button>
      ))}
    </nav>
  );
}
