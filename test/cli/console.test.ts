import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeCodePrompt } from '../../src/contract/v1/index.js';
import {
  consoleReadResponse,
  type ConsoleEntry,
  type ConsoleEvent,
  type ConsoleReadResponse,
} from '../../src/contract/v1/console.js';
import { parseCliArgs, UsageError } from '../../src/server/cli/args.js';
import { consoleArgv } from '../../src/server/cli/console/session.js';
import { initialNormalizerState, normalize } from '../../src/server/cli/console/normalize.js';
import type { ProcessProbe } from '../../src/server/cli/processProbe.js';
import { holdsSession, inspectRun } from '../../src/server/cli/runInspect.js';
import { journalDir, runJournalSchema } from '../../src/server/cli/runJournal.js';
import { RUNNER_LOG } from '../../src/server/cli/runnerLog.js';
import { readRuntime, type RuntimeState } from '../../src/server/cli/runtime.js';
import { cli, cliInBackground, stopBoards, type BackgroundCli } from '../support/cli.js';
import { fakeClaude, type FakeClaude, type FakeClaudeBehaviour } from '../support/fakeClaude.js';
import { initRepo } from '../support/gitRepo.js';
import { freePort, releasePorts } from '../support/ports.js';
import { cleanTmpDirs, tmpDir } from '../support/tmp.js';

/**
 * Console mode of the runner (plan C8): `claude --wait --console` starts `claude -p` with pipes,
 * writes the prompt to its stdin, normalizes its stdout and delivers the events to the console
 * journal of the board, whatever the board or the process do meanwhile.
 */

afterEach(async () => {
  jest.restoreAllMocks();
  await stopBoards();
  await releasePorts();
  await cleanTmpDirs();
});

const FIXTURE_DIR = join(process.cwd(), 'test', 'fixtures', 'claude-stream-json', '2.1.330');

async function api(state: RuntimeState, method: string, path: string, body?: unknown) {
  return fetch(`${state.url}api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function runningState(root: string): Promise<RuntimeState> {
  const runtime = await readRuntime(root);
  if (runtime.kind !== 'state') throw new Error('The board is not running.');
  return runtime.state;
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface Started {
  root: string;
  state: RuntimeState;
  stop: () => Promise<void>;
}

async function startBoard(root: string): Promise<Started> {
  const start = await cli(['--port', String(await freePort()), '--no-open'], { cwd: root });
  expect(start.exitCode).toBe(0);
  return {
    root,
    state: await runningState(root),
    stop: () => start.stop?.() ?? Promise.resolve(),
  };
}

/** A running board in a git repository with the task T1. */
async function boardWithTask(): Promise<Started> {
  const started = await startBoard(await initRepo(await tmpDir()));
  expect(
    (await api(started.state, 'POST', '/tasks', { title: 'Extract the git adapter' })).status,
  ).toBe(201);
  return started;
}

interface Session {
  board: Started;
  claude: FakeClaude;
  runner: BackgroundCli;
  /** The board as it is now: it may have been restarted. */
  state: () => Promise<RuntimeState>;
}

/** `claude --wait --console` waiting on the board; the task is sent to it as the page does. */
async function consoleSession(
  behaviour: FakeClaudeBehaviour,
  options: { send?: boolean } = {},
): Promise<Session> {
  const board = await boardWithTask();
  const claude = await fakeClaude();
  const runner = cliInBackground(['claude', '--wait', '--console'], {
    cwd: board.root,
    env: claude.env(behaviour),
  });
  await runner.printed(/^Waiting for Send to AI/);
  if (options.send !== false) {
    const answer = await api(board.state, 'POST', '/tasks/T1/run', { agent: 'claude-code' });
    expect(answer.status).toBe(200);
  }
  return { board, claude, runner, state: () => runningState(board.root) };
}

async function consoleOf(state: RuntimeState): Promise<ConsoleReadResponse | undefined> {
  const task = (await (await fetch(`${state.url}api/v1/tasks/T1`)).json()) as {
    aiRun?: { runId?: number; console?: boolean };
  };
  if (task.aiRun?.console !== true) return undefined;
  const answer = await fetch(
    `${state.url}api/v1/tasks/T1/ai-run/${task.aiRun.runId ?? 0}/console?limit=1000`,
  );
  if (!answer.ok) return undefined;
  return consoleReadResponse.parse(await answer.json());
}

const kinds = (entries: ConsoleEntry[]): string[] => entries.map((entry) => entry.event.kind);

/** The journal of the board, once an entry of this kind is in it. */
async function untilJournal(
  state: RuntimeState,
  kind: ConsoleEvent['kind'],
): Promise<ConsoleReadResponse> {
  const read = await until(
    () => consoleOf(state),
    (value) => value?.entries.some((entry) => entry.event.kind === kind) === true,
  );
  return read as ConsoleReadResponse;
}

const eventOf = <K extends ConsoleEvent['kind']>(
  read: ConsoleReadResponse,
  kind: K,
): Extract<ConsoleEvent, { kind: K }> | undefined =>
  read.entries.find((entry) => entry.event.kind === kind)?.event as
    Extract<ConsoleEvent, { kind: K }> | undefined;

/** The run is over for the runner: it said so, so the end was delivered or given up. */
const ended = (session: Session) => session.runner.printed(/^The session on T1 ended/);

const aiRunOf = async (state: RuntimeState) =>
  (
    (await (await fetch(`${state.url}api/v1/tasks/T1`)).json()) as {
      aiRun?: Record<string, unknown>;
    }
  ).aiRun;

/** What the normalizer makes of a fixture, with the uuid of its prompt replaced. */
function tapeOf(name: string, promptUuid: string): ConsoleEvent[] {
  const stdin = readFileSync(join(FIXTURE_DIR, `${name}.stdin.ndjson`), 'utf8');
  const fixtureUuid = (JSON.parse(stdin.split('\n')[0] ?? '') as { uuid: string }).uuid;
  let state = initialNormalizerState();
  const events: ConsoleEvent[] = [];
  for (const line of readFileSync(join(FIXTURE_DIR, `${name}.stdout.ndjson`), 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const out = normalize(state, JSON.parse(line));
    state = out.state;
    events.push(...out.events);
  }
  return JSON.parse(JSON.stringify(events).replaceAll(fixtureUuid, promptUuid)) as ConsoleEvent[];
}

/** The events of the runner that are not the tape: the prompt, the process and the probe. */
const FRAME_KINDS = ['user.message', 'process.started', 'compat.passed', 'process.exited'];

const runnerJournalOf = async (root: string, runId: number) =>
  runJournalSchema.safeParse(
    JSON.parse(
      await readFile(join(journalDir(root), `T1-${runId}.json`), 'utf8').catch(() => 'null'),
    ),
  );

describe('local-project-board claude --wait --console', () => {
  describe('the command line', () => {
    it('takes --console with claude --wait only', () => {
      expect(parseCliArgs(['claude', '--wait', '--console'])).toMatchObject({
        command: 'claude',
        wait: true,
        console: true,
      });
      expect(parseCliArgs(['claude', '--wait'])).not.toHaveProperty('console');
      for (const argv of [
        ['claude', 'T1', '--console'],
        ['claude', '--console'],
        ['serve', '--console'],
        ['claude', '--recover', 'T1', '--console'],
        ['claude', 'T1', '--check', '--console'],
      ]) {
        expect(() => parseCliArgs(argv)).toThrow(UsageError);
      }
    });
  });

  describe('the process', () => {
    it('starts as claude -p with pipes, no shell, and the prompt is not on its command line (INVARIANT)', async () => {
      const urls: string[] = [];
      const real = globalThis.fetch;
      jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        urls.push(String(input instanceof Request ? input.url : input));
        return real(input, init);
      });
      const session = await consoleSession({ streamJson: 'tools' });
      await ended(session);

      const [call] = await session.claude.calls();
      const argv = call?.argv ?? [];
      expect(argv).toContain('-p');
      expect(argv[argv.indexOf('--permission-prompts') + 1]).toBe('none');
      const sessionId = argv[argv.indexOf('--session-id') + 1] ?? '';
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
      const prompt = claudeCodePrompt('T1', session.board.state.url.replace(/\/$/, ''));
      expect(argv.join(' ')).not.toContain(prompt);
      expect(argv.join(' ')).not.toContain('T1');
      for (const flag of ['--setting-sources', '--permission-mode', '--tools']) {
        expect(argv).not.toContain(flag);
      }
      // No shell: the program is started directly, as the terminal mode starts it.
      expect(readFileSync(join(process.cwd(), 'src/server/cli/spawnSession.ts'), 'utf8')).toMatch(
        /spawnConsoleSession[\s\S]*shell: false/,
      );
      // It said that it starts consoles, so the board may hand it work.
      expect(urls.some((url) => /\/runs\?accepts=[^&]*\bconsole\b/.test(url))).toBe(true);
      expect((await aiRunOf(await session.state()))?.['console']).toBe(true);
    });

    it('is told the prompt on its first stdin line, and the board journal has that very message', async () => {
      const session = await consoleSession({ streamJson: 'tools' });
      await ended(session);

      const [first] = await session.claude.stdin();
      const message = first as { type: string; message: { content: string }; uuid: string };
      const prompt = claudeCodePrompt('T1', session.board.state.url.replace(/\/$/, ''));
      expect(message).toMatchObject({ type: 'user', message: { role: 'user', content: prompt } });
      const read = (await consoleOf(await session.state())) as ConsoleReadResponse;
      const journalled = read.entries.find((entry) => entry.event.kind === 'user.message');
      expect(journalled?.event).toEqual({
        kind: 'user.message',
        origin: 'prompt',
        messageId: message.uuid,
        text: prompt,
      });
      expect(journalled?.runnerSeq).toBe(1);
    });

    it('delivers the whole tape of the tools fixture, in the order of runnerSeq', async () => {
      const session = await consoleSession({ streamJson: 'tools' });
      await ended(session);

      const state = await session.state();
      const read = (await consoleOf(state)) as ConsoleReadResponse;
      const fromRunner = read.entries.filter((entry) => entry.source === 'runner');
      expect(fromRunner.map((entry) => entry.runnerSeq)).toEqual(
        fromRunner.map((_entry, index) => index + 1),
      );
      expect(kinds(fromRunner).slice(0, 2)).toEqual(['user.message', 'process.started']);
      const promptId = (eventOf(read, 'user.message') as { messageId: string }).messageId;
      expect(
        fromRunner.map((entry) => entry.event).filter((event) => !FRAME_KINDS.includes(event.kind)),
      ).toEqual(tapeOf('tools', promptId));
      expect(kinds(read.entries)).toContain('tool.call');
      expect(kinds(fromRunner).at(-1)).toBe('process.exited');
      expect(eventOf(read, 'compat.passed')).toBeDefined();
      expect(eventOf(read, 'process.exited')).toMatchObject({ exitCode: 0, lastTurnOpen: false });
      // The run is over for the board, and the spool left nothing behind for it to wait for.
      expect((await aiRunOf(state))?.['endedAt']).toEqual(expect.any(String));
    });
  });

  describe('delivery', () => {
    it('repeats a batch whose answer was lost from the same fromRunnerSeq, with no duplicate or gap', async () => {
      const hold = join(await tmpDir(), 'hold');
      const posts: { fromRunnerSeq: number; count: number }[] = [];
      const real = globalThis.fetch;
      let lost = false;
      jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!/\/console\/events\?/.test(url)) return real(input, init);
        const body = JSON.parse(String(init?.body)) as { fromRunnerSeq: number; events: unknown[] };
        posts.push({ fromRunnerSeq: body.fromRunnerSeq, count: body.events.length });
        const answer = await real(input, init);
        if (lost) return answer;
        // The board wrote the batch; the runner never hears of it.
        lost = true;
        throw new DOMException('The operation timed out.', 'TimeoutError');
      });
      const session = await consoleSession({
        streamJson: 'tools',
        holdUntil: hold,
        holdAfterLines: 6,
      });
      const state = await session.state();

      // Held in the middle of the tape: everything so far has been delivered, after the retry.
      const read = (await until(
        () => consoleOf(state),
        (value) => value?.entries.some((entry) => entry.event.kind === 'compat.passed') === true,
      )) as ConsoleReadResponse;
      const runId = ((await aiRunOf(state)) as { runId: number }).runId;
      const lastSeq = Math.max(...read.entries.map((entry) => entry.runnerSeq ?? 0));
      const kept = await until(
        () => runnerJournalOf(session.board.root, runId),
        (value) => value.success && value.data.console?.ackedRunnerSeq === lastSeq,
      );
      expect(kept.success).toBe(true);
      expect(posts.length).toBeGreaterThanOrEqual(2);
      // The first batch failed; the second starts where the first did, and may be longer.
      expect(posts[1]?.fromRunnerSeq).toBe(posts[0]?.fromRunnerSeq);
      expect(posts[1]?.count).toBeGreaterThanOrEqual(posts[0]?.count ?? 0);

      await writeFile(hold, '');
      await ended(session);
      const done = (await consoleOf(await session.state())) as ConsoleReadResponse;
      const seqs = done.entries.filter((e) => e.source === 'runner').map((e) => e.runnerSeq);
      expect(seqs).toEqual(seqs.map((_seq, index) => index + 1));
      expect(done.entries.some((entry) => entry.event.kind === 'notice')).toBe(false);
    });

    it('keeps the events while the board is down and delivers them to the board that comes back, with its new token', async () => {
      const hold = join(await tmpDir(), 'hold');
      const session = await consoleSession({
        streamJson: 'tools',
        holdUntil: hold,
        holdAfterLines: 6,
      });
      const first = await session.state();
      await untilJournal(first, 'compat.passed');

      await session.board.stop();
      await writeFile(hold, '');
      // The tape goes on while nobody is there to take it.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const again = await startBoard(session.board.root);
      expect(again.state.token).not.toBe(first.token);

      await ended(session);
      const read = (await consoleOf(again.state)) as ConsoleReadResponse;
      const seqs = read.entries.filter((e) => e.source === 'runner').map((e) => e.runnerSeq);
      expect(seqs).toEqual(seqs.map((_seq, index) => index + 1));
      expect(kinds(read.entries)).toContain('tool.result');
      expect(kinds(read.entries).at(-1)).toBe('process.exited');
      expect((await aiRunOf(again.state))?.['endedAt']).toEqual(expect.any(String));
    });
  });

  describe('compatibility', () => {
    it('without msg_lifecycle_v1: compat.failed, stdin is closed, the end is recorded', async () => {
      const session = await consoleSession({
        streamJson: 'tools',
        lifecycle: false,
        stayOpen: true,
      });
      await ended(session);

      const state = await session.state();
      const read = (await consoleOf(state)) as ConsoleReadResponse;
      expect(eventOf(read, 'compat.failed')).toMatchObject({ reason: 'no-lifecycle' });
      expect(eventOf(read, 'compat.passed')).toBeUndefined();
      expect(eventOf(read, 'close.requested')).toEqual({
        kind: 'close.requested',
        reason: 'incompatible',
      });
      expect(await session.claude.stdin()).toContainEqual({ eof: true });
      expect(eventOf(read, 'process.exited')).toBeDefined();
      expect(read.state.compat.status).toBe('incompatible');
      expect((await aiRunOf(state))?.['endedAt']).toEqual(expect.any(String));
    });
  });

  describe('the process dies', () => {
    it('in the middle of a turn: process.exited, the turn is interrupted, the end is recorded', async () => {
      const session = await consoleSession({ streamJson: 'tools', exitMidTurn: true });
      await ended(session);

      const state = await session.state();
      const read = (await consoleOf(state)) as ConsoleReadResponse;
      expect(eventOf(read, 'process.exited')).toMatchObject({ exitCode: 1, lastTurnOpen: true });
      expect(read.state.turn.status).toBe('interrupted');
      expect(read.state.process.status).toBe('exited');
      expect((await aiRunOf(state))?.['endedAt']).toEqual(expect.any(String));
    });
  });

  describe('stderr', () => {
    it('is cleaned of terminal codes, and never becomes what the assistant said', async () => {
      const session = await consoleSession({
        streamJson: 'tools',
        stderr: '\u001b[31mwarning:\u001b[0m something odd\n',
      });
      await ended(session);

      const read = (await consoleOf(await session.state())) as ConsoleReadResponse;
      const stderr = read.entries.filter((entry) => entry.event.kind === 'runner.stderr');
      expect(stderr.length).toBeGreaterThan(0);
      const text = stderr.map((entry) => (entry.event as { text: string }).text).join('');
      expect(text).toContain('warning: something odd');
      expect(text).not.toContain('\u001b');
      const said = read.entries
        .filter((entry) => entry.event.kind === 'assistant.text')
        .map((entry) => (entry.event as { text: string }).text)
        .join('\n');
      expect(said).not.toContain('something odd');
    });
  });

  describe('signals of the runner', () => {
    // The reaction of the runner, not of a real Ctrl+C: `claude` would get that one too (§8.4,
    // L-10). The signal is delivered to the runner's own handlers, with no real signal sent, so
    // that it is the same on every platform and reaches nothing but this process.
    const interrupt = (): void => void process.emit('SIGINT');

    it('the first SIGINT closes stdin and says so; the second stops the process at once', async () => {
      const told = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const hold = join(await tmpDir(), 'hold');
      const session = await consoleSession({
        streamJson: 'tools',
        stayOpen: true,
        holdUntil: hold,
      });
      const state = await session.state();
      await untilJournal(state, 'compat.passed');
      await until(
        async () => (await session.claude.stdin()).length,
        (count) => count >= 1,
      );

      interrupt();
      const closing = await untilJournal(state, 'close.requested');
      expect(eventOf(closing, 'close.requested')).toEqual({
        kind: 'close.requested',
        reason: 'signal',
      });
      await until(
        () => session.claude.stdin(),
        (lines) => lines.some((line) => line['eof'] === true),
      );
      // The session still stands: the first Ctrl+C asks, it does not kill.
      expect(kinds((await consoleOf(state))?.entries ?? [])).not.toContain('process.exited');
      expect(told.mock.calls.join('\n')).toContain('input to the session is closed');

      interrupt();
      const killed = await untilJournal(state, 'process.exited');
      expect(kinds(killed.entries)).toContain('kill.requested');
      await writeFile(hold, '');
      await ended(session);
    });

    it('a SIGINT while the process exits in the middle of a turn: one Ctrl+C is enough', async () => {
      const hold = join(await tmpDir(), 'hold');
      const session = await consoleSession({
        streamJson: 'tools',
        exitMidTurn: true,
        holdUntil: hold,
      });
      const state = await session.state();
      await until(
        async () => (await consoleOf(state))?.entries.some((e) => e.event.kind === 'tool.call'),
        (found) => found === true,
      );

      interrupt();
      await writeFile(hold, '');
      await ended(session);

      const read = (await consoleOf(await session.state())) as ConsoleReadResponse;
      expect(kinds(read.entries)).toContain('close.requested');
      expect(kinds(read.entries)).not.toContain('kill.requested');
      expect(eventOf(read, 'process.exited')).toMatchObject({ lastTurnOpen: true });
      expect(read.state.turn.status).toBe('interrupted');
      // The messages are settled: none is left as if the model were still working on it.
      expect(read.state.messages.map((message) => message.status)).toEqual(['interrupted']);
      expect((await aiRunOf(await session.state()))?.['endedAt']).toEqual(expect.any(String));
    });
  });

  describe('runner log', () => {
    it('tells of the connections and the end, never of what was said', async () => {
      const session = await consoleSession({ streamJson: 'tools' });
      await ended(session);

      const names = await readdir(journalDir(session.board.root));
      expect(names).toContain(RUNNER_LOG);
      const log = await readFile(join(journalDir(session.board.root), RUNNER_LOG), 'utf8');
      expect(log).toMatch(/"event":"console"/);
      const read = (await consoleOf(await session.state())) as ConsoleReadResponse;
      for (const entry of read.entries) {
        const event = entry.event;
        if (event.kind === 'assistant.text' && event.text.length > 3) {
          expect(log).not.toContain(event.text);
        }
        if (event.kind === 'user.message') expect(log).not.toContain(event.text);
      }
      expect(log).not.toContain(session.board.state.token);
    });
  });

  describe('recover', () => {
    it('finds the console process by its --session-id, as it finds the terminal one', async () => {
      const sessionId = '3d0f71eb-97a5-476d-8ea4-e7b3eb0c5bfc';
      const argv = ['claude', ...consoleArgv(sessionId, {})];
      expect(argv).toContain('--session-id');
      expect(holdsSession(argv, sessionId)).toBe(true);
      expect(holdsSession(['claude', ...consoleArgv(sessionId, { resume: true })], sessionId)).toBe(
        true,
      );

      const machine: ProcessProbe = {
        platform: 'linux',
        ownPid: 1,
        hostname: () => 'box',
        bootId: () => Promise.resolve('boot-1'),
        pidNamespace: () => Promise.resolve('pid:[1]'),
        startOf: () => Promise.resolve('gone'),
        processes: () => Promise.resolve({ list: [{ pid: 4242, argv }], unreadable: 0 }),
      };
      const verdict = await inspectRun({ sessionId }, undefined, machine);
      expect(verdict.kind).toBe('alive');
      expect(verdict.reasons.join(' ')).toContain('4242');
    });
  });

  describe('the terminal mode', () => {
    it('without --console is as it was: --session-id and the prompt, a terminal, no console', async () => {
      const urls: string[] = [];
      const real = globalThis.fetch;
      jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        urls.push(String(input instanceof Request ? input.url : input));
        return real(input, init);
      });
      const board = await boardWithTask();
      const claude = await fakeClaude();
      const runner = cliInBackground(['claude', '--wait'], { cwd: board.root, env: claude.env() });
      await runner.printed(/^Waiting for Send to AI/);
      await api(board.state, 'POST', '/tasks/T1/run', { agent: 'claude-code' });
      await runner.printed(/^The session on T1 ended/);

      const [call] = await claude.calls();
      expect(call?.argv).toHaveLength(3);
      expect(call?.argv[0]).toBe('--session-id');
      expect(urls.some((url) => /\/runs\?accepts=[^&]*\bconsole\b/.test(url))).toBe(false);
      expect((await aiRunOf(await runningState(board.root)))?.['console']).toBeUndefined();
    });
  });
});
