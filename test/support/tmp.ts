import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created: string[] = [];

export async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'board-test-'));
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
