import { act, screen, waitFor, within } from '@testing-library/react';
import type { Check } from '../../../src/contract/v1/index';
import { setLanguage } from '../../../src/web/shared/i18n/index';
import { aCheck, aTask, aTopic } from '../support/fixtures';
import { renderBoard } from '../support/render';
import { findTopDialog, topDialog } from '../support/taskDetails';

/**
 * The research, the report and the series of checks in languages with other plural forms and
 * another direction than German (Russian, Arabic), and a dialog that is open while the language
 * changes. What the agent wrote in a report stays as it was written.
 */

async function choose(user: Awaited<ReturnType<typeof renderBoard>>['user'], code: string) {
  await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), code);
}

describe('a research and its report in Russian', () => {
  const task = aTask({ id: 'T1', title: 'Ship it', status: 'todo' });

  async function openReport() {
    const rendered = await renderBoard({ tasks: [task], checks: { T1: [aCheck()] } });
    await choose(rendered.user, 'ru');
    await rendered.user.click(screen.getByRole('button', { name: 'Ship it' }));
    const details = await findTopDialog();
    const checks = await within(details).findByRole('region', { name: 'Исследование ИИ' });
    await rendered.user.click(await within(checks).findByRole('button', { name: 'Открыть T1-C1' }));
    return { ...rendered, details };
  }

  it('translates the sections and the decisions, and keeps the report as the agent wrote it', async () => {
    await openReport();

    const dialog = await findTopDialog();
    const report = within(dialog);
    for (const heading of ['Резюме', 'Рекомендации', 'Находки']) {
      expect(await report.findByRole('heading', { name: heading })).toBeInTheDocument();
    }
    expect(report.getAllByRole('button', { name: /^Принять / }).length).toBeGreaterThan(0);
    expect(report.getAllByRole('button', { name: /^Отклонить / }).length).toBeGreaterThan(0);
    expect(report.getAllByRole('button', { name: 'Закрыть' }).length).toBeGreaterThan(0);
    expect(report.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    // The summary and the findings are the agent's words.
    expect(report.getByText('One path moved.')).toBeInTheDocument();
    expect(report.getByText('The adapter was moved')).toBeInTheDocument();
  });

  it('asks for a new research in Russian and sends the same request', async () => {
    const { user, board, details } = await openReport();
    await user.click(within(topDialog()).getAllByRole('button', { name: 'Закрыть' })[0]!);

    await user.click(within(details).getByRole('button', { name: 'Новое исследование…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Новое исследование задачи T1' });
    await user.type(within(dialog).getByLabelText(/^Фокус/), 'the parser');
    await user.click(within(dialog).getByRole('button', { name: 'Начать исследование' }));

    await waitFor(() => expect(board.runs).toHaveLength(1));
    expect(board.runs[0]).toMatchObject({ taskId: 'T1', kind: 'research', comment: 'the parser' });
    expect(
      await within(details).findByText('Исследование задачи T1 передано Claude Code.'),
    ).toBeVisible();
  });
});

describe('the series of checks in Arabic', () => {
  const DONE_AT = '2026-11-10T10:00:00.000Z';
  const topic = aTopic({ id: 'P1', title: 'Alpha', blocks: [{ id: 'K1', title: 'Design' }] });
  const at = { topic: 'P1', block: 'K1' };

  it('says the progress and the state of each task in the language, and keeps the titles', async () => {
    const reported = aCheck({}, 'T2', 1) as Check;
    reported.begin.trigger = { reason: 'task-done', task: 'T1', doneAt: DONE_AT };
    const rendered = await renderBoard({
      topics: [topic],
      tasks: [
        aTask({ id: 'T1', title: 'Source', status: 'done', doneAt: DONE_AT, rank: 'a0', ...at }),
        aTask({ id: 'T2', title: 'Second', status: 'todo', rank: 'a1', ...at }),
        aTask({ id: 'T3', title: 'Third', status: 'todo', rank: 'a2', ...at }),
      ],
      checks: { T2: [reported] },
    });
    await choose(rendered.user, 'ar');
    await rendered.user.click(screen.getByRole('button', { name: 'Source' }));

    const panel = await screen.findByRole('region', { name: 'سلسلة الفحوصات' });
    expect(await within(panel).findByText('تم فحص 1 من 2')).toBeVisible();
    expect(within(panel).getByText('Second', { exact: false })).toBeVisible();
    expect(within(panel).getByText('تم الفحص')).toBeVisible();
    expect(within(panel).getByText('لم يُفحص')).toBeVisible();
    expect(within(panel).getByRole('button', { name: 'فحص T3' })).toBeInTheDocument();
  });
});

describe('a dialog that is open while the language changes', () => {
  it('is drawn again in the new language', async () => {
    const rendered = await renderBoard({
      tasks: [aTask({ id: 'T1', title: 'Ship it', status: 'todo' })],
    });
    await rendered.user.click(screen.getByRole('button', { name: 'Ship it' }));
    await rendered.user.click(await screen.findByRole('button', { name: 'Send to AI' }));
    await rendered.user.click(screen.getByRole('button', { name: 'Claude Code' }));
    await screen.findByRole('dialog', { name: 'Start Claude Code on T1' });

    act(() => setLanguage('de'));

    const dialog = await screen.findByRole('dialog', { name: 'Claude Code für T1 starten' });
    expect(within(dialog).getByRole('button', { name: 'Starten' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Modell')).toBeInTheDocument();
    act(() => setLanguage('en'));
  });
});
