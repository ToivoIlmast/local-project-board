import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Storage } from '../../src/core/ports.js';
import { parseTask, serializeTask } from '../../src/server/storage/markdown/taskFile.js';
import {
  markdownStorage,
  type MarkdownStorageOptions,
} from '../../src/server/storage/markdown/index.js';
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
  cleanup: cleanTmpDirs,
});

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
