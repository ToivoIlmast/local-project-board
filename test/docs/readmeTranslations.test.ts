import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTranslations, translationFiles } from '../support/translations.js';
import { commitAll, git, initRepo, writeRepoFile } from '../support/gitRepo.js';
import { cleanTmpDirs, tmpDir } from '../support/tmp.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

afterEach(cleanTmpDirs);

const header = (commit: string): string => `<!-- Based on README.md @ ${commit} -->\n\n# text\n`;

/** A repository whose README.md is committed and whose translations name that commit. */
async function inSyncRepo(
  languages: string[] = ['fi', 'sv'],
): Promise<{ dir: string; sha: string }> {
  const dir = await initRepo(await tmpDir());
  await writeRepoFile(dir, 'README.md', '# text\n');
  await commitAll(dir, 'readme');
  const sha = (await git(dir, 'rev-parse', 'HEAD')).trim();
  for (const language of languages) {
    await writeRepoFile(dir, `README.${language}.md`, header(sha));
  }
  if (languages.length > 0) await commitAll(dir, 'translations');
  return { dir, sha };
}

async function editReadme(dir: string, message: string): Promise<string> {
  await writeRepoFile(dir, 'README.md', `# text\n\n${message}\n`);
  await commitAll(dir, message);
  return (await git(dir, 'rev-parse', 'HEAD')).trim();
}

const problemsOf = (result: ReturnType<typeof checkTranslations>): string[] =>
  result.status === 'drift' ? result.problems : [];

describe('checkTranslations', () => {
  it('is satisfied when every translation names the commit that last changed README.md', async () => {
    const { dir } = await inSyncRepo();
    expect(checkTranslations(dir)).toEqual({ status: 'ok' });
  });

  it('is not disturbed by later commits that leave README.md alone', async () => {
    const { dir } = await inSyncRepo();
    await writeRepoFile(dir, 'other.txt', 'x\n');
    await commitAll(dir, 'something else');
    expect(checkTranslations(dir)).toEqual({ status: 'ok' });
  });

  it('accepts an abbreviated commit in the header', async () => {
    const { dir, sha } = await inSyncRepo([]);
    await writeRepoFile(dir, 'README.fi.md', header(sha.slice(0, 9)));
    await commitAll(dir, 'short header');
    expect(checkTranslations(dir)).toEqual({ status: 'ok' });
  });

  it('fails when README.md was changed after the translations were based on it (INVARIANT)', async () => {
    const { dir, sha } = await inSyncRepo();
    const changed = await editReadme(dir, 'a new promise');
    expect(problemsOf(checkTranslations(dir))).toEqual([
      `README.md changed in ${changed}, README.fi.md is based on ${sha}; update the translations and their header`,
      `README.md changed in ${changed}, README.sv.md is based on ${sha}; update the translations and their header`,
    ]);
  });

  it('names only the translation that was left behind', async () => {
    const { dir, sha } = await inSyncRepo();
    const changed = await editReadme(dir, 'a new promise');
    await writeRepoFile(dir, 'README.fi.md', header(changed));
    await commitAll(dir, 'fi caught up');
    expect(problemsOf(checkTranslations(dir))).toEqual([
      `README.md changed in ${changed}, README.sv.md is based on ${sha}; update the translations and their header`,
    ]);
  });

  it('returns to green when the headers are moved to the new commit', async () => {
    const { dir } = await inSyncRepo();
    const changed = await editReadme(dir, 'a new promise');
    await writeRepoFile(dir, 'README.fi.md', header(changed));
    await writeRepoFile(dir, 'README.sv.md', header(changed));
    await commitAll(dir, 'translations caught up');
    expect(checkTranslations(dir)).toEqual({ status: 'ok' });
  });

  it('finds translations by name, so a new language cannot be forgotten', async () => {
    const { dir, sha } = await inSyncRepo(['fi', 'sv', 'de']);
    const changed = await editReadme(dir, 'a new promise');
    await writeRepoFile(dir, 'README.fi.md', header(changed));
    await writeRepoFile(dir, 'README.sv.md', header(changed));
    await commitAll(dir, 'fi and sv caught up');
    expect(problemsOf(checkTranslations(dir))).toEqual([
      `README.md changed in ${changed}, README.de.md is based on ${sha}; update the translations and their header`,
    ]);
  });

  it.each([
    ['a placeholder instead of a commit', '<!-- Based on README.md @ uncommitted -->\n\n# text\n'],
    ['no header at all', '# text\n'],
    ['a header that is not on the first line', `\n${header('a'.repeat(40))}`],
    ['a commit that is too short to mean anything', header('abc12')],
  ])('fails for %s', async (_name, content) => {
    const { dir } = await inSyncRepo([]);
    await writeRepoFile(dir, 'README.fi.md', content);
    await commitAll(dir, 'broken header');
    const [problem, ...rest] = problemsOf(checkTranslations(dir));
    expect(rest).toEqual([]);
    expect(problem).toContain('README.fi.md');
    expect(problem).toContain('<!-- Based on README.md @ <commit> -->');
  });

  it('fails while README.md has changes that are not committed yet', async () => {
    const { dir } = await inSyncRepo();
    await writeRepoFile(dir, 'README.md', '# text\n\nnot committed\n');
    const problems = problemsOf(checkTranslations(dir));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('README.md has changes that are not committed');
  });

  describe('when there is nothing to compare with', () => {
    it('reports that outside a git repository instead of passing', async () => {
      const dir = await tmpDir();
      await writeRepoFile(dir, 'README.md', '# text\n');
      await writeRepoFile(dir, 'README.fi.md', header('a'.repeat(40)));
      const result = checkTranslations(dir);
      expect(result.status).toBe('unavailable');
      expect(result.status === 'unavailable' && result.reason).toMatch(/not a git checkout/);
    });

    it('does not borrow the history of a repository the package merely sits inside', async () => {
      const { dir } = await inSyncRepo();
      const inner = join(dir, 'unpacked');
      await mkdir(inner);
      await writeRepoFile(inner, 'README.md', '# text\n');
      await writeRepoFile(inner, 'README.fi.md', header('a'.repeat(40)));
      expect(checkTranslations(inner).status).toBe('unavailable');
    });

    it('reports a shallow clone, whose history cannot say when README.md last changed', async () => {
      const { dir } = await inSyncRepo();
      await editReadme(dir, 'a new promise');
      const clone = join(await tmpDir(), 'clone');
      execFileSync('git', ['clone', '-q', '--depth', '1', `file://${dir}`, clone]);
      const result = checkTranslations(clone);
      expect(result.status).toBe('unavailable');
      expect(result.status === 'unavailable' && result.reason).toMatch(/shallow/);
    });

    it('reports a repository where README.md has no history yet', async () => {
      const dir = await initRepo(await tmpDir());
      await writeRepoFile(dir, 'a.txt', 'a\n');
      await commitAll(dir, 'no readme');
      await writeRepoFile(dir, 'README.md', '# text\n');
      expect(checkTranslations(dir).status).toBe('unavailable');
    });
  });
});

/**
 * The real repository. Without a full git checkout there is nothing to compare with, and that
 * is said out loud: the test is reported as skipped, with the reason, never as passed. In CI
 * a missing checkout is a failure, because the check is worth nothing where it silently
 * does not run.
 */
describe('the translations of this repository', () => {
  const real = checkTranslations(ROOT);
  const skipped = real.status === 'unavailable' && !process.env['CI'];
  if (real.status === 'unavailable' && skipped) {
    console.warn(`README translations were NOT verified: ${real.reason}`);
  }

  const title = 'are based on the current README.md (INVARIANT)';
  (skipped ? it.skip : it)(
    skipped && real.status === 'unavailable' ? `${title} — SKIPPED: ${real.reason}` : title,
    () => {
      if (real.status === 'unavailable') {
        throw new Error(`README translations cannot be verified in CI: ${real.reason}`);
      }
      expect(problemsOf(real)).toEqual([]);
    },
  );

  it('are the Finnish and the Swedish README, found by name', () => {
    expect(translationFiles(ROOT)).toEqual(['README.fi.md', 'README.sv.md']);
  });
});
