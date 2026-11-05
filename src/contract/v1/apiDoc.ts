import { concretePath, queryString } from './instructions.js';
import { API_BASE_PATH, type Route } from './routes.js';
import { errorCodeSchema } from './schemas.js';

const GROUPS: Record<string, string> = {
  project: 'Board',
  session: 'Session',
  tasks: 'Tasks',
  workflow: 'AI workflow',
  versions: 'Versions',
  checks: 'Checks',
  documents: 'Documents',
  git: 'Git (read-only)',
  reports: 'Reports',
  topics: 'Topics and blocks',
  events: 'Events',
  instructions: 'Instructions',
};

/** What the routes of a group do together, which no single route can say (shown under its heading). */
const GROUP_NOTES: Record<string, string[]> = {
  tasks: [
    'A task may be placed in a topic (`topic`), in a block of it (`block`, only with `topic`), and',
    'wait for other tasks (`dependsOn`, task ids). They are not content: changing them makes no',
    'version. `POST` and `PATCH` check what they name against the board, and a refusal is `422`',
    'with nothing written:',
    '',
    '- `INVALID_PLACEMENT`: a topic that does not exist or cannot be read, a block without a',
    '  topic, or a block the topic does not hold.',
    '- `INVALID_DEPENDENCY`: an entry that is not a task id of the board (a block id included),',
    '  a task that does not exist, or one whose file, or the file of a task it leads to, cannot',
    '  be read.',
    '- `DEPENDENCY_CYCLE`: the task would be in a cycle; `details.tasks` names its tasks.',
    '',
    'A patch that names none of them leaves them as they are, unchecked.',
    '',
    'A task with a non-empty `readiness.reasons` is blocked (ADR-0032). The board refuses to start',
    'work on it with `409 TASK_BLOCKED`, and `details.reasons` carries the reasons as codes:',
    '',
    '- `GET /tasks/:id/handoff`: a blocked task has no handoff, unless its `aiRun.state` is',
    '  `working`: a run that has started keeps its handoff.',
    '- `POST /tasks/:id/run` with `kind: work`: a blocked task is not started, and a run that is',
    '  working is refused as before. `kind: check` and `kind: research` are not gated.',
    '- Nothing else is refused for readiness: reading and changing the task are as for any task.',
  ],
  topics: [
    'A topic (`P<n>`) has an ordered list of blocks (`K<n>`). Ids are global across the board,',
    'monotonic and never reused, a deleted one included. A block belongs to one topic for good:',
    'there is no move of a block between topics, and no archiving of a topic.',
    '',
    '- A topic can be deleted only when it is empty: no tasks, and no blocks — an empty block',
    '  makes it non-empty. Otherwise `409 TOPIC_NOT_EMPTY`.',
    '- A block can be deleted only when no task is in it. Otherwise `409 BLOCK_NOT_EMPTY`.',
    '- A refusal changes nothing: no file is written and no event is published.',
    '- A task file that cannot be read may be a task of the topic or block, so it refuses too.',
    '- The order of the blocks is the order of the list, kept as written; a new block goes last,',
    '  and `PUT .../blocks/order` takes every block id of the topic exactly once (`400',
    '  INVALID_REQUEST` otherwise, `404 BLOCK_NOT_FOUND` for a block of another topic on the',
    '  other block routes).',
    '- Every successful write is published as a `topic.*` event over `GET /events`:',
    '  `topic.created` and `topic.updated` carry the whole topic as stored (a change to its blocks',
    '  is a `topic.updated`), `topic.deleted` carries `topicId`.',
    '- Writes are last-write-wins (ADR-0018).',
  ],
};

const MEDIA_TYPES: Record<string, string> = {
  'application/json': 'A JSON request or response body.',
  'text/markdown': 'A task, document or report body read back as markdown text.',
  'text/html': 'A report read back as HTML.',
  'text/event-stream': 'Server-sent events; the browser page uses this to stay in sync.',
};

/**
 * The full human reference to the API, generated from the route table so it cannot describe a
 * route that does not exist (ADR-0005). Unlike the generated AI instructions, every route is
 * documented here, including the ones an agent is never told about (`ai.include: false`).
 */
export function renderApiDoc(routes: Route[]): string {
  const lines: string[] = [
    '# local-project-board API (v1)',
    '',
    'Generated from `src/contract/v1/routes.ts` (ADR-0005) — do not edit by hand. After a change',
    'to the route table, run `UPDATE_DOCS=1 npm test` to regenerate this file.',
    '',
    `Base path: \`${API_BASE_PATH}\``,
    '',
    '## Media types',
    '',
    ...Object.entries(MEDIA_TYPES).map(([type, description]) => `- \`${type}\` — ${description}`),
  ];

  for (const prefix of groupOrder(routes)) {
    lines.push('', `## ${GROUPS[prefix] ?? capitalize(prefix)}`);
    if (GROUP_NOTES[prefix]) lines.push('', ...GROUP_NOTES[prefix]);
    for (const route of routes.filter((r) => resource(r) === prefix))
      lines.push(...describe(route));
  }

  lines.push(
    '',
    '## Errors',
    '',
    'A request that fails answers with `{ "error": { "code", "message", "details" } }` and',
    'nothing else. The code is one of:',
    '',
    errorCodeSchema.options.map((code) => `- ${code}`).join('\n'),
  );

  return `${lines.join('\n')}\n`;
}

/** The part of a route id before the dot: the resource it belongs to. */
function resource(route: Route): string {
  return route.id.split('.')[0] ?? route.id;
}

/** The known resources in the order above, then anything the table has grown since. */
function groupOrder(routes: Route[]): string[] {
  const present = [...new Set(routes.map(resource))];
  return [
    ...Object.keys(GROUPS).filter((prefix) => present.includes(prefix)),
    ...present.filter((prefix) => !(prefix in GROUPS)),
  ];
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function describe(route: Route): string[] {
  const lines = [
    '',
    `### ${route.method} ${API_BASE_PATH}${route.path}`,
    '',
    route.summary,
    '',
    route.ai.include
      ? 'Given to AI agents in the generated instructions.'
      : 'Not given to AI agents in the generated instructions.',
  ];
  const example = concretePath(route);
  if (example !== undefined) lines.push('', `Example: ${route.method} ${example}`);
  const query = queryString(route.example.query);
  if (query !== undefined) lines.push('', `Query: ?${query}`);

  if (route.example.body !== undefined) {
    lines.push(
      '',
      'Request body:',
      '',
      '```json',
      JSON.stringify(route.example.body, null, 2),
      '```',
    );
  }
  const response = route.example.response;
  lines.push(
    '',
    `Response — ${route.successStatus ?? 200}, ${route.response.media}:`,
    '',
    '```' + (route.response.media === 'application/json' ? 'json' : ''),
    typeof response === 'string' ? response.trimEnd() : JSON.stringify(response, null, 2),
    '```',
  );
  return lines;
}
