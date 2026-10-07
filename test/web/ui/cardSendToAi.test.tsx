import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import { screen, waitFor, within } from '@testing-library/react';
import type { Task } from '../../../src/contract/v1/index';
import { ApiError } from '../../../src/web/api/index';
import { aTask } from '../support/fixtures';
import { renderBoard } from '../support/render';

const cardOf = (title: string): HTMLElement =>
  screen.getByRole('button', { name: title }).closest('li') as HTMLElement;

const seed = (): Task[] => [
  aTask({ id: 'T1', title: 'Ship it', status: 'todo', rank: 'a0', workflow: { push: true } }),
  aTask({ id: 'T2', title: 'Other task', status: 'todo', rank: 'a1' }),
];

async function sendFromCard(
  rendered: Awaited<ReturnType<typeof renderBoard>>,
  id: string,
): Promise<void> {
  await rendered.user.click(screen.getByRole('button', { name: `Actions for ${id}` }));
  await rendered.user.click(screen.getByRole('button', { name: 'Send to AI: Copy handoff' }));
}

describe('"Send to AI" in the menu of a card', () => {
  it('copies exactly the handoff the board gives for that task, and says so on the card', async () => {
    const rendered = await renderBoard({ tasks: seed() });

    await sendFromCard(rendered, 'T1');

    const expected = await rendered.board.client.handoff('T1');
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(expected));
    expect(
      await within(cardOf('Ship it')).findByText('Handoff copied to the clipboard.'),
    ).toBeVisible();
    // It is the handoff of the task the menu belongs to, with its own settings in it.
    expect(expected).toContain('# Task T1: Ship it');
    expect(expected).toContain('Push your commits to the remote. _(source: this task)_');
    // The other card says nothing, and nothing was opened.
    expect(within(cardOf('Other task')).queryByText(/Handoff copied/)).not.toBeInTheDocument();
    expect(window.location.search).toBe('');
  });

  it('needs no settings to be read or opened first', async () => {
    const rendered = await renderBoard({ tasks: seed() });

    await sendFromCard(rendered, 'T2');
    await within(cardOf('Other task')).findByText('Handoff copied to the clipboard.');

    expect(rendered.board.calls.filter((call) => call === 'handoff')).toHaveLength(1);
    expect(rendered.board.calls).not.toContain('taskWorkflow');
    expect(rendered.board.calls).not.toContain('updateTask');
  });

  it('says what the board said when it cannot make the handoff, on that card, and copies nothing', async () => {
    const rendered = await renderBoard({ tasks: seed() });
    await navigator.clipboard.writeText('what was there before');
    rendered.board.fail(
      'handoff',
      new ApiError(500, 'INTERNAL_ERROR', 'The handoff could not be made.'),
    );

    await sendFromCard(rendered, 'T1');

    expect(await within(cardOf('Ship it')).findByRole('alert')).toHaveTextContent(
      'The handoff could not be made.',
    );
    expect(await navigator.clipboard.readText()).toBe('what was there before');
  });

  it('says so when the browser refuses the clipboard', async () => {
    const rendered = await renderBoard({ tasks: seed() });
    const write = jest
      .spyOn(navigator.clipboard, 'writeText')
      .mockRejectedValueOnce(new Error('no'));

    await sendFromCard(rendered, 'T1');

    expect(await within(cardOf('Ship it')).findByRole('alert')).toHaveTextContent(
      /could not write to the clipboard/i,
    );
    write.mockRestore();
  });

  it('is announced politely, and the focus goes back to the button of the menu', async () => {
    const rendered = await renderBoard({ tasks: seed() });

    await sendFromCard(rendered, 'T1');

    const done = await within(cardOf('Ship it')).findByText('Handoff copied to the clipboard.');
    expect(done).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('button', { name: 'Actions for T1' })).toHaveFocus();
  });

  it('is the same entry as the one in the task: one place makes the handoff (INVARIANT)', async () => {
    const rendered = await renderBoard({ tasks: seed() });
    await sendFromCard(rendered, 'T1');
    await within(cardOf('Ship it')).findByText('Handoff copied to the clipboard.');
    const fromCard = await navigator.clipboard.readText();

    await rendered.user.click(screen.getByRole('button', { name: 'Ship it' }));
    const panel = await screen.findByRole('complementary', { name: 'Task T1' });
    await rendered.user.click(within(panel).getByRole('button', { name: 'Send to AI' }));
    await rendered.user.click(screen.getByRole('button', { name: 'Copy handoff' }));
    await within(panel).findByText('Handoff copied to the clipboard.');

    expect(await navigator.clipboard.readText()).toBe(fromCard);
  });

  it('is asked for by one piece of code only: nothing else in the page calls the handoff', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(join(process.cwd(), 'src', 'web'));

    const callers = files
      .filter((file) => /\.handoff\(/.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(process.cwd().length + 1))
      .sort();

    expect(callers).toEqual(['src/web/features/tasks/model/useSendToAi.ts']);
  });
});

describe('"Send to AI → Claude Code" in the menu of a card (T19, T27)', () => {
  it('asks the board to start Claude Code on the task of that card, and says so on that card', async () => {
    const rendered = await renderBoard({ tasks: seed() });

    await rendered.user.click(screen.getByRole('button', { name: 'Actions for T2' }));
    await rendered.user.click(screen.getByRole('button', { name: 'Send to AI: Claude Code' }));
    const dialog = await screen.findByRole('dialog', { name: 'Start Claude Code on T2' });
    await rendered.user.click(within(dialog).getByRole('button', { name: 'Start' }));

    expect(
      await within(cardOf('Other task')).findByText(/^Claude Code is starting on T2 /),
    ).toBeVisible();
    expect(
      within(cardOf('Ship it')).queryByText(/Claude Code is starting/),
    ).not.toBeInTheDocument();
    expect(rendered.board.runs).toEqual([{ taskId: 'T2', agent: 'claude-code' }]);
    expect(rendered.board.calls).not.toContain('handoff');
  });
});
