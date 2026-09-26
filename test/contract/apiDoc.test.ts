import { readFileSync, writeFileSync } from 'node:fs';
import {
  API_BASE_PATH,
  errorCodeSchema,
  renderApiDoc,
  routeList,
  type Route,
} from '../../src/contract/v1/index.js';

const DOCS_PATH = new URL('../../docs/api.md', import.meta.url);

const generated = renderApiDoc(routeList);

const endpoint = (route: Route): string => `${route.method} ${API_BASE_PATH}${route.path}`;

/** The `### METHOD /api/v1/path` headings, which is the list of routes the text documents. */
function documented(text: string): string[] {
  return [...text.matchAll(/^### (GET|POST|PATCH|PUT|DELETE) (\S+)$/gm)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
}

/** Every fenced json block, as a reader would read it. */
function jsonBlocks(text: string): unknown[] {
  return [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => JSON.parse(match[1] ?? ''));
}

describe('docs/api.md', () => {
  it('matches the generator; set UPDATE_DOCS=1 to regenerate (drift test, INVARIANT)', () => {
    if (process.env['UPDATE_DOCS'] === '1') writeFileSync(DOCS_PATH, generated);
    const onDisk = readFileSync(DOCS_PATH, 'utf8');
    expect(onDisk).toBe(generated);
  });
});

describe('renderApiDoc', () => {
  it('documents every route, including the ones agents are never told about (INVARIANT)', () => {
    expect(routeList.length).toBeGreaterThan(0);
    expect(documented(generated).sort()).toEqual(routeList.map(endpoint).sort());
  });

  it('marks each route as given to, or withheld from, AI agents', () => {
    const hidden = routeList.filter((r) => !r.ai.include).map((r) => r.id);
    expect(hidden.sort()).toEqual(['events.stream', 'instructions.get', 'workflow.update']);
    for (const route of routeList) {
      expect(generated).toContain(
        route.ai.include
          ? 'Given to AI agents in the generated instructions.'
          : 'Not given to AI agents in the generated instructions.',
      );
    }
  });

  it('shows the correct success status and media type for every route (INVARIANT)', () => {
    for (const route of routeList) {
      expect(generated).toContain(
        `Response — ${route.successStatus ?? 200}, ${route.response.media}:`,
      );
    }
  });

  it('shows the request body of every route that takes one', () => {
    for (const route of routeList) {
      if (route.request) expect(generated).toContain(JSON.stringify(route.example.body, null, 2));
    }
  });

  it('shows a concrete path and query for a route that takes parameters', () => {
    expect(generated).toContain(`Example: GET ${API_BASE_PATH}/tasks/T12/documents/plan.md`);
    expect(generated).toContain('Query: ?ref=main&limit=20');
  });

  it('lists every error code the board can send (INVARIANT)', () => {
    expect(generated).toContain('## Errors');
    expect(errorCodeSchema.options.length).toBeGreaterThan(0);
    for (const code of errorCodeSchema.options) expect(generated).toContain(code);
  });

  it('describes every media type a route actually uses', () => {
    const used = new Set(routeList.map((r) => r.response.media));
    expect(used.size).toBeGreaterThan(1);
    for (const media of used) expect(generated).toContain(`\`${media}\``);
  });

  it('only contains json blocks that validate against the contract (INVARIANT)', () => {
    const examples = new Set(
      routeList
        .flatMap((r) => [r.example.body, r.example.response])
        .filter((value) => value !== undefined && typeof value !== 'string')
        .map((value) => JSON.stringify(value, null, 2)),
    );
    const blocks = jsonBlocks(generated);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(examples.has(JSON.stringify(block, null, 2))).toBe(true);
  });

  it('groups routes by resource, in the order the board explains them', () => {
    const headings = [...generated.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings[0]).toBe('Media types');
    expect(headings).toContain('Board');
    expect(headings).toContain('Tasks');
    expect(headings.at(-1)).toBe('Errors');
    expect(headings.indexOf('Board')).toBeLessThan(headings.indexOf('Tasks'));
  });

  it('is plain markdown', () => {
    expect(generated.startsWith('# ')).toBe(true);
    expect(generated).not.toContain('undefined');
    expect(generated.endsWith('\n')).toBe(true);
  });
});
