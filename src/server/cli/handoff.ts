import {
  createDocumentService,
  createTaskService,
  createWorkflowService,
} from '../../core/index.js';
import { isTaskId } from '../../core/rules/ids.js';
import { createEventBus } from '../events/index.js';
import { composeHandoff } from '../http/v1/handoff.js';
import { createStorage } from '../storage/index.js';
import { boardFacts, type ResolvedBoard } from './board.js';
import { askRunningBoard, boardCode, boardMessage } from './running.js';

/**
 * The handoff of one task: from the board itself when it is running, so it is the very text
 * `GET /tasks/:id/handoff` answers, and composed from the files of the board when it is not.
 * Either way it is the same one text and it carries no token; reading changes nothing. A
 * blocked task without a working run has none, either way (ADR-0032 §8, F2).
 */
export async function printHandoff(
  board: ResolvedBoard,
  id: string,
  write: (text: string) => void,
): Promise<void> {
  if (!isTaskId(id)) {
    const prefix = board.config.tasks.idPrefix;
    throw new Error(`"${id}" is not a task id. Task ids look like ${prefix}1, ${prefix}2.`);
  }

  const running = await askRunningBoard(board.root, `/tasks/${id}/handoff`);
  if (running?.ok) {
    write((await running.text()).trimEnd());
    return;
  }
  // A refusal of a blocked task is the board's answer, not a failure to give one: the files
  // would only say the same, so it is not composed from them (ADR-0032 §8, F2).
  if (running !== undefined && (await boardCode(running)) === 'TASK_BLOCKED') {
    throw new Error(await boardMessage(running));
  }
  // A board that does not answer, or answers with anything else, is not a reason to fail: the
  // files are the board, and they say the same, a missing task included.
  write(await composeOffline(board, id));
}

async function composeOffline(board: ResolvedBoard, id: string): Promise<string> {
  const { config, root } = board;
  const storage = createStorage(config, { root });
  await storage.init();
  try {
    // Nothing is published: no client is listening, and the services are only read from.
    const events = createEventBus();
    const statuses = config.statuses;
    const text = await composeHandoff(
      {
        tasks: createTaskService({ storage, events, statuses }),
        documents: createDocumentService({ storage, events }),
        workflow: createWorkflowService({ storage, events, statuses }),
      },
      id,
      {
        baseUrl: `http://127.0.0.1:${config.server.port}`,
        board: boardFacts(config),
        projectRules: config.ai.rules,
      },
    );
    return text.trimEnd();
  } finally {
    await storage.close();
  }
}
