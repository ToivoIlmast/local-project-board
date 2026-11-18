/**
 * The published package, installed the way a user gets it, must start and serve the board.
 * Protects against: missing files in `files`, dev-only runtime deps, broken bin, broken
 * paths between dist/node and dist/web, and external resources in the UI (local-first).
 * Requires `npm run build` first (done by `npm run test:pack`).
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
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
const windows = process.platform === 'win32';
// A space in every path the package is packed to, installed in and started from (T10).
const work = mkdtempSync(path.join(os.tmpdir(), 'lpb pack '));
let packedFiles: string[] = [];
let tarball = '';
let child: ChildProcess | undefined;

/** On Windows `npm` and the installed bin are `.cmd` files, which only a shell can start. */
function quoted(args: string[]): string[] {
  return windows ? args.map((arg) => `"${arg}"`) : args;
}

function npm(args: string[], cwd: string): string {
  return execFileSync('npm', quoted(args), {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: windows,
  });
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
    // An allow-list, not a deny-list: whatever else lands in the tarball (`.board/`, local
    // data, scratch files, test output) fails here instead of being published.
    const allowed =
      /^(bin\/|dist\/node\/|dist\/web\/|README(\.[a-z]{2})?\.md$|LICENSE$|package\.json$)/;
    expect(packedFiles.filter((f) => !allowed.test(f))).toEqual([]);
    expect(packedFiles.filter((f) => /\.(test|spec)\.|\.tsbuildinfo$/.test(f))).toEqual([]);
  });

  it('ships a LICENSE with a real copyright holder', () => {
    // Relative to its directory: a GNU tar takes `C:` in a path for a remote host.
    const license = execFileSync('tar', ['-xzOf', path.basename(tarball), 'package/LICENSE'], {
      cwd: work,
      encoding: 'utf8',
    });
    expect(license).toMatch(/^Copyright \(c\) \d{4} \S.+$/m);
    expect(license).not.toContain('contributors');
  });

  it(
    'installs, starts in a git repository and serves the UI with local assets only',
    async () => {
      const install = path.join(work, 'install');
      const project = path.join(work, 'project');
      mkdirSync(install, { recursive: true });
      npm(['init', '-y'], install);
      npm(['install', tarball, '--no-audit', '--no-fund', '--omit=dev'], install);
      mkdirSync(project, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: project });
      writeFileSync(path.join(project, 'README.md'), '# fixture\n');

      const port = await freePort();
      const bin = path.join(
        install,
        'node_modules',
        '.bin',
        windows ? 'local-project-board.cmd' : 'local-project-board',
      );
      // The server's own pid is checked below: on Windows the `.cmd` would put a cmd.exe in
      // between, so the board is started with node and the script the bin entry names.
      child = windows
        ? spawn(
            process.execPath,
            [
              path.join(install, 'node_modules', 'local-project-board', 'bin', 'board.js'),
              '--port',
              String(port),
              '--no-open',
            ],
            { cwd: project },
          )
        : spawn(bin, ['--port', String(port), '--no-open'], { cwd: project });
      // Everything the real process prints, for as long as this test runs.
      let printed = '';
      const collect = (chunk: Buffer) => {
        printed += chunk.toString();
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      await waitForOutput(child, new RegExp(`http://127\\.0\\.0\\.1:${port}/`));

      const base = `http://127.0.0.1:${port}`;
      // The package that was installed is the one this repository describes.
      const installed = JSON.parse(
        readFileSync(
          path.join(install, 'node_modules', 'local-project-board', 'package.json'),
          'utf8',
        ),
      ) as { version: string };
      expect(installed.version).toBe(
        (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string })
          .version,
      );
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
      const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
        version: string;
      };
      // The version lives in package.json only; the installed board reports that one.
      expect(await board.json()).toMatchObject({
        storage: { provider: 'markdown' },
        version,
      });

      const refused = await fetch(`${base}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'from outside' }),
      });
      expect(refused.status).toBe(401);
      expect(await (await fetch(`${base}/api/v1/tasks`)).json()).toEqual([]);

      // The agent handoff works on the package as installed: the instructions name the URL the
      // board really answers on, hold a placeholder instead of the token, and the token that
      // `GET /session` gives opens the API.
      const instructions = await (await fetch(`${base}/api/v1/instructions`)).text();
      expect(instructions).toContain(`Base URL: ${base}/api/v1`);
      expect(instructions).toContain('Authorization: Bearer <session token>');
      const { token } = (await (await fetch(`${base}/api/v1/session`)).json()) as {
        token: string;
      };
      expect(token.length).toBeGreaterThanOrEqual(40);
      expect(html).not.toContain(token);
      expect(instructions).not.toContain(token);

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
        // `.native`: the board's root is canonical, a short (8.3) Windows name expanded.
        root: realpathSync.native(project),
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
      expect(cliInstructions.stdout).toContain('Authorization: Bearer <session token>');
      expect(cliInstructions.stdout).not.toContain(token);

      const exported = run(bin, ['export'], project);
      expect(exported.status).toBe(0);
      expect((JSON.parse(exported.stdout) as { tasks: unknown[] }).tasks).toHaveLength(1);

      // SIGTERM stops the board: it stops answering, even with that event stream open, and
      // takes its runtime state with it. Windows has no SIGTERM: the process is terminated
      // without a chance to clean up, its runtime state stays, and the next start finds it
      // stale and replaces it (ADR-0024).
      const exited = new Promise((resolve) => child?.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
      expect(existsSync(runtimeFile)).toBe(windows);
      await expect(fetch(`${base}/api/v1/project`)).rejects.toThrow();

      // The installed bin reports the version of this repository's package.json, and nothing
      // else: one line, no error, and no board started.
      const versioned = run(bin, ['--version'], project);
      expect(versioned.status).toBe(0);
      expect(versioned.stdout).toBe(`${version}\n`);
      expect(versioned.stderr).toBe('');
      expect(existsSync(runtimeFile)).toBe(windows);

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
  const result = spawnSync(windows ? `"${bin}"` : bin, quoted(args), {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    shell: windows,
  });
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
