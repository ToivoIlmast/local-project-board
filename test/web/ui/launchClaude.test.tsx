import { screen, waitFor, within } from '@testing-library/react';
import type { AiRun, Task } from '../../../src/contract/v1/index';
import { ApiError } from '../../../src/web/api/index';
import { aTask } from '../support/fixtures';
import { renderBoard, type RenderedBoard } from '../support/render';

/**
 * Send to AI → Claude Code asks for the parameters of the run first (T38): the model, the
 * language of the report and the session. What it sends is the contract's request and nothing
 * more; the language is a setting of the task and is saved as one, before the run is asked for.
 */

const todo = (extra: Partial<Task> = {}): Task =>
  aTask({ id: 'T1', title: 'Ship it', status: 'todo', ...extra });

const aRun = (extra: Partial<AiRun> = {}): AiRun => ({
  agent: 'claude-code',
  state: 'finished',
  runId: 1,
  sessionId: '0b5c0a1e-6c9b-4b8e-9c55-8f1d2a3b4c5d',
  ...extra,
});

const details = () => screen.getByRole('complementary', { name: 'Task T1' });
const dialog = () => screen.getByRole('dialog', { name: 'Start Claude Code on T1' });
const start = () => within(dialog()).getByRole('button', { name: 'Start' });
const STARTING = /^Claude Code is starting on T1 in the terminal where/;

async function openLaunch(extra: Partial<Task> = {}, options = {}): Promise<RenderedBoard> {
  const rendered = await renderBoard({ tasks: [todo(extra)], ...options });
  await rendered.user.click(screen.getByRole('button', { name: 'Ship it' }));
  await screen.findByRole('complementary', { name: 'Task T1' });
  await rendered.user.click(within(details()).getByRole('button', { name: 'Send to AI' }));
  await rendered.user.click(screen.getByRole('button', { name: 'Claude Code' }));
  await screen.findByRole('dialog', { name: 'Start Claude Code on T1' });
  return rendered;
}

/** The language select is usable once the board said which language is in effect. */
async function languageSelect(): Promise<HTMLSelectElement> {
  const select = within(dialog()).getByLabelText(/^Report language/) as HTMLSelectElement;
  await waitFor(() => expect(select).toBeEnabled());
  return select;
}

describe('the dialog of Send to AI → Claude Code (T38)', () => {
  it('opens on choosing the entry and asks the board for nothing to run yet', async () => {
    const rendered = await openLaunch();

    expect(within(dialog()).getByLabelText('Model')).toBeInTheDocument();
    expect(within(dialog()).getByLabelText(/^Report language/)).toBeInTheDocument();
    expect(within(dialog()).getByLabelText('Session')).toBeInTheDocument();
    expect(rendered.board.calls).not.toContain('runTask');
  });

  it('sends {agent} and no model when nothing was changed: as it was before the dialog (INVARIANT)', async () => {
    const rendered = await openLaunch();

    await rendered.user.click(start());

    expect(await within(details()).findByText(STARTING)).toBeVisible();
    expect(rendered.board.runs).toEqual([{ taskId: 'T1', agent: 'claude-code' }]);
    expect(Object.keys(rendered.board.runs[0] ?? {})).not.toContain('model');
    // No setting was written on the way.
    expect(rendered.board.calls).not.toContain('updateTask');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('sends a chosen alias as the model, one string', async () => {
    const rendered = await openLaunch();

    await rendered.user.selectOptions(within(dialog()).getByLabelText('Model'), 'sonnet');
    await rendered.user.click(start());

    await within(details()).findByText(STARTING);
    expect(rendered.board.runs).toEqual([{ taskId: 'T1', agent: 'claude-code', model: 'sonnet' }]);
  });

  it('sends a full model name typed in, as it was typed', async () => {
    const rendered = await openLaunch();

    await rendered.user.selectOptions(within(dialog()).getByLabelText('Model'), 'other');
    await rendered.user.type(within(dialog()).getByLabelText('Model name'), 'claude-sonnet-4-6');
    await rendered.user.click(start());

    await within(details()).findByText(STARTING);
    expect(rendered.board.runs).toEqual([
      { taskId: 'T1', agent: 'claude-code', model: 'claude-sonnet-4-6' },
    ]);
  });

  it('refuses a model name the contract refuses, and sends nothing (INVARIANT)', async () => {
    const rendered = await openLaunch();

    await rendered.user.selectOptions(within(dialog()).getByLabelText('Model'), 'other');
    const name = within(dialog()).getByLabelText('Model name');
    await rendered.user.type(name, 'sonnet --dangerously-skip-permissions');

    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(start()).toBeDisabled();
    await rendered.user.type(name, '{Enter}');
    expect(rendered.board.calls).not.toContain('runTask');
  });

  it('starts with the model of the last run, and sends it again', async () => {
    const rendered = await openLaunch({ aiRun: aRun({ model: 'opus' }) });

    expect(within(dialog()).getByLabelText('Model')).toHaveValue('opus');
    await rendered.user.click(start());

    await within(details()).findByText(STARTING);
    expect(rendered.board.runs).toEqual([{ taskId: 'T1', agent: 'claude-code', model: 'opus' }]);
  });

  it('starts with a full name of the last run in the field for another model', async () => {
    await openLaunch({ aiRun: aRun({ model: 'claude-opus-5-5' }) });

    expect(within(dialog()).getByLabelText('Model')).toHaveValue('other');
    expect(within(dialog()).getByLabelText('Model name')).toHaveValue('claude-opus-5-5');
  });

  it('starts with the default of Claude Code when the last run named no model', async () => {
    await openLaunch({ aiRun: aRun() });

    expect(within(dialog()).getByLabelText('Model')).toHaveValue('');
  });

  it('shows the language in effect for the task, and says it is a setting of the task', async () => {
    await openLaunch({}, { workflow: { board: { reportLanguage: 'fi' }, statuses: {} } });

    const select = await languageSelect();
    expect(select).toHaveValue('fi');
    expect(select).toHaveAccessibleDescription(/setting of this task/i);
  });

  it('saves a changed language to the task first, then asks for the run (INVARIANT)', async () => {
    const rendered = await openLaunch({ workflow: { push: true } });

    await rendered.user.selectOptions(await languageSelect(), 'sv');
    const before = rendered.board.calls.length;
    await rendered.user.click(start());

    await within(details()).findByText(STARTING);
    const order = rendered.board.calls.slice(before).filter((c) => /updateTask|runTask/.test(c));
    expect(order).toEqual(['updateTask', 'runTask']);
    // The other settings of the task are kept; only the language is added to them.
    expect(rendered.board.tasks[0]?.workflow).toEqual({ push: true, reportLanguage: 'sv' });
    expect(rendered.board.runs).toEqual([{ taskId: 'T1', agent: 'claude-code' }]);
  });

  it('does not ask for the run when the language could not be saved (INVARIANT)', async () => {
    const rendered = await openLaunch();
    rendered.board.fail(
      'updateTask',
      new ApiError(500, 'INTERNAL_ERROR', 'The task could not be written.'),
    );

    await rendered.user.selectOptions(await languageSelect(), 'de');
    await rendered.user.click(start());

    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(
      'The task could not be written.',
    );
    expect(rendered.board.calls).not.toContain('runTask');
    expect(rendered.board.runs).toEqual([]);
  });

  it('says in the dialog what the board said when nothing waits to start Claude Code', async () => {
    const rendered = await openLaunch();
    rendered.board.fail(
      'runTask',
      new ApiError(
        409,
        'NO_AGENT_RUNNER',
        'Nothing is waiting to start Claude Code. Run `npx local-project-board claude --wait`.',
      ),
    );

    await rendered.user.click(start());

    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(
      'Nothing is waiting to start Claude Code.',
    );
    expect(within(details()).queryByText(STARTING)).not.toBeInTheDocument();
  });

  it('is cancelled without a request, and gives the focus back to the menu', async () => {
    const rendered = await openLaunch();

    await rendered.user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(rendered.board.calls).not.toContain('runTask');
    expect(within(details()).getByRole('button', { name: 'Send to AI' })).toHaveFocus();
  });
});

describe('the session of the run (T38)', () => {
  const resume = () => within(dialog()).getByRole('option', { name: /Resume/ });
  const sessionHint = () => within(dialog()).getByLabelText('Session');

  it('offers a new session, and Resume disabled with a reason, when there is no session', async () => {
    await openLaunch();

    expect(within(dialog()).getByLabelText('Session')).toHaveValue('new');
    expect(resume()).toBeDisabled();
    expect(sessionHint()).toHaveAccessibleDescription(/no session/i);
  });

  it('keeps Resume disabled while the runner cannot continue a session yet', async () => {
    await openLaunch({ aiRun: aRun() });

    expect(resume()).toBeDisabled();
    expect(sessionHint()).toHaveAccessibleDescription(/cannot continue a session yet/i);
  });

  it('cannot start while Claude Code is working on the task, and says why', async () => {
    const rendered = await openLaunch({ aiRun: aRun({ state: 'working' }) });

    expect(start()).toBeDisabled();
    expect(within(dialog()).getByText(/working on this task/i)).toBeVisible();
    expect(resume()).toBeDisabled();
    await rendered.user.click(start());
    expect(rendered.board.calls).not.toContain('runTask');
  });
});

describe('the dialog from the menu of a card (T38)', () => {
  it('is the same dialog, for the task of the card', async () => {
    const rendered = await renderBoard({ tasks: [todo()] });

    await rendered.user.click(screen.getByRole('button', { name: 'Actions for T1' }));
    await rendered.user.click(screen.getByRole('button', { name: 'Send to AI: Claude Code' }));
    await rendered.user.selectOptions(await screen.findByLabelText('Model'), 'haiku');
    await rendered.user.click(start());

    await screen.findByText(STARTING);
    expect(rendered.board.runs).toEqual([{ taskId: 'T1', agent: 'claude-code', model: 'haiku' }]);
  });
});
