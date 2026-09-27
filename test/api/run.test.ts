import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  API_BASE_PATH as API,
  errorResponseSchema,
  routes,
  runRequestSchema,
  type RunRequest,
} from '../../src/contract/v1/index.js';
import { createTestBoard, type TestBoard } from '../support/httpBoard.js';
import { openStream, type SseClient } from '../support/sse.js';
import { cleanTmpDirs } from '../support/tmp.js';

/**
 * Send to AI → Claude Code, the part the board plays (T27). The board starts nothing: it hands
 * the request "run the agent on this task" to one runner that the person started in a terminal
 * of the project (`local-project-board claude --wait`), and the runner starts Claude Code. What
 * crosses the wire is a task id and the name of the agent; never a program, never an argument.
 */

let board: TestBoard;
const open: SseClient<RunRequest>[] = [];

const RUNS = `${API}${routes['runs.stream'].path}`;

beforeEach(async () => {
  board = await createTestBoard();
  for (const title of ['Ship it', 'Not this one']) {
    await board.post(`${API}/tasks`, { title, status: 'todo' }).expect(201);
  }
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()));
  await board.close();
  await cleanTmpDirs();
});

const code = (body: unknown): string => errorResponseSchema.parse(body).error.code;
const message = (body: unknown): string => errorResponseSchema.parse(body).error.message;

/** A runner as the CLI is one: the token of this run, and the stream of requests. */
async function runner(token = board.token): Promise<SseClient<RunRequest>> {
  const client = await openStream(board.port, RUNS, { authorization: `Bearer ${token}` }, (data) =>
    runRequestSchema.parse(data),
  );
  open.push(client);
  return client;
}

const start = (id: string, body: unknown = { agent: 'claude-code' }) =>
  board.post(`${API}/tasks/${id}/run`, body);

describe('POST /tasks/:id/run with a runner waiting', () => {
  it('hands exactly this task to the runner, and says so (INVARIANT)', async () => {
    const waiting = await runner();

    const response = await start('T2').expect(200);

    expect(response.body).toEqual({ taskId: 'T2', agent: 'claude-code' });
    expect(response.headers['content-type']).toContain(routes['tasks.run'].response.media);
    expect(() => routes['tasks.run'].response.schema.parse(response.body)).not.toThrow();
    await waiting.waitForEvents(1);
    expect(waiting.events).toEqual([{ type: 'run.requested', taskId: 'T2', agent: 'claude-code' }]);
  });

  it('gives one request to one runner and then lets it go: a runner starts one session at a time', async () => {
    const waiting = await runner();

    await start('T1').expect(200);

    await waiting.waitFor((client) => client.ended(), 'the stream to end');
    expect(waiting.events).toHaveLength(1);
    // Nobody is waiting any more: a second click is not queued for later, it is refused now.
    const second = await start('T2').expect(409);
    expect(code(second.body)).toBe('NO_AGENT_RUNNER');
  });

  it('starts each task once, on one runner only, however many are waiting (INVARIANT)', async () => {
    const first = await runner();
    const second = await runner();

    await start('T1').expect(200);
    await start('T2').expect(200);
    await start('T1').expect(409);

    await first.waitFor((client) => client.ended(), 'the first stream to end');
    await second.waitFor((client) => client.ended(), 'the second stream to end');
    const handed = [...first.events, ...second.events].map((request) => request.taskId).sort();
    expect(handed).toEqual(['T1', 'T2']);
    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(1);
  });

  it('does not count a runner that went away', async () => {
    const gone = await runner();
    await gone.close();

    const response = await start('T1').expect(409);

    expect(code(response.body)).toBe('NO_AGENT_RUNNER');
  });

  it('changes nothing on the board: the agent is the one that moves the task and reports', async () => {
    await runner();
    const before = (await board.get(`${API}/tasks`).expect(200)).body as unknown;
    const published = board.events.events.length;

    await start('T1').expect(200);

    expect((await board.get(`${API}/tasks`).expect(200)).body).toEqual(before);
    expect(board.events.events).toHaveLength(published);
  });
});

describe('POST /tasks/:id/run refuses, and hands nothing to a runner', () => {
  it('says that no runner waits, and how to start one or the session itself', async () => {
    const response = await start('T1').expect(409);

    expect(code(response.body)).toBe('NO_AGENT_RUNNER');
    expect(message(response.body)).toContain('npx local-project-board claude --wait');
    expect(message(response.body)).toContain('npx local-project-board claude T1');
  });

  it('a task that does not exist, even with a runner waiting (INVARIANT)', async () => {
    const waiting = await runner();

    const response = await start('T99').expect(404);

    expect(code(response.body)).toBe('TASK_NOT_FOUND');
    expect(waiting.events).toEqual([]);
    expect(waiting.ended()).toBe(false);
    // The runner is still there for the right task.
    await start('T1').expect(200);
  });

  it('what is not a task id', async () => {
    const waiting = await runner();

    for (const id of ['banana', 't1', 'T0', encodeURIComponent('T1; id')]) {
      expect(code((await start(id).expect(400)).body)).toBe('INVALID_REQUEST');
    }
    expect(waiting.events).toEqual([]);
  });

  it('anything but the name of a known agent: no program, no arguments, no prompt (INVARIANT)', async () => {
    const waiting = await runner();

    for (const body of [
      {},
      { agent: 'bash' },
      { agent: 'claude' },
      { agent: 'claude-code', command: 'rm -rf /' },
      { agent: 'claude-code', args: ['--dangerously-skip-permissions'] },
      { agent: 'claude-code', prompt: 'Do something else.' },
      { agent: 'claude-code', cwd: '/' },
    ]) {
      const response = await start('T1', body).expect(400);
      expect(code(response.body)).toBe('INVALID_REQUEST');
    }
    expect(waiting.events).toEqual([]);
  });

  it('a request without the token, or from another page', async () => {
    const waiting = await runner();

    const anonymous = await board
      .agent()
      .post(`${API}/tasks/T1/run`)
      .send({ agent: 'claude-code' })
      .expect(401);
    expect(code(anonymous.body)).toBe('UNAUTHORIZED');

    const foreign = await board
      .agent()
      .post(`${API}/tasks/T1/run`)
      .set('Authorization', `Bearer ${board.token}`)
      .set('Origin', 'http://evil.example')
      .send({ agent: 'claude-code' })
      .expect(403);
    expect(code(foreign.body)).toBe('FORBIDDEN_ORIGIN');

    expect(waiting.events).toEqual([]);
  });
});

describe('GET /runs: where a runner waits', () => {
  it('is a stream, open only to the holder of the token (INVARIANT)', async () => {
    for (const headers of [{}, { authorization: 'Bearer nope' }]) {
      const response = await board.agent().get(RUNS).set(headers).expect(401);
      expect(code(response.body)).toBe('UNAUTHORIZED');
    }

    const waiting = await runner();
    expect(waiting.status).toBe(200);
    expect(waiting.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(waiting.headers['cache-control']).toBe('no-store');
  });

  it('carries nothing of the board: a runner learns of a request and of nothing else', async () => {
    const waiting = await runner();

    await board.post(`${API}/tasks`, { title: 'Third' }).expect(201);
    await board.patch(`${API}/tasks/T1`, { body: 'Changed.' }).expect(200);

    expect(waiting.events).toEqual([]);
  });

  it('is not in the instructions of an agent, nor is the route that starts one', async () => {
    expect(routes['runs.stream'].ai.include).toBe(false);
    expect(routes['tasks.run'].ai.include).toBe(false);
    const instructions = (await board.get(`${API}/instructions`).expect(200)).text;
    expect(instructions).not.toContain('/run');
  });
});

describe('the board server never starts a process (ADR-0029, INVARIANT)', () => {
  it('has no module outside the CLI that can spawn one', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(join(process.cwd(), 'src'));

    const spawners = files
      .filter((file) => /child_process/.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(process.cwd().length + 1))
      .sort();

    // The git reader runs `git` read-only (ADR-0007); the CLI starts `claude` and a browser for
    // the person who typed the command. Nothing that answers a request does.
    expect(spawners).toEqual([
      'src/server/cli/claude.ts',
      'src/server/cli/openBrowser.ts',
      'src/server/git/exec.ts',
    ]);
  });
});
