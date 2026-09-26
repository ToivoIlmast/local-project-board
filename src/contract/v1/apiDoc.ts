import { concretePath, queryString } from './instructions.js';
import { API_BASE_PATH, type Route } from './routes.js';
import { errorCodeSchema } from './schemas.js';

const GROUPS: Record<string, string> = {
  project: 'Board',
  session: 'Session',
  tasks: 'Tasks',
  workflow: 'AI workflow',
  documents: 'Documents',
  git: 'Git (read-only)',
  reports: 'Reports',
  events: 'Events',
  instructions: 'Instructions',
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
