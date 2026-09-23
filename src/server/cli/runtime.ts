import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const RUNTIME_FILE = 'runtime.json';

/**
 * What a running board writes about itself, so that this machine can find it again: the CLI
 * reads it, and the user can see which process to stop. It is runtime state, not board data —
 * it lives in the untracked `.board/` and is removed on shutdown (ADR-0001, ADR-0008).
 */
export const runtimeStateSchema = z.strictObject({
  formatVersion: z.literal(1),
  pid: z.int().positive(),
  port: z.int().min(1).max(65535),
  /** The base URL the board answers on, with its trailing slash. */
  url: z.string().min(1),
  /** This run's session token; the file is written readable by its owner only. */
  token: z.string().min(1),
  /** The board root, so a file left behind by another board is recognised as stale. */
  root: z.string().min(1),
});

export type RuntimeState = z.infer<typeof runtimeStateSchema>;

export type RuntimeRead =
  | { kind: 'missing' }
  | { kind: 'unreadable'; file: string }
  | { kind: 'state'; state: RuntimeState };

export function runtimePath(root: string): string {
  return join(root, '.board', RUNTIME_FILE);
}

/** Written whole or not at all, and never readable by anyone else: it holds the token. */
export async function writeRuntime(state: RuntimeState): Promise<void> {
  const file = runtimePath(state.root);
  const temp = join(file, '..', `.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export async function readRuntime(root: string): Promise<RuntimeRead> {
  const file = runtimePath(root);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return { kind: 'missing' };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return { kind: 'state', state: runtimeStateSchema.parse(parsed) };
  } catch {
    // Half a file, or a file someone edited: the board must not guess what it meant.
    return { kind: 'unreadable', file };
  }
}

export async function removeRuntime(root: string): Promise<void> {
  await rm(runtimePath(root), { force: true });
}

/**
 * Whether the board this file describes is still there. Asking the board itself is the only
 * honest answer: a pid can be reused and a port can be taken over by something else, so the
 * server has to identify itself by the board root it is serving.
 */
export async function isBoardAlive(state: RuntimeState): Promise<boolean> {
  try {
    const response = await fetch(`${state.url}api/v1/project`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return false;
    const project = (await response.json()) as { root?: unknown };
    return project.root === state.root;
  } catch {
    return false;
  }
}
