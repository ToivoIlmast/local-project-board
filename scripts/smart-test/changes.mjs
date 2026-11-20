// @ts-check
/**
 * What changed: the work of this branch since it left the base branch, committed or not, plus
 * files git does not track yet. Whenever git cannot answer that reliably the result says why,
 * and the caller runs Full mode: a guessed change set must never shrink the tests.
 */
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * @typedef {'A' | 'M' | 'D'} ChangeStatus
 * @typedef {{ status: ChangeStatus, path: string }} Change
 *   A rename or copy is two changes, a deletion of the old path and an addition of the new one,
 *   so that both sides are followed.
 * @typedef {{
 *   ok: true,
 *   changes: Change[],
 *   base: string,
 *   mergeBase: string,
 *   commits: number,
 *   notes: string[],
 * }} ChangesFound
 * @typedef {{ ok: false, reason: string }} ChangesUnknown
 * @typedef {(args: string[]) => Promise<string>} Git  Runs git in the repository; rejects on failure.
 */

/** Base branches tried in order when none is given. A remote one keeps unpushed commits in. */
const BASE_CANDIDATES = ['origin/main', 'origin/master', 'main', 'master'];

/** States in which the working tree is half of something else: Smart mode cannot trust it. */
const IN_PROGRESS = [
  ['MERGE_HEAD', 'a merge'],
  ['CHERRY_PICK_HEAD', 'a cherry-pick'],
  ['REVERT_HEAD', 'a revert'],
  ['rebase-merge', 'a rebase'],
  ['rebase-apply', 'a rebase or `git am`'],
  ['BISECT_LOG', 'a bisect'],
];

/**
 * @param {string} cwd
 * @returns {Git}
 */
export function gitIn(cwd) {
  return (args) =>
    new Promise((resolvePromise, reject) => {
      execFile(
        'git',
        ['-c', 'core.quotepath=off', ...args],
        { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) reject(new Error(String(stderr || error.message).trim()));
          else resolvePromise(stdout);
        },
      );
    });
}

/**
 * @param {string} message
 * @returns {ChangesUnknown}
 */
const unknown = (message) => ({ ok: false, reason: message });

/** @param {string} path */
const canonical = (path) => {
  try {
    return realpathSync.native(path).toLowerCase();
  } catch {
    return resolve(path).toLowerCase();
  }
};

/**
 * Parses `git diff --name-status -z`: `M\0path\0`, `R100\0old\0new\0`.
 * @param {string} output
 * @returns {Change[]}
 */
export function parseNameStatus(output) {
  const fields = output.split('\0');
  /** @type {Change[]} */
  const changes = [];
  for (let i = 0; i < fields.length;) {
    const code = fields[i++] ?? '';
    if (code === '') continue;
    const kind = code[0];
    if (kind === 'R' || kind === 'C') {
      const from = fields[i++] ?? '';
      const to = fields[i++] ?? '';
      // A copy leaves the original in place; only a rename removes it.
      if (kind === 'R') changes.push({ status: 'D', path: from });
      changes.push({ status: 'A', path: to });
      continue;
    }
    const path = fields[i++] ?? '';
    if (kind === 'A') changes.push({ status: 'A', path });
    else if (kind === 'D') changes.push({ status: 'D', path });
    // M, T (type change), U (unmerged) and anything new: treat it as changed content.
    else changes.push({ status: 'M', path });
  }
  return changes;
}

/**
 * @param {Git} git
 * @param {string | undefined} requested
 * @returns {Promise<string | undefined>}
 */
async function findBase(git, requested) {
  const candidates = requested !== undefined ? [requested] : [];
  if (requested === undefined) {
    const originHead = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
      .then((out) => out.trim())
      .catch(() => '');
    if (originHead !== '') candidates.push(originHead);
    candidates.push(...BASE_CANDIDATES);
  }
  for (const ref of candidates) {
    const ok = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).then(
      () => true,
      () => false,
    );
    if (ok) return ref;
  }
  return undefined;
}

/**
 * @param {{ root: string, git?: Git, base?: string | undefined }} options
 * @returns {Promise<ChangesFound | ChangesUnknown>}
 */
export async function collectChanges({ root, git = gitIn(root), base: requestedBase }) {
  /** @type {string} */
  let top;
  try {
    top = (await git(['rev-parse', '--show-toplevel'])).trim();
  } catch (error) {
    return unknown(`not a git checkout, or git is unavailable (${messageOf(error)})`);
  }
  // A copy of the project that merely sits inside another repository has no history of its own.
  if (canonical(top) !== canonical(root)) {
    return unknown(`the git repository found is ${top}, not this project's root`);
  }

  for (const [marker, what] of IN_PROGRESS) {
    const path = (await git(['rev-parse', '--git-path', marker ?? ''])).trim();
    if (existsSync(resolve(root, path))) {
      return unknown(`git is in the middle of ${what}; finish or abort it first`);
    }
  }

  const unmerged = (await git(['diff', '--name-only', '--diff-filter=U'])).trim();
  if (unmerged !== '') return unknown('there are unresolved merge conflicts');

  const hasHead = await git(['rev-parse', '--verify', '--quiet', 'HEAD']).then(
    () => true,
    () => false,
  );
  if (!hasHead) return unknown('the repository has no commits yet');

  const shallow = (await git(['rev-parse', '--is-shallow-repository'])).trim();
  if (shallow === 'true') {
    return unknown('the clone is shallow, so where this branch left its base is not known');
  }

  const base = await findBase(git, requestedBase);
  if (base === undefined) {
    return unknown(
      requestedBase !== undefined
        ? `the base \`${requestedBase}\` is not a commit in this repository`
        : `no base branch found (tried origin/HEAD, ${BASE_CANDIDATES.join(', ')})`,
    );
  }

  /** @type {string} */
  let mergeBase;
  try {
    mergeBase = (await git(['merge-base', 'HEAD', base])).trim();
  } catch {
    return unknown(`HEAD and ${base} have no common history`);
  }

  /** @type {string[]} */
  const notes = [];
  const commits = Number((await git(['rev-list', '--count', `${mergeBase}..HEAD`])).trim());
  const head = (await git(['rev-parse', 'HEAD'])).trim();
  if (head === mergeBase && !base.includes('/')) {
    notes.push(
      `HEAD is the base \`${base}\` itself: only changes that are not committed are compared`,
    );
  }

  // The working tree against the merge base: committed, staged and unstaged changes at once.
  const tracked = parseNameStatus(
    await git(['diff', '--name-status', '-z', '-M', '--no-ext-diff', mergeBase]),
  );
  const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter((path) => path !== '')
    .map((path) => /** @type {Change} */ ({ status: 'A', path }));

  /** @type {Map<string, Change>} */
  const byPath = new Map();
  for (const change of [...tracked, ...untracked]) {
    const path = change.path.replaceAll('\\', '/');
    const earlier = byPath.get(path);
    // A path that is both removed and added (a rename onto it) has changed content.
    const status = earlier !== undefined && earlier.status !== change.status ? 'M' : change.status;
    byPath.set(path, { status, path });
  }
  const changes = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { ok: true, changes, base, mergeBase, commits, notes };
}

/**
 * Files under src/ and test/ — tracked or new, not ignored — whose text contains `token`.
 * @param {string} root
 * @returns {(token: string) => Promise<string[]>}
 */
export function referencesIn(root) {
  return (token) =>
    new Promise((resolvePromise, reject) => {
      execFile(
        'git',
        [
          '-c',
          'core.quotepath=off',
          'grep',
          '-l',
          '-z',
          '-F',
          '--untracked',
          '-e',
          token,
          '--',
          'src',
          'test',
        ],
        { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          // `git grep` exits with 1 when nothing matches; that is an answer, not a failure.
          if (error && !(error.code === 1 && stderr.trim() === '')) {
            reject(new Error(`git grep failed: ${String(stderr || error.message).trim()}`));
            return;
          }
          resolvePromise(stdout.split('\0').filter((path) => path !== ''));
        },
      );
    });
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message.split('\n')[0] : String(error);
}
