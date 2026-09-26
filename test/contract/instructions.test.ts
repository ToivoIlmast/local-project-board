import {
  API_BASE_PATH,
  API_RULES,
  errorResponseSchema,
  generateInstructions,
  routeList,
  routes,
  workflowSteps,
  type Route,
} from '../../src/contract/v1/index.js';
import { defaultWorkflow, resolveWorkflow } from '../../src/core/index.js';

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
    // `workflow.update` replaces the board's and the columns' settings whole: it is the
    // Settings page's request, not something an agent should do to the rules it works under.
    expect(excluded.map((r) => r.id).sort()).toEqual([
      'events.stream',
      'instructions.get',
      'workflow.update',
    ]);
    for (const route of excluded) expect(instructions).not.toContain(endpoint(route));
  });

  it('tells an agent how to read the settings it works under, and only that', () => {
    expect(instructions).toContain(`### GET ${API_BASE_PATH}/workflow`);
    expect(instructions).toContain(`### GET ${API_BASE_PATH}/tasks/:id/workflow`);
    expect(instructions).not.toContain(`### PUT ${API_BASE_PATH}/workflow`);
  });

  it('tells an agent to read the handoff of a task before it starts, and repeats none of its steps (INVARIANT)', () => {
    expect(instructions).toContain(`### GET ${API_BASE_PATH}/tasks/:id/handoff`);
    expect(instructions).toContain('## Working on a task');
    const section = /## Working on a task\n([\s\S]*?)\n## /.exec(instructions)?.[1] ?? '';

    expect(section).toContain(`GET http://127.0.0.1:7432${API_BASE_PATH}/tasks/<id>/handoff`);
    // What to do is decided per task by its settings, so it is not said here at all.
    expect(section).not.toMatch(/branch|commit|push|checks|report|merge/i);
  });

  it('says the same about working on a task whatever the rules are: it is not a rule (INVARIANT)', () => {
    const custom = generateInstructions({
      baseUrl: 'http://127.0.0.1:7432',
      board: BOARD,
      projectRules: ['Ask before renaming a task.'],
    });
    const empty = generateInstructions({
      baseUrl: 'http://127.0.0.1:7432',
      board: BOARD,
      projectRules: [],
    });

    for (const text of [custom, empty]) expect(text).toContain('## Working on a task');
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

  describe('the rules: what the API needs, and what a project adds (T16)', () => {
    const generate = (projectRules?: readonly string[]): string =>
      generateInstructions({ baseUrl: 'http://127.0.0.1:7432', board: BOARD, projectRules });

    /** The bullets of "## Rules" itself, without the subsection that follows them. */
    const apiSection = (text: string): string =>
      /\n## Rules\n([\s\S]*?)(?:\n### Project rules\n|\n## )/.exec(text)?.[1] ?? '';
    const projectSection = (text: string): string | undefined =>
      /\n### Project rules\n([\s\S]*?)\n## /.exec(text)?.[1];

    it('lists every API rule when the project adds none (INVARIANT)', () => {
      expect(API_RULES.length).toBeGreaterThan(0);
      for (const rule of API_RULES) expect(instructions).toContain(`- ${rule}`);
    });

    it('lists every API rule whatever the project adds: a list cannot replace them (INVARIANT)', () => {
      const projectRules = [
        [],
        ['Ask before renaming a task.'],
        // A project that copies a built-in rule, or contradicts one, still leaves them all.
        [...API_RULES],
        ['Unknown fields are fine.', 'Invent a position for a task if you like.'],
      ];
      for (const rules of [undefined, ...projectRules]) {
        const text = generate(rules);
        expect(apiSection(text)).toBe(`\n${API_RULES.map((rule) => `- ${rule}`).join('\n')}\n`);
      }
    });

    it('puts the rules of the project after the API rules, in a subsection of their own', () => {
      const text = generate(['Never delete a task without asking first.', 'Ask before X.']);

      expect(text).toContain(
        '\n### Project rules\n\n' +
          'Conventions of this project. They add to the rules above and to the steps of a ' +
          "task's handoff; they replace neither.\n\n" +
          '- Never delete a task without asking first.\n- Ask before X.\n',
      );
      const rules = text.indexOf('## Rules');
      const last = text.lastIndexOf(`- ${API_RULES.at(-1)}`);
      expect(rules).toBeGreaterThan(-1);
      expect(text.indexOf('### Project rules')).toBeGreaterThan(last);
      // The project's rules come before the routes, where an agent reads rules.
      expect(text.indexOf('### Project rules')).toBeLessThan(text.indexOf('## Board'));
    });

    it('does not say an API rule twice when a project copied it into its own list', () => {
      // What ADR-0026 made the way to keep the built-in rules while adding one's own.
      const text = generate([...API_RULES, 'Ask before renaming a task.']);

      for (const rule of API_RULES) expect(text.split(`- ${rule}`)).toHaveLength(2);
      expect(projectSection(text)).toContain('- Ask before renaming a task.');
      // A list of nothing but copies is no project rules at all.
      expect(generate([...API_RULES])).toBe(generate([]));
      expect(generate([...API_RULES])).not.toContain('### Project rules');
    });

    it('says each rule of the project once, and does not turn it into an API rule', () => {
      const text = generate(['Ask before renaming a task.']);

      expect(text.match(/Ask before renaming a task\./g)).toHaveLength(1);
      expect(apiSection(text)).not.toContain('Ask before renaming');
    });

    it('has no subsection for an empty list, and none when the option is left out', () => {
      for (const text of [generate([]), generate(undefined), instructions]) {
        expect(text).not.toContain('### Project rules');
        expect(text).not.toContain('Conventions of this project');
        // The API rules end where the routes begin; nothing is left dangling.
        expect(projectSection(text)).toBeUndefined();
      }
      expect(generate([])).toBe(generate(undefined));
    });

    it('documents the same routes whatever the project adds', () => {
      expect(documented(generate(['Ask before renaming a task.']))).toEqual(
        documented(instructions),
      );
    });

    it('is a subsection of "## Rules": it is not a second list of the same kind', () => {
      const headings: string[] = generate(['x']).match(/^#{2,3} .*$/gm) ?? [];
      const rules = headings.indexOf('## Rules');
      expect(headings.slice(rules, rules + 2)).toEqual(['## Rules', '### Project rules']);
    });

    describe('no rule about how to work is written here (INVARIANT)', () => {
      // Branch, checks, commit, push, report and editing code belong to the settings and to
      // the handoff that `renderWorkflowSteps` writes (ADR-0028); a rule about them here would
      // be a second source of the same thing.
      const WORKFLOW_WORDS =
        /\b(branch(es)?|commit(s|ted)?|push(es|ed)?|merge[sd]?|checks?|tests?|pipeline|lint|source|edit(s|ing)?|repository|git)\b|report\.md/i;

      it.each(API_RULES.map((rule) => [rule]))('%s', (rule) => {
        expect(rule).not.toMatch(WORKFLOW_WORDS);
      });

      it('does not repeat a step or a rule of the handoff anywhere in the instructions', () => {
        const effective = resolveWorkflow(
          defaultWorkflow(BOARD.statuses),
          {},
          undefined,
          undefined,
        );
        const steps = workflowSteps(effective, {
          taskId: 'T1',
          status: 'todo',
          branch: 'task/T1',
        });
        expect(steps.length).toBeGreaterThan(0);
        // What the text says of itself, before it documents the routes: the example answer of
        // the handoff route quotes a handoff, and that is the route's, not a rule.
        const own = instructions.slice(0, instructions.indexOf('\n## Board\n'));
        expect(own).toContain('## Rules');
        for (const step of steps) {
          // Without the "(source: ...)" note that the handoff adds to each step.
          const text = step.text.replace(/ _\(.*\)_$/, '');
          expect(own).not.toContain(text);
        }
      });
    });
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
