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

/**
 * A POST with the session token to a board known to be running; nothing when the network fails.
 * The token goes in the header only: never in a URL, an argument or a line that is printed.
 */
export async function post(
  state: RuntimeState,
  path: string,
  body: unknown,
): Promise<Response | undefined> {
  try {
    return await fetch(`${state.url}${API_BASE_PATH.slice(1)}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${state.token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return undefined;
  }
}

/** The board says what is wrong in its own words; a board that says nothing is quoted by status. */
export async function boardMessage(answer: Response, what = 'the task'): Promise<string> {
  try {
    const body = (await answer.clone().json()) as { error?: { message?: unknown } };
    if (typeof body.error?.message === 'string') return body.error.message;
  } catch {
    // Not the board's own error: the status is all there is to say.
  }
  return `The board answered ${answer.status} when asked for ${what}.`;
}

/** The board's error code of an answer, when it is one of the board's own errors. */
export async function boardCode(answer: Response): Promise<string | undefined> {
  try {
    const body = (await answer.clone().json()) as { error?: { code?: unknown } };
    return typeof body.error?.code === 'string' ? body.error.code : undefined;
  } catch {
    return undefined;
  }
}
