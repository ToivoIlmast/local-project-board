import { API_BASE_PATH } from '../../contract/v1/index.js';
import { isBoardAlive, readRuntime } from './runtime.js';

/**
 * What the running board of this root answers to a GET under `/api/v1`, or nothing at all when
 * there is no such board: a runtime file alone is not a running board, and a damaged one is no
 * reason to refuse, because a read changes nothing.
 */
export async function askRunningBoard(root: string, path: string): Promise<Response | undefined> {
  const runtime = await readRuntime(root);
  if (runtime.kind !== 'state') return undefined;
  if (!(await isBoardAlive(runtime.state))) return undefined;
  try {
    return await fetch(`${runtime.state.url}${API_BASE_PATH.slice(1)}${path}`, {
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return undefined;
  }
}
