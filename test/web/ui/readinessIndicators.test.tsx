import { screen, within } from '@testing-library/react';
import type { Task } from '../../../src/contract/v1/index';
import { ApiError } from '../../../src/web/api/index';
import { aTask, aTopic } from '../support/fixtures';
import { renderBoard } from '../support/render';

/** What the Kanban says of readiness, and what it does about it (T91; ADR-0032 §7–8). */

const alpha = aTopic({
  id: 'P1',
  title: 'Alpha',
  blocks: [
    { id: 'K1', title: 'Design' },
    { id: 'K2', title: 'Build' },
  ],
});

// The fake board changes the tasks it is given, so every test gets its own.
const first = () => aTask({ id: 'T1', title: 'First', status: 'todo', topic: 'P1', block: 'K1' });
// Held by the earlier block: one reason.
const held = () => aTask({ id: 'T2', title: 'Held', status: 'todo', topic: 'P1', block: 'K2' });
// Waits for T1, which is not done, and for T9, which is not there: two reasons.
const waiting = () =>
  aTask({ id: 'T3', title: 'Waiting', status: 'todo', dependsOn: ['T1', 'T9'] });
const free = () => aTask({ id: 'T4', title: 'Free', status: 'todo' });

const HELD = 'Blocked: block K1 is not done: T1';
const WAITING = 'Blocked: T1 is not done; T9 does not exist';

const seeded = (extra: Task[] = []) => ({
  topics: [alpha],
  tasks: [first(), held(), waiting(), free(), ...extra],
});

const cardOf = (title: string): HTMLElement =>
  screen.getByRole('button', { name: title }).closest('li') as HTMLElement;

/** What a sighted person reads: the text without what is there for a screen reader only. */
function visibleText(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  copy.querySelectorAll('.visually-hidden').forEach((hidden) => hidden.remove());
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
}

async function menuOf(rendered: Awaited<ReturnType<typeof renderBoard>>, id: string) {
  await rendered.user.click(screen.getByRole('button', { name: `Actions for ${id}` }));
}

describe('the lock on the Kanban', () => {
  it('counts the blocked tasks of the board: 🔒 n', async () => {
    await renderBoard(seeded());

    const count = screen.getByLabelText('2 blocked tasks');
    expect(visibleText(count)).toBe('🔒 2');
  });

  it('does not count a done task, and shows no count when nothing is blocked', async () => {
    const done = aTask({ id: 'T5', title: 'Finished', status: 'done', dependsOn: ['T1'] });
    await renderBoard({ topics: [alpha], tasks: [first(), done] });

    expect(screen.queryByLabelText(/blocked tasks?$/)).not.toBeInTheDocument();
    expect(within(cardOf('Finished')).queryByTitle(/^Blocked/)).not.toBeInTheDocument();
  });

  it('shows on each blocked card only 🔒 n, n being its reasons', async () => {
    await renderBoard(seeded());

    const held = within(cardOf('Held')).getByTitle(/^Blocked/);
    const waiting = within(cardOf('Waiting')).getByTitle(/^Blocked/);
    expect(visibleText(held)).toBe('🔒 1');
    expect(visibleText(waiting)).toBe('🔒 2');
    // The card itself does not spell the reasons out.
    expect(visibleText(cardOf('Held'))).not.toContain('is not done');
    expect(within(cardOf('Free')).queryByTitle(/^Blocked/)).not.toBeInTheDocument();
  });

  it('gives the reasons as a tooltip and as text for a screen reader', async () => {
    await renderBoard(seeded());

    expect(within(cardOf('Held')).getByTitle(/^Blocked/)).toHaveAttribute('title', HELD);
    expect(within(cardOf('Held')).getByText(HELD)).toHaveClass('visually-hidden');
    expect(within(cardOf('Waiting')).getByTitle(/^Blocked/)).toHaveAttribute('title', WAITING);
    expect(within(cardOf('Waiting')).getByText(WAITING)).toHaveClass('visually-hidden');
  });

  it('takes the reasons from the board, so they change when the board does', async () => {
    const { board, user } = await renderBoard(seeded());
    expect(screen.getByLabelText('2 blocked tasks')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Actions for T1' }));
    await user.click(screen.getByRole('button', { name: 'Move to done' }));

    // T1 is done: the block and the dependency go; T3 still misses T9.
    await screen.findByLabelText('1 blocked task');
    expect(board.tasks.find((task) => task.id === 'T1')?.status).toBe('done');
    expect(within(cardOf('Waiting')).getByTitle(/^Blocked/)).toHaveAttribute(
      'title',
      'Blocked: T9 does not exist',
    );
  });

  it('leaves AI: working as it was, and shows it with the lock', async () => {
    const working = aTask({
      id: 'T6',
      title: 'Working',
      status: 'todo',
      dependsOn: ['T1'],
      aiRun: { agent: 'claude-code', state: 'working', runId: 1 },
    });
    await renderBoard({ topics: [alpha], tasks: [first(), working] });

    const card = within(cardOf('Working'));
    expect(card.getByTitle('AI run: working')).toHaveTextContent('AI: working');
    expect(card.getByTitle('An AI run is working')).toHaveTextContent('●');
    expect(visibleText(card.getByTitle(/^Blocked/))).toBe('🔒 1');
  });
});

describe('Send to AI on a blocked card', () => {
  it('disables both Copy handoff and Claude Code, and says why next to each', async () => {
    const rendered = await renderBoard(seeded());
    await menuOf(rendered, 'T2');

    for (const name of ['Send to AI: Copy handoff', 'Send to AI: Claude Code']) {
      const item = screen.getByRole('button', { name });
      expect(item).toBeDisabled();
      expect(item).toHaveAccessibleDescription(HELD);
      expect(within(item.closest('li') as HTMLElement).getByText(HELD)).toBeVisible();
    }
  });

  it('does nothing when a disabled entry is pressed', async () => {
    const rendered = await renderBoard(seeded());
    await navigator.clipboard.writeText('what was there before');
    await menuOf(rendered, 'T2');

    await rendered.user.click(screen.getByRole('button', { name: 'Send to AI: Copy handoff' }));
    await rendered.user.click(screen.getByRole('button', { name: 'Send to AI: Claude Code' }));

    expect(rendered.board.calls).not.toContain('handoff');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe('what was there before');
  });

  it('is the same in the menu of the task’s own panel', async () => {
    const rendered = await renderBoard(seeded());
    await rendered.user.click(screen.getByRole('button', { name: 'Held' }));
    const panel = await screen.findByRole('complementary', { name: 'Task T2' });

    await rendered.user.click(within(panel).getByRole('button', { name: 'Send to AI' }));

    expect(screen.getByRole('button', { name: 'Copy handoff' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Claude Code' })).toBeDisabled();
  });

  it('keeps both entries enabled on a task that is not blocked', async () => {
    const rendered = await renderBoard(seeded());
    await menuOf(rendered, 'T4');

    expect(screen.getByRole('button', { name: 'Send to AI: Copy handoff' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Send to AI: Claude Code' })).toBeEnabled();
  });

  it('keeps both entries enabled on a blocked task whose run is working', async () => {
    const working = aTask({
      id: 'T6',
      title: 'Working',
      status: 'todo',
      dependsOn: ['T1'],
      aiRun: { agent: 'claude-code', state: 'working', runId: 1 },
    });
    const rendered = await renderBoard({ topics: [alpha], tasks: [first(), working] });
    await menuOf(rendered, 'T6');

    expect(screen.getByRole('button', { name: 'Send to AI: Copy handoff' })).toBeEnabled();
    const claude = screen.getByRole('button', { name: 'Send to AI: Claude Code' });
    expect(claude).toBeEnabled();
    await rendered.user.click(claude);
    // As before T91: the dialog opens and says the run is working.
    expect(await screen.findByRole('dialog')).toHaveTextContent(/working/i);
  });
});

describe('a TASK_BLOCKED the board answers', () => {
  const refusal = new ApiError(409, 'TASK_BLOCKED', 'Task "T4" is blocked.', {
    id: 'T4',
    reasons: [
      { code: 'task-not-done', task: 'T1' },
      { code: 'block-empty', topic: 'P1', block: 'K1' },
    ],
  });

  it('shows its reasons on the card when the handoff is refused', async () => {
    const rendered = await renderBoard(seeded());
    rendered.board.fail('handoff', refusal);
    await menuOf(rendered, 'T4');

    await rendered.user.click(screen.getByRole('button', { name: 'Send to AI: Copy handoff' }));

    const alert = await within(cardOf('Free')).findByRole('alert');
    expect(alert).toHaveTextContent('T1 is not done');
    expect(alert).toHaveTextContent('block K1 has no tasks');
  });

  it('shows its reasons in the dialog when the start is refused', async () => {
    const rendered = await renderBoard(seeded());
    rendered.board.fail('runTask', refusal);
    await menuOf(rendered, 'T4');
    await rendered.user.click(screen.getByRole('button', { name: 'Send to AI: Claude Code' }));
    const dialog = await screen.findByRole('dialog', { name: 'Start Claude Code on T4' });

    await rendered.user.click(within(dialog).getByRole('button', { name: 'Start' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('T1 is not done');
    expect(alert).toHaveTextContent('block K1 has no tasks');
  });
});
