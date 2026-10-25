import { randomUUID } from 'node:crypto';
import { claudeCheckPrompt, researchPrompt } from '../../contract/v1/index.js';
import { deliverCheckEnd } from './checkEnd.js';
import { writeCheckJournal, type CheckJournal } from './checkJournal.js';
import { boardMessage, post } from './running.js';
import type { RuntimeState } from './runtime.js';
import { spawnSession } from './spawnSession.js';

/** The name the board records for the agent of a check (ADR-0029: one agent so far). */
const AGENT = 'claude-code';

/** How long to retry the end before leaving it to the journal. */
const END_RETRY_MS = 30_000;
const END_RETRY_INITIAL_DELAY_MS = 200;

/**
 * Starts Claude Code on an actuality check of one task, in this terminal (ADR-0030 §6). The board
 * starts nothing; this is the same job as `startSession`, with a record of its own:
 *
 * - begin is `POST /tasks/:id/checks`, which pins the check to the version on disk and answers
 *   with its number; the run of the task (`aiRun`) is neither read nor written;
 * - the journal is `<ID>-check-<n>.json`, apart from the journals of work runs;
 * - `claude` is given `--session-id <uuid> <prompt>`, the prompt naming the handoff of this
 *   check. A check is always a new session; no token and no handoff text are on the command line.
 *
 * A research is a check of its own kind (ADR-0030 R1, ADR-0029 T54): `research` makes the begin
 * say so and carry the person's comment, and the prompt is `researchPrompt`. The comment goes
 * into the JSON body of the begin and nowhere else: not into the argv or the environment of
 * `claude`, and not into the journal.
 *
 * Resolves to the exit code of the session, so the command ends as `claude` did.
 */
export async function startCheckSession(
  program: string,
  id: string,
  board: RuntimeState,
  root: string,
  env: NodeJS.ProcessEnv,
  model?: string,
  research?: Research,
): Promise<number> {
  const boardUrl = board.url.replace(/\/+$/, '');
  const sessionId = randomUUID();
  const check = await beginCheck(board, id, sessionId, model, research);
  const prompt =
    research === undefined
      ? claudeCheckPrompt(id, check, boardUrl)
      : researchPrompt(id, check, boardUrl);

  // The prompt stays the last argument.
  const args = [
    ...(model === undefined ? [] : ['--model', model]),
    '--session-id',
    sessionId,
    prompt,
  ];

  const journal = { root, kept: true, record: journalOf(id, check, sessionId) };
  await keep(journal, journal.record);
  return spawnSession(program, args, root, env, {
    onEnd: (input) => endCheck(journal, input),
  });
}

/** What makes a check a research: the kind, and the focus the person gave, if any. */
export interface Research {
  comment?: string | undefined;
}

function journalOf(taskId: string, check: number, sessionId: string): CheckJournal {
  return { formatVersion: 1, kind: 'check', taskId, check, sessionId };
}

interface Journal {
  root: string;
  record: CheckJournal;
  kept: boolean;
}

/** Records the start on the board; throws if the board refuses, before any session runs. */
async function beginCheck(
  board: RuntimeState,
  taskId: string,
  sessionId: string,
  model: string | undefined,
  research: Research | undefined,
): Promise<number> {
  const response = await post(board, `/tasks/${taskId}/checks`, {
    agent: AGENT,
    sessionId,
    ...(model === undefined ? {} : { model }),
    ...(research === undefined ? {} : { kind: 'research' }),
    ...(research?.comment === undefined ? {} : { comment: research.comment }),
  });
  if (response === undefined) {
    throw new Error(
      `The board did not answer when beginning a check of ${taskId}. Is it still running?`,
    );
  }
  if (!response.ok) throw new Error(await boardMessage(response));
  const body = (await response.json()) as { number?: unknown };
  if (typeof body.number !== 'number') {
    throw new Error(`The board returned an unexpected response for a check of ${taskId}.`);
  }
  return body.number;
}

async function keep(journal: Journal, record: CheckJournal): Promise<void> {
  journal.record = record;
  try {
    await writeCheckJournal(journal.root, record);
  } catch (error) {
    if (journal.kept) {
      process.stderr.write(
        `Warning: the runner journal of check ${record.check} of ${record.taskId} could not be ` +
          `written (${error instanceof Error ? error.message : String(error)}). If this runner ` +
          'dies, the check stays without an end.\n',
      );
    }
    journal.kept = false;
  }
}

/**
 * Records the end of the process: first in the journal, on the disk, then on the board,
 * retrying for ~30 s and looking for the board afresh each time. An end the board did not take
 * stays in the journal and is delivered by the next runner.
 */
async function endCheck(
  journal: Journal,
  input: { exitCode?: number; launchError?: string },
): Promise<void> {
  await keep(journal, {
    ...journal.record,
    outcome: { ...input, endedAt: new Date().toISOString() },
  });
  const { taskId, check } = journal.record;
  const deadline = Date.now() + END_RETRY_MS;
  let delay = END_RETRY_INITIAL_DELAY_MS;
  for (;;) {
    if ((await deliverCheckEnd(journal.root, journal.record)) !== 'pending') return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(delay, remaining));
    });
    delay = Math.min(delay * 2, 5_000);
  }
  process.stderr.write(
    `Warning: the board did not take the end of check ${check} of ${taskId}.\n` +
      (journal.kept
        ? '  It is kept in .board/runner/ and is delivered by the next ' +
          '`local-project-board claude --wait` or `claude <ID>`.\n'
        : '  It could not be kept on disk either; the check stays without an end.\n'),
  );
}
