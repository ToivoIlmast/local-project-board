import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import { taskSchema, type Task } from '../../src/contract/v1/index.js';
import { startSession } from '../../src/server/cli/claude.js';
import { NotBegun, reportRunFailure } from '../../src/server/cli/runFailure.js';
import { readRuntime, writeRuntime, type RuntimeState } from '../../src/server/cli/runtime.js';
import { resolveBoardRoot } from '../../src/server/project/boardRoot.js';
import { cli, cliInBackground, stopBoards } from '../support/cli.js';
import { fakeClaude } from '../support/fakeClaude.js';
import { initRepo } from '../support/gitRepo.js';
import { freePort, releasePorts } from '../support/ports.js';
import { cleanTmpDirs, tmpDir } from '../support/tmp.js';

/**
 * The runner's half of ADR-0029 T94 (K9–K11): `claude --wait` reports a work run that stopped
 * before begin, once, with fixed words, and only for a request that carries a `requestId`; it
 * declares `signals=run-failure`, and steps back once for a board of an earlier version.
 */

afterEach(async () => {
  await stopBoards();
  await releasePorts();
  await cleanTmpDirs();
});

const WAITING = /^Waiting for Send to AI → Claude Code/;
const RUNNER_ERROR = 'The runner could not start Claude Code; see its terminal.';

async function api(state: RuntimeState, method: string, path: string, body?: unknown) {
  return fetch(`${state.url}api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function readTask(state: RuntimeState, id: string): Promise<Task> {
  const { readiness: _readiness, ...task } = (await (
    await api(state, 'GET', `/tasks/${id}`)
  ).json()) as Task & {
    readiness: unknown;
  };
  return taskSchema.parse(task);
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A running board in a git repository, with T1 and T2. */
async function boardWithTasks(): Promise<{ root: string; state: RuntimeState }> {
  const root = await initRepo(await tmpDir());
  const start = await cli(['--port', String(await freePort()), '--no-open'], { cwd: root });
  expect(start.exitCode).toBe(0);
  const runtime = await readRuntime(root);
  if (runtime.kind !== 'state') throw new Error('The board is not running.');
  for (const title of ['Extract the git adapter', 'Write the report']) {
    expect((await api(runtime.state, 'POST', '/tasks', { title, status: 'todo' })).status).toBe(
      201,
    );
  }
  return { root, state: runtime.state };
}

describe('claude --wait reports a start that did not begin (K9), on the real board', () => {
  it('claude gone from the PATH: claude-missing on the page, the text in the terminal, and it waits again (S4a)', async () => {
    const { root, state } = await boardWithTasks();
    const claude = await fakeClaude();
    const runner = cliInBackground(['claude', '--wait'], { cwd: root, env: claude.env() });
    await runner.printed(WAITING);
    // Claude Code was there when the runner began to wait, and is gone when the request comes.
    await rm(join(claude.bin, 'claude'));

    expect((await api(state, 'POST', '/tasks/T1/run', { agent: 'claude-code' })).status).toBe(200);

    const task = await until(
      () => readTask(state, 'T1'),
      (read) => read.launch?.failure !== undefined,
    );
    expect(task.launch).toMatchObject({ afterRunId: 0, reports: true });
    expect(task.launch?.failure).toEqual({
      kind: 'claude-missing',
      message: expect.stringMatching(
        /^Claude Code was not found: there is no `claude` in the PATH\./,
      ),
      at: expect.any(String),
    });
    // Nothing began: no run, no process.
    expect(task.aiRun).toBeUndefined();
    expect(await claude.calls()).toEqual([]);
    // Fixed words only: no token, no path of this machine.
    expect(task.launch?.failure?.message).not.toContain(state.token);
    expect(task.launch?.failure?.message).not.toContain(claude.bin);
    await runner.printed(/`claude`.*PATH/);
    await runner.printed(WAITING, 2);
    expect(runner.err.join('\n')).not.toMatch(/did not take the report/);
  });

  it('a start that begins removes the launch: the page then shows the run, and nothing is reported', async () => {
    const { root, state } = await boardWithTasks();
    const claude = await fakeClaude();
    const hold = join(await tmpDir(), 'release');
    const runner = cliInBackground(['claude', '--wait'], {
      cwd: root,
      env: claude.env({ holdUntil: hold }),
    });
    await runner.printed(WAITING);

    await api(state, 'POST', '/tasks/T1/run', { agent: 'claude-code' });

    const working = await until(
      () => readTask(state, 'T1'),
      (read) => read.aiRun?.state === 'working',
    );
    expect(working.launch).toBeUndefined();
    await writeFile(hold, '', 'utf8');
    await runner.printed(/^The session on T1 ended/);
    expect((await readTask(state, 'T1')).launch).toBeUndefined();
  });
});

describe('startSession says why a start did not begin (K9), against the real board', () => {
  it('begin-refused: the board refused the begin, with its own words; nothing is spawned', async () => {
    const { root, state } = await boardWithTasks();
    const claude = await fakeClaude();
    await api(state, 'PATCH', '/tasks/T2', { dependsOn: ['T1'] });

    const failure = await startSession(
      `${claude.bin}/claude`,
      'T2',
      state,
      root,
      claude.env(),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(NotBegun);
    expect(failure).toMatchObject({ kind: 'begin-refused' });
    expect((failure as NotBegun).report).toMatch(/T2/);
    expect((failure as NotBegun).report).toBe((failure as NotBegun).message);
    expect(await claude.calls()).toEqual([]);
  });

  it('resume-refused: the board has no finished session to resume', async () => {
    const { root, state } = await boardWithTasks();
    const claude = await fakeClaude();

    const failure = await startSession(
      `${claude.bin}/claude`,
      'T1',
      state,
      root,
      claude.env(),
      undefined,
      'resume',
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      kind: 'resume-refused',
      report: 'Task T1 has no finished session of Claude Code to resume.',
    });
    expect(await claude.calls()).toEqual([]);
  });

  it('runner-error: the board did not answer; the report is fixed words, the terminal keeps the reason', async () => {
    const { root, state } = await boardWithTasks();
    const claude = await fakeClaude();
    const gone: RuntimeState = { ...state, url: `http://127.0.0.1:${await freePort()}/` };

    const failure = await startSession(
      `${claude.bin}/claude`,
      'T1',
      gone,
      root,
      claude.env(),
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ kind: 'runner-error', report: RUNNER_ERROR });
    expect((failure as Error).message).toMatch(/did not answer/);
  });

  it('a failure after begin is not one of these: it is end{launchError}, as T33 says', async () => {
    const { root, state } = await boardWithTasks();

    const code = await startSession(join(root, 'no-such-claude'), 'T1', state, root, process.env);

    expect(typeof code).toBe('number');
    const task = await readTask(state, 'T1');
    expect(task.aiRun).toMatchObject({ state: 'failed', failure: { kind: 'launch' } });
    expect(task.launch).toBeUndefined();
  });
});

/** A board that answers only what a test needs, and records what it was sent. */
interface StubBoard {
  root: string;
  state: RuntimeState;
  queries: string[];
  reports: { body: unknown; authorization: string | undefined }[];
  /** Answers to `run-failure`, in order; the last one repeats. */
  answers: number[];
  /** Requests not yet handed: the next runner that waits gets the first. */
  queue: unknown[];
  /** Hands a request to the runner waiting now, or to the next one that waits. */
  hand: (request: unknown) => void;
  server: Server;
}

/**
 * The query of `GET /runs` as a board before T94 parses it: strict, `accepts` only (copied from
 * the contract at cd9e635). An unknown name is `400 INVALID_REQUEST` before the runner counts.
 */
const runsQueryBeforeT94 = z.strictObject({
  accepts: z
    .string()
    .regex(/^(check|research)(,(check|research))*$/)
    .optional(),
});

async function stubBoard(
  options: { earlier?: boolean; answers?: number[] } = {},
): Promise<StubBoard> {
  const root = await resolveBoardRoot(await initRepo(await tmpDir()));
  await mkdir(join(root, '.board'), { recursive: true });
  const token = randomBytes(16).toString('hex');
  const stub = {
    root,
    queries: [] as string[],
    reports: [] as StubBoard['reports'],
    answers: options.answers ?? [200],
    queue: [] as unknown[],
    waiting: [] as ServerResponse[],
    hand(request: unknown): void {
      const runner = stub.waiting.pop();
      if (runner === undefined) stub.queue.push(request);
      else runner.end(`data: ${JSON.stringify(request)}\n\n`);
    },
  };
  const json = (response: ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    let text = '';
    request.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
    request.on('end', () => {
      if (url.pathname === '/api/v1/project') return json(response, 200, { root });
      if (url.pathname === '/api/v1/runs') {
        stub.queries.push(url.search);
        const query = Object.fromEntries(url.searchParams);
        if (options.earlier === true && !runsQueryBeforeT94.safeParse(query).success) {
          return json(response, 400, {
            error: { code: 'INVALID_REQUEST', message: 'The request does not match.', details: {} },
          });
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('retry: 500\n\n');
        const next = stub.queue.shift();
        if (next !== undefined) response.end(`data: ${JSON.stringify(next)}\n\n`);
        else stub.waiting.push(response);
        return;
      }
      const failure = /^\/api\/v1\/tasks\/(T\d+)\/run-failure$/.exec(url.pathname);
      if (failure !== null) {
        stub.reports.push({ body: JSON.parse(text), authorization: request.headers.authorization });
        const status = stub.answers[stub.reports.length - 1] ?? stub.answers.at(-1) ?? 200;
        return json(response, status, status === 200 ? { recorded: true } : { error: {} });
      }
      if (/^\/api\/v1\/tasks\/T\d+\/ai-run$/.test(url.pathname)) {
        const { sessionId } = JSON.parse(text) as { sessionId: string };
        return json(response, 200, { agent: 'runner', state: 'working', runId: 1, sessionId });
      }
      if (/\/end$/.test(url.pathname)) return json(response, 200, {});
      return json(response, 404, { error: { code: 'NOT_FOUND', message: 'No.', details: {} } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const state: RuntimeState = {
    formatVersion: 1,
    pid: process.pid,
    port,
    url: `http://127.0.0.1:${port}/`,
    token,
    root,
  };
  await writeRuntime(state);
  return Object.assign(stub, { state, server });
}

const closeStub = (stub: StubBoard): Promise<void> =>
  new Promise((resolve) => {
    stub.server.closeAllConnections();
    stub.server.close(() => resolve());
  });

const failure = new NotBegun(
  'claude-missing',
  'Claude Code was not found.',
  'Claude Code was not found.',
);
const REQUEST = 'b7e1c0d2-3f4a-4b5c-9d6e-7f8091a2b3c4';

describe('the delivery of a report (K9): three tries, 500 ms apart, then the terminal', () => {
  it('sends the request id, the kind and the message, with the token in the header only', async () => {
    const stub = await stubBoard();
    try {
      expect(await reportRunFailure(stub.root, 'T1', REQUEST, failure)).toBe('delivered');
      expect(stub.reports).toEqual([
        {
          body: {
            requestId: REQUEST,
            kind: 'claude-missing',
            message: 'Claude Code was not found.',
          },
          authorization: `Bearer ${stub.state.token}`,
        },
      ]);
    } finally {
      await closeStub(stub);
    }
  });

  it('cuts the message to 500 characters before it sends it (K10)', async () => {
    const stub = await stubBoard();
    try {
      const long = new NotBegun('begin-refused', 'x', 'y'.repeat(800));
      await reportRunFailure(stub.root, 'T1', REQUEST, long);
      expect((stub.reports[0]?.body as { message: string }).message).toHaveLength(500);
    } finally {
      await closeStub(stub);
    }
  });

  it('tries again on 5xx, 500 ms apart, and is delivered on the third try', async () => {
    const stub = await stubBoard({ answers: [503, 500, 200] });
    try {
      const began = Date.now();
      expect(await reportRunFailure(stub.root, 'T1', REQUEST, failure)).toBe('delivered');
      expect(stub.reports).toHaveLength(3);
      expect(Date.now() - began).toBeGreaterThanOrEqual(900);
    } finally {
      await closeStub(stub);
    }
  });

  it('gives up after three tries: undelivered', async () => {
    const stub = await stubBoard({ answers: [503] });
    try {
      expect(await reportRunFailure(stub.root, 'T1', REQUEST, failure)).toBe('undelivered');
      expect(stub.reports).toHaveLength(3);
    } finally {
      await closeStub(stub);
    }
  });

  it.each([
    [409, 'stale'],
    [400, 'refused'],
    [401, 'refused'],
    [404, 'refused'],
  ] as const)('ends at once on %i: %s', async (status, outcome) => {
    const stub = await stubBoard({ answers: [status] });
    try {
      expect(await reportRunFailure(stub.root, 'T1', REQUEST, failure)).toBe(outcome);
      expect(stub.reports).toHaveLength(1);
    } finally {
      await closeStub(stub);
    }
  });

  it('looks for the board again before each try: a board that came back takes it', async () => {
    const stub = await stubBoard();
    try {
      const gone = { ...stub.state, url: `http://127.0.0.1:${await freePort()}/` };
      await writeRuntime(gone);
      setTimeout(() => void writeRuntime(stub.state), 200);
      expect(await reportRunFailure(stub.root, 'T1', REQUEST, failure)).toBe('delivered');
    } finally {
      await closeStub(stub);
    }
  });

  it('no board at all: undelivered, after three looks', async () => {
    const root = await initRepo(await tmpDir());
    expect(await reportRunFailure(root, 'T1', REQUEST, failure)).toBe('undelivered');
  });
});

describe('a board of an earlier version (K11): one step back, no request lost', () => {
  it('asks once with signals, then without, says so once, and starts the request it is handed', async () => {
    const stub = await stubBoard({ earlier: true });
    try {
      const claude = await fakeClaude();
      stub.queue.push({ type: 'run.requested', taskId: 'T1', agent: 'claude-code' });
      const runner = cliInBackground(['claude', '--wait'], { cwd: stub.root, env: claude.env() });

      await until(claude.calls, (calls) => calls.length === 1);
      await runner.printed(/^The session on T1 ended/);
      await runner.printed(WAITING, 2);

      expect(stub.queries[0]).toBe('?accepts=check,research&signals=run-failure');
      // From then on, to the board with this token, never signals again.
      expect(stub.queries.slice(1)).toEqual(
        stub.queries.slice(1).map(() => '?accepts=check,research'),
      );
      expect(stub.queries.length).toBeGreaterThanOrEqual(3);
      const notes = runner.out.filter((line) => /earlier version/.test(line));
      expect(notes).toEqual([
        'This board is of an earlier version: it will not show a failed start on the page.',
      ]);
      expect(stub.reports).toEqual([]);
    } finally {
      await closeStub(stub);
    }
  });

  it('a board of this version: signals every time, and no note', async () => {
    const stub = await stubBoard();
    try {
      const claude = await fakeClaude();
      stub.queue.push({ type: 'run.requested', taskId: 'T1', agent: 'claude-code' });
      const runner = cliInBackground(['claude', '--wait'], { cwd: stub.root, env: claude.env() });
      await runner.printed(WAITING, 2);
      expect(stub.queries.slice(0, 2)).toEqual([
        '?accepts=check,research&signals=run-failure',
        '?accepts=check,research&signals=run-failure',
      ]);
      expect(runner.out.join('\n')).not.toMatch(/earlier version/);
    } finally {
      await closeStub(stub);
    }
  });

  it('a request without a requestId is never reported: there is nothing to report it to', async () => {
    const stub = await stubBoard({ earlier: true });
    try {
      const claude = await fakeClaude();
      const runner = cliInBackground(['claude', '--wait'], { cwd: stub.root, env: claude.env() });
      await runner.printed(WAITING);
      await rm(join(claude.bin, 'claude'));
      stub.hand({ type: 'run.requested', taskId: 'T1', agent: 'claude-code' });
      await runner.printed(/`claude`.*PATH/);
      expect(stub.reports).toEqual([]);
    } finally {
      await closeStub(stub);
    }
  });
});
