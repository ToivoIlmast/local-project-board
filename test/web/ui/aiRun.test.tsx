import { act, screen, within } from '@testing-library/react';
import type { Task } from '../../../src/contract/v1/index';
import { aTask } from '../support/fixtures';
import { renderBoard, type RenderedBoard } from '../support/render';

/**
 * What an agent reported about its run on a task, in the details of that task (T27, the model
 * of T20). The board shows it as the agent's own word; it does not check it against git — that
 * reconciliation, and a line on the card, are left to T20.
 */

const finished = {
  agent: 'claude-code',
  state: 'finished' as const,
  checks: 'passed' as const,
  commit: '9f1c1a2b3c4d',
  startedAt: '2026-09-26T10:00:00.000Z',
  finishedAt: '2026-09-26T11:00:00.000Z',
};

async function openTask(task: Partial<Task>): Promise<RenderedBoard> {
  const rendered = await renderBoard({
    tasks: [aTask({ id: 'T1', title: 'Ship it', status: 'todo', ...task })],
  });
  await rendered.user.click(screen.getByRole('button', { name: 'Ship it' }));
  await screen.findByRole('complementary', { name: 'Task T1' });
  return rendered;
}

const details = () => screen.getByRole('complementary', { name: 'Task T1' });
const run = () => within(details()).queryByRole('region', { name: 'AI run' });
const value = (term: string): string | null | undefined =>
  within(run() as HTMLElement).getByText(term).nextElementSibling?.textContent;

describe('the AI run in the details of a task (T27)', () => {
  it('shows what the agent reported: who, how it went, the checks, the commit, the times and the branch', async () => {
    await openTask({ aiRun: finished, branch: 'task/T1-ship-it' });

    expect(run()).toBeVisible();
    expect(value('Agent')).toBe('claude-code');
    expect(value('State')).toBe('finished');
    expect(value('Checks')).toBe('passed');
    expect(value('Commit')).toBe('9f1c1a2b3c4d');
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
});
