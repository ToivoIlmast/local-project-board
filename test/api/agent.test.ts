import {
  documentMetaSchema,
  gitStatusSchema,
  projectSchema,
  reportSchema,
  taskSchema,
} from '../../src/contract/v1/index.js';
import { createTestBoard, type TestBoard } from '../support/httpBoard.js';
import { cleanTmpDirs } from '../support/tmp.js';

let board: TestBoard;

beforeEach(async () => {
  board = await createTestBoard();
});

afterEach(async () => {
  await board.close();
  await cleanTmpDirs();
});

/**
 * An agent that knows one thing: the board answers on this port. Everything else — where the
 * API is and how to be allowed to change anything — it reads out of the instructions, the way
 * a model handed the instructions text would (§16).
 */
class Agent {
  private constructor(
    readonly api: string,
    readonly token: string,
    readonly instructions: string,
  ) {}

  /**
   * An agent that is handed the handoff of one task and nothing else. The handoff has no token:
   * it says where to ask for one, and the agent does exactly that.
   */
  static async fromHandoff(port: number, id: string): Promise<Agent> {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/tasks/${id}/handoff`);
    expect(response.status).toBe(200);
    const handoff = await response.text();
    expect(handoff).not.toMatch(/^Authorization: Bearer (?!<session token>)/m);

    const api = /^Base URL: (\S+)$/m.exec(handoff)?.[1];
    expect(typeof api).toBe('string');
    expect(handoff).toContain(`GET ${api}/session`);
    expect(handoff.includes('### GET /api/v1/session')).toBe(true);
    const session = (await (await fetch(`${api}/session`)).json()) as { token: string };
    return new Agent(api as string, session.token, handoff);
  }

  static async start(port: number): Promise<Agent> {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/instructions`);
    expect(response.status).toBe(200);
    const instructions = await response.text();

    const api = /^Base URL: (\S+)$/m.exec(instructions)?.[1];
    const token = /^Authorization: Bearer (\S+)$/m.exec(instructions)?.[1];
    expect(typeof api).toBe('string');
    expect(typeof token).toBe('string');
    return new Agent(api as string, token as string, instructions);
  }

  /** What the agent was handed: the instructions, or the handoff that carries them. */
  get text(): string {
    return this.instructions;
  }

  /** The instructions promise this route; the agent calls nothing they do not describe. */
  private documents(method: string, route: string): boolean {
    return this.instructions.includes(`### ${method} /api/v1${route}`);
  }

  async call(method: string, route: string, path: string, body?: unknown): Promise<Response> {
    expect([method, route, this.documents(method, route)]).toEqual([method, route, true]);
    return fetch(`${this.api}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async json(
    method: string,
    route: string,
    path: string,
    body?: unknown,
    status = 200,
  ): Promise<unknown> {
    const response = await this.call(method, route, path, body);
    expect([path, response.status]).toEqual([path, status]);
    return response.json();
  }
}

describe('an external agent with nothing but the instructions', () => {
  it('runs a whole session against the board (INVARIANT)', async () => {
    const agent = await Agent.start(board.port);

    // 1. What board is this, and what may a task look like on it?
    const project = projectSchema.parse(await agent.json('GET', '/project', '/project'));
    expect(project.statuses.length).toBeGreaterThan(1);
    const [first, second] = project.statuses as [string, string];
    expect(await agent.json('GET', '/tasks', '/tasks')).toEqual([]);

    // 2. Create two tasks, the second one to have a neighbour to move around.
    const created = taskSchema.parse(
      await agent.json(
        'POST',
        '/tasks',
        '/tasks',
        {
          title: 'Audit the dependency graph',
          status: first,
          body: '## Finding\n\nThree packages are two majors behind.\n',
          labels: ['audit'],
        },
        201,
      ),
    );
    const neighbour = taskSchema.parse(
      await agent.json(
        'POST',
        '/tasks',
        '/tasks',
        { title: 'Second finding', status: second },
        201,
      ),
    );
    expect(created.id).toBe('T1');

    // 3. Change it, then move it into another column, behind the neighbour.
    const updated = taskSchema.parse(
      await agent.json('PATCH', '/tasks/:id', `/tasks/${created.id}`, {
        labels: ['audit', 'deps'],
      }),
    );
    expect(updated.labels).toEqual(['audit', 'deps']);

    const moved = taskSchema.parse(
      await agent.json('POST', '/tasks/:id/move', `/tasks/${created.id}/move`, {
        status: second,
        after: neighbour.id,
      }),
    );
    expect(moved.status).toBe(second);
    expect(moved.rank > neighbour.rank).toBe(true);

    // 4. Attach the working document to the task it belongs to.
    const document = documentMetaSchema.parse(
      await agent.json(
        'PUT',
        '/tasks/:id/documents/:name',
        `/tasks/${created.id}/documents/plan.md`,
        { content: '# Plan\n\n1. Update the two majors.\n' },
      ),
    );
    expect(document).toMatchObject({ taskId: created.id, name: 'plan.md' });
    const read = await agent.call(
      'GET',
      '/tasks/:id/documents/:name',
      `/tasks/${created.id}/documents/plan.md`,
    );
    expect(read.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(await read.text()).toContain('Update the two majors');

    // 5. Save the result of the audit as a report and read it back.
    const report = reportSchema.parse(
      await agent.json(
        'POST',
        '/reports',
        '/reports',
        {
          title: 'Dependency audit',
          format: 'html',
          content: '<h1>Dependency audit</h1><p>3 outdated packages.</p>',
        },
        201,
      ),
    );
    const rendered = await agent.call('GET', '/reports/:id', `/reports/${report.id}`);
    expect(rendered.status).toBe(200);
    expect(rendered.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await rendered.text()).toContain('3 outdated packages');

    // 6. Read the repository the board is about.
    gitStatusSchema.parse(await agent.json('GET', '/git/status', '/git/status'));

    // 7. Everything the agent did is on the disk, not only in the answers it got.
    expect((await board.storage.listTasks()).map((task) => task.id)).toEqual(['T1', 'T2']);
    expect(await board.storage.listDocuments('T1')).toMatchObject([{ name: 'plan.md' }]);
    expect(await board.storage.listReports()).toMatchObject([{ title: 'Dependency audit' }]);
  });

  it('is refused the moment it stops sending the token it was given', async () => {
    const agent = await Agent.start(board.port);
    const response = await fetch(`${agent.api}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'no token' }),
    });

    expect(response.status).toBe(401);
    expect(await board.storage.listTasks()).toEqual([]);
  });
});

/** What an agent that only reads the numbered steps of a handoff is asked to do with the API. */
function calls(handoff: string): { method: string; route: string; path: string; body?: unknown }[] {
  const section = handoff.split('## How to work on this task\n')[1]?.split('\n---\n')[0] ?? '';
  const found: { method: string; route: string; path: string; body?: unknown }[] = [];
  for (const line of section.split('\n').filter((each) => /^\d+\. /.test(each))) {
    if (/^\d+\. Do not /.test(line)) continue;
    const patch = /`PATCH \/api\/v1(\/tasks\/T\d+)` with `(\{[^`]*\})`/.exec(line);
    if (patch) {
      found.push({
        method: 'PATCH',
        route: '/tasks/:id',
        path: patch[1] ?? '',
        body: JSON.parse(patch[2] ?? ''),
      });
    }
    const put = /`PUT \/api\/v1(\/tasks\/T\d+\/documents\/report\.md)`/.exec(line);
    if (put) {
      found.push({
        method: 'PUT',
        route: '/tasks/:id/documents/:name',
        path: put[1] ?? '',
        body: { content: '# Report\n\nDone as the handoff said.\n' },
      });
    }
  }
  return found;
}

describe('an external agent with nothing but the handoff of a task', () => {
  it('records the branch, moves the task and writes the report, as the steps say (INVARIANT)', async () => {
    const created = taskSchema.parse(
      (
        await board
          .post('/api/v1/tasks', { title: 'Audit the dependency graph', status: 'todo' })
          .expect(201)
      ).body,
    );
    const agent = await Agent.fromHandoff(board.port, created.id);

    for (const call of calls(agent.text)) {
      await agent.json(call.method, call.route, call.path, call.body);
    }

    const after = taskSchema.parse(await agent.json('GET', '/tasks/:id', `/tasks/${created.id}`));
    // The default workflow: work starts in `in-progress`, the branch is recorded, the status is
    // left alone at the end because the task waits for the review.
    expect(after.status).toBe('in-progress');
    expect(after.branch).toBe('task/T1-audit-the-dependency-graph');
    const report = await agent.call(
      'GET',
      '/tasks/:id/documents/:name',
      `/tasks/${created.id}/documents/report.md`,
    );
    expect(await report.text()).toContain('Done as the handoff said');
    expect(await board.storage.listDocuments('T1')).toMatchObject([{ name: 'report.md' }]);
  });

  it('is told to do less when the settings say so: no branch, no report, nothing to move to', async () => {
    const created = taskSchema.parse(
      (
        await board
          .post('/api/v1/tasks', {
            title: 'Only look',
            status: 'todo',
            workflow: { branch: false, report: false },
          })
          .expect(201)
      ).body,
    );
    await board.put('/api/v1/workflow', { board: { startStatus: null }, statuses: {} }).expect(200);
    const agent = await Agent.fromHandoff(board.port, created.id);

    expect(calls(agent.text)).toEqual([]);
    const after = taskSchema.parse(await agent.json('GET', '/tasks/:id', `/tasks/${created.id}`));
    expect(after).toMatchObject({ status: 'todo' });
    expect(after.branch).toBeUndefined();
    expect(await board.storage.listDocuments('T1')).toEqual([]);
  });

  it('is refused the moment it stops sending the token it asked for', async () => {
    const created = taskSchema.parse(
      (await board.post('/api/v1/tasks', { title: 'x' }).expect(201)).body,
    );
    const agent = await Agent.fromHandoff(board.port, created.id);
    const response = await fetch(`${agent.api}/tasks/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: 'x' }),
    });

    expect(response.status).toBe(401);
  });
});
