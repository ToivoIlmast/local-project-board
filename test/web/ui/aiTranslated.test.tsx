import { screen, waitFor, within } from '@testing-library/react';
import type { AiRun, Task } from '../../../src/contract/v1/index';
import { UI_LANGUAGES, formatMessage } from '../../../src/web/shared/i18n/index';
import { lookup } from '../../../src/web/shared/i18n/catalog';
import { taskCatalogs } from '../../../src/web/features/tasks/i18n/details';
import { aResearch, aTask } from '../support/fixtures';
import { renderBoard, type RenderedBoard } from '../support/render';

/**
 * The AI part of a task in another language (German here): the menu, the dialog that starts
 * Claude Code, the state and the history of a run. What is sent to the board, and the text the
 * board wrote for the agent, stay as they are whatever language the page is shown in.
 */

type TaskKey = keyof typeof taskCatalogs.en;

const failedRun: AiRun = {
  agent: 'claude-code',
  state: 'failed',
  runId: 2,
  sessionId: '0b5c0a1e-6c9b-4b8e-9c55-8f1d2a3b4c5d',
  mode: 'new',
  model: 'sonnet',
  failure: { kind: 'exit', message: 'process exited with code 3', exitCode: 3 },
};

const todo = (extra: Partial<Task> = {}): Task =>
  aTask({ id: 'T1', title: 'Ship it', status: 'todo', ...extra });

async function openGerman(extra: Partial<Task> = {}, options = {}): Promise<RenderedBoard> {
  const rendered = await renderBoard({ tasks: [todo(extra)], ...options });
  await rendered.user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'de');
  await rendered.user.click(screen.getByRole('button', { name: 'Ship it' }));
  await screen.findByRole('complementary', { name: 'Aufgabe T1' });
  return rendered;
}

const details = () => screen.getByRole('complementary', { name: 'Aufgabe T1' });
const dialog = () => screen.getByRole('dialog', { name: 'Claude Code für T1 starten' });

describe('Send to AI in another language', () => {
  it('translates the menu and the dialog, and sends the same request', async () => {
    const rendered = await openGerman({ aiRun: failedRun });

    await rendered.user.click(within(details()).getByRole('button', { name: 'An KI senden' }));
    expect(screen.getByRole('button', { name: 'Übergabe kopieren' })).toBeInTheDocument();
    await rendered.user.click(screen.getByRole('button', { name: 'Claude Code' }));

    for (const label of ['Modell', 'Sitzung']) {
      expect(within(dialog()).getByLabelText(label)).toBeInTheDocument();
    }
    expect(within(dialog()).getByLabelText(/^Sprache des Berichts/)).toBeInTheDocument();
    expect(within(dialog()).getByRole('option', { name: 'Neue Sitzung' })).toBeInTheDocument();
    expect(within(dialog()).queryByLabelText('Session')).not.toBeInTheDocument();

    await rendered.user.selectOptions(within(dialog()).getByLabelText('Sitzung'), 'resume');
    await rendered.user.click(within(dialog()).getByRole('button', { name: 'Starten' }));

    expect(await within(details()).findByText(/^T1 wurde an den Runner/)).toBeVisible();
    // The request is the contract's, in no language.
    expect(rendered.board.runs).toEqual([
      { taskId: 'T1', agent: 'claude-code', model: 'sonnet', mode: 'resume' },
    ]);
  });

  it('copies the handoff of the board byte for byte, whatever the language', async () => {
    const rendered = await openGerman({ body: 'Do the thing.', labels: ['ai'] });

    await rendered.user.click(within(details()).getByRole('button', { name: 'An KI senden' }));
    await rendered.user.click(screen.getByRole('button', { name: 'Übergabe kopieren' }));

    expect(
      await within(details()).findByText('Übergabe in die Zwischenablage kopiert.'),
    ).toBeVisible();
    const expected = await rendered.board.client.handoff('T1');
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(expected));
    expect(expected).toContain('# Task T1: Ship it');
  });
});

describe('the run of a task in another language', () => {
  it('says the state, the failure and the way back in words of the language, and keeps the agent’s', async () => {
    await openGerman({ aiRun: failedRun, branch: 'task/T1-ship-it' });

    const block = within(details()).getByRole('region', { name: 'KI-Lauf' });
    const value = (term: string) => within(block).getByText(term).nextElementSibling?.textContent;
    expect(value('Zustand')).toBe('fehlgeschlagen');
    expect(value('Modell')).toBe('sonnet');
    expect(value('Versuch')).toBe('#2');
    expect(
      within(block).getByText(/Die Sitzung endete ohne Abschlussbericht \(Code 3\)/),
    ).toBeVisible();
    expect(within(block).getByRole('button', { name: 'Fortsetzen' })).toBeInTheDocument();
    expect(within(block).getByRole('button', { name: 'Neu starten' })).toBeInTheDocument();
  });

  it('shows the history of researches in the language, and the focus as it was written', async () => {
    await openGerman(
      {},
      {
        checks: { T1: [aResearch()] },
      },
    );

    const section = await within(details()).findByRole('region', { name: 'KI-Recherche' });
    await waitFor(() => expect(section).toHaveTextContent(/Recherche · Berichtet/));
    expect(within(section).getByText('Look at the git adapter only.')).toBeVisible();
    expect(within(section).getByRole('button', { name: 'T1-C1 öffnen' })).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Neue Recherche…' })).toBeInTheDocument();
  });
});

describe('the words of the AI part in every language', () => {
  const language = (code: (typeof UI_LANGUAGES)[number]) => ({
    say: (key: Parameters<typeof lookup<TaskKey>>[2], params?: Record<string, string | number>) =>
      formatMessage(code, lookup(taskCatalogs, code, key), params),
  });

  it.each(UI_LANGUAGES)('%s: names the state and the mode of a run differently', (code) => {
    const { say } = language(code);
    expect(say('ai.run.state')).not.toBe(say('ai.run.mode'));
  });

  it.each(UI_LANGUAGES)('%s: says one undecided recommendation in the singular', (code) => {
    const { say } = language(code);
    const one = say('ai.launch.undecided', { check: 'T1-C1', count: 1 });
    const many = say('ai.launch.undecided', { check: 'T1-C1', count: 5 });
    expect(one).toContain('1');
    if (['en', 'fi', 'sv', 'no', 'da', 'is', 'de'].includes(code)) expect(one).not.toBe(many);
  });
});
