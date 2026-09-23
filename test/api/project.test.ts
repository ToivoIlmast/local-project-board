import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  API_BASE_PATH as API,
  errorResponseSchema,
  gitBranchSchema,
  gitCommitSchema,
  gitDiffSchema,
  gitStatusSchema,
  projectSchema,
} from '../../src/contract/v1/index.js';
import { BoardError } from '../../src/core/errors.js';
import type { GitReader } from '../../src/core/ports.js';
import { gitReader, nullGitReader } from '../../src/server/git/index.js';
import { createTestBoard, type TestBoard } from '../support/httpBoard.js';
import { repoWithCommit, writeRepoFile } from '../support/gitRepo.js';
import { cleanTmpDirs, tmpDir } from '../support/tmp.js';

let board: TestBoard;

afterEach(async () => {
  await board.close();
  await cleanTmpDirs();
});

describe('GET /project', () => {
  it('describes the board, its statuses and its storage', async () => {
    board = await createTestBoard();
    const response = await board.get(`${API}/project`).expect(200);
    const project = projectSchema.parse(response.body);

    expect(project).toMatchObject({
      name: 'test-board',
      root: board.root,
      statuses: ['backlog', 'todo', 'in-progress', 'done'],
      idPrefix: 'T',
      storage: { provider: 'markdown' },
      readIssues: [],
    });
  });

  it('reports a file that cannot be read instead of inventing a task', async () => {
    board = await createTestBoard();
    const dir = join(board.root, '.board', 'tasks', 'T7');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'task.md'), '---\ntitle: [broken\n---\n', 'utf8');

    const project = projectSchema.parse((await board.get(`${API}/project`).expect(200)).body);
    expect(project.readIssues).toEqual([
      { file: 'tasks/T7/task.md', message: expect.stringContaining('frontmatter') },
    ]);
    expect((await board.get(`${API}/tasks`).expect(200)).body).toEqual([]);
  });

  it('invents no branch when the project is not a repository', async () => {
    board = await createTestBoard({ git: nullGitReader() });
    const project = projectSchema.parse((await board.get(`${API}/project`).expect(200)).body);
    expect(project.git).toEqual({ available: false, detached: false });
  });
});

describe('git endpoints on a repository', () => {
  beforeEach(async () => {
    const root = await repoWithCommit(await tmpDir());
    board = await createTestBoard({ root, git: gitReader({ root }) });
  });

  it('reads the status, the branches and the commits', async () => {
    await writeRepoFile(board.root, 'a.txt', 'changed\n');

    const status = gitStatusSchema.parse((await board.get(`${API}/git/status`).expect(200)).body);
    expect(status).toMatchObject({ branch: 'main', clean: false });

    const branches = z
      .array(gitBranchSchema)
      .parse((await board.get(`${API}/git/branches`).expect(200)).body);
    expect(branches).toEqual([{ name: 'main', current: true }]);

    const commits = z
      .array(gitCommitSchema)
      .parse((await board.get(`${API}/git/commits`).expect(200)).body);
    expect(commits.map((commit) => commit.subject)).toEqual(['first commit']);
  });

  it('passes the query the contract describes through to git', async () => {
    await writeRepoFile(board.root, 'a.txt', 'changed\n');

    const diff = gitDiffSchema.parse((await board.get(`${API}/git/diff`).expect(200)).body);
    expect(diff.text).toContain('+changed');

    const scoped = gitDiffSchema.parse(
      (await board.get(`${API}/git/diff?path=a.txt`).expect(200)).body,
    );
    expect(scoped.text).toContain('a.txt');

    const staged = gitDiffSchema.parse(
      (await board.get(`${API}/git/diff?staged=true`).expect(200)).body,
    );
    expect(staged.text).toBe('');

    const limited = z
      .array(gitCommitSchema)
      .parse((await board.get(`${API}/git/commits?ref=main&limit=1`).expect(200)).body);
    expect(limited).toHaveLength(1);
  });

  it('rejects a git argument at the HTTP boundary, before git is asked anything', async () => {
    const refs = ['--upload-pack=touch pwned', '-n1', 'a b', 'a;rm -rf /', '--help', ''];
    for (const ref of refs) {
      const response = await board.get(`${API}/git/commits?ref=${encodeURIComponent(ref)}&limit=5`);
      expect(response.status).toBe(400);
      expect(errorResponseSchema.parse(response.body).error.code).toBe('INVALID_REQUEST');
    }

    for (const path of ['--output=pwned.txt', '-n', '']) {
      const response = await board.get(`${API}/git/diff?path=${encodeURIComponent(path)}`);
      expect(response.status).toBe(400);
    }

    expect((await board.get(`${API}/git/commits?limit=0`)).status).toBe(400);
    expect((await board.get(`${API}/git/commits?limit=201`)).status).toBe(400);
    expect((await board.get(`${API}/git/commits?junk=1`)).status).toBe(400);
  });
});

describe('git endpoints without git', () => {
  it('answers with the neutral state instead of failing', async () => {
    board = await createTestBoard({ git: nullGitReader() });

    expect(gitStatusSchema.parse((await board.get(`${API}/git/status`).expect(200)).body)).toEqual({
      branch: null,
      detached: false,
      clean: true,
      files: [],
    });
    expect((await board.get(`${API}/git/branches`).expect(200)).body).toEqual([]);
    expect((await board.get(`${API}/git/commits`).expect(200)).body).toEqual([]);
    expect((await board.get(`${API}/git/diff`).expect(200)).body).toEqual({
      text: '',
      truncated: false,
    });
  });

  it('maps a rejected git argument to 422 if one ever reaches the adapter', async () => {
    const refusing: GitReader = {
      ...nullGitReader(),
      commits: () => {
        throw new BoardError('INVALID_GIT_ARGUMENT', 'Invalid git ref.', {
          argument: 'ref',
          value: 'x',
        });
      },
    };
    board = await createTestBoard({ git: refusing });

    const response = await board.get(`${API}/git/commits`).expect(422);
    expect(errorResponseSchema.parse(response.body).error.code).toBe('INVALID_GIT_ARGUMENT');
  });
});
