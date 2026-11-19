import { screen, waitFor, within } from '@testing-library/react';
import { aProject, aTask, STATUSES } from '../support/fixtures';
import { renderBoard } from '../support/render';

function idsIn(status: string): string[] {
  const column = document.querySelector(`[data-status="${status}"]`);
  return Array.from(column?.querySelectorAll('[data-task-id]') ?? []).map(
    (card) => card.getAttribute('data-task-id') ?? '',
  );
}

describe('the board in another language', () => {
  const project = aProject({ statuses: [...STATUSES.slice(0, 3), 'review', 'done'] });
  const tasks = [
    aTask({ id: 'T1', title: 'Extract the git adapter', status: 'todo', labels: ['refactor'] }),
  ];

  it('translates the header, the columns and the card menu, and nothing the person wrote', async () => {
    const { user } = await renderBoard({ project, tasks });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'de');

    for (const name of ['Neue Aufgabe', 'Berichte', 'Themen', 'Einstellungen', 'Neu laden']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'New task' })).not.toBeInTheDocument();

    // The four standard statuses are translated; the one this board configured is shown as is.
    const columns = screen
      .getAllByRole('region', { name: /\(\d+\)$/ })
      .map((column) => column.getAttribute('aria-label'));
    expect(columns).toEqual([
      'Backlog (0)',
      'Zu erledigen (1)',
      'In Arbeit (0)',
      'review (0)',
      'Erledigt (0)',
    ]);
    expect(screen.getByRole('navigation', { name: 'Ansicht' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Thema' })).toBeInTheDocument();

    // What was written by a person stays as it was.
    expect(screen.getByText('Extract the git adapter')).toBeInTheDocument();
    expect(screen.getByText('refactor')).toBeInTheDocument();
    expect(screen.getByText('dep-health')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Aktionen für T1' }));
    const menu = within(document.querySelector<HTMLElement>('.menu__list') as HTMLElement);
    for (const name of [
      'Öffnen',
      'Bearbeiten',
      'Nach oben',
      'Nach unten',
      'Nach Backlog verschieben',
      'Nach In Arbeit verschieben',
      'Nach review verschieben',
      'Nach Erledigt verschieben',
      'Löschen',
    ]) {
      expect(menu.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('still moves a task to the status it is called by on the board, not by its label', async () => {
    const { user, board } = await renderBoard({ project, tasks });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'de');

    await user.click(screen.getByRole('button', { name: 'Aktionen für T1' }));
    await user.click(screen.getByRole('button', { name: 'Nach Erledigt verschieben' }));

    await waitFor(() => expect(idsIn('done')).toEqual(['T1']));
    expect(idsIn('todo')).toEqual([]);
    expect(board.tasks.find((task) => task.id === 'T1')?.status).toBe('done');
  });

  it('translates the dialogs the page asks, with the id of the task as it is', async () => {
    const { user } = await renderBoard({ project, tasks });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'ru');

    await user.click(screen.getByRole('button', { name: 'Действия для T1' }));
    await user.click(screen.getByRole('button', { name: 'Удалить' }));

    const dialog = screen.getByRole('dialog', { name: 'Удалить T1?' });
    expect(within(dialog).getByRole('button', { name: 'Отмена' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Закрыть' })).toBeInTheDocument();
  });
});
