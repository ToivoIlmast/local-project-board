import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NewTask, Storage } from '../../src/core/ports.js';
import { parseTask, serializeTask } from '../../src/server/storage/markdown/taskFile.js';
import { parseTopic } from '../../src/server/storage/markdown/topicFile.js';
import {
  markdownStorage,
  type MarkdownStorageOptions,
} from '../../src/server/storage/markdown/index.js';
import { defaultConfig } from '../../src/server/config/schema.js';
import { createStorage } from '../../src/server/storage/index.js';
import { writeFileAtomic } from '../../src/server/storage/markdown/atomic.js';
import { runStorageConformance } from '../conformance/storage.js';
import { cleanTmpDirs, tmpDir } from '../support/tmp.js';

const roots = new Map<Storage, MarkdownStorageOptions>();

function create(options: MarkdownStorageOptions): Storage {
  const storage = markdownStorage(options);
  roots.set(storage, options);
  return storage;
}

runStorageConformance({
  name: 'markdown',
  create: async (options = {}) => create({ root: await tmpDir(), ...options }),
  reopen: async (previous) => {
    const options = roots.get(previous);
    if (!options) throw new Error('Unknown storage instance');
    return create(options);
  },
  strandMarkdown: async (storage, taskId, number, markdown) => {
    const options = roots.get(storage);
    if (!options) throw new Error('Unknown storage instance');
    const dir = join(options.root, '.board', 'tasks', taskId, 'history', 'checks');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${number}.report.md`), markdown, { encoding: 'utf8', flag: 'wx' });
  },
  removeTopic: async (storage, topicId) => {
    await rm(join(topicsDirOf(storage), topicId), { recursive: true, force: true });
  },
  breakTopic: async (storage, topicId) => {
    const file = join(topicsDirOf(storage), topicId, 'topic.md');
    const text = await readFile(file, 'utf8');
    await writeFile(file, 'A topic.md without frontmatter.\n', 'utf8');
    return () => writeFile(file, text, 'utf8');
  },
  addTopicField: async (storage, topicId, key, value) => {
    const file = join(topicsDirOf(storage), topicId, 'topic.md');
    const text = await readFile(file, 'utf8');
    const line = `${key}: ${JSON.stringify(value)}\n`;
    await writeFile(file, text.replace(/\n---\n/, `\n${line}---\n`), 'utf8');
  },
  setSequence: async (storage, state) => {
    const file = join(topicsDirOf(storage), 'sequence.json');
    if (state === 'missing') await rm(file, { force: true });
    else if (state === 'invalid') await writeFile(file, '{ "topicSequence": ', 'utf8');
    else await writeFile(file, JSON.stringify({ formatVersion: 1, ...state }), 'utf8');
  },
  cleanup: cleanTmpDirs,
});

function topicsDirOf(storage: Storage): string {
  const options = roots.get(storage);
  if (!options) throw new Error('Unknown storage instance');
  return join(options.root, '.board', 'topics');
}

describe('markdown storage on disk', () => {
  let root: string;
  let storage: Storage;

  beforeEach(async () => {
    root = await tmpDir();
    storage = markdownStorage({ root });
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    await cleanTmpDirs();
  });

  const task = {
    title: 'Extract the git adapter',
    status: 'todo',
    rank: 'a0',
    body: '## Context\n\nStill in the HTTP layer.\n',
    labels: ['refactor'],
  };

  it('keeps the board out of git with a self-ignoring .gitignore (ADR-0001)', async () => {
    expect(await readFile(join(root, '.board', '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('writes a task as readable markdown with frontmatter', async () => {
    const created = await storage.createTask(task);
    const file = join(root, '.board', 'tasks', created.id, 'task.md');
    const text = await readFile(file, 'utf8');
    expect(text.startsWith('---\n')).toBe(true);
    expect(text).toContain('title: Extract the git adapter');
    expect(text).toContain('status: todo');
    expect(text.endsWith('## Context\n\nStill in the HTTP layer.\n')).toBe(true);
  });

  it('keeps documents as plain files next to the task (ADR-0003)', async () => {
    const created = await storage.createTask(task);
    await storage.writeDocument(created.id, 'plan.md', '# Plan\n');
    const file = join(root, '.board', 'tasks', created.id, 'plan.md');
    expect(await readFile(file, 'utf8')).toBe('# Plan\n');
  });

  it('keeps a report as a file plus its metadata', async () => {
    const report = await storage.writeReport({
      title: 'Audit',
      format: 'html',
      content: '<h1>A</h1>\n',
    });
    const dir = join(root, '.board', 'reports');
    expect(await readFile(join(dir, `${report.id}.html`), 'utf8')).toBe('<h1>A</h1>\n');
    expect(JSON.parse(await readFile(join(dir, `${report.id}.json`), 'utf8'))).toMatchObject({
      title: 'Audit',
      format: 'html',
    });
  });

  it('keeps unknown frontmatter fields in the file after an update', async () => {
    const created = await storage.createTask({ ...task, extra: { estimate: 3, owner: 'me' } });
    await storage.updateTask(created.id, { title: 'Renamed' });
    const text = await readFile(join(root, '.board', 'tasks', created.id, 'task.md'), 'utf8');
    expect(text).toContain('estimate: 3');
    expect(text).toContain('owner: me');
  });

  it('reads a task that a person or an agent wrote by hand', async () => {
    const dir = join(root, '.board', 'tasks', 'T7');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'task.md'),
      '---\nid: T7\ntitle: Handwritten\nstatus: todo\nrank: a0\nlabels: []\ncreatedAt: 2026-09-21T10:00:00.000Z\nupdatedAt: 2026-09-21T10:00:00.000Z\n---\nBody.\n',
      'utf8',
    );
    expect(await storage.getTask('T7')).toMatchObject({
      id: 'T7',
      title: 'Handwritten',
      body: 'Body.\n',
    });
  });

  it('does not hand out an id that a handwritten task already uses', async () => {
    const dir = join(root, '.board', 'tasks', 'T7');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'task.md'),
      '---\nid: T7\ntitle: Handwritten\nstatus: todo\nrank: a0\nlabels: []\ncreatedAt: 2026-09-21T10:00:00.000Z\nupdatedAt: 2026-09-21T10:00:00.000Z\n---\n',
      'utf8',
    );
    expect((await storage.createTask(task)).id).toBe('T8');
  });

  describe('dependsOn on a board edited by hand (T85)', () => {
    /** A task.md as a person writes it, with the frontmatter lines given. */
    async function handwrite(id: string, lines = ''): Promise<void> {
      const dir = join(root, '.board', 'tasks', id);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'task.md'),
        `---\nid: ${id}\ntitle: Handwritten\nstatus: todo\nrank: a0\nlabels: []\n${lines}createdAt: 2026-09-21T10:00:00.000Z\nupdatedAt: 2026-09-21T10:00:00.000Z\n---\n`,
        'utf8',
      );
    }

    async function codeOf(action: Promise<unknown>): Promise<string> {
      const error = await action.then(
        () => undefined,
        (failure: unknown) => failure,
      );
      return (error as { code?: string } | undefined)?.code ?? 'no error';
    }

    /** Every file of the board and its bytes: what a refusal must leave as it was. */
    async function files(): Promise<Record<string, string>> {
      const board = join(root, '.board');
      const entries = await readdir(board, { recursive: true, withFileTypes: true });
      const result: Record<string, string> = {};
      for (const entry of entries.filter((candidate) => candidate.isFile())) {
        const path = join(entry.parentPath, entry.name);
        result[path.slice(board.length + 1)] = await readFile(path, 'utf8');
      }
      return result;
    }

    it('refuses a create that closes a cycle with a task that named its id in advance', async () => {
      // T1 was written by hand to wait for T2, which does not exist yet: T2 is the next id.
      await handwrite('T1', 'dependsOn:\n  - T2\n');
      const before = await files();
      expect(await codeOf(storage.createTask({ ...task, dependsOn: ['T1'] }))).toBe(
        'DEPENDENCY_CYCLE',
      );
      expect(await files()).toEqual(before);
      expect((await storage.createTask(task)).id).toBe('T2');
    });

    it('refuses a dependency on a task whose file cannot be read: its own are unknown', async () => {
      const good = await storage.createTask(task);
      await handwrite('T5');
      await writeFile(join(root, '.board', 'tasks', 'T5', 'task.md'), 'broken\n', 'utf8');
      const before = await files();
      expect(await codeOf(storage.updateTask(good.id, { dependsOn: ['T5'] }))).toBe(
        'INVALID_DEPENDENCY',
      );
      expect(await codeOf(storage.createTask({ ...task, dependsOn: ['T5'] }))).toBe(
        'INVALID_DEPENDENCY',
      );
      expect(await files()).toEqual(before);
    });

    it('refuses a dependency that leads to a task whose file cannot be read (fail-closed)', async () => {
      const first = await storage.createTask(task);
      await handwrite('T2', 'dependsOn:\n  - T5\n');
      await handwrite('T5');
      await writeFile(join(root, '.board', 'tasks', 'T5', 'task.md'), 'broken\n', 'utf8');
      const before = await files();
      expect(await codeOf(storage.updateTask(first.id, { dependsOn: ['T2'] }))).toBe(
        'INVALID_DEPENDENCY',
      );
      expect(await files()).toEqual(before);
    });

    it('lets a cycle left by hand elsewhere stand in the way of no other write', async () => {
      await handwrite('T1', 'dependsOn:\n  - T2\n');
      await handwrite('T2', 'dependsOn:\n  - T1\n');
      const other = await storage.createTask({ ...task, dependsOn: ['T1'] });
      expect(other.dependsOn).toEqual(['T1']);
      // A write to a task of the cycle that keeps it is refused; clearing breaks it.
      expect(await codeOf(storage.updateTask('T1', { dependsOn: ['T2'] }))).toBe(
        'DEPENDENCY_CYCLE',
      );
      expect((await storage.updateTask('T1', { title: 'Renamed' })).dependsOn).toEqual(['T2']);
      expect(await storage.updateTask('T1', { dependsOn: null })).not.toHaveProperty('dependsOn');
    });

    it('writes no file of a task on a refused update, the other tasks included', async () => {
      const a = await storage.createTask(task);
      const b = await storage.createTask({ ...task, dependsOn: [a.id] });
      const before = await files();
      expect(await codeOf(storage.updateTask(a.id, { title: 'x', dependsOn: [b.id] }))).toBe(
        'DEPENDENCY_CYCLE',
      );
      expect(await files()).toEqual(before);
    });
  });

  it('reports a broken task file instead of crashing (INVARIANT)', async () => {
    const good = await storage.createTask(task);
    const dir = join(root, '.board', 'tasks', 'T99');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'task.md'), '---\ntitle: [broken\n---\nBody\n', 'utf8');

    expect((await storage.listTasks()).map((t) => t.id)).toEqual([good.id]);
    expect(await storage.getTask('T99')).toBeNull();

    const issues = await storage.readIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]?.file).toBe('tasks/T99/task.md');
    expect(issues[0]?.message).toContain('frontmatter');
  });

  it('reports a task whose report language is not one of the 14, and keeps the other tasks (T34)', async () => {
    const good = await storage.createTask(task);
    const dir = join(root, '.board', 'tasks', 'T77');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'task.md'),
      '---\nid: T77\ntitle: Bad language\nstatus: todo\nrank: a1\nlabels: []\nworkflow:\n  reportLanguage: xx\ncreatedAt: 2026-09-21T10:00:00.000Z\nupdatedAt: 2026-09-21T10:00:00.000Z\n---\n',
      'utf8',
    );

    expect((await storage.listTasks()).map((t) => t.id)).toEqual([good.id]);
    const issues = await storage.readIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]?.file).toBe('tasks/T77/task.md');
    expect(issues[0]?.message).toContain('reportLanguage');
  });

  it('stores and reads back the language of a task (T34)', async () => {
    const created = await storage.createTask({ ...task, workflow: { reportLanguage: 'fi' } });
    expect((await storage.getTask(created.id))?.workflow).toEqual({ reportLanguage: 'fi' });
  });

  it('reports a task with a commitLanguage in its workflow as unreadable, and keeps the others (T43)', async () => {
    const good = await storage.createTask(task);
    const dir = join(root, '.board', 'tasks', 'T78');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'task.md'),
      '---\nid: T78\ntitle: Own commit language\nstatus: todo\nrank: a1\nlabels: []\nworkflow:\n  commitLanguage: fi\ncreatedAt: 2026-09-21T10:00:00.000Z\nupdatedAt: 2026-09-21T10:00:00.000Z\n---\n',
      'utf8',
    );

    expect((await storage.listTasks()).map((t) => t.id)).toEqual([good.id]);
    const issues = await storage.readIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]?.file).toBe('tasks/T78/task.md');
    expect(issues[0]?.message).toContain('commitLanguage');
  });

  it('reports a file with no frontmatter instead of crashing', async () => {
    const dir = join(root, '.board', 'tasks', 'T42');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'task.md'), 'Just a note, no frontmatter.\n', 'utf8');
    expect(await storage.listTasks()).toEqual([]);
    expect((await storage.readIssues())[0]?.message).toContain('frontmatter');
  });

  it('stops reporting a file once it is fixed', async () => {
    const dir = join(root, '.board', 'tasks', 'T42');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'task.md');
    await writeFile(file, 'broken\n', 'utf8');
    expect(await storage.readIssues()).toHaveLength(1);
    await writeFile(
      file,
      '---\nid: T42\ntitle: Fixed\nstatus: todo\nrank: a0\nlabels: []\ncreatedAt: 2026-09-21T10:00:00.000Z\nupdatedAt: 2026-09-21T10:00:00.000Z\n---\n',
      'utf8',
    );
    expect(await storage.readIssues()).toEqual([]);
  });

  it('removes the task directory, documents and all, when a task is deleted', async () => {
    const created = await storage.createTask(task);
    await storage.writeDocument(created.id, 'plan.md', '# Plan\n');
    const dir = join(root, '.board', 'tasks', created.id);
    await storage.deleteTask(created.id);
    await expect(readdir(dir)).rejects.toThrow();
  });

  it('ignores files and directories that are not tasks', async () => {
    await storage.createTask(task);
    await writeFile(join(root, '.board', 'tasks', 'README.md'), 'not a task\n', 'utf8');
    await mkdir(join(root, '.board', 'tasks', 'scratch'), { recursive: true });
    expect(await storage.listTasks()).toHaveLength(1);
  });

  it('leaves no temporary files behind', async () => {
    const created = await storage.createTask(task);
    await storage.writeDocument(created.id, 'plan.md', '# Plan\n');
    await storage.updateTask(created.id, { title: 'Renamed' });
    const files = await readdir(join(root, '.board', 'tasks', created.id));
    expect(files.sort()).toEqual(['plan.md', 'task.md']);
  });

  it('never exposes a half-written file (INVARIANT 6)', async () => {
    const file = join(root, 'big.md');
    const oldContent = '# old\n';
    const newContent = `# ${'x'.repeat(8_000_000)}\n`;
    await writeFileAtomic(file, oldContent);

    const seen = new Set<string>();
    let reading = true;
    const reader = (async () => {
      while (reading) {
        try {
          seen.add(readFileSync(file, 'utf8'));
        } catch {
          seen.add('<missing>');
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    await writeFileAtomic(file, newContent);
    reading = false;
    await reader;

    expect(seen.size).toBeGreaterThan(0);
    for (const content of seen) expect([oldContent, newContent]).toContain(content);
  }, 30_000);

  it('restores nothing and keeps the original when a write fails (INVARIANT 6)', async () => {
    const file = join(root, 'note.md');
    await writeFileAtomic(file, 'original\n');
    await expect(writeFileAtomic(join(root, 'missing-dir', 'note.md'), 'x')).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('original\n');
    expect((await readdir(root)).filter((name) => name.includes('tmp'))).toEqual([]);
  });

  it('tells the caller when the board changed outside the server', async () => {
    const changes: number[] = [];
    const watched = markdownStorage({ root, onExternalChange: () => changes.push(Date.now()) });
    await watched.init();
    const created = await watched.createTask(task);
    await writeFile(
      join(root, '.board', 'tasks', created.id, 'task.md'),
      '---\nid: T1\ntitle: Edited by an agent\nstatus: todo\nrank: a0\nlabels: []\ncreatedAt: 2026-09-21T10:00:00.000Z\nupdatedAt: 2026-09-21T10:00:00.000Z\n---\n',
      'utf8',
    );
    // The watcher is best-effort, so wait for it rather than assuming a fixed delay.
    for (let i = 0; i < 100 && changes.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await watched.close();
    expect(changes.length).toBeGreaterThan(0);
  }, 20_000);
});

describe('markdown storage: workflow settings', () => {
  let root: string;
  let storage: Storage;
  const statuses = ['backlog', 'todo', 'in-progress', 'done'];
  const file = (): string => join(root, '.board', 'workflow.yaml');

  beforeEach(async () => {
    root = await tmpDir();
    storage = markdownStorage({ root, statuses });
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    await cleanTmpDirs();
  });

  const task = {
    title: 'Extract the git adapter',
    status: 'todo',
    rank: 'a0',
    body: '## Context\n',
    labels: [],
  };

  it('does not create the file until somebody sets something', async () => {
    await storage.createTask(task);
    expect(await storage.readWorkflow()).toEqual({ board: {}, statuses: {} });
    await expect(readFile(file(), 'utf8')).rejects.toThrow();
    expect(await storage.readIssues()).toEqual([]);
  });

  it('keeps the overrides in .board/workflow.yaml as readable YAML with a format version', async () => {
    await storage.writeWorkflow({
      board: { push: false, checkCommand: 'npm test' },
      statuses: { backlog: { editCode: false } },
    });
    expect(await readFile(file(), 'utf8')).toBe(
      [
        'formatVersion: 1',
        'board:',
        '  push: false',
        '  checkCommand: npm test',
        'statuses:',
        '  backlog:',
        '    editCode: false',
        '',
      ].join('\n'),
    );
  });

  it('writes only the keys that were set: no defaults, nothing computed (INVARIANT)', async () => {
    await storage.writeWorkflow({ board: { push: true }, statuses: {} });
    const text = await readFile(file(), 'utf8');
    expect(text).toBe('formatVersion: 1\nboard:\n  push: true\n');
    for (const key of ['editCode', 'branch', 'checks', 'commit', 'report', 'startStatus']) {
      expect(text).not.toContain(key);
    }
  });

  it('writes an empty file body for empty overrides, and reads it back as empty', async () => {
    await storage.writeWorkflow({ board: {}, statuses: {} });
    expect(await readFile(file(), 'utf8')).toBe('formatVersion: 1\n');
    expect(await storage.readWorkflow()).toEqual({ board: {}, statuses: {} });
  });

  it('shows a hand edit on the next call, without a restart (INVARIANT)', async () => {
    await storage.writeWorkflow({ board: { push: false }, statuses: {} });
    expect((await storage.readWorkflow()).board).toEqual({ push: false });

    await writeFile(
      file(),
      'formatVersion: 1\nboard:\n  push: true\n  baseBranch: develop\nstatuses:\n  todo:\n    checks: false\n',
      'utf8',
    );
    expect(await storage.readWorkflow()).toEqual({
      board: { push: true, baseBranch: 'develop' },
      statuses: { todo: { checks: false } },
    });
  });

  it('sees the file appear and disappear', async () => {
    await writeFile(file(), 'formatVersion: 1\nboard:\n  commit: false\n', 'utf8');
    expect((await storage.readWorkflow()).board).toEqual({ commit: false });
    await rm(file());
    expect(await storage.readWorkflow()).toEqual({ board: {}, statuses: {} });
  });

  it('leaves no temporary file behind', async () => {
    await storage.writeWorkflow({ board: { push: true }, statuses: {} });
    await storage.writeWorkflow({ board: { push: false }, statuses: {} });
    expect((await readdir(join(root, '.board'))).filter((name) => name.endsWith('.tmp'))).toEqual(
      [],
    );
  });

  describe('a file that cannot be used', () => {
    it.each([
      ['broken YAML', 'formatVersion: 1\nboard: [oops\n', 'YAML'],
      ['not a mapping', '- a\n- b\n', 'mapping'],
      ['an empty file', '', 'mapping'],
      ['no format version', 'board:\n  push: true\n', 'formatVersion'],
      ['a newer format version', 'formatVersion: 2\nboard:\n  push: true\n', 'formatVersion'],
      ['a value of the wrong type', 'formatVersion: 1\nboard:\n  push: "yes"\n', 'board.push'],
      ['an unknown setting', 'formatVersion: 1\nboard:\n  allowSourceEdits: true\n', 'board'],
      [
        'a board-only setting in a column',
        'formatVersion: 1\nstatuses:\n  todo:\n    baseBranch: main\n',
        'statuses.todo',
      ],
      ['an unknown top-level key', 'formatVersion: 1\ncolumns: {}\n', 'columns'],
      [
        'a report language that is not one of the 14 (T34)',
        'formatVersion: 1\nboard:\n  reportLanguage: xx\n',
        'board.reportLanguage',
      ],
      [
        'a report language in a column (T34)',
        'formatVersion: 1\nstatuses:\n  todo:\n    reportLanguage: fi\n',
        'statuses.todo',
      ],
      [
        'a commit language that is not one of the 14 (T43)',
        'formatVersion: 1\nboard:\n  commitLanguage: xx\n',
        'board.commitLanguage',
      ],
      [
        'a commit language in a column (T43)',
        'formatVersion: 1\nstatuses:\n  todo:\n    commitLanguage: fi\n',
        'statuses.todo',
      ],
    ])('is reported, and the board runs on defaults: %s', async (_why, text, mention) => {
      const created = await storage.createTask(task);
      await writeFile(file(), text, 'utf8');

      expect(await storage.readWorkflow()).toEqual({ board: {}, statuses: {} });
      // Nothing else is affected.
      expect(await storage.listTasks()).toEqual([created]);

      const issues = await storage.readIssues();
      expect(issues).toHaveLength(1);
      expect(issues[0]?.file).toBe('workflow.yaml');
      expect(issues[0]?.message).toContain(mention);
    });

    it('is reported next to a broken task, not instead of it', async () => {
      const dir = join(root, '.board', 'tasks', 'T99');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'task.md'), 'broken\n', 'utf8');
      await writeFile(file(), 'formatVersion: 1\nboard: [oops\n', 'utf8');
      expect((await storage.readIssues()).map((issue) => issue.file)).toEqual([
        'tasks/T99/task.md',
        'workflow.yaml',
      ]);
    });

    it('is reported when the path is not a file at all', async () => {
      await mkdir(file(), { recursive: true });
      expect(await storage.readWorkflow()).toEqual({ board: {}, statuses: {} });
      expect((await storage.readIssues()).map((issue) => issue.file)).toEqual(['workflow.yaml']);
    });

    it('stops being reported once it is fixed', async () => {
      await writeFile(file(), 'formatVersion: 1\nboard: [oops\n', 'utf8');
      expect(await storage.readIssues()).toHaveLength(1);
      await writeFile(file(), 'formatVersion: 1\nboard:\n  push: true\n', 'utf8');
      expect(await storage.readIssues()).toEqual([]);
      expect((await storage.readWorkflow()).board).toEqual({ push: true });
    });

    it('is overwritten by the next write, which repairs the board', async () => {
      await writeFile(file(), 'not: [valid', 'utf8');
      await storage.writeWorkflow({ board: { push: true }, statuses: {} });
      expect(await storage.readIssues()).toEqual([]);
      expect((await storage.readWorkflow()).board).toEqual({ push: true });
    });
  });

  describe('a column whose status is not configured', () => {
    const write = (): Promise<void> =>
      writeFile(
        file(),
        'formatVersion: 1\nstatuses:\n  todo:\n    editCode: false\n  review:\n    editCode: false\n',
        'utf8',
      );

    it('is a read issue, not a crash', async () => {
      await write();
      const issues = await storage.readIssues();
      expect(issues).toHaveLength(1);
      expect(issues[0]?.file).toBe('workflow.yaml');
      expect(issues[0]?.message).toContain('statuses.review');
    });

    it('does not take the configured columns down with it', async () => {
      await write();
      expect((await storage.readWorkflow()).statuses.todo).toEqual({ editCode: false });
    });

    it('is checked against the statuses of the board configuration when built from it', async () => {
      const configured = createStorage(
        { ...defaultConfig('test-board'), statuses: ['todo', 'done'] },
        { root },
      );
      await write();
      const issues = await configured.readIssues();
      expect(issues).toHaveLength(1);
      expect(issues[0]?.message).toContain('statuses.review');
    });

    it('is checked only when the provider knows the configured statuses', async () => {
      const unaware = markdownStorage({ root });
      await write();
      expect(await unaware.readIssues()).toEqual([]);
    });
  });

  describe('task.md and the workflow field', () => {
    // Keys in the order the board writes them, so that a round trip can be compared as text.
    const text = (workflow = '', after = ''): string =>
      `---\nid: T7\ntitle: Handwritten\nstatus: todo\nrank: a0\nlabels: []\n${workflow}createdAt: 2026-09-21T10:00:00.000Z\nupdatedAt: 2026-09-21T10:00:00.000Z\n${after}---\nBody.\n`;

    it('reads and writes a task without `workflow` byte for byte as before (INVARIANT)', () => {
      const parsed = parseTask('T7', text());
      if (!('task' in parsed)) throw new Error(parsed.error);
      expect('workflow' in parsed.task).toBe(false);
      expect(parsed.task.extra).toBeUndefined();
      expect(serializeTask(parsed.task)).toBe(text());
    });

    it('reads and writes a task with `workflow` byte for byte (INVARIANT)', () => {
      const withWorkflow = text('workflow:\n  commit: false\n  push: true\n');
      const parsed = parseTask('T7', withWorkflow);
      if (!('task' in parsed)) throw new Error(parsed.error);
      expect(parsed.task.workflow).toEqual({ commit: false, push: true });
      // A known field, so it is not kept as an unknown one.
      expect(parsed.task.extra).toBeUndefined();
      expect(serializeTask(parsed.task)).toBe(withWorkflow);
    });

    it("keeps the user's own frontmatter fields next to `workflow`", () => {
      const withBoth = text('workflow:\n  push: true\n', 'estimate: 3\n');
      const parsed = parseTask('T7', withBoth);
      if (!('task' in parsed)) throw new Error(parsed.error);
      expect(parsed.task.extra).toEqual({ estimate: 3 });
      expect(parsed.task.workflow).toEqual({ push: true });
      expect(serializeTask(parsed.task)).toBe(withBoth);
    });

    it('reports a task whose `workflow` does not fit, and does not invent overrides', () => {
      for (const bad of [
        'workflow: yes\n',
        'workflow:\n  push: "yes"\n',
        'workflow:\n  nope: 1\n',
      ]) {
        const parsed = parseTask('T7', text(bad));
        expect('error' in parsed).toBe(true);
        if ('error' in parsed) expect(parsed.error).toContain('workflow');
      }
    });

    it('turns a bad `workflow` into a read issue instead of a crash', async () => {
      const dir = join(root, '.board', 'tasks', 'T7');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'task.md'), text('workflow:\n  push: "yes"\n'), 'utf8');
      expect(await storage.getTask('T7')).toBeNull();
      const issues = await storage.readIssues();
      expect(issues).toHaveLength(1);
      expect(issues[0]?.file).toBe('tasks/T7/task.md');
    });

    it('does not rewrite a task file just because the board has overrides', async () => {
      const created = await storage.createTask(task);
      const path = join(root, '.board', 'tasks', created.id, 'task.md');
      const before = await readFile(path, 'utf8');
      await storage.writeWorkflow({ board: { push: true }, statuses: { todo: { commit: false } } });
      await storage.readWorkflow();
      expect(await readFile(path, 'utf8')).toBe(before);
      expect(before).not.toContain('workflow');
    });
  });

  it('never writes an effective value: every file holds only what was set (INVARIANT)', async () => {
    const created = await storage.createTask({ ...task, workflow: { push: true } });
    await storage.writeWorkflow({ board: { checkCommand: 'npm test' }, statuses: {} });
    await storage.updateTask(created.id, { status: 'done', rank: 'a1' });
    await storage.readIssues();

    const taskText = await readFile(join(root, '.board', 'tasks', created.id, 'task.md'), 'utf8');
    expect(taskText).toContain('workflow:\n  push: true\n');
    for (const key of ['editCode', 'branch:', 'checks', 'commit', 'report', 'inactive', 'source']) {
      // `branch:` is a task field; a task without a branch has none.
      expect(taskText).not.toContain(key);
    }
    expect(await readFile(file(), 'utf8')).toBe(
      'formatVersion: 1\nboard:\n  checkCommand: npm test\n',
    );
  });
});

describe('task.md and doneAt (T96)', () => {
  const file = (status: string, doneAt = ''): string =>
    `---\nid: T7\ntitle: Handwritten\nstatus: ${status}\nrank: a0\nlabels: []\n${doneAt}createdAt: 2026-09-21T10:00:00.000Z\nupdatedAt: 2026-09-21T10:00:00.000Z\n---\nBody.\n`;

  it('reads and writes a done task without `doneAt` byte for byte, and makes none (INVARIANT)', () => {
    const parsed = parseTask('T7', file('done'));
    if (!('task' in parsed)) throw new Error(parsed.error);
    expect(parsed.task.doneAt).toBeUndefined();
    expect(parsed.task.extra).toBeUndefined();
    expect(serializeTask(parsed.task)).toBe(file('done'));
  });

  it('reads and writes `doneAt` byte for byte, and not as an unknown field', () => {
    const text = file('done', 'doneAt: 2026-11-06T10:00:00.000Z\n');
    const parsed = parseTask('T7', text);
    if (!('task' in parsed)) throw new Error(parsed.error);
    expect(parsed.task.doneAt).toBe('2026-11-06T10:00:00.000Z');
    expect(parsed.task.extra).toBeUndefined();
    expect(serializeTask(parsed.task)).toBe(text);
  });

  it('does not read a `doneAt` that is not a datetime', () => {
    expect(parseTask('T7', file('done', 'doneAt: yesterday\n'))).toHaveProperty('error');
  });
});

describe('task.md and aiRun runner fields (T31)', () => {
  let root2: string;
  let storage2: Storage;

  beforeEach(async () => {
    root2 = await tmpDir();
    storage2 = markdownStorage({ root: root2 });
    await storage2.init();
  });

  afterEach(async () => {
    await storage2.close();
  });

  const basePrefix = `---\nid: T7\ntitle: Test\nstatus: todo\nrank: a0\nlabels: []\n`;
  const baseSuffix = `createdAt: 2026-09-21T10:00:00.000Z\nupdatedAt: 2026-09-21T10:00:00.000Z\n`;

  it('round-trips new runner fields (runId, sessionId, mode, model, failure, endedAt) (INVARIANT)', () => {
    // Fields in schema-definition order so the round-trip is byte for byte.
    const aiRunYaml =
      'aiRun:\n' +
      '  agent: claude-code\n' +
      '  state: failed\n' +
      '  runId: 3\n' +
      '  sessionId: a1b2c3d4-e5f6-4890-abcd-ef0123456789\n' +
      '  mode: new\n' +
      '  model: claude-sonnet-4-6\n' +
      '  startedAt: 2026-09-21T10:00:00Z\n' +
      '  failure:\n' +
      '    kind: exit\n' +
      '    message: process exited with code 1\n' +
      '    exitCode: 1\n' +
      '  endedAt: 2026-09-21T10:05:00Z\n';
    const text = `${basePrefix}${aiRunYaml}${baseSuffix}---\n`;
    const parsed = parseTask('T7', text);
    if (!('task' in parsed)) throw new Error(parsed.error);
    expect(parsed.task.aiRun?.runId).toBe(3);
    expect(parsed.task.aiRun?.sessionId).toBe('a1b2c3d4-e5f6-4890-abcd-ef0123456789');
    expect(parsed.task.aiRun?.failure).toEqual({
      kind: 'exit',
      message: 'process exited with code 1',
      exitCode: 1,
    });
    expect(serializeTask(parsed.task)).toBe(text);
  });

  it('reads legacy aiRun without runId without a readIssue and without changing the file (INVARIANT)', async () => {
    const legacyYaml =
      'aiRun:\n' +
      '  agent: Claude Code\n' +
      '  state: working\n' +
      '  startedAt: 2026-09-28T06:35:08Z\n';
    const dir = join(root2, '.board', 'tasks', 'T30');
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'task.md');
    const fileContent = `${basePrefix}${legacyYaml}${baseSuffix}---\n`;
    await writeFile(filePath, fileContent, 'utf8');

    const task = await storage2.getTask('T30');
    expect(task).not.toBeNull();
    expect(task?.aiRun?.agent).toBe('Claude Code');
    expect(task?.aiRun?.state).toBe('working');

    const issues = await storage2.readIssues();
    expect(issues.find((i) => i.file.includes('T30'))).toBeUndefined();

    // File must not have been rewritten
    expect(await readFile(filePath, 'utf8')).toBe(fileContent);
  });
});

describe('markdown storage: the history of a task (ADR-0030)', () => {
  let root: string;
  let storage: Storage;
  let taskId: string;
  const history = (...parts: string[]): string =>
    join(root, '.board', 'tasks', taskId, 'history', ...parts);
  const snapshot = { title: 'T', body: '', labels: [] };
  const edit = {
    source: 'edit' as const,
    changed: [] as ('body' | 'title' | 'labels')[],
    snapshot,
  };

  beforeEach(async () => {
    root = await tmpDir();
    storage = markdownStorage({ root });
    await storage.init();
    taskId = (
      await storage.createTask({ title: 'T', status: 'todo', rank: 'a0', body: '', labels: [] })
    ).id;
  });

  afterEach(async () => {
    await storage.close();
    await cleanTmpDirs();
  });

  it('keeps a version in history/versions/<n>.json, next to nothing else of the task', async () => {
    await storage.appendVersion(taskId, edit);
    expect(await readdir(history('versions'))).toEqual(['1.json']);
    const stored = JSON.parse(await readFile(history('versions', '1.json'), 'utf8')) as unknown;
    expect(stored).toMatchObject({ taskId, number: 1, source: 'edit', snapshot });
  });

  it('reports a version it cannot read, leaves it out, and never writes over it (INVARIANT)', async () => {
    await storage.appendVersion(taskId, edit);
    await storage.appendVersion(taskId, edit);
    await writeFile(history('versions', '2.json'), '{ not json', 'utf8');

    expect((await storage.listVersions(taskId)).map((v) => v.number)).toEqual([1]);
    expect(await storage.readIssues()).toEqual([
      expect.objectContaining({ file: `tasks/${taskId}/history/versions/2.json` }),
    ]);

    // The broken file still counts: the next number is 3, and 2 is not touched.
    expect((await storage.appendVersion(taskId, edit)).number).toBe(3);
    expect(await readFile(history('versions', '2.json'), 'utf8')).toBe('{ not json');
  });

  it('reports a record of the wrong shape, and a file that holds another number', async () => {
    await storage.appendVersion(taskId, edit);
    await writeFile(history('versions', '1.json'), JSON.stringify({ number: 1 }), 'utf8');
    expect(await storage.listVersions(taskId)).toEqual([]);
    expect((await storage.readIssues()).map((issue) => issue.file)).toEqual([
      `tasks/${taskId}/history/versions/1.json`,
    ]);
  });

  it('does not count an unreadable check, but does not reuse its number either', async () => {
    const sessionId = 'a1b2c3d4-e5f6-4890-abcd-ef0123456789';
    await storage.appendVersion(taskId, edit);
    await storage.beginCheck(taskId, { version: 1, agent: 'a', sessionId, repo: null });
    await writeFile(history('checks', '1.begin.json'), 'nope', 'utf8');

    expect(await storage.listChecks(taskId)).toEqual([]);
    expect(await storage.readCheck(taskId, 1)).toBeNull();
    expect((await storage.readIssues()).map((issue) => issue.file)).toEqual([
      `tasks/${taskId}/history/checks/1.begin.json`,
    ]);
    expect(
      (await storage.beginCheck(taskId, { version: 1, agent: 'a', sessionId, repo: null })).number,
    ).toBe(2);
    expect(await readFile(history('checks', '1.begin.json'), 'utf8')).toBe('nope');
  });

  it('reports an unreadable decision, and a report that is not valid', async () => {
    const sessionId = 'a1b2c3d4-e5f6-4890-abcd-ef0123456789';
    await storage.appendVersion(taskId, edit);
    const { number } = await storage.beginCheck(taskId, {
      version: 1,
      agent: 'a',
      sessionId,
      repo: null,
    });
    await storage.appendDecision(taskId, number, { recommendation: 'r', decision: 'accepted' });
    await writeFile(history('checks', `${number}.decisions`, '1.json'), '[]', 'utf8');
    await writeFile(history('checks', `${number}.report.json`), '{}', 'utf8');

    const files = (await storage.readIssues()).map((issue) => issue.file).sort();
    expect(files).toEqual([
      `tasks/${taskId}/history/checks/${number}.decisions/1.json`,
      `tasks/${taskId}/history/checks/${number}.report.json`,
    ]);
    // A report file that exists, valid or not, is a report that was taken: no second one.
    await expect(
      storage.writeCheckReport(taskId, number, {
        agent: 'a',
        verdict: 'current',
        summary: 's',
        findings: [],
        recommendations: [],
        version: 1,
        repo: null,
      }),
    ).rejects.toMatchObject({ code: 'CHECK_ALREADY_FINAL' });
    expect(await readFile(history('checks', `${number}.report.json`), 'utf8')).toBe('{}');
  });

  describe('research files (ADR-0030 R3)', () => {
    const sessionId = 'a1b2c3d4-e5f6-4890-abcd-ef0123456789';
    const markdown = '# Research\n\nÜber alles.\n';
    const research = {
      agent: 'a',
      summary: 's',
      findings: [],
      recommendations: [],
      markdown,
      version: 1,
      repo: null,
    };

    async function written(): Promise<number> {
      await storage.appendVersion(taskId, edit);
      const { number } = await storage.beginCheck(taskId, {
        version: 1,
        agent: 'a',
        sessionId,
        repo: null,
        kind: 'research',
      });
      await storage.writeCheckReport(taskId, number, research);
      return number;
    }

    it('keeps the text byte for byte in <n>.report.md, and its size and hash in <n>.report.json', async () => {
      const number = await written();
      expect(await readdir(history('checks'))).toEqual([
        `${number}.begin.json`,
        `${number}.report.json`,
        `${number}.report.md`,
      ]);
      expect(await readFile(history('checks', `${number}.report.md`), 'utf8')).toBe(markdown);
      const record = JSON.parse(
        await readFile(history('checks', `${number}.report.json`), 'utf8'),
      ) as { markdown: { bytes: number }; summary: string };
      expect(record.markdown.bytes).toBe(Buffer.byteLength(markdown, 'utf8'));
      expect(record).not.toHaveProperty('verdict');
    });

    it('writes the markdown before the record, so a record never points at nothing', async () => {
      const number = await written();
      const [md, json] = await Promise.all([
        stat(history('checks', `${number}.report.md`)),
        stat(history('checks', `${number}.report.json`)),
      ]);
      expect(md.mtimeMs).toBeLessThanOrEqual(json.mtimeMs);
    });

    it('reports a record whose markdown is missing or is not the size it names, and keeps both files (INVARIANT)', async () => {
      const number = await written();
      const mdFile = history('checks', `${number}.report.md`);

      await writeFile(mdFile, 'short', 'utf8');
      expect((await storage.readIssues()).map((issue) => issue.file)).toEqual([
        `tasks/${taskId}/history/checks/${number}.report.md`,
      ]);
      expect(await storage.readCheckMarkdown(taskId, number)).toBeNull();
      await expect(storage.writeCheckReport(taskId, number, research)).rejects.toMatchObject({
        code: 'CHECK_ALREADY_FINAL',
      });
      expect(await readFile(mdFile, 'utf8')).toBe('short');

      await rm(mdFile);
      expect((await storage.readIssues()).map((issue) => issue.file)).toEqual([
        `tasks/${taskId}/history/checks/${number}.report.md`,
      ]);
    });

    it('does not call a markdown without a record an issue, and does not take its number for another check', async () => {
      await storage.appendVersion(taskId, edit);
      const { number } = await storage.beginCheck(taskId, {
        version: 1,
        agent: 'a',
        sessionId,
        repo: null,
        kind: 'research',
      });
      await writeFile(history('checks', `${number}.report.md`), markdown, 'utf8');
      expect(await storage.readIssues()).toEqual([]);
      expect(
        (await storage.beginCheck(taskId, { version: 1, agent: 'a', sessionId, repo: null }))
          .number,
      ).toBe(number + 1);
    });

    it('reports a report record that is broken, and a begin with a field it does not know', async () => {
      const number = await written();
      await writeFile(history('checks', `${number}.report.json`), '{ "markdown": 1 }', 'utf8');
      await writeFile(
        history('checks', '2.begin.json'),
        JSON.stringify({ kind: 'review', number: 2 }),
        'utf8',
      );
      expect((await storage.readIssues()).map((issue) => issue.file).sort()).toEqual([
        `tasks/${taskId}/history/checks/${number}.report.json`,
        `tasks/${taskId}/history/checks/2.begin.json`,
      ]);
      expect(
        (await storage.beginCheck(taskId, { version: 1, agent: 'a', sessionId, repo: null }))
          .number,
      ).toBe(3);
    });

    it('reads a check written before research existed, as an actuality check (INVARIANT)', async () => {
      await storage.appendVersion(taskId, edit);
      await mkdir(history('checks'), { recursive: true });
      const begin = {
        taskId,
        number: 1,
        version: 1,
        createdAt: '2026-10-18T10:00:00.000Z',
        agent: 'claude-code',
        sessionId,
        model: 'opus',
        repo: { branch: 'task/T21', head: '9f1c1a2b3c4d', clean: true },
      };
      const report = {
        taskId,
        check: 1,
        version: 1,
        createdAt: '2026-10-18T10:05:00.000Z',
        agent: 'claude-code',
        verdict: 'partly-outdated',
        summary: 'Mostly fine.',
        findings: [
          {
            id: 'f1',
            title: 'Moved',
            explanation: 'The file moved.',
            evidence: [{ kind: 'file', ref: 'src/a.ts' }],
          },
        ],
        recommendations: [
          { id: 'r1', findings: ['f1'], text: 'Fix it.', edit: { field: 'title', value: 'New' } },
        ],
        repo: { branch: 'task/T21', head: '9f1c1a2b3c4d', clean: true },
      };
      await writeFile(history('checks', '1.begin.json'), `${JSON.stringify(begin, null, 2)}\n`);
      await writeFile(history('checks', '1.report.json'), `${JSON.stringify(report, null, 2)}\n`);

      const check = await storage.readCheck(taskId, 1);
      expect(check?.state).toBe('reported');
      expect(check?.begin).toEqual(begin);
      expect(check?.report).toEqual(report);
      expect(await storage.readIssues()).toEqual([]);
      expect(await storage.readCheckMarkdown(taskId, 1)).toBeNull();
    });
  });

  it('removes the whole directory of the history with the task', async () => {
    await storage.appendVersion(taskId, edit);
    await storage.deleteTask(taskId);
    await expect(readdir(join(root, '.board', 'tasks', taskId))).rejects.toThrow();
  });

  it('is not seen by an older board: the task file and the documents are where they were', async () => {
    await storage.appendVersion(taskId, edit);
    await storage.writeDocument(taskId, 'plan.md', '# Plan\n');
    expect((await readdir(join(root, '.board', 'tasks', taskId))).sort()).toEqual([
      'history',
      'plan.md',
      'task.md',
    ]);
  });
});

describe('markdown storage: topics, blocks and their counters (ADR-0032 §2–3)', () => {
  let root: string;
  let storage: Storage;
  const topicsDir = (): string => join(root, '.board', 'topics');
  const sequenceFile = (): string => join(topicsDir(), 'sequence.json');

  beforeEach(async () => {
    root = await tmpDir();
    storage = markdownStorage({ root });
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    await cleanTmpDirs();
  });

  async function exists(file: string): Promise<boolean> {
    return stat(file).then(
      () => true,
      () => false,
    );
  }

  async function refusal(action: Promise<unknown>): Promise<string | undefined> {
    return action.then(
      () => undefined,
      (error: unknown) => (error as { code?: string }).code,
    );
  }

  it('keeps the counters in topics/sequence.json, apart from board.json (INVARIANT)', async () => {
    await storage.createTask({ title: 't', status: 'todo', rank: 'a0', body: '', labels: [] });
    const topic = await storage.createTopic({ title: 'M1', body: '' });
    await storage.createBlock(topic.id, { title: 'A' });
    await storage.createBlock(topic.id, { title: 'B' });

    expect(JSON.parse(await readFile(sequenceFile(), 'utf8'))).toEqual({
      formatVersion: 1,
      topicSequence: 1,
      blockSequence: 2,
    });
    const state = JSON.parse(await readFile(join(root, '.board', 'board.json'), 'utf8'));
    expect(Object.keys(state).sort()).toEqual(['formatVersion', 'reportSequence', 'taskSequence']);
  });

  it('writes a topic as topics/P<n>/topic.md with its ordered blocks', async () => {
    const topic = await storage.createTopic({ title: 'M1 Core', body: '## Goal\n' });
    await storage.createBlock(topic.id, { title: 'Storage' });
    await storage.createBlock(topic.id, { title: 'API' });
    const text = await readFile(join(topicsDir(), 'P1', 'topic.md'), 'utf8');
    expect(text.startsWith('---\n')).toBe(true);
    expect(text).toContain('title: M1 Core');
    expect(text.indexOf('K1')).toBeLessThan(text.indexOf('K2'));
    expect(text).not.toMatch(/^status:/m);
    expect(text.endsWith('---\n## Goal\n')).toBe(true);
  });

  it('leaves no temporary file behind', async () => {
    const topic = await storage.createTopic({ title: 'M1', body: '' });
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => storage.createBlock(topic.id, { title: `B${i}` })),
    );
    expect((await readdir(topicsDir())).sort()).toEqual(['P1', 'sequence.json']);
    expect(await readdir(join(topicsDir(), 'P1'))).toEqual(['topic.md']);
  });

  it('reads a board of an earlier version as it was, and adds topics beside it', async () => {
    const task = await storage.createTask({
      title: 't',
      status: 'todo',
      rank: 'a0',
      body: 'Body.\n',
      labels: [],
    });
    const taskFile = join(root, '.board', 'tasks', task.id, 'task.md');
    const stateFile = join(root, '.board', 'board.json');
    const before = [await readFile(taskFile, 'utf8'), await readFile(stateFile, 'utf8')];
    await storage.close();
    storage = markdownStorage({ root });
    await storage.init();

    expect(await exists(topicsDir())).toBe(false);
    expect(await storage.getTopic('P1')).toBeNull();
    expect(await storage.getTask(task.id)).toEqual(task);
    expect((await storage.createTopic({ title: 'M1', body: '' })).id).toBe('P1');
    expect([await readFile(taskFile, 'utf8'), await readFile(stateFile, 'utf8')]).toEqual(before);
  });

  it('counts a topic directory without topic.md as a topic it cannot read (O-1)', async () => {
    await storage.createTopic({ title: 'M1', body: '' });
    await mkdir(join(topicsDir(), 'P7'));
    await rm(sequenceFile());
    expect(await refusal(storage.createTopic({ title: 'x', body: '' }))).toBe(
      'ID_SEQUENCE_UNRECOVERABLE',
    );
    expect(await refusal(storage.createBlock('P1', { title: 'x' }))).toBe(
      'ID_SEQUENCE_UNRECOVERABLE',
    );
  });

  it('writes nothing at all when it refuses (O-1)', async () => {
    const topic = await storage.createTopic({ title: 'M1', body: '' });
    await storage.createBlock(topic.id, { title: 'A' });
    const topicFile = join(topicsDir(), 'P1', 'topic.md');
    await writeFile(join(topicsDir(), 'P1', 'topic.md'), 'broken\n', 'utf8');
    await rm(sequenceFile());

    expect(await refusal(storage.createTopic({ title: 'x', body: '' }))).toBe(
      'ID_SEQUENCE_UNRECOVERABLE',
    );
    expect(await exists(sequenceFile())).toBe(false);
    expect(await readdir(topicsDir())).toEqual(['P1']);
    expect(await readFile(topicFile, 'utf8')).toBe('broken\n');
  });

  it.each([
    ['not JSON', '{'],
    ['not an object', '[1, 2]'],
    ['a counter missing', '{"formatVersion":1,"topicSequence":3}'],
    ['a negative counter', '{"formatVersion":1,"topicSequence":-1,"blockSequence":2}'],
    ['a fraction', '{"formatVersion":1,"topicSequence":1.5,"blockSequence":2}'],
    ['a string', '{"formatVersion":1,"topicSequence":"3","blockSequence":2}'],
    ['another format', '{"formatVersion":2,"topicSequence":3,"blockSequence":2}'],
  ])('treats a sequence.json with %s as invalid (O-1)', async (_name, content) => {
    const topic = await storage.createTopic({ title: 'M1', body: '' });
    await storage.createBlock(topic.id, { title: 'A' });
    await storage.createTopic({ title: 'M2', body: '' });
    await writeFile(sequenceFile(), content, 'utf8');
    await writeFile(join(topicsDir(), 'P2', 'topic.md'), 'broken\n', 'utf8');

    expect(await refusal(storage.createTopic({ title: 'x', body: '' }))).toBe(
      'ID_SEQUENCE_UNRECOVERABLE',
    );
    await rm(join(topicsDir(), 'P2'), { recursive: true });
    // With every topic readable, the same file is recovered from the ids, not refused.
    expect((await storage.createTopic({ title: 'x', body: '' })).id).toBe('P2');
    expect((await storage.createBlock('P1', { title: 'B' })).id).toBe('K2');
  });

  it('ignores what is not a topic in the topics directory', async () => {
    await mkdir(join(topicsDir(), 'notes'), { recursive: true });
    await writeFile(join(topicsDir(), 'README.md'), '# Notes\n', 'utf8');
    await writeFile(join(topicsDir(), 'notes', 'topic.md'), 'not a topic\n', 'utf8');
    expect((await storage.createTopic({ title: 'M1', body: '' })).id).toBe('P1');
  });

  it('takes the directory name as the id, whatever the file says', async () => {
    await storage.createTopic({ title: 'M1', body: '' });
    const file = join(topicsDir(), 'P1', 'topic.md');
    await writeFile(file, (await readFile(file, 'utf8')).replace('id: P1', 'id: P9'), 'utf8');
    expect((await storage.getTopic('P1'))?.id).toBe('P1');
  });

  it('keeps a field it does not know in topic.md through a write, as written (INVARIANT)', async () => {
    const topic = await storage.createTopic({ title: 'M1', body: 'Body.\n' });
    const file = join(topicsDir(), 'P1', 'topic.md');
    const text = (await readFile(file, 'utf8')).replace(
      'title: M1',
      'title: M1\nowner: me\nlinks:\n  - a\n  - b',
    );
    await writeFile(file, text, 'utf8');
    expect((await storage.getTopic(topic.id))?.extra).toEqual({ owner: 'me', links: ['a', 'b'] });
    await storage.createBlock(topic.id, { title: 'A' });
    const written = await readFile(file, 'utf8');
    expect(written).toContain('owner: me');
    expect(written).toContain('links:\n  - a\n  - b');
    expect(written).toContain('Body.\n');
    expect(await storage.readIssues()).toEqual([]);
  });

  it('reads an id, title or blocks of the wrong shape as unreadable, not as extra', async () => {
    await storage.createTopic({ title: 'M1', body: '' });
    const file = join(topicsDir(), 'P1', 'topic.md');
    await writeFile(file, '---\ntitle: M1\nblocks: nope\nowner: me\n---\n', 'utf8');
    expect(await storage.getTopic('P1')).toBeNull();
    expect((await storage.readIssues()).map((issue) => issue.file)).toEqual(['topics/P1/topic.md']);
    expect(await readFile(file, 'utf8')).toBe('---\ntitle: M1\nblocks: nope\nowner: me\n---\n');
  });
});

describe('task.md: topic, block and dependsOn (ADR-0032 §3, T82)', () => {
  // An earlier board knows none of the three: they are the person's own fields, after updatedAt.
  const legacyText =
    '---\nid: T7\ntitle: Handwritten\nstatus: todo\nrank: a0\nlabels: []\n' +
    'createdAt: 2026-09-21T10:00:00.000Z\nupdatedAt: 2026-09-21T10:00:00.000Z\n' +
    'topic: P2\nblock: K5\ndependsOn:\n  - T3\n  - T4\nestimate: 3\nlinks:\n  a: [1, 2]\n---\nBody.\n';

  const countOf = (text: string, key: string): number =>
    text.split('\n').filter((line) => line.startsWith(`${key}:`)).length;

  it('reads the three from the fields an earlier board kept in `extra`, not as unknown ones (INVARIANT)', () => {
    const parsed = parseTask('T7', legacyText);
    if (!('task' in parsed)) throw new Error(parsed.error);
    expect(parsed.task).toMatchObject({ topic: 'P2', block: 'K5', dependsOn: ['T3', 'T4'] });
    expect(parsed.task.extra).toEqual({ estimate: 3, links: { a: [1, 2] } });
  });

  it('writes each of the three once, and the unknown fields as they were (INVARIANT)', () => {
    const parsed = parseTask('T7', legacyText);
    if (!('task' in parsed)) throw new Error(parsed.error);
    const written = serializeTask(parsed.task);
    for (const key of ['topic', 'block', 'dependsOn', 'estimate', 'links']) {
      expect(countOf(written, key)).toBe(1);
    }
    const again = parseTask('T7', written);
    if (!('task' in again)) throw new Error(again.error);
    expect(again.task).toEqual(parsed.task);
  });

  it('writes a task without them exactly as before (INVARIANT)', () => {
    const plain =
      '---\nid: T7\ntitle: Handwritten\nstatus: todo\nrank: a0\nlabels: []\n' +
      'createdAt: 2026-09-21T10:00:00.000Z\nupdatedAt: 2026-09-21T10:00:00.000Z\nestimate: 3\n---\nBody.\n';
    const parsed = parseTask('T7', plain);
    if (!('task' in parsed)) throw new Error(parsed.error);
    expect(serializeTask(parsed.task)).toBe(plain);
  });

  it('reports a value of the wrong shape as unreadable, and does not invent it', () => {
    for (const bad of ['topic: T1\n', 'block: K1\n', 'dependsOn: T3\n', 'topic: P1\nblock: P1\n']) {
      const parsed = parseTask(
        'T7',
        legacyText.replace(/topic: P2\nblock: K5\ndependsOn:\n {2}- T3\n {2}- T4\n/, bad),
      );
      expect('error' in parsed).toBe(true);
    }
  });

  describe('on disk', () => {
    let root: string;
    let storage: Storage;

    beforeEach(async () => {
      root = await tmpDir();
      storage = markdownStorage({ root });
      await storage.init();
      const dir = join(root, '.board', 'tasks', 'T7');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'task.md'), legacyText, 'utf8');
    });

    afterEach(async () => {
      await storage.close();
      await cleanTmpDirs();
    });

    const file = (): string => join(root, '.board', 'tasks', 'T7', 'task.md');

    it('reads the legacy board without a read issue', async () => {
      expect(await storage.readIssues()).toEqual([]);
      expect(await storage.getTask('T7')).toMatchObject({
        topic: 'P2',
        block: 'K5',
        dependsOn: ['T3', 'T4'],
      });
    });

    it('keeps all of it through a write of something else (INVARIANT)', async () => {
      await storage.updateTask('T7', { title: 'Renamed', labels: ['x'] });
      const text = await readFile(file(), 'utf8');
      for (const key of ['topic', 'block', 'dependsOn', 'estimate', 'links']) {
        expect(countOf(text, key)).toBe(1);
      }
      expect(text).toContain('topic: P2');
      expect(text).toContain('block: K5');
      expect(text).toContain('  - T3\n  - T4\n');
      expect(text).toContain('estimate: 3');
      expect((await storage.getTask('T7'))?.extra).toEqual({ estimate: 3, links: { a: [1, 2] } });
      expect(await storage.readIssues()).toEqual([]);
    });

    it('removes a field from the file when the patch clears it, and keeps the others', async () => {
      await storage.updateTask('T7', { dependsOn: null });
      const text = await readFile(file(), 'utf8');
      expect(countOf(text, 'dependsOn')).toBe(0);
      expect(text).toContain('topic: P2');
      expect(text).toContain('estimate: 3');
    });
  });
});

describe('markdown storage: topic and block writes on disk (T84)', () => {
  let root: string;
  let storage: Storage;

  beforeEach(async () => {
    root = await tmpDir();
    storage = markdownStorage({ root });
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    await cleanTmpDirs();
  });

  const newTask = (over: Record<string, unknown> = {}): NewTask => ({
    title: 'A task',
    status: 'todo',
    rank: 'a0',
    body: '',
    labels: [],
    ...over,
  });

  /** Every file under .board with its bytes, and the directories: nothing may differ. */
  async function disk(dir = join(root, '.board')): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        result[`${path}/`] = '';
        Object.assign(result, await disk(path));
      } else {
        result[path] = await readFile(path, 'utf8');
      }
    }
    return result;
  }

  const topicFile = (id: string): string => join(root, '.board', 'topics', id, 'topic.md');

  it('writes a reordered topic as the blocks list of topic.md, in that order', async () => {
    const created = await storage.createTopic({ title: 'M1', body: 'Body\n' });
    for (const title of ['a', 'b', 'c']) await storage.createBlock(created.id, { title });
    await storage.reorderBlocks(created.id, ['K3', 'K1', 'K2']);
    const text = await readFile(topicFile(created.id), 'utf8');
    expect(text.indexOf('id: K3')).toBeLessThan(text.indexOf('id: K1'));
    expect(text.indexOf('id: K1')).toBeLessThan(text.indexOf('id: K2'));
    expect(text.endsWith('---\nBody\n')).toBe(true);
    expect(parseTopic('P1', text)).toMatchObject({
      topic: { blocks: [{ id: 'K3' }, { id: 'K1' }, { id: 'K2' }] },
    });
  });

  it('removes the directory of a deleted topic, and keeps the counters', async () => {
    const created = await storage.createTopic({ title: 'M1', body: '' });
    await storage.deleteTopic(created.id);
    expect(await readdir(join(root, '.board', 'topics'))).toEqual(['sequence.json']);
    expect(
      JSON.parse(await readFile(join(root, '.board', 'topics', 'sequence.json'), 'utf8')),
    ).toEqual({
      formatVersion: 1,
      topicSequence: 1,
      blockSequence: 0,
    });
  });

  describe('a refusal changes no file at all (INVARIANT)', () => {
    beforeEach(async () => {
      await storage.createTopic({ title: 'with a task', body: '' });
      await storage.createBlock('P1', { title: 'busy' });
      await storage.createBlock('P1', { title: 'empty' });
      await storage.createTopic({ title: 'with an empty block only', body: '' });
      await storage.createBlock('P2', { title: 'empty' });
      await storage.createTask(newTask({ topic: 'P1', block: 'K1' }));
    });

    it.each([
      ['a topic with a task in a block', (s: Storage) => s.deleteTopic('P1'), 'TOPIC_NOT_EMPTY'],
      ['a topic with an empty block only', (s: Storage) => s.deleteTopic('P2'), 'TOPIC_NOT_EMPTY'],
      ['a block with a task', (s: Storage) => s.deleteBlock('P1', 'K1'), 'BLOCK_NOT_EMPTY'],
      ['a topic that does not exist', (s: Storage) => s.deleteTopic('P9'), 'TOPIC_NOT_FOUND'],
      ['a block that does not exist', (s: Storage) => s.deleteBlock('P1', 'K9'), 'BLOCK_NOT_FOUND'],
      ['a block of another topic', (s: Storage) => s.deleteBlock('P2', 'K1'), 'BLOCK_NOT_FOUND'],
      [
        'an order that is not whole',
        (s: Storage) => s.reorderBlocks('P1', ['K1']),
        'INVALID_REQUEST',
      ],
      [
        'a rename of a missing block',
        (s: Storage) => s.updateBlock('P1', 'K9', { title: 'x' }),
        'BLOCK_NOT_FOUND',
      ],
      [
        'an update of a missing topic',
        (s: Storage) => s.updateTopic('P9', { title: 'x' }),
        'TOPIC_NOT_FOUND',
      ],
    ])('%s', async (_name, action, code) => {
      const before = await disk();
      await expect(action(storage)).rejects.toMatchObject({ code });
      expect(await disk()).toEqual(before);
    });
  });

  it('does not even recover the counters when it refuses a delete (INVARIANT)', async () => {
    await storage.createTopic({ title: 'M1', body: '' });
    await storage.createBlock('P1', { title: 'busy' });
    await storage.createTask(newTask({ topic: 'P1', block: 'K1' }));
    await rm(join(root, '.board', 'topics', 'sequence.json'));
    const before = await disk();
    await expect(storage.deleteBlock('P1', 'K1')).rejects.toMatchObject({
      code: 'BLOCK_NOT_EMPTY',
    });
    await expect(storage.deleteTopic('P1')).rejects.toMatchObject({ code: 'TOPIC_NOT_EMPTY' });
    expect(await disk()).toEqual(before);
  });

  it('refuses to delete a topic or a block while a task file cannot be read: it may be in it', async () => {
    await storage.createTopic({ title: 'with a block', body: '' });
    await storage.createBlock('P1', { title: 'b' });
    await storage.createTopic({ title: 'bare', body: '' });
    const dir = join(root, '.board', 'tasks', 'T1');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'task.md'), 'not a task file\n', 'utf8');
    const before = await disk();
    await expect(storage.deleteBlock('P1', 'K1')).rejects.toMatchObject({
      code: 'BLOCK_NOT_EMPTY',
    });
    await expect(storage.deleteTopic('P2')).rejects.toMatchObject({ code: 'TOPIC_NOT_EMPTY' });
    expect(await disk()).toEqual(before);
  });

  it('counts a task that names a block of the topic as its own, even without a topic field', async () => {
    const created = await storage.createTopic({ title: 'M1', body: '' });
    await storage.createBlock(created.id, { title: 'b' });
    const dir = join(root, '.board', 'tasks', 'T1');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'task.md'),
      '---\nid: T1\ntitle: By hand\nstatus: todo\nrank: a0\nlabels: []\nblock: K1\n' +
        'createdAt: 2026-09-21T10:00:00.000Z\nupdatedAt: 2026-09-21T10:00:00.000Z\n---\n',
      'utf8',
    );
    await expect(storage.deleteBlock(created.id, 'K1')).rejects.toMatchObject({
      code: 'BLOCK_NOT_EMPTY',
    });
    await expect(storage.deleteTopic(created.id)).rejects.toMatchObject({
      code: 'TOPIC_NOT_EMPTY',
    });
  });
});
