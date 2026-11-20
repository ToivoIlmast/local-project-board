import { screen, waitFor, within } from '@testing-library/react';
import { aTask } from '../support/fixtures';
import { renderBoard } from '../support/render';

const BODY = '## Context\n\nThe status parser still lives in the HTTP layer.';

describe('the details of a task in another language', () => {
  const tasks = () => [
    aTask({ id: 'T1', title: 'First', status: 'todo' }),
    aTask({
      id: 'T2',
      title: 'Extract the git adapter',
      status: 'todo',
      body: BODY,
      labels: ['refactor', 'git'],
      branch: 'feat/git-adapter',
      dependsOn: ['T1'],
    }),
  ];

  async function openT2() {
    const rendered = await renderBoard({ tasks: tasks() });
    await rendered.user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'de');
    await rendered.user.click(screen.getByRole('button', { name: 'Extract the git adapter' }));
    const panel = await screen.findByRole('complementary', { name: 'Aufgabe T2' });
    return { ...rendered, panel };
  }

  it('translates the fields, the status and the sections, and nothing the person wrote', async () => {
    const { panel } = await openT2();

    expect(within(panel).getByLabelText('Version')).toBeInTheDocument();
    expect(within(panel).getByLabelText('Status')).toHaveDisplayValue('Zu erledigen');
    for (const name of ['Bearbeiten', 'Aktualität prüfen', 'Löschen', 'Schließen']) {
      expect(within(panel).getByRole('button', { name })).toBeInTheDocument();
    }
    expect(within(panel).getByRole('region', { name: 'Dokumente' })).toBeInTheDocument();
    expect(within(panel).getByRole('heading', { name: 'Versionen' })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();

    // The description, the title, the labels and the branch stay as they were written.
    expect(within(panel).getByRole('heading', { name: 'Extract the git adapter' })).toBeVisible();
    expect(within(panel).getByRole('heading', { name: 'Context' })).toBeInTheDocument();
    expect(
      within(panel).getByText('The status parser still lives in the HTTP layer.'),
    ).toBeVisible();
    expect(within(panel).getByText('refactor')).toBeInTheDocument();
    expect(within(panel).getByText('git')).toBeInTheDocument();
    expect(within(panel).getByText('⎇ feat/git-adapter')).toBeInTheDocument();
  });

  it('says why a blocked task is blocked, with the ids as they are, and sends the real status', async () => {
    const { user, board, panel } = await openT2();

    await user.selectOptions(within(panel).getByLabelText('Status'), 'done');

    const dialog = await screen.findByRole('dialog', { name: 'Status von T2 ändern?' });
    expect(within(dialog).getByText(/T2 ist blockiert/)).toBeInTheDocument();
    expect(within(dialog).getByText('T1 ist nicht erledigt')).toBeInTheDocument();
    expect(board.tasks.find((task) => task.id === 'T2')?.status).toBe('todo');

    await user.click(within(dialog).getByRole('button', { name: 'Status ändern' }));
    await waitFor(() => expect(board.tasks.find((task) => task.id === 'T2')?.status).toBe('done'));
  });

  it('translates the form and keeps what was typed and what is sent', async () => {
    const { user, board, panel } = await openT2();

    await user.click(within(panel).getByRole('button', { name: 'Bearbeiten' }));
    const dialog = await screen.findByRole('dialog', { name: 'T2 bearbeiten' });
    for (const label of ['Titel', 'Status', 'Thema', 'Block', 'Hängt ab von', 'Labels', 'Branch']) {
      expect(within(dialog).getByLabelText(label)).toBeInTheDocument();
    }
    expect(within(dialog).getByLabelText('Labels')).toHaveValue('refactor, git');
    expect(within(dialog).getByLabelText('Beschreibung')).toHaveValue(BODY);

    await user.type(within(dialog).getByLabelText('Labels'), ', web');
    await user.click(within(dialog).getByRole('button', { name: 'Änderungen prüfen' }));
    expect(within(dialog).getByRole('heading', { name: 'Änderungen an T2 prüfen' })).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    await waitFor(() =>
      expect(board.tasks.find((task) => task.id === 'T2')?.labels).toEqual([
        'refactor',
        'git',
        'web',
      ]),
    );
  });
});
