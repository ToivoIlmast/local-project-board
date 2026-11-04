import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  API_BASE_PATH as API,
  errorResponseSchema,
  taskSchema,
  versionListSchema,
} from '../../src/contract/v1/index.js';
import { createTestBoard, type TestBoard } from '../support/httpBoard.js';
import { cleanTmpDirs } from '../support/tmp.js';

/**
 * The place and the dependencies of a task over POST and PATCH /tasks (T85, ADR-0032 §3–4): what
 * does not hold against the board is `422`, and a refusal writes nothing at all.
 */

let board: TestBoard;

beforeEach(async () => {
  board = await createTestBoard();
  // P1 holds K1 and P2 holds K2, so a block of the other topic can be named.
  await board.storage.createTopic({ title: 'first', body: '' });
  await board.storage.createBlock('P1', { title: 'one' });
  await board.storage.createTopic({ title: 'second', body: '' });
  await board.storage.createBlock('P2', { title: 'two' });
});

afterEach(async () => {
  await board.close();
  await cleanTmpDirs();
});

/** A task written through the port, so the setup does not lean on what is under test. */
async function seed(place: { topic?: string; block?: string; dependsOn?: string[] } = {}) {
  return board.storage.createTask({
    title: 'A task',
    status: 'todo',
    rank: 'a0',
    body: '',
    labels: [],
    ...place,
  });
}

/** Every file of the board with its bytes, and every event published: what a refusal leaves. */
async function state(): Promise<unknown> {
  const dir = join(board.root, '.board');
  const files: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[path.slice(dir.length + 1)] = await readFile(path, 'utf8');
  }
  return { files, events: structuredClone(board.events.events) };
}

function codeOf(body: unknown): string {
  return errorResponseSchema.parse(body).error.code;
}

async function expectRefusedPost(body: Record<string, unknown>, code: string): Promise<void> {
  const before = await state();
  const response = await board.post(`${API}/tasks`, { title: 'New', ...body }).expect(422);
  expect(codeOf(response.body)).toBe(code);
  expect(await state()).toEqual(before);
}

async function expectRefusedPatch(
  id: string,
  body: Record<string, unknown>,
  code: string,
): Promise<void> {
  const before = await state();
  const original = (await board.get(`${API}/tasks/${id}`).expect(200)).body as unknown;
  const response = await board.patch(`${API}/tasks/${id}`, body).expect(422);
  expect(codeOf(response.body)).toBe(code);
  expect(await state()).toEqual(before);
  expect((await board.get(`${API}/tasks/${id}`).expect(200)).body).toEqual(original);
}

describe('dependsOn over HTTP (T85 acceptance)', () => {
  it('refuses a cycle: 422 DEPENDENCY_CYCLE with its tasks, nothing written', async () => {
    const a = await seed();
    const b = await seed({ dependsOn: [a.id] });
    await expectRefusedPatch(a.id, { dependsOn: [b.id] }, 'DEPENDENCY_CYCLE');
    await expectRefusedPatch(a.id, { dependsOn: [a.id] }, 'DEPENDENCY_CYCLE');
    const response = await board.patch(`${API}/tasks/${a.id}`, { dependsOn: [b.id] });
    expect(errorResponseSchema.parse(response.body).error.details).toEqual({
      tasks: [a.id, b.id],
    });
  });

  it('refuses a cycle together with a content change: no version, no content', async () => {
    const a = await seed();
    const b = await seed({ dependsOn: [a.id] });
    await expectRefusedPatch(
      a.id,
      { title: 'Renamed', body: 'New body\n', dependsOn: [b.id] },
      'DEPENDENCY_CYCLE',
    );
  });

  it('refuses a task that does not exist, on POST and on PATCH', async () => {
    const a = await seed();
    await expectRefusedPost({ dependsOn: ['T99'] }, 'INVALID_DEPENDENCY');
    await expectRefusedPost({ dependsOn: [a.id, 'T99'] }, 'INVALID_DEPENDENCY');
    await expectRefusedPatch(a.id, { dependsOn: ['T99'] }, 'INVALID_DEPENDENCY');
  });

  it('refuses a block id in dependsOn, on POST and on PATCH', async () => {
    const a = await seed();
    await expectRefusedPost({ dependsOn: ['K1'] }, 'INVALID_DEPENDENCY');
    await expectRefusedPatch(a.id, { dependsOn: ['K1'] }, 'INVALID_DEPENDENCY');
    await expectRefusedPatch(a.id, { dependsOn: ['P1'] }, 'INVALID_DEPENDENCY');
  });

  it('takes a dependency, of another topic too, and answers with it as stored', async () => {
    const other = await seed({ topic: 'P2', block: 'K2' });
    const created = await board
      .post(`${API}/tasks`, { title: 'New', topic: 'P1', block: 'K1', dependsOn: [other.id] })
      .expect(201);
    const task = taskSchema.parse(created.body);
    expect(task).toMatchObject({ topic: 'P1', block: 'K1', dependsOn: [other.id] });
    expect(await board.storage.getTask(task.id)).toEqual(task);
    expect(board.events.types().at(-1)).toBe('task.created');
  });

  it('changes dependencies by PATCH without a version, and clears them with null', async () => {
    const a = await seed();
    const b = await seed();
    const versions = async (id: string) =>
      versionListSchema.parse((await board.get(`${API}/tasks/${id}/versions`).expect(200)).body);
    const before = await versions(b.id);

    const patched = await board.patch(`${API}/tasks/${b.id}`, { dependsOn: [a.id] }).expect(200);
    expect(taskSchema.parse(patched.body).dependsOn).toEqual([a.id]);
    expect(await versions(b.id)).toEqual(before);
    expect(board.events.types().at(-1)).toBe('task.updated');

    const cleared = await board.patch(`${API}/tasks/${b.id}`, { dependsOn: null }).expect(200);
    expect(cleared.body).not.toHaveProperty('dependsOn');
    expect(await versions(b.id)).toEqual(before);
  });
});

describe('topic and block over HTTP (T85 acceptance)', () => {
  it('refuses a block of another topic, on POST and on PATCH', async () => {
    const placed = await seed({ topic: 'P1', block: 'K1' });
    await expectRefusedPost({ topic: 'P1', block: 'K2' }, 'INVALID_PLACEMENT');
    await expectRefusedPatch(placed.id, { block: 'K2' }, 'INVALID_PLACEMENT');
    await expectRefusedPatch(placed.id, { topic: 'P2' }, 'INVALID_PLACEMENT');
  });

  it('refuses a block without a topic', async () => {
    const loose = await seed();
    await expectRefusedPost({ block: 'K1' }, 'INVALID_PLACEMENT');
    await expectRefusedPatch(loose.id, { block: 'K1' }, 'INVALID_PLACEMENT');
  });

  it('refuses a topic that does not exist, and a block that does not exist', async () => {
    const placed = await seed({ topic: 'P1' });
    await expectRefusedPost({ topic: 'P9' }, 'INVALID_PLACEMENT');
    await expectRefusedPost({ topic: 'P9', block: 'K1' }, 'INVALID_PLACEMENT');
    await expectRefusedPost({ topic: 'P1', block: 'K9' }, 'INVALID_PLACEMENT');
    await expectRefusedPatch(placed.id, { topic: 'P9' }, 'INVALID_PLACEMENT');
    await expectRefusedPatch(placed.id, { block: 'K9' }, 'INVALID_PLACEMENT');
  });

  it('places a task by POST and moves it by PATCH, without a version', async () => {
    const created = await board.post(`${API}/tasks`, { title: 'New', topic: 'P1' }).expect(201);
    const task = taskSchema.parse(created.body);
    expect(task).toMatchObject({ topic: 'P1' });
    expect(task).not.toHaveProperty('block');
    const versions = (await board.get(`${API}/tasks/${task.id}/versions`).expect(200)).body;

    const moved = await board
      .patch(`${API}/tasks/${task.id}`, { topic: 'P2', block: 'K2' })
      .expect(200);
    expect(moved.body).toMatchObject({ topic: 'P2', block: 'K2' });
    expect(await board.storage.getTask(task.id)).toEqual(moved.body);
    expect((await board.get(`${API}/tasks/${task.id}/versions`).expect(200)).body).toEqual(
      versions,
    );

    const out = await board
      .patch(`${API}/tasks/${task.id}`, { topic: null, block: null })
      .expect(200);
    expect(out.body).not.toHaveProperty('topic');
    expect(out.body).not.toHaveProperty('block');
  });

  it('keeps fields of the person’s own in task.md across a placement write', async () => {
    const a = await seed();
    const b = await seed();
    const file = join(board.root, '.board', 'tasks', b.id, 'task.md');
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace(/\n---\n/, '\nestimate: 3\n---\n'), 'utf8');

    await board.patch(`${API}/tasks/${b.id}`, { dependsOn: [a.id], topic: 'P1' }).expect(200);
    expect(await readFile(file, 'utf8')).toContain('estimate: 3');
    expect((await board.storage.getTask(b.id))?.extra).toEqual({ estimate: 3 });
  });

  it('a POST that is refused uses no id: the next task gets it', async () => {
    await seed();
    await board.post(`${API}/tasks`, { title: 'New', topic: 'P9' }).expect(422);
    await board.post(`${API}/tasks`, { title: 'New', dependsOn: ['T9'] }).expect(422);
    const next = await board.post(`${API}/tasks`, { title: 'New' }).expect(201);
    expect((next.body as { id: string }).id).toBe('T2');
  });
});

describe('the form of the fields over HTTP', () => {
  it('answers 400 for what is not in the form of the contract, before the board is asked', async () => {
    const a = await seed();
    for (const body of [
      { dependsOn: a.id },
      { dependsOn: ['not an id'] },
      { topic: 'K1' },
      { block: 'P1' },
    ]) {
      const before = await state();
      const response = await board.post(`${API}/tasks`, { title: 'New', ...body }).expect(400);
      expect(codeOf(response.body)).toBe('INVALID_REQUEST');
      await board.patch(`${API}/tasks/${a.id}`, body).expect(400);
      expect(await state()).toEqual(before);
    }
  });
});
