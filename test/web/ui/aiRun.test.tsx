import { act, screen, waitFor, within } from '@testing-library/react';
import type { GitCommit, Task } from '../../../src/contract/v1/index';
import { aTask } from '../support/fixtures';
import { renderBoard, type RenderedBoard } from '../support/render';

/**
 * What an agent reported about its run on a task: in the details of that task (T27) and as a
 * state badge on the card (T20). T20 also adds a mismatch warning when the reported commit is
 * not found in the commits of the task's branch.
 */

const COMMIT_SHA = '9f1c1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b';
const COMMIT_SHORT = '9f1c1a2b3c4d';

const finished = {
  agent: 'claude-code',
  state: 'finished' as const,
  checks: 'passed' as const,
  commit: COMMIT_SHORT,
  startedAt: '2026-09-26T10:00:00.000Z',
  finishedAt: '2026-09-26T11:00:00.000Z',
};

const aCommit = (sha: string): GitCommit => ({
  sha,
  subject: 'T1: ship it',
  author: 'Toivo',
  date: '2026-09-26T10:00:00.000Z',
});

async function openTask(task: Partial<Task>, commits?: GitCommit[]): Promise<RenderedBoard> {
  const rendered = await renderBoard({
    tasks: [aTask({ id: 'T1', title: 'Ship it', status: 'todo', ...task })],
    ...(commits !== undefined ? { commits } : {}),
  });
  await rendered.user.click(screen.getByRole('button', { name: 'Ship it' }));
  await screen.findByRole('complementary', { name: 'Task T1' });
  return rendered;
}

const card = () => screen.getByRole('button', { name: 'Ship it' }).closest('li') as HTMLElement;
const details = () => screen.getByRole('complementary', { name: 'Task T1' });
const run = () => within(details()).queryByRole('region', { name: 'AI run' });
const value = (term: string): string | null | undefined =>
  within(run() as HTMLElement).getByText(term).nextElementSibling?.textContent;

describe('the AI run in the details of a task (T27 + T20)', () => {
  it('shows what the agent reported: who, how it went, the checks, the commit, the times and the branch', async () => {
    await openTask({ aiRun: finished, branch: 'task/T1-ship-it' }, [aCommit(COMMIT_SHA)]);

    expect(run()).toBeVisible();
    expect(value('Agent')).toBe('claude-code');
    expect(value('State')).toBe('finished');
    expect(value('Checks')).toBe('passed');
    await waitFor(() => expect(value('Commit')).toBe(COMMIT_SHORT));
    expect(value('Branch')).toBe('task/T1-ship-it');
    expect(value('Started')).not.toBe('');
    expect(value('Finished')).not.toBe('');
  });

  it('says that it is the word of the agent, not something the board checked', async () => {
    await openTask({ aiRun: finished });

    expect(within(run() as HTMLElement).getByText(/reported by the agent/i)).toBeVisible();
  });

  it('shows only what was reported: a run that is still going has no checks and no end', async () => {
    await openTask({ aiRun: { agent: 'claude-code', state: 'working' } });

    expect(value('State')).toBe('working');
    for (const term of ['Checks', 'Commit', 'Finished', 'Branch']) {
      expect(within(run() as HTMLElement).queryByText(term)).not.toBeInTheDocument();
    }
  });

  it('is not there for a task no agent has reported on', async () => {
    await openTask({});

    expect(run()).not.toBeInTheDocument();
  });

  it('follows the run as the agent reports it, without a reload', async () => {
    const rendered = await openTask({});

    await act(async () => {
      await rendered.board.client.updateTask('T1', {
        aiRun: { agent: 'claude-code', state: 'working' },
      });
    });
    expect(value('State')).toBe('working');

    await act(async () => {
      await rendered.board.client.updateTask('T1', { aiRun: finished });
    });
    expect(value('State')).toBe('finished');
    expect(value('Checks')).toBe('passed');
  });

  describe('commit verification against the branch (T20)', () => {
    it('shows the commit as-is when it is found in the branch commits', async () => {
      await openTask({ aiRun: finished, branch: 'task/T1-ship-it' }, [aCommit(COMMIT_SHA)]);

      await waitFor(() => expect(value('Commit')).toBe(COMMIT_SHORT));
    });

    it('flags the commit when it is not found in the branch commits', async () => {
      await openTask({ aiRun: finished, branch: 'task/T1-ship-it' }, [
        aCommit('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      ]);

      await waitFor(() => expect(value('Commit')).toMatch(/not found in branch/));
    });

    it('shows the commit as-is when there is no branch to check against', async () => {
      await openTask({ aiRun: finished });

      expect(value('Commit')).toBe(COMMIT_SHORT);
    });
  });
});

describe('AI run state on the card (T20)', () => {
  it('shows a badge with the state when the task has an aiRun', async () => {
    await renderBoard({
      tasks: [aTask({ id: 'T1', title: 'Ship it', status: 'todo', aiRun: finished })],
    });

    expect(within(card()).getByTitle('AI run: finished')).toBeVisible();
  });

  it('uses an accent badge for a working run', async () => {
    await renderBoard({
      tasks: [
        aTask({
          id: 'T1',
          title: 'Ship it',
          status: 'todo',
          aiRun: { agent: 'claude-code', state: 'working' },
        }),
      ],
    });

    const badge = within(card()).getByTitle('AI run: working');
    expect(badge).toBeVisible();
    expect(badge.textContent).toBe('AI: working');
  });

  it('uses a warning badge for a failed run', async () => {
    await renderBoard({
      tasks: [
        aTask({
          id: 'T1',
          title: 'Ship it',
          status: 'todo',
          aiRun: { agent: 'claude-code', state: 'failed' },
        }),
      ],
    });

    expect(within(card()).getByTitle('AI run: failed')).toBeVisible();
  });

  it('shows no AI run badge when there is no aiRun', async () => {
    await renderBoard({
      tasks: [aTask({ id: 'T1', title: 'Ship it', status: 'todo' })],
    });

    expect(within(card()).queryByTitle(/AI run:/)).not.toBeInTheDocument();
  });
});
