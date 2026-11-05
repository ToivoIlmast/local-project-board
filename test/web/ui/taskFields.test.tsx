import { screen, within } from '@testing-library/react';
import { ApiError } from '../../../src/web/api/index';
import { aTask, aTopic } from '../support/fixtures';
import { renderBoard } from '../support/render';

/** The fields of a task that place it and make it wait (T91; ADR-0032 §3). */

const alpha = aTopic({
  id: 'P1',
  title: 'Alpha',
  blocks: [
    { id: 'K1', title: 'Design' },
    { id: 'K2', title: 'Build' },
  ],
});
const beta = aTopic({ id: 'P2', title: 'Beta', blocks: [{ id: 'K3', title: 'Prepare' }] });

const dialog = () => screen.getByRole('dialog');
const field = (name: string) => within(dialog()).getByLabelText(name);
const optionsOf = (name: string) =>
  within(field(name))
    .getAllByRole('option')
    .map((option) => option.textContent);

const seeded = () => ({
  topics: [alpha, beta],
  tasks: [
    aTask({ id: 'T1', title: 'Dependency', status: 'todo' }),
    aTask({
      id: 'T2',
      title: 'Placed',
      status: 'todo',
      topic: 'P1',
      block: 'K1',
      dependsOn: ['T1'],
    }),
  ],
});

async function openNew(options = seeded()) {
  const rendered = await renderBoard(options);
  await rendered.user.click(screen.getByRole('button', { name: 'New task' }));
  return rendered;
}

async function openEdit(id: string) {
  const rendered = await renderBoard(seeded());
  await rendered.user.click(screen.getByRole('button', { name: `Actions for ${id}` }));
  await rendered.user.click(screen.getByRole('button', { name: 'Edit' }));
  return rendered;
}

describe('the Topic, Block and Depends on fields of the form', () => {
  it('offers No topic and every topic, and a Block that needs a topic first', async () => {
    await openNew();

    expect(optionsOf('Topic')).toEqual(['No topic', 'P1 · Alpha', 'P2 · Beta']);
    expect(field('Topic')).toHaveValue('');
    expect(field('Block')).toBeDisabled();
    expect(optionsOf('Block')).toEqual(['No block']);
    expect(field('Depends on')).toHaveValue('');
  });

  it('keeps the Block options to the blocks of the selected Topic', async () => {
    const { user } = await openNew();

    await user.selectOptions(field('Topic'), 'P1 · Alpha');
    expect(field('Block')).toBeEnabled();
    expect(optionsOf('Block')).toEqual(['No block', 'K1 · Design', 'K2 · Build']);

    await user.selectOptions(field('Block'), 'K2 · Build');
    await user.selectOptions(field('Topic'), 'P2 · Beta');
    // The block of the other topic is not carried over.
    expect(optionsOf('Block')).toEqual(['No block', 'K3 · Prepare']);
    expect(field('Block')).toHaveValue('');

    await user.selectOptions(field('Topic'), 'No topic');
    expect(field('Block')).toBeDisabled();
  });

  it('creates a task with a Topic, a Block and dependencies', async () => {
    const { user, board } = await openNew();

    await user.type(field('Title'), 'Placed anew');
    await user.selectOptions(field('Topic'), 'P1 · Alpha');
    await user.selectOptions(field('Block'), 'K2 · Build');
    await user.type(field('Depends on'), 'T1, T2');
    await user.click(within(dialog()).getByRole('button', { name: 'Create' }));

    await screen.findByRole('complementary', { name: /^Task T3$/ });
    expect(board.tasks.find((task) => task.id === 'T3')).toMatchObject({
      topic: 'P1',
      block: 'K2',
      dependsOn: ['T1', 'T2'],
    });
  });

  it('sends none of the three when they are left empty', async () => {
    const { user, board } = await openNew();

    await user.type(field('Title'), 'Plain');
    await user.click(within(dialog()).getByRole('button', { name: 'Create' }));

    await screen.findByRole('complementary', { name: /^Task T3$/ });
    const created = board.tasks.find((task) => task.id === 'T3')!;
    expect(created).not.toHaveProperty('topic');
    expect(created).not.toHaveProperty('block');
    expect(created).not.toHaveProperty('dependsOn');
  });

  it('starts an edit with the values the task has', async () => {
    await openEdit('T2');

    expect(field('Topic')).toHaveValue('P1');
    expect(field('Block')).toHaveValue('K1');
    expect(field('Depends on')).toHaveValue('T1');
  });

  it('edits the three, and sends only what changed', async () => {
    const { user, board } = await openEdit('T2');

    await user.selectOptions(field('Block'), 'K2 · Build');
    await user.click(within(dialog()).getByRole('button', { name: 'Review changes' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }));

    await screen.findByRole('button', { name: 'Actions for T2' });
    expect(board.patches).toEqual([{ id: 'T2', patch: expect.objectContaining({ block: 'K2' }) }]);
    expect(board.patches[0]?.patch).not.toHaveProperty('topic');
    expect(board.patches[0]?.patch).not.toHaveProperty('dependsOn');
    expect(board.tasks.find((task) => task.id === 'T2')).toMatchObject({
      topic: 'P1',
      block: 'K2',
    });
  });

  it('clears the optional fields: null for each of the three', async () => {
    const { user, board } = await openEdit('T2');

    await user.selectOptions(field('Topic'), 'No topic');
    await user.clear(field('Depends on'));
    await user.click(within(dialog()).getByRole('button', { name: 'Review changes' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }));

    await screen.findByRole('button', { name: 'Actions for T2' });
    expect(board.patches).toHaveLength(1);
    expect(board.patches[0]?.patch).toMatchObject({ topic: null, block: null, dependsOn: null });
    const saved = board.tasks.find((task) => task.id === 'T2')!;
    expect(saved).not.toHaveProperty('topic');
    expect(saved).not.toHaveProperty('block');
    expect(saved).not.toHaveProperty('dependsOn');
  });

  it('clears only the Block when the Topic stays', async () => {
    const { user, board } = await openEdit('T2');

    await user.selectOptions(field('Block'), 'No block');
    await user.click(within(dialog()).getByRole('button', { name: 'Review changes' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }));

    await screen.findByRole('button', { name: 'Actions for T2' });
    expect(board.patches[0]?.patch).toMatchObject({ block: null });
    expect(board.patches[0]?.patch).not.toHaveProperty('topic');
  });
});

describe('what the board refuses in these fields', () => {
  const refusals: [string, ApiError, string, string][] = [
    [
      'INVALID_PLACEMENT for a block',
      new ApiError(422, 'INVALID_PLACEMENT', 'Block "K2" does not belong to topic "P2".', {
        topic: 'P2',
        block: 'K2',
      }),
      'Block',
      'Block "K2" does not belong to topic "P2".',
    ],
    [
      'INVALID_PLACEMENT for a topic',
      new ApiError(422, 'INVALID_PLACEMENT', 'Topic "P2" does not exist or cannot be read.', {
        topic: 'P2',
      }),
      'Topic',
      'Topic "P2" does not exist or cannot be read.',
    ],
    [
      'INVALID_DEPENDENCY',
      new ApiError(422, 'INVALID_DEPENDENCY', 'Task "T99" does not exist.', { dependsOn: 'T99' }),
      'Depends on',
      'Task "T99" does not exist.',
    ],
    [
      'DEPENDENCY_CYCLE',
      new ApiError(422, 'DEPENDENCY_CYCLE', 'T3 would be in a cycle: T3, T1.', {
        tasks: ['T3', 'T1'],
      }),
      'Depends on',
      'T3 would be in a cycle: T3, T1.',
    ],
  ];

  it.each(refusals)(
    'creating: %s is said at its field, and everything entered stays',
    async (_name, error, name, message) => {
      const { user, board } = await openNew();
      board.fail('createTask', error);

      await user.type(field('Title'), 'Doomed');
      await user.selectOptions(field('Topic'), 'P1 · Alpha');
      await user.selectOptions(field('Block'), 'K2 · Build');
      await user.type(field('Depends on'), 'T1');
      await user.click(within(dialog()).getByRole('button', { name: 'Create' }));

      expect(await within(dialog()).findByText(message)).toBeVisible();
      expect(field(name)).toHaveAccessibleDescription(expect.stringContaining(message));
      expect(field(name)).toBeInvalid();
      // The other fields are not accused.
      for (const other of ['Topic', 'Block', 'Depends on'].filter((label) => label !== name)) {
        expect(field(other)).toBeValid();
      }
      expect(field('Title')).toHaveValue('Doomed');
      expect(field('Topic')).toHaveValue('P1');
      expect(field('Block')).toHaveValue('K2');
      expect(field('Depends on')).toHaveValue('T1');
    },
  );

  it.each(refusals)(
    'editing: %s sends the person back to the form with the error at its field and their values',
    async (_name, error, name, message) => {
      const { user, board } = await openEdit('T2');
      board.fail('updateTask', error);

      await user.clear(field('Depends on'));
      await user.type(field('Depends on'), 'T1, T99');
      await user.selectOptions(field('Block'), 'K2 · Build');
      await user.click(within(dialog()).getByRole('button', { name: 'Review changes' }));
      await user.click(within(dialog()).getByRole('button', { name: 'Save' }));

      expect(await within(dialog()).findByText(message)).toBeVisible();
      expect(field(name)).toBeInvalid();
      expect(field('Depends on')).toHaveValue('T1, T99');
      expect(field('Block')).toHaveValue('K2');
      expect(within(dialog()).getByRole('button', { name: 'Review changes' })).toBeVisible();
    },
  );

  it('forgets the error at a field once the person changes that field', async () => {
    const { user, board } = await openNew();
    board.fail(
      'createTask',
      new ApiError(422, 'INVALID_DEPENDENCY', 'Task "T99" does not exist.', { dependsOn: 'T99' }),
    );
    await user.type(field('Title'), 'Doomed');
    await user.type(field('Depends on'), 'T99');
    await user.click(within(dialog()).getByRole('button', { name: 'Create' }));
    await within(dialog()).findByText('Task "T99" does not exist.');

    await user.type(field('Depends on'), '{Backspace}{Backspace}{Backspace}T1');

    expect(within(dialog()).queryByText('Task "T99" does not exist.')).not.toBeInTheDocument();
    expect(field('Depends on')).toBeValid();
  });
});
