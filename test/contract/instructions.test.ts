import {
  API_BASE_PATH,
  DEFAULT_AI_RULES,
  errorResponseSchema,
  generateInstructions,
  routeList,
  routes,
  type Route,
} from '../../src/contract/v1/index.js';

const BOARD = { name: 'dep-health', statuses: ['backlog', 'todo', 'done'], idPrefix: 'T' };

const instructions = generateInstructions({
  baseUrl: 'http://127.0.0.1:7432',
  token: 'secret-1',
  board: BOARD,
});

const endpoint = (route: Route): string => `${route.method} ${API_BASE_PATH}${route.path}`;

/** The `### METHOD /api/v1/path` headings, which is the list of routes the text documents. */
function documented(text: string): string[] {
  return [...text.matchAll(/^### (GET|POST|PATCH|PUT|DELETE) (\S+)$/gm)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
}

/** Every fenced json block, as the agent would read it. */
function jsonBlocks(text: string): unknown[] {
  return [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => JSON.parse(match[1] ?? ''));
}

describe('generated AI instructions', () => {
  it('documents exactly the routes marked ai.include (drift test, INVARIANT)', () => {
    const included = routeList.filter((r) => r.ai.include);
    expect(included.length).toBeGreaterThan(0);
    // Set equality, so a route that is added, removed or silently renamed fails here.
    expect(documented(instructions).sort()).toEqual(included.map(endpoint).sort());
    for (const route of included) expect(instructions).toContain(route.summary);
  });

  it('leaves out routes that are not for agents', () => {
    const excluded = routeList.filter((r) => !r.ai.include);
    expect(excluded.map((r) => r.id).sort()).toEqual(['events.stream', 'instructions.get']);
    for (const route of excluded) expect(instructions).not.toContain(endpoint(route));
  });

  it('never tells an agent to read the instructions it is already reading', () => {
    expect(instructions).not.toContain(routes['instructions.get'].path);
  });

  it('shows the request body, the status and the media type of every documented route', () => {
    for (const route of routeList.filter((r) => r.ai.include)) {
      if (route.request)
        expect(instructions).toContain(JSON.stringify(route.example.body, null, 2));
      expect(instructions).toContain(
        `Response — ${route.successStatus ?? 200}, ${route.response.media}:`,
      );
    }
  });

  it('shows a concrete path and query for a route that takes parameters', () => {
    expect(instructions).toContain(`Example: GET ${API_BASE_PATH}/tasks/T12/documents/plan.md`);
    expect(instructions).toContain('Query: ?ref=main&limit=20');
  });

  it('only contains examples that validate against the contract (INVARIANT)', () => {
    const examples = new Set(
      routeList
        .filter((r) => r.ai.include)
        .flatMap((r) => [r.example.body, r.example.response])
        .filter((value) => value !== undefined && typeof value !== 'string')
        .map((value) => JSON.stringify(value, null, 2)),
    );
    const blocks = jsonBlocks(instructions);
    expect(blocks.length).toBeGreaterThan(examples.size);
    for (const block of blocks) {
      const text = JSON.stringify(block, null, 2);
      if (examples.has(text)) continue;
      // The only block that is not a route example is the error shape.
      expect(errorResponseSchema.safeParse(block)).toMatchObject({ success: true });
    }
  });

  it('gives the agent the base URL and the token it must send', () => {
    expect(instructions).toContain('Base URL: http://127.0.0.1:7432/api/v1');
    expect(instructions).toContain('Authorization: Bearer secret-1');
  });

  it('tells the agent what this very board calls its statuses and ids', () => {
    expect(instructions).toContain('## This board');
    expect(instructions).toContain('backlog, todo, done');
    expect(instructions).toContain('dep-health');
    expect(instructions).toContain('T1');
  });

  it('states the rules that keep an agent from corrupting the board', () => {
    expect(instructions).toMatch(/before.*after|after.*before/);
    expect(instructions).toContain('task.md');
    expect(instructions).toMatch(/sandbox/i);
  });

  it('lists every default rule when none is configured (INVARIANT)', () => {
    expect(DEFAULT_AI_RULES.length).toBeGreaterThan(0);
    for (const rule of DEFAULT_AI_RULES) expect(instructions).toContain(`- ${rule}`);
  });

  it('uses the configured rules instead of the defaults, and only those', () => {
    const custom = generateInstructions({
      baseUrl: 'http://127.0.0.1:7432',
      board: BOARD,
      rules: ['Never delete a task without asking first.', 'Ask before changing branch.'],
    });
    expect(custom).toContain(
      '## Rules\n\n- Never delete a task without asking first.\n' + '- Ask before changing branch.',
    );
    for (const rule of DEFAULT_AI_RULES) expect(custom).not.toContain(rule);
  });

  it('treats an empty rules list as no rules at all, rather than falling back to defaults', () => {
    const empty = generateInstructions({
      baseUrl: 'http://127.0.0.1:7432',
      board: BOARD,
      rules: [],
    });
    expect(empty).not.toMatch(/## Rules\n\n- /);
    for (const rule of DEFAULT_AI_RULES) expect(empty).not.toContain(rule);
  });

  it('describes the error format and every code the board can answer with', () => {
    expect(instructions).toContain('## Errors');
    for (const code of ['TASK_NOT_FOUND', 'UNKNOWN_STATUS', 'UNAUTHORIZED', 'INVALID_REQUEST']) {
      expect(instructions).toContain(code);
    }
  });

  it('is plain markdown', () => {
    expect(instructions.startsWith('# ')).toBe(true);
    expect(instructions).not.toContain('undefined');
    expect(instructions.endsWith('\n')).toBe(true);
  });

  it('carries no token of its own when it is generated without one', () => {
    const anonymous = generateInstructions({ baseUrl: 'http://127.0.0.1:7432', board: BOARD });
    expect(anonymous).not.toContain('secret-1');
    expect(anonymous).toContain('<session token>');
    // Without a token the agent is told where to get one, and that route is in the contract.
    expect(anonymous).toContain(`${API_BASE_PATH}/session`);
  });

  it('describes no board facts when it is generated without a board', () => {
    const bare = generateInstructions({ baseUrl: 'http://127.0.0.1:7432' });
    // No "This board" section at all; the route examples still show what a board looks like.
    expect(bare).not.toContain('## This board');
    expect(bare).not.toContain('Statuses');
    expect(bare).not.toContain('undefined');
    expect(documented(bare).sort()).toEqual(
      routeList
        .filter((r) => r.ai.include)
        .map(endpoint)
        .sort(),
    );
  });

  it('describes the API surface and not the implementation (INVARIANT)', () => {
    for (const word of ['Express', 'React', 'TypeScript', 'markdown storage', 'zod']) {
      expect(instructions).not.toContain(word);
    }
  });
});
