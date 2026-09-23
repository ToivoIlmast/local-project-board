/**
 * The published package, installed the way a user gets it, must start and serve the board.
 * Protects against: missing files in `files`, dev-only runtime deps, broken bin, broken
 * paths between dist/node and dist/web, and external resources in the UI (local-first).
 * Requires `npm run build` first (done by `npm run test:pack`).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
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
});

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

  it('installs, starts in a git repository and serves the UI with local assets only', async () => {
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
  });
});
