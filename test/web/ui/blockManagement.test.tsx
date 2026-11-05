import { act, screen, waitFor, within } from '@testing-library/react';
import { aTask, aTopic } from '../support/fixtures';
import { renderBoard } from '../support/render';

/** Renaming, adding, moving and deleting the blocks of a topic from the Blocks View (T92). */

const alpha = aTopic({
  id: 'P1',
  title: 'Alpha',
  blocks: [
    { id: 'K1', title: 'Design' },
    { id: 'K2', title: 'Build' },
    { id: 'K3', title: 'Review' },
    { id: 'K4', title: 'Release' },
  ],
});
const tasks = () => [
  aTask({ id: 'T1', title: 'Sketch', status: 'done', topic: 'P1', block: 'K1' }),
  aTask({ id: 'T2', title: 'Spec', status: 'todo', topic: 'P1', block: 'K2' }),
];

async function open() {
  window.history.replaceState({}, '', '/?view=blocks');
  const rendered = await renderBoard({ topics: [structuredClone(alpha)], tasks: tasks() });
  await screen.findByRole('region', { name: 'Blocks' });
  return rendered;
}

const trigger = (id: string) => screen.getByRole('button', { name: `Block ${id} actions` });
const order = () =>
  within(screen.getByRole('region', { name: 'P1 · Alpha' }))
    .getAllByRole('heading', { level: 4 })
    .map((heading) => heading.textContent);
const mutations = (calls: string[]) =>
  calls.filter((call) => /^(create|update|reorder|delete)Blocks?$/.test(call));

describe('the menu of a block', () => {
  it('has a trigger with its own name on every block', async () => {
    await open();

    const names = screen
      .getAllByRole('button', { name: /^Block K\d+ actions$/ })
      .map((button) => button.getAttribute('aria-label'));
    expect(names).toEqual([
      'Block K1 actions',
      'Block K2 actions',
      'Block K3 actions',
      'Block K4 actions',
    ]);
  });

  it('offers exactly Rename, Add block, Move to position and Delete', async () => {
    const { user } = await open();

    await user.click(trigger('K2'));

    expect(
      within(document.querySelector('.menu__list') as HTMLElement)
        .getAllByRole('button')
        .map((item) => item.textContent),
    ).toEqual(['Rename', 'Add block', 'Move to position', 'Delete']);
  });

  it('opens with the keyboard and gives the focus back to its button on Escape', async () => {
    const { user } = await open();

    trigger('K2').focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Rename' })).toBeVisible();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull();
    expect(trigger('K2')).toHaveFocus();
  });
});

describe('Rename', () => {
  it('changes the title with one call and keeps the id and the place', async () => {
    const { user, board } = await open();

    await user.click(trigger('K2'));
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    const title = within(screen.getByRole('dialog')).getByLabelText('Title');
    expect(title).toHaveValue('Build');
    await user.clear(title);
    await user.type(title, 'Make');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mutations(board.calls)).toEqual(['updateBlock']);
    expect(order()).toEqual(['K1 · Design', 'K2 · Make', 'K3 · Review', 'K4 · Release']);
    expect(trigger('K2')).toHaveFocus();
  });
});

describe('Add block', () => {
  it('adds a block at the end of its topic with one createBlock and no reorder', async () => {
    const { user, board } = await open();

    await user.click(trigger('K1'));
    await user.click(screen.getByRole('button', { name: 'Add block' }));
    await user.type(within(screen.getByRole('dialog')).getByLabelText('Title'), 'Ship');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mutations(board.calls)).toEqual(['createBlock']);
    expect(order()).toEqual([
      'K1 · Design',
      'K2 · Build',
      'K3 · Review',
      'K4 · Release',
      'K5 · Ship',
    ]);
    expect(trigger('K1')).toHaveFocus();
  });

  it('does not add a block with a blank title', async () => {
    const { user, board } = await open();

    await user.click(trigger('K1'));
    await user.click(screen.getByRole('button', { name: 'Add block' }));

    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(mutations(board.calls)).toEqual([]);
  });
});

describe('Move to position', () => {
  it('moves the block with one reorder request and shows the order the board returned', async () => {
    const { user, board } = await open();

    await user.click(trigger('K1'));
    await user.click(screen.getByRole('button', { name: 'Move to position' }));
    const position = within(screen.getByRole('dialog')).getByLabelText('Position');
    expect(position).toHaveValue('1');
    await user.selectOptions(position, '3');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Move' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mutations(board.calls)).toEqual(['reorderBlocks']);
    expect(board.topics[0]?.blocks.map((b) => b.id)).toEqual(['K2', 'K3', 'K1', 'K4']);
    expect(order()).toEqual(['K2 · Build', 'K3 · Review', 'K1 · Design', 'K4 · Release']);
    expect(trigger('K1')).toHaveFocus();
  });

  it('does not send a request for the place the block is already in', async () => {
    const { user, board } = await open();

    await user.click(trigger('K2'));
    await user.click(screen.getByRole('button', { name: 'Move to position' }));

    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Move' })).toBeDisabled();
    expect(mutations(board.calls)).toEqual([]);
  });
});

describe('Delete', () => {
  it('asks first, and deletes an empty block once it is confirmed', async () => {
    const { user, board } = await open();

    await user.click(trigger('K4'));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete K4?' });
    expect(mutations(board.calls)).toEqual([]);

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(mutations(board.calls)).toEqual([]);
    expect(trigger('K4')).toHaveFocus();

    await user.click(trigger('K4'));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Delete$/ }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mutations(board.calls)).toEqual(['deleteBlock']);
    expect(order()).toEqual(['K1 · Design', 'K2 · Build', 'K3 · Review']);
    // The block with the button is gone: the focus is somewhere on the page, not lost.
    expect(document.body).not.toHaveFocus();
  });

  it('surfaces BLOCK_NOT_EMPTY for a block that holds a task, and leaves the block', async () => {
    const { user } = await open();

    await user.click(trigger('K1'));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Delete$/ }));

    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent(
      /not empty/,
    );
    expect(order()).toContain('K1 · Design');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger('K1')).toHaveFocus();
  });
});

describe('a change made elsewhere', () => {
  it('is shown when the board announces topic.updated', async () => {
    const { board } = await open();

    act(() =>
      board.emit({
        type: 'topic.updated',
        topic: {
          ...alpha,
          blocks: [
            { id: 'K3', title: 'Review' },
            { id: 'K1', title: 'Sketching' },
          ],
        },
      }),
    );

    await waitFor(() =>
      expect(order()).toEqual(['K3 · Review', 'K1 · Sketching', 'Not in a block']),
    );
  });
});
