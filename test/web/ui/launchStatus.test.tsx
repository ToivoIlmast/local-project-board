import { randomUUID } from 'node:crypto';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import type { AiRun, Launch, Task } from '../../../src/contract/v1/index';
import { formatDate } from '../../../src/web/shared/lib/format';
import { openStream, type SseClient } from '../../support/sse';
import { aTask } from '../support/fixtures';
import { nodeFetch } from '../support/nodeTransport';
import { renderAgainstRealBoard, type RealBoard } from '../support/realBoard';
import { renderBoard, type RenderedBoard } from '../support/render';

/**
 * What the page says about a request of Claude Code (ADR-0029 T94, K12): it reads `task.launch`
 * and `task.aiRun` and nothing else. A 200 of /run is "sent to a runner", never "starting"; only
 * `aiRun.working` says that Claude Code has started; a failure is said only when it was reported.
 */

const REQUESTED_AT = '2026-11-06T09:00:00.000Z';

const aLaunch = (extra: Partial<Launch> = {}): Launch => ({
  requestId: '0b5c0a1e-6c9b-4b8e-9c55-8f1d2a3b4c5d',
  requestedAt: REQUESTED_AT,
  afterRunId: 0,
  reports: true,
  ...extra,
});

const aRun = (extra: Partial<AiRun> = {}): AiRun => ({
  agent: 'claude-code',
  state: 'failed',
  runId: 1,
  sessionId: '1c6d0b2f-7d0c-4c9f-8d66-9a2e3b4c5d6e',
  ...extra,
});

const todo = (extra: Partial<Task> = {}): Task =>
  aTask({ id: 'T1', title: 'Ship it', status: 'todo', ...extra });

const details = () => screen.getByRole('complementary', { name: 'Task T1' });

const STARTING = /is starting/i;
const SENT = /^Sent to a runner at /;
const EARLIER =
  /^Sent at .* to a runner of an earlier version, which cannot report a failed start\./;
const DID_NOT_START = 'Claude Code did not start';

async function openDetails(task: Task): Promise<RenderedBoard> {
  const rendered = await renderBoard({ tasks: [task] });
  await rendered.user.click(screen.getByRole('button', { name: 'Ship it' }));
  await screen.findByRole('complementary', { name: 'Task T1' });
  return rendered;
}

/** Send to AI → Claude Code → Start, from the details of the task. */
async function startFromDetails(rendered: { user: RenderedBoard['user'] }): Promise<void> {
  await rendered.user.click(within(details()).getByRole('button', { name: 'Send to AI' }));
  await rendered.user.click(screen.getByRole('button', { name: 'Claude Code' }));
  const dialog = await screen.findByRole('dialog', { name: 'Start Claude Code on T1' });
  await rendered.user.click(within(dialog).getByRole('button', { name: 'Start' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}

describe('a request that was sent, and nothing more (K12)', () => {
  it('a 200 of /run says the request was sent to a runner, not that Claude Code is starting', async () => {
    const rendered = await openDetails(todo());

    await startFromDetails(rendered);

    expect(
      await within(details()).findByText(/^Sent T1 to the runner in the terminal where/),
    ).toBeVisible();
    expect(within(details()).queryByText(STARTING)).not.toBeInTheDocument();
    expect(within(details()).queryByRole('status', { name: /starting/i })).not.toBeInTheDocument();
  });

  it('a current launch without a report: neutral, static, with the time, and no spinner', async () => {
    await openDetails(todo({ launch: aLaunch() }));

    const note = within(details()).getByText(SENT);
    expect(note).toHaveTextContent(formatDate(REQUESTED_AT));
    expect(note).toHaveTextContent(
      'Claude Code has not begun, and the runner has reported no problem. The board cannot tell ' +
        'whether the runner is still there; if nothing begins, look at its terminal.',
    );
    expect(within(details()).queryByText(STARTING)).not.toBeInTheDocument();
    expect(within(details()).queryByText(DID_NOT_START)).not.toBeInTheDocument();
    expect(details().querySelector('.spinner')).toBeNull();
  });

  it('a request whose report never came is never called a failure, however old it is', async () => {
    await openDetails(todo({ launch: aLaunch({ requestedAt: '2020-01-01T00:00:00.000Z' }) }));

    expect(within(details()).getByText(SENT)).toBeVisible();
    expect(within(details()).queryByText(DID_NOT_START)).not.toBeInTheDocument();
    expect(within(details()).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a runner of an earlier version: says it cannot report a failed start', async () => {
    await openDetails(todo({ launch: aLaunch({ reports: false }) }));

    expect(within(details()).getByText(EARLIER)).toHaveTextContent(
      'If nothing begins, look at its terminal.',
    );
    expect(within(details()).queryByText(SENT)).not.toBeInTheDocument();
  });
});

describe('a start that did not begin (K12)', () => {
  it.each([
    ['claude-missing', 'The runner found no `claude` in the PATH.'],
    ['resume-refused', 'The runner found no finished session of Claude Code to resume.'],
    ['begin-refused', 'The board refused to begin the run.'],
    ['runner-error', 'The runner stopped before Claude Code began.'],
  ] as const)(
    '%s: says Claude Code did not start, why, the runner’s words and the time',
    async (kind, why) => {
      const at = '2026-11-06T09:00:02.000Z';
      await openDetails(
        todo({ launch: aLaunch({ failure: { kind, message: 'Its own words.', at } }) }),
      );

      const alert = within(details()).getByRole('alert');
      expect(alert).toHaveTextContent(DID_NOT_START);
      expect(alert).toHaveTextContent(why);
      expect(alert).toHaveTextContent('Its own words.');
      expect(alert).toHaveTextContent(formatDate(at));
      expect(within(details()).queryByText(SENT)).not.toBeInTheDocument();
    },
  );

  it('shows the runner’s message as text, never as markup (K10)', async () => {
    const message = '<img src=x onerror=alert(1)> **bold**';
    await openDetails(
      todo({ launch: aLaunch({ failure: { kind: 'begin-refused', message, at: REQUESTED_AT } }) }),
    );
    expect(within(details()).getByText(message, { exact: false })).toBeVisible();
    expect(details().querySelector('img')).toBeNull();
  });

  it('keeps Start available after a failure', async () => {
    const rendered = await openDetails(
      todo({ launch: aLaunch({ failure: { kind: 'claude-missing', at: REQUESTED_AT } }) }),
    );

    await startFromDetails(rendered);

    expect(rendered.board.runs).toEqual([{ taskId: 'T1', agent: 'claude-code' }]);
  });
});

describe('what the page does not show (K4, K12)', () => {
  it('a working run: the run, and nothing of a launch, even one left beside it', async () => {
    await openDetails(
      todo({ aiRun: aRun({ state: 'working', runId: 1 }), launch: aLaunch({ afterRunId: 1 }) }),
    );

    expect(within(details()).getByText('working')).toBeVisible();
    expect(within(details()).queryByText(SENT)).not.toBeInTheDocument();
    expect(within(details()).queryByText(DID_NOT_START)).not.toBeInTheDocument();
  });

  it('a stale launch: a run has begun since the request, so nothing about it (afterRunId)', async () => {
    await openDetails(
      todo({
        aiRun: aRun({ runId: 2 }),
        launch: aLaunch({ afterRunId: 1, failure: { kind: 'claude-missing', at: REQUESTED_AT } }),
      }),
    );

    expect(within(details()).queryByText(DID_NOT_START)).not.toBeInTheDocument();
    expect(within(details()).queryByText(SENT)).not.toBeInTheDocument();
  });

  it('a new request replaces the failure of the one before it', async () => {
    const rendered = await openDetails(
      todo({ launch: aLaunch({ failure: { kind: 'claude-missing', at: REQUESTED_AT } }) }),
    );
    expect(within(details()).getByText(DID_NOT_START)).toBeVisible();

    const task = rendered.board.tasks.find((candidate) => candidate.id === 'T1');
    act(() =>
      rendered.board.emit({
        type: 'task.updated',
        task: { ...todo(), ...task, launch: aLaunch({ requestId: randomUUID() }) },
      }),
    );

    await waitFor(() =>
      expect(within(details()).queryByText(DID_NOT_START)).not.toBeInTheDocument(),
    );
    expect(within(details()).getByText(SENT)).toBeVisible();
  });
});

describe('against the real board: the request, its report, a reload and the begin', () => {
  let board: RealBoard | undefined;
  let runner: SseClient<unknown> | undefined;

  afterEach(async () => {
    await runner?.close();
    cleanup();
    await board?.server.close();
    runner = undefined;
    board = undefined;
  });

  it('shows only what the board holds, in order: sent, failed, still failed after a reload, then the run', async () => {
    board = await renderAgainstRealBoard();
    await board.client.createTask({ title: 'Ship it', status: 'todo' });
    runner = await openStream(
      board.server.port,
      '/api/v1/runs?signals=run-failure',
      { authorization: `Bearer ${board.server.token}` },
      (data) => data,
    );
    await board.user.click(await screen.findByRole('button', { name: 'Ship it' }));
    await screen.findByRole('complementary', { name: 'Task T1' });

    await startFromDetails(board);

    // The 200 says sent; the launch the board wrote says the same, and nothing is "starting".
    expect(await within(details()).findByText(SENT)).toBeVisible();
    expect(within(details()).queryByText(STARTING)).not.toBeInTheDocument();
    const [event] = (await runner.waitForEvents(1)) as { requestId: string }[];

    const reported = await nodeFetch(`${board.server.origin}/api/v1/tasks/T1/run-failure`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${board.server.token}`,
      },
      body: JSON.stringify({
        requestId: event?.requestId,
        kind: 'claude-missing',
        message: 'Claude Code was not found.',
      }),
    });
    expect(reported.status).toBe(200);

    expect(await within(details()).findByText(DID_NOT_START)).toBeVisible();
    expect(within(details()).getByRole('alert')).toHaveTextContent('Claude Code was not found.');

    // A reload: a new page on the same board reads the same thing from the task.
    const server = board.server;
    cleanup();
    board = await renderAgainstRealBoard({ root: server.root });
    await server.close();
    await board.user.click(await screen.findByRole('button', { name: 'Ship it' }));
    await screen.findByRole('complementary', { name: 'Task T1' });
    expect(within(details()).getByText(DID_NOT_START)).toBeVisible();

    // A begin of any caller: the run is shown, and the failure is gone.
    const begun = await nodeFetch(`${board.server.origin}/api/v1/tasks/T1/ai-run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${board.server.token}`,
      },
      body: JSON.stringify({ sessionId: randomUUID(), mode: 'new' }),
    });
    expect(begun.status).toBe(200);
    expect(await within(details()).findByText('working')).toBeVisible();
    expect(within(details()).queryByText(DID_NOT_START)).not.toBeInTheDocument();
    expect(within(details()).queryByText(SENT)).not.toBeInTheDocument();
  });
});
