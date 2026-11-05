import { screen, waitFor, within } from '@testing-library/react';
import { aTask, aTopic } from '../support/fixtures';
import { renderBoard } from '../support/render';

/** The Blocks View: every topic, its blocks in their order, and the tasks in them (T91). */

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
const beta = aTopic({ id: 'P2', title: 'Beta', blocks: [{ id: 'K5', title: 'Lonely' }] });

const at = (block: string, topic = 'P1') => ({ topic, block });

const makeTasks = () => [
  aTask({ id: 'T1', title: 'Sketch', status: 'done', ...at('K1') }),
  aTask({ id: 'T2', title: 'Spec', status: 'done', ...at('K1') }),
  // Ready: the block before it is done, both dependencies are.
  aTask({ id: 'T3', title: 'Implement', status: 'todo', dependsOn: ['T1', 'T2'], ...at('K2') }),
  aTask({ id: 'T4', title: 'Prototype', status: 'done', ...at('K2') }),
  // Held by K2 and by T3: two reasons, of which one is shown.
  aTask({ id: 'T5', title: 'Inspect', status: 'todo', dependsOn: ['T3', 'T4'], ...at('K3') }),
  aTask({
    id: 'T6',
    title: 'Pairing',
    status: 'todo',
    aiRun: { agent: 'claude-code', state: 'working', runId: 1 },
    ...at('K2'),
  }),
  aTask({ id: 'T7', title: 'Unplaced in P1', status: 'todo', topic: 'P1' }),
  aTask({ id: 'T8', title: 'No topic at all', status: 'todo' }),
];

const seeded = () => ({ topics: [alpha, beta], tasks: makeTasks() });

const search = () => new URLSearchParams(window.location.search);

async function openAt(url: string, options = seeded()) {
  window.history.replaceState({}, '', url);
  return renderBoard(options);
}

async function openBlocks(url = '/?view=blocks', options = seeded()) {
  const rendered = await openAt(url, options);
  await screen.findByRole('region', { name: 'Blocks' });
  return rendered;
}

const stack = () => screen.getByRole('region', { name: 'Blocks' });
const block = (name: string) => within(stack()).getByRole('region', { name });
const row = (id: string) => stack().querySelector(`[data-task-id="${id}"]`) as HTMLElement;
const taskIds = () =>
  Array.from(stack().querySelectorAll('[data-task-id]')).map((el) =>
    el.getAttribute('data-task-id'),
  );

const STATES = ['completed', 'waiting for previous Block', 'empty'];
const statesIn = (region: HTMLElement) =>
  STATES.filter((state) => within(region).queryByText(state) !== null);

describe('the Blocks View is a view of the main area', () => {
  it('replaces the columns of the board and is not a panel beside it', async () => {
    await openBlocks();

    expect(within(screen.getByRole('main')).getByRole('region', { name: 'Blocks' })).toBeVisible();
    expect(screen.queryByRole('region', { name: /^todo \(/ })).toBeNull();
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('shows the normal board when there is no view, or one the board does not know', async () => {
    await openAt('/?view=banana');

    expect(screen.queryByRole('region', { name: 'Blocks' })).toBeNull();
    expect(screen.getByRole('region', { name: /^todo \(/ })).toBeVisible();
    const switcher = screen.getByRole('navigation', { name: 'View' });
    expect(within(switcher).getByRole('button', { name: 'Board' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('has a Board / Blocks switch whose active side says so with aria-current', async () => {
    const { user } = await openAt('/');
    const switcher = screen.getByRole('navigation', { name: 'View' });
    const board = within(switcher).getByRole('button', { name: 'Board' });
    const blocks = within(switcher).getByRole('button', { name: 'Blocks' });
    expect(board).toHaveAttribute('aria-current', 'page');
    expect(blocks).not.toHaveAttribute('aria-current');

    await user.click(blocks);

    expect(await screen.findByRole('region', { name: 'Blocks' })).toBeVisible();
    expect(blocks).toHaveAttribute('aria-current', 'page');
    expect(board).not.toHaveAttribute('aria-current');
    expect(search().get('view')).toBe('blocks');

    await user.click(board);

    expect(screen.queryByRole('region', { name: 'Blocks' })).toBeNull();
    expect(search().has('view')).toBe(false);
  });

  it('keeps the topic and the panel when the view is switched, both ways', async () => {
    const { user } = await openAt('/?topic=P2&panel=git');
    const switcher = screen.getByRole('navigation', { name: 'View' });

    await user.click(within(switcher).getByRole('button', { name: 'Blocks' }));
    expect(search().get('view')).toBe('blocks');
    expect(search().get('topic')).toBe('P2');
    expect(search().get('panel')).toBe('git');

    await user.click(within(switcher).getByRole('button', { name: 'Board' }));
    expect(search().get('topic')).toBe('P2');
    expect(search().get('panel')).toBe('git');
    expect(search().has('view')).toBe(false);
  });

  it('survives a reload', async () => {
    const first = await openBlocks('/?view=blocks&topic=P1');
    first.unmount();

    await renderBoard(seeded());

    expect(await screen.findByRole('region', { name: 'Blocks' })).toBeVisible();
    expect(search().get('view')).toBe('blocks');
  });

  it('shows Blocks in the main area and a panel beside it, independently', async () => {
    await openBlocks('/?view=blocks&panel=git');

    expect(screen.getByRole('region', { name: 'Blocks' })).toBeVisible();
    expect(await screen.findByRole('complementary', { name: 'Git' })).toBeVisible();
  });

  it('opens the task of the address beside the Blocks', async () => {
    await openBlocks('/?view=blocks&task=T1');

    expect(await screen.findByRole('complementary', { name: 'Task T1' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Blocks' })).toBeVisible();
  });

  it('turns the old panel address into the view, without leaving the panel open', async () => {
    await openBlocks('/?panel=blocks');

    expect(await screen.findByRole('region', { name: 'Blocks' })).toBeVisible();
    await waitFor(() => expect(search().get('view')).toBe('blocks'));
    expect(search().has('panel')).toBe(false);
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('has one way to open Blocks: no Blocks button among the panels', async () => {
    await openAt('/');

    expect(screen.getAllByRole('button', { name: 'Blocks' })).toHaveLength(1);
    expect(
      within(document.querySelector('.header__actions') as HTMLElement).queryByRole('button', {
        name: 'Blocks',
      }),
    ).toBeNull();
  });

  it('opens a task from a row, which closes the panel as everywhere else', async () => {
    const { user } = await openBlocks('/?view=blocks&panel=git');
    await screen.findByRole('complementary', { name: 'Git' });

    await user.click(within(row('T5')).getByRole('button', { name: 'Inspect' }));

    expect(await screen.findByRole('complementary', { name: 'Task T5' })).toBeVisible();
    expect(search().has('panel')).toBe(false);
    expect(search().get('task')).toBe('T5');
    expect(search().get('view')).toBe('blocks');
  });
});

describe('the stack of topics, blocks and tasks', () => {
  it('lists each topic with its blocks in the order of the topic', async () => {
    await openBlocks();

    const topic = within(stack()).getByRole('region', { name: 'P1 · Alpha' });
    const blocks = within(topic)
      .getAllByRole('region')
      .map((region) => region.getAttribute('aria-label'));
    expect(blocks).toEqual([
      'K1 · Design',
      'K2 · Build',
      'K3 · Review',
      'K4 · Release',
      'Not in a block',
    ]);
  });

  it('lists the topics in the order the board has them, the global section last', async () => {
    await openBlocks();

    const names = within(stack())
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent);
    expect(names).toEqual(['P1 · Alpha', 'P2 · Beta', 'No block']);
  });

  it('puts a task of a topic that has no block in its topic, not in the global section', async () => {
    await openBlocks();

    expect(within(block('Not in a block')).getByText('Unplaced in P1')).toBeVisible();
    expect(within(block('No block')).queryByText('Unplaced in P1')).toBeNull();
  });

  it('puts in the global section the tasks that have neither a topic nor a block, only', async () => {
    await openBlocks();

    const global = block('No block');
    expect(within(global).getByText('No topic at all')).toBeVisible();
    expect(
      Array.from(global.querySelectorAll('[data-task-id]')).map((el) =>
        el.getAttribute('data-task-id'),
      ),
    ).toEqual(['T8']);
  });

  it('shows no task twice', async () => {
    await openBlocks();

    const ids = taskIds();
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']);
  });

  it('shows one topic and nothing else for ?topic=', async () => {
    await openBlocks('/?view=blocks&topic=P2');

    expect(within(stack()).getByRole('region', { name: 'P2 · Beta' })).toBeVisible();
    expect(within(stack()).queryByRole('region', { name: 'P1 · Alpha' })).toBeNull();
    expect(within(stack()).queryByRole('region', { name: 'No block' })).toBeNull();
  });

  it('shows only the global section for ?topic=none', async () => {
    await openBlocks('/?view=blocks&topic=none');

    expect(taskIds()).toEqual(['T8']);
    expect(within(stack()).queryByRole('region', { name: 'P1 · Alpha' })).toBeNull();
    expect(within(stack()).queryByRole('region', { name: 'P2 · Beta' })).toBeNull();
  });

  it('says so when the board has no topics, and still shows the tasks without one', async () => {
    await openBlocks('/?view=blocks', { tasks: makeTasks(), topics: [] });

    expect(await within(stack()).findByText('No topics')).toBeVisible();
    expect(within(block('No block')).getByText('No topic at all')).toBeVisible();
  });
});

describe('Blocks View offers no way of ordering that is not a form', () => {
  it('has nothing to drag, no drag roles and no arrows to move blocks with', async () => {
    const { user } = await openBlocks();
    await user.click(screen.getByRole('button', { name: 'Block K2 actions' }));
    await user.click(screen.getByRole('button', { name: 'Move to position' }));

    const root = screen.getByRole('main');
    expect(root.querySelectorAll('[draggable="true"], [draggable=""]')).toHaveLength(0);
    expect(document.querySelectorAll('[aria-grabbed], [aria-dropeffect]')).toHaveLength(0);
    expect(document.querySelectorAll('[aria-roledescription*="sortable" i]')).toHaveLength(0);
    expect(document.querySelectorAll('[aria-roledescription*="draggable" i]')).toHaveLength(0);
    const controls = [...document.querySelectorAll('button, [role="button"]')];
    for (const control of controls) {
      const name = `${control.getAttribute('aria-label') ?? ''} ${control.textContent ?? ''}`;
      expect(name).not.toMatch(/move (up|down|left|right)/i);
      expect(name).not.toMatch(/[↑↓←→⬆⬇⬅➡▲▼⇧⇩]/u);
    }
  });
});

describe('the header of a block', () => {
  it('shows done/total and completed for a block whose tasks are all done', async () => {
    await openBlocks();

    const header = block('K1 · Design');
    expect(within(header).getByText('2/2')).toBeVisible();
    expect(statesIn(header)).toEqual(['completed']);
  });

  it('shows waiting for previous Block for a block held by an earlier one', async () => {
    await openBlocks();

    const header = block('K3 · Review');
    expect(within(header).getByText('0/1')).toBeVisible();
    expect(statesIn(header)).toEqual(['waiting for previous Block']);
  });

  it('shows 0/0 and empty for a block with no tasks, though an earlier block also holds it', async () => {
    await openBlocks();

    const header = block('K4 · Release');
    expect(within(header).getByText('0/0')).toBeVisible();
    expect(statesIn(header)).toEqual(['empty']);
  });

  it('shows done/total and no state for a block that is under way and held by nothing', async () => {
    await openBlocks();

    const header = block('K2 · Build');
    expect(within(header).getByText('1/3')).toBeVisible();
    expect(statesIn(header)).toEqual([]);
  });

  it('shows exactly one state in every block that has one', async () => {
    await openBlocks();

    for (const name of ['K1 · Design', 'K3 · Review', 'K4 · Release', 'K5 · Lonely']) {
      expect(statesIn(block(name)).length).toBeLessThanOrEqual(1);
    }
    expect(statesIn(block('K5 · Lonely'))).toEqual(['empty']);
  });
});

describe('the row of a task', () => {
  it('marks a done task ✓ and nothing else', async () => {
    await openBlocks();

    const done = within(row('T1'));
    expect(done.getByTitle('Done')).toHaveTextContent('✓');
    expect(done.queryByTitle(/^Blocked/)).toBeNull();
    expect(done.queryByTitle('Ready to start')).toBeNull();
  });

  it('marks a task that may start ▷', async () => {
    await openBlocks();

    expect(within(row('T3')).getByTitle('Ready to start')).toHaveTextContent('▷');
  });

  it('marks a blocked task 🔒 with its reasons as the tooltip', async () => {
    await openBlocks();

    const lock = within(row('T5')).getByTitle(/^Blocked/);
    expect(lock).toHaveTextContent('🔒');
    expect(lock.getAttribute('title')).toContain('block K2 is not done: T3');
    expect(lock.getAttribute('title')).toContain('T3 is not done');
  });

  it('marks a task whose run is working ●', async () => {
    await openBlocks();

    expect(within(row('T6')).getByTitle('An AI run is working')).toHaveTextContent('●');
  });

  it('shows one short reason: the first the board gave', async () => {
    await openBlocks();

    const held = within(row('T5'));
    expect(held.getByText('block K2 is not done: T3, T6')).toBeVisible();
    expect(held.queryByText('T3 is not done')).toBeNull();
    // Nothing to say of a task that may start.
    expect(within(row('T3')).queryByText(/not done/)).toBeNull();
  });

  it('shows the progress of dependencies as ↻ done/total', async () => {
    await openBlocks();

    expect(within(row('T5')).getByText('↻ 1/2')).toBeVisible();
    expect(within(row('T3')).getByText('↻ 2/2')).toBeVisible();
    expect(within(row('T1')).queryByText(/↻/)).toBeNull();
  });

  it('says the same in words for a screen reader', async () => {
    await openBlocks();

    expect(within(row('T5')).getByText('1 of 2 dependencies done')).toHaveClass('visually-hidden');
  });

  it('opens the task when its title is pressed', async () => {
    const { user } = await openBlocks();

    await user.click(within(row('T5')).getByRole('button', { name: 'Inspect' }));

    expect(await screen.findByRole('complementary', { name: 'Task T5' })).toBeVisible();
  });

  it('shows the tasks of a topic that are in no block apart, outside the order', async () => {
    await openBlocks();

    const loose = block('Not in a block');
    expect(within(loose).getByText('Unplaced in P1')).toBeVisible();
    expect(within(loose).queryByText(/\d+\/\d+/)).toBeNull();
  });
});
