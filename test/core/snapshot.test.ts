import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { boardSnapshotSchema } from '../../src/core/model/index.js';
import type { Storage } from '../../src/core/ports.js';
import { createSnapshot } from '../../src/core/services/snapshot.js';
import { markdownStorage } from '../../src/server/storage/markdown/index.js';
import { createMemoryStore, inMemoryStorage } from '../support/inMemoryStorage.js';
import { cleanTmpDirs, tmpDir } from '../support/tmp.js';

const project = { name: 'dep-health', statuses: ['todo', 'done'], idPrefix: 'T' };

async function fill(storage: Storage): Promise<void> {
  await storage.init();
  const first = await storage.createTask({
    title: 'Extract the git adapter',
    status: 'todo',
    rank: 'a0',
    body: '## Context\n',
    labels: ['refactor'],
    extra: { estimate: 3 },
  });
  await storage.createTask({
    title: 'Write the docs',
    status: 'done',
    rank: 'a1',
    body: '',
    labels: [],
  });
  await storage.writeDocument(first.id, 'plan.md', '# Plan\n');
  await storage.writeDocument(first.id, 'notes.md', '# Notes\n');
  await storage.writeReport({ title: 'Audit', format: 'html', content: '<h1>Audit</h1>\n' });
}

describe('createSnapshot', () => {
  afterAll(cleanTmpDirs);

  it('contains every task, document and report of the board (INVARIANT)', async () => {
    const storage = inMemoryStorage(createMemoryStore());
    await fill(storage);
    const snapshot = await createSnapshot(storage, project);

    expect(boardSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.formatVersion).toBe(2);
    expect(snapshot.project).toEqual(project);
    expect(snapshot.tasks).toEqual(await storage.listTasks());
    expect(snapshot.documents).toEqual([
      { taskId: 'T1', name: 'notes.md', content: '# Notes\n' },
      { taskId: 'T1', name: 'plan.md', content: '# Plan\n' },
    ]);
    expect(snapshot.reports).toEqual([
      expect.objectContaining({ id: 'R1', title: 'Audit', content: '<h1>Audit</h1>\n' }),
    ]);
  });

  it('describes an empty board too', async () => {
    const storage = inMemoryStorage(createMemoryStore());
    await storage.init();
    const snapshot = await createSnapshot(storage, project);
    expect(snapshot).toMatchObject({
      workflow: { board: {}, statuses: {} },
      tasks: [],
      documents: [],
      reports: [],
    });
  });

  it('contains the workflow overrides of the board, its columns and its tasks (INVARIANT)', async () => {
    const storage = inMemoryStorage(createMemoryStore());
    await fill(storage);
    const workflow = {
      board: { push: false, checkCommand: 'npm test' },
      statuses: { todo: { editCode: false } },
    };
    await storage.writeWorkflow(workflow);
    await storage.updateTask('T2', { workflow: { commit: false } });

    const snapshot = await createSnapshot(storage, project);

    expect(boardSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.workflow).toEqual(workflow);
    expect(snapshot.tasks.find((t) => t.id === 'T2')?.workflow).toEqual({ commit: false });
    expect(snapshot.tasks.find((t) => t.id === 'T1')).not.toHaveProperty('workflow');
  });

  it('holds overrides only: nothing the resolver computes (INVARIANT)', async () => {
    const storage = inMemoryStorage(createMemoryStore());
    await fill(storage);
    await storage.writeWorkflow({ board: { push: true }, statuses: {} });
    const snapshot = await createSnapshot(storage, project);
    expect(JSON.stringify(snapshot.workflow)).toBe('{"board":{"push":true},"statuses":{}}');
  });

  it('does not change the board it exports (INVARIANT)', async () => {
    const root = await tmpDir();
    const storage = markdownStorage({ root });
    await fill(storage);

    const before = await fingerprint(join(root, '.board'));
    await createSnapshot(storage, project);
    expect(await fingerprint(join(root, '.board'))).toEqual(before);
    await storage.close();
  });
});

async function fingerprint(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (!entry.isFile()) continue;
    const info = await stat(path);
    result[path] = `${info.mtimeMs}:${await readFile(path, 'utf8')}`;
  }
  return result;
}
