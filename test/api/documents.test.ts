import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  API_BASE_PATH as API,
  documentMetaSchema,
  errorResponseSchema,
  taskSchema,
} from '../../src/contract/v1/index.js';
import { createTestBoard, type TestBoard } from '../support/httpBoard.js';
import { cleanTmpDirs, tmpDir } from '../support/tmp.js';

let board: TestBoard;
let taskId: string;
/** The directory above the board, where a file the API must never reach is kept. */
let outside: string;

beforeEach(async () => {
  outside = await tmpDir();
  board = await createTestBoard({ root: join(outside, 'project') });
  const created = await board.post(`${API}/tasks`, { title: 'a' }).expect(201);
  taskId = taskSchema.parse(created.body).id;
});

afterEach(async () => {
  await board.close();
  await cleanTmpDirs();
});

const documents = (): string => `${API}/tasks/${taskId}/documents`;

describe('documents over HTTP', () => {
  it('writes, lists, reads, overwrites and deletes a document', async () => {
    expect((await board.get(documents()).expect(200)).body).toEqual([]);

    const written = await board.put(`${documents()}/plan.md`, { content: '# Plan\n' }).expect(200);
    expect(documentMetaSchema.parse(written.body)).toMatchObject({ taskId, name: 'plan.md' });
    expect(await readFile(join(board.root, '.board', 'tasks', taskId, 'plan.md'), 'utf8')).toBe(
      '# Plan\n',
    );

    const listed = await board.get(documents()).expect(200);
    expect(
      z
        .array(documentMetaSchema)
        .parse(listed.body)
        .map((d) => d.name),
    ).toEqual(['plan.md']);

    const read = await board.get(`${documents()}/plan.md`).expect(200);
    expect(read.headers['content-type']).toMatch(/^text\/markdown/);
    expect(read.text).toBe('# Plan\n');

    await board.put(`${documents()}/plan.md`, { content: '# Plan v2\n' }).expect(200);
    expect((await board.get(`${documents()}/plan.md`).expect(200)).text).toBe('# Plan v2\n');

    expect((await board.del(`${documents()}/plan.md`).expect(200)).body).toEqual({ deleted: true });
    await board.get(`${documents()}/plan.md`).expect(404);
    expect(board.events.types()).toEqual([
      'task.created',
      'document.written',
      'document.written',
      'document.deleted',
    ]);
  });

  it('answers 404 for a document and a task that do not exist', async () => {
    const missing = await board.get(`${documents()}/absent.md`).expect(404);
    expect(errorResponseSchema.parse(missing.body).error.code).toBe('DOCUMENT_NOT_FOUND');
    await board.get(`${API}/tasks/T99/documents/plan.md`).expect(404);
    await board.put(`${API}/tasks/T99/documents/plan.md`, { content: 'x' }).expect(404);
    await board.get(`${API}/tasks/T99/documents`).expect(404);
  });

  it('keeps task.md reserved, whatever case it is written in', async () => {
    const before = await readFile(join(board.root, '.board', 'tasks', taskId, 'task.md'), 'utf8');

    for (const name of ['task.md', 'TASK.md', 'Task.md']) {
      const response = await board.put(`${documents()}/${name}`, { content: 'stolen\n' });
      expect(response.status).toBe(400);
      expect(errorResponseSchema.parse(response.body).error.code).toBe('INVALID_REQUEST');
    }

    expect(await readFile(join(board.root, '.board', 'tasks', taskId, 'task.md'), 'utf8')).toBe(
      before,
    );
  });

  it('refuses a name the contract does not allow', async () => {
    for (const name of ['.env', 'plan.txt', 'plan', 'sub%2Fdir.md', 'x'.repeat(70) + '.md']) {
      const response = await board.put(`${documents()}/${name}`, { content: 'x' });
      expect(response.status).toBe(400);
      expect(errorResponseSchema.parse(response.body).error.code).toBe('INVALID_REQUEST');
    }
    expect((await board.get(documents()).expect(200)).body).toEqual([]);
  });

  it('never leaves the board directory, whatever the name is encoded as', async () => {
    const secret = join(outside, 'secret.md');
    await writeFile(secret, 'TOP SECRET\n', 'utf8');

    const attempts = [
      '../secret.md',
      '..%2fsecret.md',
      '..%2Fsecret.md',
      '%2e%2e%2fsecret.md',
      '%2e%2e/secret.md',
      '%252e%252e%252fsecret.md',
      '..%5csecret.md',
      '....//secret.md',
      '../../../../etc/passwd',
      '..%2f..%2f..%2f..%2fetc%2fpasswd',
      '/etc/passwd',
    ];

    for (const name of attempts) {
      const response = await board.get(`${documents()}/${name}`);
      expect([400, 404]).toContain(response.status);
      expect(response.text).not.toContain('TOP SECRET');
      expect(response.text).not.toContain('root:');
      expect(response.text).not.toContain(board.root);
    }

    for (const name of attempts) {
      const response = await board.put(`${documents()}/${name}`, { content: 'written\n' });
      expect([400, 404]).toContain(response.status);
    }
    expect(await readFile(secret, 'utf8')).toBe('TOP SECRET\n');
  });

  it('refuses a body the contract does not describe', async () => {
    await board.put(`${documents()}/plan.md`, { content: 'x', extra: 1 }).expect(400);
    await board.put(`${documents()}/plan.md`, {}).expect(400);
    await board.put(`${documents()}/plan.md`, { content: 'x'.repeat(1_000_001) }).expect(400);
    expect((await board.get(documents()).expect(200)).body).toEqual([]);
  });
});
