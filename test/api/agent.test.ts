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
