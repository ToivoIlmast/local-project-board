import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export type TranslationCheck =
  | { status: 'ok' }
  | { status: 'drift'; problems: string[] }
  | { status: 'unavailable'; reason: string };

const HEADER = /^<!-- Based on README\.md @ ([0-9a-f]{7,40}) -->$/;
const HEADER_FORM = '<!-- Based on README.md @ <commit> -->';

/** README.fi.md, README.sv.md, ...: found by name, so a new language cannot be forgotten. */
export function translationFiles(root: string): string[] {
  return readdirSync(root)
    .filter((name) => /^README\.[a-z]{2,3}\.md$/.test(name))
    .sort();
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
}

/** Why the history cannot be trusted to answer, or undefined when it can. */
function whyUnavailable(root: string): string | undefined {
  try {
    // Sitting inside somebody else's repository (an unpacked package in a project) is not
    // being a checkout of this one.
    if (realpathSync(git(root, 'rev-parse', '--show-toplevel')) !== realpathSync(root)) {
      return 'not a git checkout (the directory is inside another repository)';
    }
    if (git(root, 'rev-parse', '--is-shallow-repository') === 'true') {
      return 'shallow clone: the history is cut off, so the last change to README.md is unknown (fetch full history)';
    }
    if (git(root, 'log', '-1', '--format=%H', '--', 'README.md') === '') {
      return 'README.md has no commit in this repository yet';
    }
  } catch {
    return 'not a git checkout (or git is not installed)';
  }
  return undefined;
}

/**
 * Compares the commit named in each translation's first line with the last commit that changed
 * README.md (docs/PROPOSAL.ru.md §27). Synchronous, so a test file can decide at load time
 * whether to run or to be reported as skipped.
 */
export function checkTranslations(root: string): TranslationCheck {
  const reason = whyUnavailable(root);
  if (reason !== undefined) return { status: 'unavailable', reason };

  const last = git(root, 'log', '-1', '--format=%H', '--', 'README.md');
  const problems: string[] = [];

  if (git(root, 'status', '--porcelain', '--', 'README.md') !== '') {
    problems.push(
      'README.md has changes that are not committed; commit it, then set the translation headers to that commit',
    );
  }

  for (const file of translationFiles(root)) {
    const firstLine = readFileSync(join(root, file), 'utf8').split('\n')[0]?.trimEnd() ?? '';
    const based = HEADER.exec(firstLine)?.[1];
    if (based === undefined) {
      problems.push(
        `${file}: the first line must be ${HEADER_FORM}, found ${JSON.stringify(firstLine)}`,
      );
    } else if (!last.startsWith(based)) {
      problems.push(
        `README.md changed in ${last}, ${file} is based on ${based}; update the translations and their header`,
      );
    }
  }

  return problems.length === 0 ? { status: 'ok' } : { status: 'drift', problems };
}
