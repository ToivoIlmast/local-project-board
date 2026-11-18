import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created: string[] = [];

/**
 * A new directory under its canonical name: the board names its root by `realpath`, which on
 * Windows expands a short (8.3) TEMP such as `RUNNER~1` and on macOS turns `/var` into
 * `/private/var`; a test comparing roots must start from the same name (T10).
 */
export async function tmpDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'board-test-')));
  created.push(dir);
  return dir;
}

export async function writeYaml(dir: string, name: string, content: string): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, content, 'utf8');
  return file;
}

export async function cleanTmpDirs(): Promise<void> {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}
