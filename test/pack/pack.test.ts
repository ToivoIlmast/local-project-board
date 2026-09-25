/**
 * The published package, installed the way a user gets it, must start and serve the board.
 * Protects against: missing files in `files`, dev-only runtime deps, broken bin, broken
 * paths between dist/node and dist/web, and external resources in the UI (local-first).
 * Requires `npm run build` first (done by `npm run test:pack`).
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
/** Packing, installing and starting a real package is slow; the project timeout is not
 * always applied to a hook, so every slow step here carries its own. */
const SLOW_MS = 180_000;
const work = mkdtempSync(path.join(os.tmpdir(), 'lpb-pack-'));
let packedFiles: string[] = [];
let tarball = '';
let child: ChildProcess | undefined;

function npm(args: string[], cwd: string): string {
  return execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function waitForOutput(proc: ChildProcess, pattern: RegExp, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () => reject(new Error(`Timed out. Output so far:\n${output}`)),
      timeoutMs,
    );
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (pattern.test(output)) {
        clearTimeout(timer);
        resolve(output);
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Process exited with ${code}. Output:\n${output}`));
    });
  });
}

beforeAll(() => {
  const [info] = JSON.parse(npm(['pack', '--json', '--pack-destination', work], root)) as {
    filename: string;
    files: { path: string }[];
  }[];
  if (!info) throw new Error('npm pack produced no output');
  tarball = path.join(work, info.filename);
  packedFiles = info.files.map((f) => f.path);
}, SLOW_MS);

afterAll(() => {
  child?.kill('SIGTERM');
  rmSync(work, { recursive: true, force: true });
});

describe('npm package', () => {
  it('contains the runtime and nothing from sources or tests', () => {
    expect(packedFiles).toEqual(
      expect.arrayContaining([
        'bin/board.js',
        'dist/node/server/cli/main.js',
        'dist/web/index.html',
        'README.md',
        'README.fi.md',
        'README.sv.md',
        'LICENSE',
        'package.json',
      ]),
    );
    expect(packedFiles.filter((f) => /^(src|test|docs)\//.test(f))).toEqual([]);
  });

  it(
    'installs, starts in a git repository and serves the UI with local assets only',
    async () => {
      const install = path.join(work, 'install');
      const project = path.join(work, 'project');
      npm(['init', '-y'], (execFileSync('mkdir', ['-p', install]), install));
      npm(['install', tarball, '--no-audit', '--no-fund', '--omit=dev'], install);
      execFileSync('mkdir', ['-p', project]);
      execFileSync('git', ['init', '-q'], { cwd: project });
      writeFileSync(path.join(project, 'README.md'), '# fixture\n');

      const port = await freePort();
      const bin = path.join(install, 'node_modules', '.bin', 'local-project-board');
      child = spawn(bin, ['--port', String(port), '--no-open'], { cwd: project });
      // Everything the real process prints, for as long as this test runs.
      let printed = '';
      const collect = (chunk: Buffer) => {
        printed += chunk.toString();
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      await waitForOutput(child, new RegExp(`http://127\\.0\\.0\\.1:${port}/`));

      const base = `http://127.0.0.1:${port}`;
      const page = await fetch(`${base}/`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('<div id="root">');

      // Local-first: every resource the page loads comes from the board itself.
      const refs = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? '');
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) {
        expect(ref).toMatch(/^\/(?!\/)/);
        expect((await fetch(`${base}${ref}`)).status).toBe(200);
      }

      // The page the package ships is the board's own UI, and local-first is enforced by the
      // header it is served with, not only by what the page happens to ask for.
      const script = refs.find((ref) => ref.endsWith('.js')) ?? '';
      expect(await (await fetch(`${base}${script}`)).text()).toContain('/api/');
      const csp = page.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("connect-src 'self'");

      // Client-side routes fall back to the SPA.
      expect(await (await fetch(`${base}/task/T1`)).text()).toContain('<div id="root">');

      // The installed package serves the API, and refuses a mutation without the token.
      const board = await fetch(`${base}/api/v1/project`);
      expect(board.status).toBe(200);
      expect(await board.json()).toMatchObject({ storage: { provider: 'markdown' } });

      const refused = await fetch(`${base}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'from outside' }),
      });
      expect(refused.status).toBe(401);
      expect(await (await fetch(`${base}/api/v1/tasks`)).json()).toEqual([]);

      // The agent handoff works on the package as installed: the instructions name the URL the
      // board really answers on, carry this run's token, and that token opens the API.
      const instructions = await (await fetch(`${base}/api/v1/instructions`)).text();
      expect(instructions).toContain(`Base URL: ${base}/api/v1`);
      const token = /^Authorization: Bearer (\S+)$/m.exec(instructions)?.[1] ?? '';
      expect(token.length).toBeGreaterThanOrEqual(40);
      expect(html).not.toContain(token);
      expect(await (await fetch(`${base}/api/v1/session`)).json()).toEqual({ token });

      const created = await fetch(`${base}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: 'created with the token from the instructions' }),
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({ id: 'T1' });

      // The event stream works on the installed package too: the change made while it is open
      // arrives, whatever else the watcher reports around it.
      const stream = await fetch(`${base}/api/v1/events`, { signal: AbortSignal.timeout(10_000) });
      expect(stream.headers.get('content-type')).toMatch(/^text\/event-stream/);
      const frames = readFrames(stream, 'task.updated');
      // Longer than the watcher waits before it reports the write that created T1: on a slow
      // machine that echo arrives here by itself, and it must not hide what comes after it.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await fetch(`${base}/api/v1/tasks/T1`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: 'renamed while a client was listening' }),
      });
      expect(await frames).toContain('task.updated');

      // The running board wrote its runtime state, and it describes this very process.
      const runtimeFile = path.join(project, '.board', 'runtime.json');
      const runtime = JSON.parse(readFileSync(runtimeFile, 'utf8')) as Record<string, unknown>;
      expect(runtime).toMatchObject({
        formatVersion: 1,
        pid: child.pid,
        port,
        url: `${base}/`,
        token,
        root: realpathSync(project),
      });

      // The board printed its URL and, after a whole session, nothing about the token.
      expect(printed).toContain(`http://127.0.0.1:${port}/`);
      expect(printed).not.toContain(token);

      // A second board on the same directory is refused while this one is running, and the
      // refusal says nothing about the token.
      const second = run(bin, ['--no-open'], project);
      expect(second.status).toBe(1);
      expect(second.stderr).toContain('already running');
      expect(second.stderr).not.toContain(token);

      // The CLI of the installed package reaches the running board.
      const cliInstructions = run(bin, ['instructions'], project);
      expect(cliInstructions.status).toBe(0);
      expect(cliInstructions.stdout).toContain(`Authorization: Bearer ${token}`);

      const exported = run(bin, ['export'], project);
      expect(exported.status).toBe(0);
      expect((JSON.parse(exported.stdout) as { tasks: unknown[] }).tasks).toHaveLength(1);

      // SIGTERM stops the board: it stops answering, even with that event stream open, and
      // takes its runtime state with it.
      const exited = new Promise((resolve) => child?.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
      expect(existsSync(runtimeFile)).toBe(false);
      await expect(fetch(`${base}/api/v1/project`)).rejects.toThrow();

      // And now that nothing is running, the CLI still answers, without a token.
      const offline = run(bin, ['instructions'], project);
      expect(offline.status).toBe(0);
      expect(offline.stdout).toContain('<session token>');
      expect(offline.stdout).not.toContain(token);
    },
    SLOW_MS,
  );
});

function run(
  bin: string,
  args: string[],
  cwd: string,
): { status: number; stdout: string; stderr: string } {
  // A timeout, so a command that unexpectedly keeps running fails the test instead of
  // hanging it: `local-project-board` with no arguments is a server when it is not refused.
  const result = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: 30_000 });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/**
 * The event types received until `until` arrives, until the stream is dropped. The frames
 * before it are kept: the watcher echoes the board's own earlier writes as `board.changed`
 * (ADR-0019), so the event a test waits for is not necessarily the first one to arrive.
 */
async function readFrames(response: Response, until: string): Promise<string[]> {
  const reader = response.body?.getReader();
  if (!reader) return [];
  const decoder = new TextDecoder();
  const types: string[] = [];
  const deadline = Date.now() + 10_000;
  let buffer = '';
  while (Date.now() < deadline && !types.includes(until)) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Only whole frames are parsed; a frame cut in half waits for the rest of its bytes.
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const data = frame.split('\n').find((line) => line.startsWith('data: '));
      if (data) types.push((JSON.parse(data.slice(6)) as { type: string }).type);
    }
  }
  await reader.cancel();
  return types;
}
