import { act, screen, waitFor, within } from '@testing-library/react';
import type { ConsoleEvent, Task } from '../../../src/contract/v1/index';
import { ApiError } from '../../../src/web/api/index';
import { CONSOLE_PHASES } from '../../../src/core/rules/console';
import { taskCatalogs } from '../../../src/web/features/tasks/i18n/details';
import { eventsOfFixture } from '../support/consoleJournal';
import { aTask } from '../support/fixtures';
import { renderBoard, type RenderedBoard } from '../support/render';
import { findTaskDetails, taskDetails } from '../support/taskDetails';

/**
 * The console of a Console mode run in the details of its task (C9): read only. The journals here
 * are the recorded streams of a real `claude`, normalized the way the runner does.
 */

const consoleRun = {
  agent: 'claude-code',
  state: 'working' as const,
  runId: 1,
  console: true as const,
  startedAt: '2026-09-26T10:00:00.000Z',
};

const said = (text: string, id = 'msg_1'): ConsoleEvent => ({
  kind: 'assistant.text',
  apiMessageId: id,
  scope: null,
  text,
});

async function openTask(
  consoles: Record<string, ConsoleEvent[]>,
  task: Partial<Task> = {},
  others: Task[] = [],
): Promise<RenderedBoard> {
  const rendered = await renderBoard({
    tasks: [
      aTask({ id: 'T1', title: 'Ship it', status: 'in-progress', aiRun: consoleRun, ...task }),
      ...others,
    ],
    consoles,
  });
  await rendered.user.click(screen.getByRole('button', { name: 'Ship it' }));
  await findTaskDetails('Task T1');
  return rendered;
}

const consoleOf = () => within(taskDetails('Task T1')).getByRole('region', { name: 'Console' });
const reads = (board: RenderedBoard['board']) =>
  board.calls.filter((call) => call === 'getConsole').length;

describe('the console in the details of a task', () => {
  it('is not there for a run that is not a console run', async () => {
    await openTask({}, { aiRun: { agent: 'claude-code', state: 'working', runId: 1 } });

    expect(
      within(taskDetails('Task T1')).queryByRole('region', { name: 'Console' }),
    ).not.toBeInTheDocument();
  });

  it('shows what the person and Claude said, in the order it happened', async () => {
    await openTask({
      'T1/1': [
        { kind: 'process.started', pid: 1 },
        { kind: 'compat.passed' },
        { kind: 'user.message', origin: 'board', messageId: crypto.randomUUID(), text: 'Hello' },
        said('Hi there'),
      ],
    });

    const feed = await within(consoleOf()).findByRole('list', { name: 'Console events' });
    const items = within(feed).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Hello');
    expect(items[1]).toHaveTextContent('Hi there');
  });

  it('tells the roles by words, not by colour alone', async () => {
    await openTask({
      'T1/1': [
        { kind: 'process.started', pid: 1 },
        { kind: 'compat.passed' },
        { kind: 'user.message', origin: 'board', messageId: crypto.randomUUID(), text: 'Run it' },
        said('Running'),
        { kind: 'tool.call', toolUseId: 't1', tool: 'Bash', summary: 'npm test', scope: null },
        { kind: 'tool.result', toolUseId: 't1', isError: true, preview: 'boom', scope: null },
      ],
    });

    const feed = await within(consoleOf()).findByRole('list', { name: 'Console events' });
    const labels = Array.from(feed.querySelectorAll('.console__role')).map((el) => el.textContent);
    expect(labels).toEqual(['You', 'Claude', 'Tool', 'Result · error']);
    // A word in each item names its role, whatever the CSS does.
    expect(within(feed).getByText('Bash')).toBeVisible();
    expect(within(feed).getByText('npm test')).toBeVisible();
    expect(within(feed).getByText('boom')).toBeVisible();
  });

  it('puts a subagent in a card of its own with what it did inside', async () => {
    await openTask({ 'T1/1': eventsOfFixture('subagent') });

    const card = await within(consoleOf()).findByRole('group', { name: /Subagent/ });
    expect(within(card).getByText('Read')).toBeVisible();
    expect(within(card).getAllByText('Subagent').length).toBeGreaterThan(0);
  });

  it('says a message was added to the current work', async () => {
    await openTask({ 'T1/1': eventsOfFixture('mid-turn-message') });

    expect(await within(consoleOf()).findByText('Added to the current work')).toBeVisible();
  });

  it('shows the text of Claude as text: markup in it is neither run nor drawn', async () => {
    const attack = '<script>window.__pwned = 1</script><img src="x" onerror="window.__pwned = 2">';
    await openTask({ 'T1/1': [{ kind: 'compat.passed' }, said(attack)] });

    const feed = await within(consoleOf()).findByRole('list', { name: 'Console events' });
    expect(feed).toHaveTextContent(attack);
    expect(feed.querySelector('script, img')).toBeNull();
    expect((window as unknown as Record<string, unknown>)['__pwned']).toBeUndefined();
  });

  it('shows the same of a user message and of a tool result', async () => {
    const attack = '<img src=x onerror=alert(1)>';
    await openTask({
      'T1/1': [
        { kind: 'user.message', origin: 'board', messageId: crypto.randomUUID(), text: attack },
        { kind: 'tool.call', toolUseId: 't1', tool: 'Bash', summary: attack, scope: null },
        { kind: 'tool.result', toolUseId: 't1', isError: false, preview: attack, scope: null },
      ],
    });

    const feed = await within(consoleOf()).findByRole('list', { name: 'Console events' });
    expect(feed.querySelector('img, script')).toBeNull();
    expect(feed.textContent?.split(attack).length).toBe(4);
  });
});

describe('the status bar', () => {
  it('says what Claude is doing', async () => {
    await openTask({
      'T1/1': [
        { kind: 'process.started', pid: 1 },
        { kind: 'compat.passed' },
        { kind: 'turn.started', turn: 1, userMessageIds: [] },
      ],
    });

    expect(await within(consoleOf()).findByRole('status')).toHaveTextContent('Claude is working');
  });

  it('never says it waits for an answer, whatever the journal holds', async () => {
    for (const name of ['permissions', 'tools-write-denied', 'api-error']) {
      const { unmount } = await openTask({ 'T1/1': eventsOfFixture(name) });
      const bar = await within(consoleOf()).findByRole('status');
      expect(bar.textContent).not.toMatch(/answer|waiting for|ответ|ждёт/i);
      unmount();
    }
  });

  it('has no phase worded as waiting for an answer, in any language', () => {
    for (const [language, catalog] of Object.entries(taskCatalogs)) {
      for (const phase of CONSOLE_PHASES) {
        const text = String(catalog[`console.phase.${phase}` as keyof typeof catalog]);
        expect([language, text]).toEqual([language, expect.any(String)]);
        expect(text).not.toMatch(/waiting for (an |your )?(answer|reply)|ждёт ответа/i);
      }
    }
  });
});

describe('what the page reads when the board says the journal grew', () => {
  it('reads the new entries of the open run and shows them', async () => {
    const { board } = await openTask({ 'T1/1': [{ kind: 'compat.passed' }, said('First')] });
    await within(consoleOf()).findByText('First');
    const before = reads(board);

    act(() => board.appendConsole('T1', 1, [said('Second', 'msg_2')]));

    expect(await within(consoleOf()).findByText('Second')).toBeVisible();
    expect(reads(board)).toBe(before + 1);
    expect(within(consoleOf()).getByText('First')).toBeVisible();
  });

  it('does not read anything for the console of another task', async () => {
    const other = aTask({ id: 'T2', title: 'Other', aiRun: consoleRun });
    const { board } = await openTask({ 'T1/1': [said('Mine')], 'T2/1': [said('Theirs')] }, {}, [
      other,
    ]);
    await within(consoleOf()).findByText('Mine');
    const before = reads(board);

    act(() => board.appendConsole('T2', 1, [said('More', 'msg_9')]));
    await act(async () => undefined);

    expect(reads(board)).toBe(before);
    expect(within(consoleOf()).queryByText('Theirs')).not.toBeInTheDocument();
  });

  it('does not read anything for another run of the open task', async () => {
    const { board } = await openTask({ 'T1/1': [said('Mine')], 'T1/2': [said('Old')] });
    await within(consoleOf()).findByText('Mine');
    const before = reads(board);

    act(() => board.appendConsole('T1', 2, [said('More', 'msg_9')]));
    await act(async () => undefined);

    expect(reads(board)).toBe(before);
  });

  it('does not read anything when the task is not open', async () => {
    const rendered = await renderBoard({
      tasks: [aTask({ id: 'T1', title: 'Ship it', aiRun: consoleRun })],
      consoles: { 'T1/1': [said('Mine')] },
    });

    act(() => rendered.board.appendConsole('T1', 1, [said('More', 'msg_9')]));
    await act(async () => undefined);

    expect(reads(rendered.board)).toBe(0);
  });

  it('says so when the journal cannot be read, and reads it again when asked', async () => {
    const rendered = await renderBoard({
      tasks: [aTask({ id: 'T1', title: 'Ship it', aiRun: consoleRun })],
      consoles: { 'T1/1': [said('Back again')] },
    });
    rendered.board.fail('getConsole', new ApiError(500, 'INTERNAL_ERROR', 'The disk is gone.'));
    await rendered.user.click(screen.getByRole('button', { name: 'Ship it' }));
    await findTaskDetails('Task T1');

    expect(await within(consoleOf()).findByRole('alert')).toHaveTextContent('The disk is gone.');
    await rendered.user.click(within(consoleOf()).getByRole('button', { name: 'Try again' }));

    expect(await within(consoleOf()).findByText('Back again')).toBeVisible();
    expect(within(consoleOf()).queryByRole('alert')).not.toBeInTheDocument();
  });
});
