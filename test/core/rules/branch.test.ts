import { taskBranchName } from '../../../src/core/index.js';

describe('taskBranchName', () => {
  it('is `task/<ID>-<slug>` with the slug taken from the title', () => {
    expect(taskBranchName('T13', 'AI workflow model')).toBe('task/T13-ai-workflow-model');
  });

  it('lower-cases the title and turns every run of other characters into one dash', () => {
    expect(taskBranchName('T2', '  Fix:  the --  "git" adapter!! ')).toBe(
      'task/T2-fix-the-git-adapter',
    );
    expect(taskBranchName('T7', 'CI: filter main/master')).toBe('task/T7-ci-filter-main-master');
  });

  it('keeps digits', () => {
    expect(taskBranchName('T14', 'API v1 for settings')).toBe('task/T14-api-v1-for-settings');
  });

  it('does not transliterate Cyrillic: only the Latin words of a title are kept (decision)', () => {
    expect(
      taskBranchName('T15', 'AI workflow: handoff задачи, сгенерированный из effective-настроек'),
    ).toBe('task/T15-ai-workflow-handoff-effective');
  });

  it('is just the id when the title has no Latin word at all', () => {
    expect(taskBranchName('T21', 'Пересмотреть настройки')).toBe('task/T21');
    expect(taskBranchName('T22', '!!! ???')).toBe('task/T22');
  });

  it('drops the accents of a Latin letter instead of splitting the word', () => {
    expect(taskBranchName('T3', 'Käyttöliittymä för användare')).toBe(
      'task/T3-kayttoliittyma-for-anvandare',
    );
  });

  it('cuts the slug at a whole word, so a branch name stays short', () => {
    const name = taskBranchName(
      'T8',
      'A very long title that goes on and on and on and never seems to stop at all',
    );

    expect(name).toBe('task/T8-a-very-long-title-that-goes-on-and-on');
    expect(name.slice('task/T8-'.length).length).toBeLessThanOrEqual(40);
  });

  it('cuts a single word that is longer than the limit', () => {
    const name = taskBranchName('T9', 'x'.repeat(100));

    expect(name).toBe(`task/T9-${'x'.repeat(40)}`);
  });

  it('is deterministic and only ever a valid ref name (no spaces, no leading or trailing dash)', () => {
    for (const title of ['Ünïcode -- ##', 'a', '-a-', 'UPPER lower 123']) {
      const name = taskBranchName('T1', title);
      expect(taskBranchName('T1', title)).toBe(name);
      expect(name).toMatch(/^task\/T1(-[a-z0-9]+(-[a-z0-9]+)*)?$/);
    }
  });
});
