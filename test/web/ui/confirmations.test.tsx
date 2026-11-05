import { act, screen, waitFor, within } from '@testing-library/react';
import { jest } from '@jest/globals';
import { aTask, aTopic } from '../support/fixtures';
import { cardsIn, renderBoard, type RenderedBoard } from '../support/render';

/**
 * What the owner is asked before a manual change (T91; ADR-0032 §8): a status change of a
 * blocked task, and a move between topics or blocks. Cancel writes nothing; Confirm writes once.
 * Reordering inside a column is neither, and asks nothing.
 */

const alpha = aTopic({
  id: 'P1',
  title: 'Alpha',
  blocks: [
    { id: 'K1', title: 'Design' },
    { id: 'K2', title: 'Build' },
  ],
});
const beta = aTopic({
  id: 'P2',
  title: 'Beta',
  blocks: [
    { id: 'K3', title: 'Prepare' },
    { id: 'K4', title: 'Ship' },
  ],
});

const seeded = () => ({
  topics: [alpha, beta],
  tasks: [
    aTask({ id: 'T1', title: 'First', status: 'todo', rank: 'a0', topic: 'P1', block: 'K1' }),
    // Held by K1: one reason.
    aTask({ id: 'T2', title: 'Held', status: 'todo', rank: 'a1', topic: 'P1', block: 'K2' }),
    aTask({ id: 'T3', title: 'Free', status: 'todo', rank: 'a2' }),
    // A task of a topic's last block, held by the empty K3.
    aTask({ id: 'T4', title: 'Far', status: 'todo', rank: 'a3', topic: 'P2', block: 'K4' }),
  ],
});

const HELD = 'block K1 is not done: T1';
const dialog = () => screen.getByRole('dialog');
const writes = (rendered: RenderedBoard) =>
  rendered.board.calls.filter((call) => call === 'moveTask' || call === 'updateTask');

async function chooseMoveTo(rendered: RenderedBoard, id: string, status: string) {
  await rendered.user.click(screen.getByRole('button', { name: `Actions for ${id}` }));
  await rendered.user.click(screen.getByRole('button', { name: `Move to ${status}` }));
}

describe('a status change of a blocked task, from the menu of a card', () => {
  it('asks first, with the old and the new status and the reasons', async () => {
    const rendered = await renderBoard(seeded());

    await chooseMoveTo(rendered, 'T2', 'done');

    expect(await screen.findByRole('dialog')).toBeVisible();
    expect(dialog()).toHaveTextContent('T2');
    expect(dialog()).toHaveTextContent('todo');
    expect(dialog()).toHaveTextContent('done');
    expect(within(dialog()).getByText(HELD)).toBeVisible();
    expect(writes(rendered)).toEqual([]);
  });

  it('writes nothing and changes nothing when cancelled', async () => {
    const rendered = await renderBoard(seeded());
    await chooseMoveTo(rendered, 'T2', 'done');

    await rendered.user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(writes(rendered)).toEqual([]);
    expect(cardsIn('todo')).toContain('T2');
    expect(cardsIn('done')).toEqual([]);
    expect(rendered.board.tasks.find((task) => task.id === 'T2')?.status).toBe('todo');
  });

  it('writes exactly once when confirmed, and shows what the board answered', async () => {
    const rendered = await renderBoard(seeded());
    await chooseMoveTo(rendered, 'T2', 'done');

    await rendered.user.click(within(dialog()).getByRole('button', { name: 'Change status' }));

    await waitFor(() => expect(cardsIn('done')).toEqual(['T2']));
    expect(writes(rendered)).toEqual(['moveTask']);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not move the card before the board has answered: no optimistic update', async () => {
    const rendered = await renderBoard(seeded());
    const release = rendered.board.hold('moveTask');
    await chooseMoveTo(rendered, 'T2', 'done');

    await rendered.user.click(within(dialog()).getByRole('button', { name: 'Change status' }));

    expect(cardsIn('todo')).toContain('T2');
    expect(cardsIn('done')).toEqual([]);
    release();
    await waitFor(() => expect(cardsIn('done')).toEqual(['T2']));
  });

  it('asks nothing for a task that is not blocked', async () => {
    const rendered = await renderBoard(seeded());

    await chooseMoveTo(rendered, 'T3', 'done');

    await waitFor(() => expect(cardsIn('done')).toEqual(['T3']));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(writes(rendered)).toEqual(['moveTask']);
  });

  it('asks nothing for a reorder: the task keeps its status', async () => {
    const rendered = await renderBoard(seeded());
    await rendered.user.click(screen.getByRole('button', { name: 'Actions for T2' }));

    await rendered.user.click(screen.getByRole('button', { name: 'Move down' }));

    await waitFor(() => expect(cardsIn('todo')).toEqual(['T1', 'T3', 'T2', 'T4']));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(writes(rendered)).toEqual(['moveTask']);
  });
});

describe('a status change of a blocked task, from the keyboard', () => {
  it('asks the same, Escape cancels without a write and gives the focus back', async () => {
    const rendered = await renderBoard(seeded());
    await rendered.user.click(screen.getByRole('button', { name: 'Actions for T2' }));
    screen.getByRole('button', { name: 'Move to done' }).focus();

    await rendered.user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog')).toHaveTextContent(HELD);
    await rendered.user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(writes(rendered)).toEqual([]);
    expect(screen.getByRole('button', { name: 'Actions for T2' })).toHaveFocus();
  });

  it('confirms with Enter on the button, writes once and follows the card', async () => {
    const rendered = await renderBoard(seeded());
    await rendered.user.click(screen.getByRole('button', { name: 'Actions for T2' }));
    screen.getByRole('button', { name: 'Move to done' }).focus();
    await rendered.user.keyboard('{Enter}');
    await screen.findByRole('dialog');

    within(dialog()).getByRole('button', { name: 'Change status' }).focus();
    await rendered.user.keyboard('{Enter}');

    await waitFor(() => expect(cardsIn('done')).toEqual(['T2']));
    expect(writes(rendered)).toEqual(['moveTask']);
    await waitFor(() =>
      expect(document.querySelector('[data-task-id="T2"] .card__title')).toHaveFocus(),
    );
  });

  it('asks the same of the status select of the task’s panel', async () => {
    const rendered = await renderBoard(seeded());
    await rendered.user.click(screen.getByRole('button', { name: 'Held' }));
    const panel = await screen.findByRole('complementary', { name: 'Task T2' });

    await rendered.user.selectOptions(within(panel).getByLabelText('Status'), 'in-progress');

    expect(await screen.findByRole('dialog')).toHaveTextContent(HELD);
    expect(writes(rendered)).toEqual([]);
    expect(within(panel).getByLabelText('Status')).toHaveValue('todo');

    await rendered.user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(writes(rendered)).toEqual([]);

    await rendered.user.selectOptions(within(panel).getByLabelText('Status'), 'in-progress');
    await rendered.user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Change status' }),
    );
    await waitFor(() => expect(cardsIn('in-progress')).toEqual(['T2']));
    expect(writes(rendered)).toEqual(['updateTask']);
  });
});

describe('a status change of a blocked task, by dragging', () => {
  const COLUMN_WIDTH = 100;

  /** jsdom has no layout: columns side by side, cards of one height stacked in them. */
  function layOut(statuses: string[]) {
    return jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const status = this.dataset['status'];
      if (status !== undefined) {
        const left = statuses.indexOf(status) * COLUMN_WIDTH;
        return rect(left, 0, COLUMN_WIDTH - 10, 1000);
      }
      if (this.dataset['taskId'] !== undefined) {
        const siblings = Array.from(this.parentElement?.querySelectorAll('[data-task-id]') ?? []);
        return rect(0, siblings.indexOf(this) * 50, COLUMN_WIDTH - 10, 40);
      }
      return rect(0, 0, 0, 0);
    });
  }

  const rect = (left: number, top: number, width: number, height: number): DOMRect =>
    ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;

  function drag(id: string, x: number, y: number): void {
    const card = document.querySelector(`[data-task-id="${id}"]`) as HTMLElement;
    act(() => {
      card.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 5, clientY: 5 }),
      );
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup', { clientX: x, clientY: y }));
    });
  }

  afterEach(() => jest.restoreAllMocks());

  it('asks before a blocked card is dropped in another column, and cancel writes nothing', async () => {
    const rendered = await renderBoard(seeded());
    layOut(['backlog', 'todo', 'in-progress', 'done']);

    drag('T2', 3 * COLUMN_WIDTH + 10, 20);

    expect(await screen.findByRole('dialog')).toHaveTextContent(HELD);
    expect(writes(rendered)).toEqual([]);
    expect(cardsIn('done')).toEqual([]);
    await rendered.user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(writes(rendered)).toEqual([]);
    expect(cardsIn('todo')).toContain('T2');
  });

  it('writes once, to the column it was dropped in, when confirmed', async () => {
    const rendered = await renderBoard(seeded());
    layOut(['backlog', 'todo', 'in-progress', 'done']);

    drag('T2', 3 * COLUMN_WIDTH + 10, 20);
    await rendered.user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Change status' }),
    );

    await waitFor(() => expect(cardsIn('done')).toEqual(['T2']));
    expect(writes(rendered)).toEqual(['moveTask']);
  });

  it('asks nothing for a blocked card dropped in its own column: a reorder', async () => {
    const rendered = await renderBoard(seeded());
    layOut(['backlog', 'todo', 'in-progress', 'done']);

    // Below every card of todo.
    drag('T2', COLUMN_WIDTH + 10, 400);

    await waitFor(() => expect(cardsIn('todo')).toEqual(['T1', 'T3', 'T4', 'T2']));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(writes(rendered)).toEqual(['moveTask']);
  });

  it('asks nothing for a card that is not blocked', async () => {
    const rendered = await renderBoard(seeded());
    layOut(['backlog', 'todo', 'in-progress', 'done']);

    drag('T3', 3 * COLUMN_WIDTH + 10, 20);

    await waitFor(() => expect(cardsIn('done')).toEqual(['T3']));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(writes(rendered)).toEqual(['moveTask']);
  });
});

describe('a status change of a blocked task, in the form', () => {
  async function editStatus(rendered: RenderedBoard, status: string) {
    await rendered.user.click(screen.getByRole('button', { name: 'Actions for T2' }));
    await rendered.user.click(screen.getByRole('button', { name: 'Edit' }));
    await rendered.user.selectOptions(within(dialog()).getByLabelText('Status'), status);
    await rendered.user.click(within(dialog()).getByRole('button', { name: 'Review changes' }));
  }

  it('shows the reasons in the review, where the change is confirmed', async () => {
    const rendered = await renderBoard(seeded());

    await editStatus(rendered, 'done');

    expect(within(dialog()).getByText(HELD)).toBeVisible();
    expect(writes(rendered)).toEqual([]);
  });

  it('writes once on Save and nothing on Cancel', async () => {
    const rendered = await renderBoard(seeded());
    await editStatus(rendered, 'done');
    await rendered.user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(writes(rendered)).toEqual([]);

    await editStatus(rendered, 'done');
    await rendered.user.click(within(dialog()).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(cardsIn('done')).toEqual(['T2']));
    expect(writes(rendered)).toEqual(['updateTask']);
  });

  it('shows no reasons for a task that is not blocked', async () => {
    const rendered = await renderBoard(seeded());
    await rendered.user.click(screen.getByRole('button', { name: 'Actions for T3' }));
    await rendered.user.click(screen.getByRole('button', { name: 'Edit' }));
    await rendered.user.selectOptions(within(dialog()).getByLabelText('Status'), 'done');
    await rendered.user.click(within(dialog()).getByRole('button', { name: 'Review changes' }));

    expect(within(dialog()).queryByText(/is blocked/)).not.toBeInTheDocument();
  });
});

describe('a move between topics or blocks', () => {
  async function editPlace(
    rendered: RenderedBoard,
    id: string,
    place: { topic?: string; block?: string },
  ) {
    await rendered.user.click(screen.getByRole('button', { name: `Actions for ${id}` }));
    await rendered.user.click(screen.getByRole('button', { name: 'Edit' }));
    if (place.topic !== undefined) {
      await rendered.user.selectOptions(within(dialog()).getByLabelText('Topic'), place.topic);
    }
    if (place.block !== undefined) {
      await rendered.user.selectOptions(within(dialog()).getByLabelText('Block'), place.block);
    }
    await rendered.user.click(within(dialog()).getByRole('button', { name: 'Review changes' }));
  }

  const move = () => within(dialog()).getByRole('region', { name: 'Move' });

  it('Topic to Topic: shows the old place, the new place, readiness and the order of blocks', async () => {
    const rendered = await renderBoard(seeded());

    await editPlace(rendered, 'T2', { topic: 'P2 · Beta', block: 'K3 · Prepare' });

    expect(move()).toHaveTextContent('P1 · Alpha / K2 · Build');
    expect(move()).toHaveTextContent('P2 · Beta / K3 · Prepare');
    expect(move()).toHaveTextContent(`Readiness now: blocked — ${HELD}`);
    expect(move()).toHaveTextContent('Readiness after: ready');
    // K2 loses its only task; K3 gains its first, and K4 behind it was held by the empty K3.
    expect(move()).toHaveTextContent(/K2 .*empty/);
    expect(move()).toHaveTextContent(/K3/);
    expect(writes(rendered)).toEqual([]);
  });

  it('Block to Block: shows both blocks and what changes for readiness', async () => {
    const rendered = await renderBoard(seeded());

    await editPlace(rendered, 'T2', { block: 'K1 · Design' });

    expect(move()).toHaveTextContent('P1 · Alpha / K2 · Build');
    expect(move()).toHaveTextContent('P1 · Alpha / K1 · Design');
    expect(move()).toHaveTextContent('Readiness after: ready');
    expect(move()).toHaveTextContent(/outside|first block|waits for no block/i);
  });

  it('cancel performs no write and changes nothing', async () => {
    const rendered = await renderBoard(seeded());
    await editPlace(rendered, 'T2', { block: 'K1 · Design' });

    await rendered.user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(writes(rendered)).toEqual([]);
    expect(rendered.board.tasks.find((task) => task.id === 'T2')).toMatchObject({
      topic: 'P1',
      block: 'K2',
    });
  });

  it('confirm performs exactly one update, with the new place, and shows the board’s answer', async () => {
    const rendered = await renderBoard(seeded());
    await editPlace(rendered, 'T2', { topic: 'P2 · Beta', block: 'K3 · Prepare' });

    await rendered.user.click(within(dialog()).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(writes(rendered)).toEqual(['updateTask']);
    expect(rendered.board.patches).toEqual([
      { id: 'T2', patch: expect.objectContaining({ topic: 'P2', block: 'K3' }) },
    ]);
    expect(rendered.board.tasks.find((task) => task.id === 'T2')).toMatchObject({
      topic: 'P2',
      block: 'K3',
    });
  });

  it('does not move before the board has answered: no optimistic update', async () => {
    const rendered = await renderBoard(seeded());
    const release = rendered.board.hold('updateTask');
    await editPlace(rendered, 'T2', { block: 'K1 · Design' });

    await rendered.user.click(within(dialog()).getByRole('button', { name: 'Save' }));

    expect(rendered.board.tasks.find((task) => task.id === 'T2')?.block).toBe('K2');
    release();
    await waitFor(() =>
      expect(rendered.board.tasks.find((task) => task.id === 'T2')?.block).toBe('K1'),
    );
  });

  it('asks nothing about a move when only the title, the status or the dependencies change', async () => {
    const rendered = await renderBoard(seeded());
    await rendered.user.click(screen.getByRole('button', { name: 'Actions for T3' }));
    await rendered.user.click(screen.getByRole('button', { name: 'Edit' }));
    await rendered.user.type(within(dialog()).getByLabelText('Depends on'), 'T1');
    await rendered.user.click(within(dialog()).getByRole('button', { name: 'Review changes' }));

    expect(within(dialog()).queryByRole('region', { name: 'Move' })).not.toBeInTheDocument();
  });

  it('asks nothing about a move for a task that stays where it is', async () => {
    const rendered = await renderBoard(seeded());
    await rendered.user.click(screen.getByRole('button', { name: 'Actions for T2' }));
    await rendered.user.click(screen.getByRole('button', { name: 'Edit' }));
    await rendered.user.type(within(dialog()).getByLabelText('Title'), ' again');
    await rendered.user.click(within(dialog()).getByRole('button', { name: 'Review changes' }));

    expect(within(dialog()).queryByRole('region', { name: 'Move' })).not.toBeInTheDocument();
  });
});
