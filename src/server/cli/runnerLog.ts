import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { journalDir } from './runJournal.js';

/**
 * The persistent log of the runner (T76 B2): what it prints to the terminal and nothing else
 * would keep — the exact argv of every session it starts, what became of each end it sent
 * (`delivered`, `dropped`, `pending`) and its warnings. One JSON object per line, appended to
 * `.board/runner/runner.log` beside the journals (not a `.json` file, so no journal reader
 * takes it), readable by its owner only.
 *
 * It never holds the token: the argv of `claude` carries none (T19), and nothing else the
 * runner knows of the board's token is passed here. A log that cannot be written never stops a
 * run: it is best effort, silently.
 */
export const RUNNER_LOG = 'runner.log';

export type RunnerLogEntry =
  | {
      event: 'start';
      taskId: string;
      runId: number;
      mode: 'new' | 'resume' | 'restart';
      program: string;
      argv: string[];
    }
  | { event: 'end'; taskId: string; runId: number; delivery: 'delivered' | 'dropped' | 'pending' }
  | { event: 'warning'; taskId?: string; runId?: number; message: string };

export async function logRunner(root: string, entry: RunnerLogEntry): Promise<void> {
  try {
    const dir = journalDir(root);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, RUNNER_LOG);
    await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, {
      mode: 0o600,
    });
    await chmod(file, 0o600);
  } catch {
    // Observability must not stop the run it observes.
  }
}
