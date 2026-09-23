import { API_BASE_PATH, routeList, type Route } from './routes.js';

export interface InstructionsOptions {
  /** Origin the server is listening on, e.g. http://127.0.0.1:7432 */
  baseUrl: string;
  /** Session token; mutations require it. */
  token?: string | undefined;
}

const GROUPS: Record<string, string> = {
  project: 'Board',
  tasks: 'Tasks',
  documents: 'Documents',
  git: 'Git (read-only)',
  reports: 'Reports',
};

/**
 * The instructions an agent is given, generated from the route table so that they cannot
 * describe an API that does not exist (ADR-0005).
 */
export function generateInstructions({ baseUrl, token }: InstructionsOptions): string {
  const included = routeList.filter((route) => route.ai.include);
  const lines: string[] = [
    '# local-project-board API (v1)',
    '',
    'A local board for one developer. Tasks carry markdown bodies, documents and reports.',
    '',
    `Base URL: ${baseUrl}${API_BASE_PATH}`,
  ];
  if (token !== undefined) {
    lines.push(
      '',
      `Every request that changes something must send: Authorization: Bearer ${token}`,
    );
  }
  lines.push(
    '',
    'Rules:',
    '- Requests and responses are JSON, except where a route says otherwise.',
    '- A task status must be one of the board statuses; read them first.',
    '- Ids are stable: an id is never reused after a task is deleted.',
    '- Unknown fields are rejected, so send exactly what a route describes.',
  );

  for (const [prefix, heading] of Object.entries(GROUPS)) {
    const group = included.filter((route) => route.id.startsWith(`${prefix}.`));
    if (group.length === 0) continue;
    lines.push('', `## ${heading}`);
    for (const route of group) lines.push(...describe(route));
  }
  return `${lines.join('\n')}\n`;
}

function describe(route: Route): string[] {
  const lines = ['', `### ${route.method} ${API_BASE_PATH}${route.path}`, '', route.summary];
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
    'Response:',
    '',
    '```' + (route.response.media === 'application/json' ? 'json' : ''),
    typeof response === 'string' ? response.trimEnd() : JSON.stringify(response, null, 2),
    '```',
  );
  return lines;
}
