import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Storage } from '../../src/core/ports.js';
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
    const issues: { file: string; message: string }[] = [];
    const reader = markdownStorage({ root, onIssue: (issue) => issues.push(issue) });
    await reader.init();
    const good = await reader.createTask(task);
    const dir = join(root, '.board', 'tasks', 'T99');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'task.md'), '---\ntitle: [broken\n---\nBody\n', 'utf8');

    const tasks = await reader.listTasks();
    expect(tasks.map((t) => t.id)).toEqual([good.id]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.file).toContain('T99');
    expect(await reader.getTask('T99')).toBeNull();
    await reader.close();
  });

  it('removes the task directory, documents and all, when a task is deleted', async () => {
    const created = await storage.createTask(task);
    await storage.writeDocument(created.id, 'plan.md', '# Plan\n');
    const dir = join(root, '.board', 'tasks', created.id);
    await storage.deleteTask(created.id);
    await expect(readdir(dir)).rejects.toThrow();
  });

  it('reports a file with no frontmatter instead of crashing', async () => {
    const issues: { file: string; message: string }[] = [];
    const reader = markdownStorage({ root, onIssue: (issue) => issues.push(issue) });
    await reader.init();
    const dir = join(root, '.board', 'tasks', 'T42');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'task.md'), 'Just a note, no frontmatter.\n', 'utf8');
    expect(await reader.listTasks()).toEqual([]);
    expect(issues[0]?.message).toContain('frontmatter');
    await reader.close();
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
