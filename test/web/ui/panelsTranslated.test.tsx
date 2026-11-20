import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { setLanguage, type UiLanguage } from '../../../src/web/shared/i18n/index';
import { STATUSES, aGitStatus, aProject, aReport, aTask, aTopic } from '../support/fixtures';
import { renderBoard } from '../support/render';

afterEach(() => setLanguage('en'));

/** The language is chosen as a person does: in the list of the header, named in English first. */
const choose = (user: UserEvent, language: UiLanguage) =>
  user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), language);

/** The words of the one language that the two runs below are done in. */
const WORDS = {
  en: {
    settings: 'Settings',
    board: 'Board',
    column: 'Column todo',
    save: 'Save',
    reportLanguage: 'Report language',
    push: 'Push',
  },
  de: {
    settings: 'Einstellungen',
    board: 'Board',
    // A standard status is named as the board names it (T4), a custom one as it is written.
    column: 'Spalte Zu erledigen',
    save: 'Speichern',
    reportLanguage: 'Berichtssprache',
    push: 'Pushen',
  },
} as const;

async function saveSettings(language: UiLanguage & keyof typeof WORDS) {
  const words = WORDS[language];
  const { user, board } = await renderBoard();
  await choose(user, language);

  await user.click(screen.getByRole('button', { name: words.settings }));
  const panel = await screen.findByRole('complementary', { name: words.settings });
  const group = within(panel).getByRole('group', { name: words.board });
  expect(within(panel).getByRole('group', { name: words.column })).toBeInTheDocument();

  await user.click(within(group).getByRole('checkbox', { name: words.push }));
  // The languages are named in the language of the page; what is chosen is the code.
  const select = within(group).getByLabelText(words.reportLanguage);
  await user.selectOptions(select, 'fi');
  await user.click(within(panel).getByRole('button', { name: words.save }));

  await waitFor(() =>
    expect(board.workflow).toEqual({
      board: { push: true, reportLanguage: 'fi' },
      statuses: {},
    }),
  );
  return { panel, select };
}

const commits = [
  {
    sha: '9f1c1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b',
    subject: 'Extract the git status parser',
    author: 'Toivo',
    date: '2026-09-21T11:30:00.000Z',
  },
];

const changedGit = () =>
  aGitStatus({
    branch: 'feat/ui',
    clean: false,
    files: [{ path: 'src/a.ts', staged: true, status: 'modified' }],
  });

/** The text of the definition next to a term of "also in effect" in the AI block of a task. */
const valueOf = (scope: HTMLElement, term: string): string =>
  within(scope).getByText(term).closest('div')?.querySelector('dd')?.textContent ?? '';

describe('the side panels in another language', () => {
  it.each([
    ['en', 'Finnish', 'English (default)'],
    ['de', 'Finnisch', 'Englisch (Standard)'],
  ] as const)(
    'sends the same settings in %s as in any other language',
    async (language, finnish, english) => {
      const { select } = await saveSettings(language);
      // The option shows the name in the language of the page and keeps the code as its value.
      expect(within(select).getByRole('option', { name: finnish })).toHaveValue('fi');
      expect(within(select).getByRole('option', { name: english })).toHaveValue('');
    },
  );

  it('translates the frame of the settings and of the reports, and not what an agent wrote', async () => {
    const reports = [aReport({ id: 'R1', title: 'Dependency audit', format: 'md' })];
    const { user } = await renderBoard({ reports });
    await choose(user, 'de');

    await user.click(screen.getByRole('button', { name: 'Einstellungen' }));
    const settings = await screen.findByRole('complementary', { name: 'Einstellungen' });
    expect(within(settings).getByText('KI-Workflow')).toBeInTheDocument();
    expect(within(settings).getByText('Spalten')).toBeInTheDocument();
    expect(within(settings).getAllByLabelText('Code bearbeiten')).not.toHaveLength(0);
    expect(within(settings).getAllByLabelText('Prüfbefehl')).not.toHaveLength(0);
    expect(within(settings).queryByText('Edit code')).not.toBeInTheDocument();
    expect(within(settings).getByRole('group', { name: 'Spalte Backlog' })).toBeInTheDocument();
    await user.click(within(settings).getByRole('button', { name: 'Schließen' }));

    await user.click(screen.getByRole('button', { name: 'Berichte' }));
    const panel = await screen.findByRole('complementary', { name: 'Berichte' });
    expect(within(panel).getByRole('button', { name: 'Dependency audit' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'R1 löschen' })).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Dependency audit' }));
    expect(await within(panel).findByRole('region', { name: 'Bericht R1' })).toBeInTheDocument();
  });

  it('translates the topics, and keeps their titles', async () => {
    const topics = [aTopic({ id: 'P1', title: 'Platform work' })];
    const { user } = await renderBoard({ topics });
    await choose(user, 'de');

    await user.click(screen.getByRole('button', { name: 'Themen' }));
    const panel = await screen.findByRole('complementary', { name: 'Themen' });
    expect(within(panel).getByText('Platform work')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'P1 bearbeiten' })).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Neues Thema' }));
    expect(within(panel).getByLabelText('Titel')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Erstellen' })).toBeDisabled();
  });
});

describe('the statuses in the settings', () => {
  it('names the standard statuses in the language shown, keeps a custom one, and saves the status itself', async () => {
    const { user, board } = await renderBoard({
      project: aProject({ statuses: [...STATUSES, 'review'] }),
    });
    await choose(user, 'de');
    await user.click(screen.getByRole('button', { name: 'Einstellungen' }));
    const panel = await screen.findByRole('complementary', { name: 'Einstellungen' });

    for (const name of ['Backlog', 'Zu erledigen', 'In Arbeit', 'Erledigt', 'review']) {
      expect(within(panel).getByRole('group', { name: `Spalte ${name}` })).toBeInTheDocument();
    }
    expect(within(panel).queryByRole('group', { name: 'Spalte todo' })).not.toBeInTheDocument();

    const group = within(panel).getByRole('group', { name: 'Board' });
    const start = within(group).getByLabelText('Status beim Start der Arbeit');
    expect(within(start).getByRole('option', { name: 'Standard (In Arbeit)' })).toHaveValue(
      'default',
    );
    expect(within(start).getByRole('option', { name: 'In Arbeit' })).toHaveValue(
      'status:in-progress',
    );
    expect(within(start).getByRole('option', { name: 'review' })).toHaveValue('status:review');

    await user.selectOptions(start, 'Erledigt');
    await user.click(within(panel).getByRole('button', { name: 'Speichern' }));
    await waitFor(() =>
      expect(board.workflow).toEqual({ board: { startStatus: 'done' }, statuses: {} }),
    );
  });

  it('leaves a status the board does not have as it is written', async () => {
    const { user } = await renderBoard({
      workflow: { board: { startStatus: 'gone' }, statuses: { archive: { push: true } } },
    });
    await choose(user, 'de');
    await user.click(screen.getByRole('button', { name: 'Einstellungen' }));
    const panel = await screen.findByRole('complementary', { name: 'Einstellungen' });

    expect(within(panel).getByRole('alert')).toHaveTextContent('Spalte „archive“');
    const stale = within(panel).getByRole('group', {
      name: 'Spalte archive (kein Status dieses Boards)',
    });
    expect(within(stale).getByText('Pushen: ein')).toBeInTheDocument();
    expect(
      within(stale).getByRole('button', { name: 'Einstellungen von archive entfernen' }),
    ).toBeInTheDocument();
    const group = within(panel).getByRole('group', { name: 'Board' });
    expect(within(group).getByLabelText('Status beim Start der Arbeit')).toHaveDisplayValue(
      'gone (kein Status dieses Boards)',
    );
  });
});

describe('the AI settings of a task in another language', () => {
  it('says the sentences made of the words of the settings in that language only', async () => {
    const { user } = await renderBoard({
      tasks: [aTask({ id: 'T1', title: 'Ship it', status: 'todo' })],
      workflow: { board: { checkCommand: 'npm test' }, statuses: { todo: { push: true } } },
    });
    await choose(user, 'de');
    await user.click(screen.getByRole('button', { name: 'Ship it' }));
    const details = await screen.findByRole('complementary', { name: 'Aufgabe T1' });
    const ai = within(details).getByRole('region', { name: 'AI' });
    // The rest of the block is translated with the AI part of a task (T6).
    await user.click(within(ai).getByRole('button', { name: 'Customize for this task' }));
    const push = within(ai).getByLabelText('Pushen');
    await waitFor(() => expect(push).toHaveAccessibleDescription(/^Wirksam/));

    expect(push).toHaveDisplayValue('Erben (jetzt ein, aus der Spalte Zu erledigen)');
    expect(push).toHaveAccessibleDescription('Wirksam: ein, aus der Spalte Zu erledigen.');
    expect(within(ai).getByLabelText('Committen')).toHaveAccessibleDescription(
      'Wirksam: ein, aus dem Standard.',
    );
    const language = within(ai).getByLabelText('Berichtssprache');
    expect(language).toHaveDisplayValue('Wie das Board (jetzt Englisch, aus dem Standard)');
    expect(language).toHaveAccessibleDescription(/ Wirksam: Englisch, aus dem Standard\.$/);
    expect(valueOf(ai, 'Status beim Start der Arbeit')).toBe('In Arbeit, aus dem Standard');
    expect(valueOf(ai, 'Prüfbefehl')).toBe('npm test, aus dem Board');

    await user.selectOptions(push, 'Aus');
    expect(push).toHaveAccessibleDescription(
      'Wirksam: ein, aus der Spalte Zu erledigen. Noch nicht gespeichert.',
    );

    const english = /\b(Inherit|In effect|from|Like the board|Not saved|Reading)\b/;
    for (const control of within(ai).getAllByRole('combobox')) {
      expect(control).not.toHaveAccessibleDescription(english);
      for (const option of within(control).getAllByRole('option')) {
        expect(option.textContent).not.toMatch(english);
      }
    }
    for (const value of ai.querySelectorAll('dd')) expect(value.textContent).not.toMatch(english);
  });
});

describe('the git panel in another language', () => {
  it('translates its words and shows what git gave as it is', async () => {
    const { user } = await renderBoard({ git: changedGit(), commits });
    await choose(user, 'de');

    await user.click(screen.getByRole('button', { name: 'Git' }));
    const panel = await screen.findByRole('complementary', { name: 'Git' });
    expect(within(panel).getByText('feat/ui')).toBeInTheDocument();
    expect(within(panel).getByText('nicht committete Änderungen')).toBeInTheDocument();
    expect(within(panel).getByRole('heading', { name: 'Geänderte Dateien' })).toBeInTheDocument();
    expect(within(panel).getByText('gestaged modified')).toBeInTheDocument();
    expect(within(panel).getByRole('heading', { name: 'Letzte Commits' })).toBeInTheDocument();
    expect(await within(panel).findByText('Extract the git status parser')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Schließen' })).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'src/a.ts' }));
    expect(await within(panel).findByRole('region', { name: 'Diff von src/a.ts' })).toBeVisible();
    expect(within(panel).getByRole('region', { name: 'Diff-Text' })).toHaveTextContent(
      '@@ -1 +1 @@',
    );
  });

  it.each([
    ['fi', 'committaamattomia muutoksia'],
    ['is', 'breytingar sem ekki hafa verið commit-aðar'],
  ] as const)(
    'says in %s that the changes are not committed, not that they are unsaved',
    async (language, dirty) => {
      const { user } = await renderBoard({ git: changedGit() });
      await choose(user, language);

      await user.click(screen.getByRole('button', { name: 'Git' }));
      const panel = await screen.findByRole('complementary', { name: 'Git' });
      expect(within(panel).getByText(dirty)).toBeInTheDocument();
    },
  );
});

describe('technical text on a page that reads right to left', () => {
  it('writes the branch, the paths, the commits and the diff left to right', async () => {
    const { user } = await renderBoard({ git: changedGit(), commits });
    await choose(user, 'ar');
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');

    await user.click(screen.getByRole('button', { name: 'Git' }));
    const panel = await screen.findByRole('complementary', { name: 'Git' });
    expect(within(panel).getByText('feat/ui')).toHaveAttribute('dir', 'ltr');
    expect(within(panel).getByRole('button', { name: 'src/a.ts' })).toHaveAttribute('dir', 'ltr');
    expect(await within(panel).findByText('9f1c1a2')).toHaveAttribute('dir', 'ltr');
    // A subject may be in any language: it is isolated and takes its own direction.
    expect(within(panel).getByText('Extract the git status parser').tagName).toBe('BDI');

    await user.click(within(panel).getByRole('button', { name: 'src/a.ts' }));
    const diff = await within(panel).findByRole('region', { name: 'الفروق في src/a.ts' });
    expect(within(diff).getByRole('heading', { name: 'src/a.ts' })).toHaveAttribute('dir', 'ltr');
    expect(within(diff).getByRole('region', { name: 'نص الفروق' })).toHaveAttribute('dir', 'ltr');
    // The panel itself keeps the direction of the page.
    expect(panel).not.toHaveAttribute('dir');
  });

  it('keeps the words of a detached HEAD in the direction of the page', async () => {
    const { user } = await renderBoard({ git: aGitStatus({ branch: null }) });
    await choose(user, 'ar');

    await user.click(screen.getByRole('button', { name: 'Git' }));
    const panel = await screen.findByRole('complementary', { name: 'Git' });
    expect(within(panel).getByText('HEAD منفصل')).not.toHaveAttribute('dir');
  });

  it('writes the base branch and the check command left to right', async () => {
    const { user } = await renderBoard();
    await choose(user, 'ar');

    await user.click(screen.getByRole('button', { name: 'الإعدادات' }));
    const panel = await screen.findByRole('complementary', { name: 'الإعدادات' });
    expect(within(panel).getByLabelText('الفرع الأساسي')).toHaveAttribute('dir', 'ltr');
    expect(within(panel).getByLabelText('أمر الفحص')).toHaveAttribute('dir', 'ltr');
  });
});

describe('a side panel open while the language changes', () => {
  it('follows the new language at once, the sentences of the model too', async () => {
    const { user } = await renderBoard({
      workflow: { board: {}, statuses: { archive: { push: true } } },
    });
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const before = await screen.findByRole('complementary', { name: 'Settings' });
    expect(within(before).getByRole('group', { name: 'Column todo' })).toBeInTheDocument();

    await choose(user, 'fr');

    const panel = screen.getByRole('complementary', { name: 'Paramètres' });
    expect(within(panel).getByRole('group', { name: 'Colonne à faire' })).toBeInTheDocument();
    const todo = within(panel).getByRole('group', { name: 'Colonne à faire' });
    expect(within(todo).getByLabelText('Push')).toHaveAccessibleDescription(
      'En vigueur : désactivé, depuis le défaut.',
    );
    // The names of the languages start with a capital in a list, as a French list writes them.
    const language = within(panel).getByLabelText('Langue du rapport');
    expect(within(language).getByRole('option', { name: 'Finnois' })).toHaveValue('fi');
    expect(within(language).getByRole('option', { name: 'Anglais (par défaut)' })).toHaveValue('');
    // French puts a space before a colon.
    expect(within(panel).getByText('Push : activé')).toBeInTheDocument();
    expect(within(panel).queryByText(/In effect|Column/)).not.toBeInTheDocument();
  });
});

describe('the question about unsaved changes, with the words of the side panels', () => {
  it.each([
    [
      'de',
      'Themen',
      'Neues Thema',
      'Titel',
      'Einstellungen',
      'Es gibt nicht gespeicherte Änderungen an dem neuen Thema.',
    ],
    [
      'pt',
      'Tópicos',
      'Novo tópico',
      'Título',
      'Configurações',
      'Você tem alterações não salvas em um novo tópico.',
    ],
    [
      'is',
      'Efni',
      'Nýtt efni',
      'Titill',
      'Stillingar',
      'Þú ert með óvistaðar breytingar á nýja efninu.',
    ],
  ] as const)(
    'names a new topic in %s as the sentence needs it',
    async (language, topics, create, title, settings, sentence) => {
      const { user } = await renderBoard();
      await choose(user, language);
      await user.click(screen.getByRole('button', { name: topics }));
      const panel = await screen.findByRole('complementary', { name: topics });
      await user.click(within(panel).getByRole('button', { name: create }));
      await user.type(within(panel).getByLabelText(title), 'Platform work');

      await user.click(screen.getByRole('button', { name: settings }));

      expect(await screen.findByRole('dialog')).toHaveTextContent(sentence);
    },
  );

  it('names the settings of the board in German as the sentence needs them', async () => {
    const { user } = await renderBoard();
    await choose(user, 'de');
    await user.click(screen.getByRole('button', { name: 'Einstellungen' }));
    const panel = await screen.findByRole('complementary', { name: 'Einstellungen' });
    const group = within(panel).getByRole('group', { name: 'Board' });
    await user.click(within(group).getByRole('checkbox', { name: 'Pushen' }));

    await user.click(screen.getByRole('button', { name: 'Berichte' }));

    expect(await screen.findByRole('dialog')).toHaveTextContent(
      'Es gibt nicht gespeicherte Änderungen an den KI-Workflow-Einstellungen des Boards und seiner Spalten.',
    );
  });
});
