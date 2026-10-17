import { act, screen, waitFor, within } from '@testing-library/react';
import type { AiRun, Task } from '../../../src/contract/v1/index';
import { ApiError } from '../../../src/web/api/index';
import { aTask } from '../support/fixtures';
import { renderBoard, type RenderedBoard } from '../support/render';

/**
 * The AI run of a task as the lifecycle of a session, and the way back from a run that failed or
 * wants a review (T39): why it ended, what the runner and what the agent said, and Resume and
 * Restart — never while Claude Code is working, and never a Restart nobody confirmed.
 */

const SESSION = '0b5c0a1e-6c9b-4b8e-9c55-8f1d2a3b4c5d';

const aRun = (extra: Partial<AiRun> = {}): AiRun => ({
  agent: 'claude-code',
  state: 'failed',
  runId: 2,
  sessionId: SESSION,
  mode: 'new',
  model: 'sonnet',
  ...extra,
});

const todo = (aiRun: AiRun | undefined): Task =>
  aTask({
    id: 'T1',
    title: 'Ship it',
    status: 'todo',
    branch: 'task/T1-ship-it',
    ...(aiRun === undefined ? {} : { aiRun }),
  });

async function openTask(aiRun: AiRun | undefined): Promise<RenderedBoard> {
  const rendered = await renderBoard({ tasks: [todo(aiRun)] });
  await rendered.user.click(screen.getByRole('button', { name: 'Ship it' }));
  await screen.findByRole('complementary', { name: 'Task T1' });
  return rendered;
}

const details = () => screen.getByRole('complementary', { name: 'Task T1' });
const block = () => within(details()).getByRole('region', { name: 'AI run' });
const resumeButton = () => within(block()).queryByRole('button', { name: 'Resume' });
const restartButton = () => within(block()).queryByRole('button', { name: 'Restart' });
const value = (term: string): string | null | undefined =>
  within(block()).getByText(term).nextElementSibling?.textContent;

describe('why a run ended, in words (T39)', () => {
  it.each<[string, Partial<AiRun>, RegExp]>([
    [
      'launch',
      { failure: { kind: 'launch', message: 'spawn claude ENOENT' } },
      /Claude Code could not be started/,
    ],
    [
      'exit',
      { failure: { kind: 'exit', message: 'process exited with code 3', exitCode: 3 } },
      /The session ended without a final report \(code 3\)/,
    ],
    [
      'agent',
      { failure: { kind: 'agent', message: 'The tests of the project do not pass.' } },
      /The tests of the project do not pass\./,
    ],
    [
      'lost',
      { failure: { kind: 'lost', message: 'the runner is gone' } },
      /The run was lost: the runner ended without a result/,
    ],
  ])('says its own thing for %s', async (kind, extra, text) => {
    await openTask(aRun(extra));

    expect(within(block()).getByRole('alert')).toHaveTextContent(text);
    // The texts are not shared: none of the other three is said as well.
    const others = [
      /could not be started/,
      /ended without a final report/,
      /The run was lost/,
    ].filter((other) => !other.test(String(text)));
    for (const other of others) {
      expect(within(block()).queryByText(other)).not.toBeInTheDocument();
    }
    // The warning is for a run the agent called finished, and for no other.
    expect(within(block()).queryByText(/reported the run as finished/)).not.toBeInTheDocument();
    expect(kind).toBeTruthy();
  });

  it('says nothing about a failure when there is none', async () => {
    await openTask(aRun({ state: 'needs-review' }));

    expect(within(block()).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('warns about the exit code of a run the agent reported as finished', async () => {
    await openTask(
      aRun({
        state: 'finished',
        failure: { kind: 'exit', message: 'process exited with code 2', exitCode: 2 },
      }),
    );

    expect(within(block()).getByText(/finished.*exited with code 2/i)).toBeVisible();
    // It is a warning, not the verdict that the run failed.
    expect(within(block()).queryByText(/ended without a final report/)).not.toBeInTheDocument();
  });
});

describe('the technical lifecycle of the run (T39)', () => {
  it('shows the attempt, the state, the model and the mode of the run', async () => {
    await openTask(aRun({ mode: 'restart' }));

    expect(value('Attempt')).toBe('#2');
    expect(value('State')).toBe('failed');
    expect(value('Model')).toBe('sonnet');
    expect(value('Mode')).toBe('restart');
  });

  it('marks what the agent said as the agent’s word, and what the runner wrote as nobody’s', async () => {
    await openTask(
      aRun({
        state: 'needs-review',
        checks: 'passed',
        commit: '9f1c1a2b3c4d',
        agent: 'claude-code',
      }),
    );

    const marked = (term: string): HTMLElement =>
      within(block()).getByText(term).closest('div') as HTMLElement;
    for (const term of ['Agent', 'Checks', 'Commit']) {
      expect(within(marked(term)).getByText(/reported by the agent/i)).toBeVisible();
    }
    for (const term of ['Attempt', 'State', 'Model', 'Mode']) {
      expect(within(marked(term)).queryByText(/reported by the agent/i)).not.toBeInTheDocument();
    }
  });

  it('copies the command that continues the session by hand', async () => {
    const rendered = await openTask(aRun());

    await rendered.user.click(
      within(block()).getByRole('button', { name: 'Copy command to continue by hand' }),
    );

    expect(await navigator.clipboard.readText()).toBe(`claude --resume ${SESSION}`);
  });

  it('has no command to copy for a run without a session (legacy)', async () => {
    await openTask({ agent: 'claude-code', state: 'failed' });

    expect(
      within(block()).queryByRole('button', { name: 'Copy command to continue by hand' }),
    ).not.toBeInTheDocument();
  });
});

describe('the buttons that recover a run (T39)', () => {
  it.each<[AiRun['state'], boolean]>([
    ['working', false],
    ['finished', false],
    ['failed', true],
    ['needs-review', true],
  ])('state %s: recovery buttons are shown = %s', async (state, shown) => {
    await openTask(aRun({ state }));

    expect(resumeButton() !== null).toBe(shown);
    expect(restartButton() !== null).toBe(shown);
  });

  it('offers at most those two buttons, and no other', async () => {
    await openTask(aRun());

    const names = within(block())
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(names).toEqual(['Copy command to continue by hand', 'Resume', 'Restart']);
  });

  it('Resume opens the dialog of the start with the session Resume chosen, and sends mode resume', async () => {
    const rendered = await openTask(aRun());

    await rendered.user.click(resumeButton() as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'Start Claude Code on T1' });
    expect(within(dialog).getByLabelText('Session')).toHaveValue('resume');
    expect(rendered.board.calls).not.toContain('runTask');

    await rendered.user.click(within(dialog).getByRole('button', { name: 'Start' }));

    await waitFor(() =>
      expect(rendered.board.runs).toEqual([
        { taskId: 'T1', agent: 'claude-code', model: 'sonnet', mode: 'resume' },
      ]),
    );
  });

  it('Restart asks first, and sends nothing until it is confirmed (INVARIANT)', async () => {
    const rendered = await openTask(aRun({ runId: 2 }));

    await rendered.user.click(restartButton() as HTMLElement);

    const confirm = await screen.findByRole('dialog', { name: /Start .* over/i });
    expect(confirm).toHaveTextContent(/renamed.*-attempt-/i);
    expect(confirm).toHaveTextContent(/nothing is deleted/i);
    expect(rendered.board.calls).not.toContain('runTask');

    await rendered.user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(rendered.board.calls).not.toContain('runTask');
  });

  it('Restart, confirmed, sends mode restart', async () => {
    const rendered = await openTask(aRun());

    await rendered.user.click(restartButton() as HTMLElement);
    const confirm = await screen.findByRole('dialog', { name: /Start .* over/i });
    await rendered.user.click(within(confirm).getByRole('button', { name: 'Restart' }));

    await waitFor(() =>
      expect(rendered.board.runs).toEqual([
        { taskId: 'T1', agent: 'claude-code', model: 'sonnet', mode: 'restart' },
      ]),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await within(block()).findByText(/Claude Code is starting on T1/)).toBeVisible();
  });

  it('says in the confirmation what the board said when Restart is refused', async () => {
    const rendered = await openTask(aRun());
    rendered.board.fail(
      'runTask',
      new ApiError(409, 'NO_AGENT_RUNNER', 'Nothing is waiting to start Claude Code.'),
    );

    await rendered.user.click(restartButton() as HTMLElement);
    const confirm = await screen.findByRole('dialog', { name: /Start .* over/i });
    await rendered.user.click(within(confirm).getByRole('button', { name: 'Restart' }));

    expect(await within(confirm).findByRole('alert')).toHaveTextContent(
      'Nothing is waiting to start Claude Code.',
    );
  });

  it('a legacy run without a session: Restart is there, Resume is not', async () => {
    await openTask({ agent: 'claude-code', state: 'failed' });

    expect(resumeButton()).not.toBeInTheDocument();
    expect(restartButton()).toBeVisible();
  });
});

describe('the run follows the board without a reload (T39)', () => {
  it('shows and takes away the buttons as the state changes', async () => {
    const rendered = await openTask(aRun({ state: 'working' }));
    expect(restartButton()).not.toBeInTheDocument();

    await act(async () => {
      rendered.board.emit({
        type: 'task.updated',
        task: todo(
          aRun({ failure: { kind: 'exit', message: 'process exited with code 1', exitCode: 1 } }),
        ),
      });
    });
    expect(restartButton()).toBeVisible();
    expect(value('State')).toBe('failed');

    await act(async () => {
      rendered.board.emit({ type: 'task.updated', task: todo(aRun({ state: 'working' })) });
    });
    expect(restartButton()).not.toBeInTheDocument();
    expect(resumeButton()).not.toBeInTheDocument();
  });
});

describe('the badge on the card (T39)', () => {
  const card = () => screen.getByRole('button', { name: 'Ship it' }).closest('li') as HTMLElement;

  it('says the attempt on a failed run, as a warning', async () => {
    await renderBoard({ tasks: [todo(aRun({ runId: 3 }))] });

    const badge = within(card()).getByTitle('AI run: failed');
    expect(badge.textContent).toBe('AI: failed #3');
    expect(badge.className).toMatch(/warning/);
  });

  it('says the attempt on a run that needs a review', async () => {
    await renderBoard({ tasks: [todo(aRun({ state: 'needs-review', runId: 2 }))] });

    expect(within(card()).getByTitle('AI run: needs-review').textContent).toBe(
      'AI: needs-review #2',
    );
  });

  it('says no attempt on a run that has none (legacy)', async () => {
    await renderBoard({ tasks: [todo({ agent: 'claude-code', state: 'failed' })] });

    expect(within(card()).getByTitle('AI run: failed').textContent).toBe('AI: failed');
  });
});
