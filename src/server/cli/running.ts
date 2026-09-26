import { API_BASE_PATH } from '../../contract/v1/index.js';
import { isBoardAlive, readRuntime, type RuntimeState } from './runtime.js';

/**
 * The runtime state of the board that is running for this root, or nothing when there is none:
 * a runtime file alone is not a running board, and a damaged one is no reason to refuse.
 */
export async function findRunningBoard(root: string): Promise<RuntimeState | undefined> {
  const runtime = await readRuntime(root);
  if (runtime.kind !== 'state') return undefined;
  return (await isBoardAlive(runtime.state)) ? runtime.state : undefined;
}

/**
 * What the running board of this root answers to a GET under `/api/v1`, or nothing at all when
 * there is no such board. A read changes nothing, so it carries no token.
 */
export async function askRunningBoard(root: string, path: string): Promise<Response | undefined> {
  const state = await findRunningBoard(root);
  if (state === undefined) return undefined;
  return get(state, path);
}

/** A GET on a board that is known to be running; nothing when it stopped answering. */
export async function get(state: RuntimeState, path: string): Promise<Response | undefined> {
  try {
    return await fetch(`${state.url}${API_BASE_PATH.slice(1)}${path}`, {
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return undefined;
  }
}
