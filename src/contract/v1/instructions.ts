import { DEFAULT_AI_RULES } from '../../core/rules/aiRules.js';
import { API_BASE_PATH, routeList, type Route } from './routes.js';
import { errorCodeSchema } from './schemas.js';

export { DEFAULT_AI_RULES };

/** What the board itself is called and what a task on it may say; read at generation time. */
export interface BoardFacts {
  name: string;
  statuses: string[];
  idPrefix: string;
}

export interface InstructionsOptions {
  /** Origin the server is listening on, e.g. http://127.0.0.1:7432 */
  baseUrl: string;
  /** Session token; mutations require it. Without one the text points at the session route. */
  token?: string | undefined;
  /** The live board, so an agent does not have to guess a status or an id. */
  board?: BoardFacts | undefined;
  /** What "## Rules" tells the agent; defaults to DEFAULT_AI_RULES (overridable: ai.rules). */
  rules?: readonly string[] | undefined;
}

const TOKEN_PLACEHOLDER = '<session token>';

const GROUPS: Record<string, string> = {
  project: 'Board',
  session: 'Session',
  tasks: 'Tasks',
  documents: 'Documents',
  git: 'Git (read-only)',
  reports: 'Reports',
};

/** A failure always looks like this; the codes below are the whole list the board can send. */
const ERROR_EXAMPLE = {
  error: {
    code: 'TASK_NOT_FOUND',
    message: 'There is no task T12 on this board.',
    details: { id: 'T12' },
  },
};

/**
 * The instructions an agent is given, generated from the route table so that they cannot
 * describe an API that does not exist (ADR-0005). They are operating instructions for the
 * API surface: what to call, what to send, what comes back, what may not be done.
 */
export function generateInstructions({
  baseUrl,
  token,
  board,
  rules,
}: InstructionsOptions): string {
  const api = `${baseUrl}${API_BASE_PATH}`;
  const lines: string[] = [
    '# local-project-board API (v1)',
    '',
    'A personal board for one project on this machine: tasks with markdown bodies, documents',
    'attached to a task, stored reports and read-only repository information. You are a client',
    'of this board. Everything you change through this API is written to the project at once',
    'and the developer sees it immediately.',
    '',
    `Base URL: ${api}`,
    '',
    '## Authentication',
    '',
    'Reading needs nothing. Every request that changes something must carry this header:',
    '',
    '```text',
    `Authorization: Bearer ${token ?? TOKEN_PLACEHOLDER}`,
    '```',
    '',
    token === undefined
      ? `Ask for the current token first: GET ${api}/session answers with it.`
      : 'That token belongs to this run of the board and a restart replaces it;' +
        ` GET ${api}/session always answers with the current one.`,
    'The board reads the token from that header only: never put it in a URL and never write it',
    'into a task, a document or a report.',
  ];

  if (board) {
    lines.push(
      '',
      '## This board',
      '',
      `- Project: ${board.name}`,
      `- Statuses, and a task may have no other: ${board.statuses.join(', ')}`,
      `- Task ids look like ${board.idPrefix}1, ${board.idPrefix}2 and are never reused`,
    );
  }

  lines.push('', '## Rules', '', ...(rules ?? DEFAULT_AI_RULES).map((rule) => `- ${rule}`));

  // `ai.include` is the only thing that decides what an agent is told about: a resource the
  // route table grows is documented under a heading of its own rather than silently dropped.
  const included = routeList.filter((route) => route.ai.include);
  for (const prefix of groupOrder(included)) {
    lines.push('', `## ${GROUPS[prefix] ?? capitalize(prefix)}`);
    for (const route of included.filter((route) => resource(route) === prefix)) {
      lines.push(...describe(route));
    }
  }

  lines.push(
    '',
    '## Errors',
    '',
    'A request that fails answers with this and with nothing else:',
    '',
    '```json',
    JSON.stringify(ERROR_EXAMPLE, null, 2),
    '```',
    '',
    'The status says what kind of failure it is: 400 a malformed request, 401 a missing or wrong',
    'token, 403 a request from another page or addressed to another host, 404 something that is',
    'not there, 409 a state conflict, 413 a body that is too large, 422 a value the board cannot',
    'accept, 500 a failure on the board side. The code is one of:',
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
function groupOrder(included: Route[]): string[] {
  const present = [...new Set(included.map(resource))];
  return [
    ...Object.keys(GROUPS).filter((prefix) => present.includes(prefix)),
    ...present.filter((prefix) => !(prefix in GROUPS)),
  ];
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function describe(route: Route): string[] {
  const lines = ['', `### ${route.method} ${API_BASE_PATH}${route.path}`, '', route.summary];
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

/** The path with the example parameters filled in, so the agent sees a real URL. */
export function concretePath(route: Route): string | undefined {
  const params = route.example.params;
  if (params === null || typeof params !== 'object') return undefined;
  const values = params as Record<string, unknown>;
  return `${API_BASE_PATH}${route.path}`.replace(/:(\w+)/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}

export function queryString(query: unknown): string | undefined {
  if (query === null || typeof query !== 'object') return undefined;
  // Written by hand: the contract is plain TypeScript and takes nothing from a host platform.
  const text = Object.entries(query as Record<string, unknown>)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  return text === '' ? undefined : text;
}
