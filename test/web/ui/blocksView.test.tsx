import { screen, within } from '@testing-library/react';
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

async function openBlocks() {
  const rendered = await renderBoard(seeded());
  await rendered.user.click(screen.getByRole('button', { name: 'Blocks' }));
  await screen.findByRole('complementary', { name: 'Blocks' });
  return rendered;
}

const panel = () => screen.getByRole('complementary', { name: 'Blocks' });
const block = (name: string) => within(panel()).getByRole('region', { name });
const row = (id: string) => panel().querySelector(`[data-task-id="${id}"]`) as HTMLElement;

const STATES = ['completed', 'waiting for previous Block', 'empty'];
const statesIn = (region: HTMLElement) =>
  STATES.filter((state) => within(region).queryByText(state) !== null);

describe('opening the Blocks View', () => {
  it('is a panel beside the board, in the address, like the others', async () => {
    await openBlocks();

    expect(new URLSearchParams(window.location.search).get('panel')).toBe('blocks');
    expect(within(panel()).getByRole('heading', { name: 'Blocks' })).toBeVisible();
  });

  it('lists each topic with its blocks in the order of the topic', async () => {
    await openBlocks();

    const topic = within(panel()).getByRole('region', { name: 'P1 · Alpha' });
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
    expect(within(panel()).getByRole('region', { name: 'P2 · Beta' })).toBeVisible();
  });

  it('leaves out a task that has no topic, and says nothing of it as a block', async () => {
    await openBlocks();

    expect(row('T8')).toBeNull();
  });

  it('says so when the board has no topics', async () => {
    const rendered = await renderBoard({ tasks: makeTasks() });
    await rendered.user.click(screen.getByRole('button', { name: 'Blocks' }));

    expect(
      await within(await screen.findByRole('complementary', { name: 'Blocks' })).findByText(
        'No topics',
      ),
    ).toBeVisible();
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
