import { z } from 'zod';
import {
  API_BASE_PATH,
  API_VERSION,
  parseBody,
  parseParams,
  parseQuery,
  routeList,
  routeUrl,
  routes,
  type Route,
} from '../../src/contract/v1/index.js';

const cases: [string, Route][] = routeList.map((route) => [route.id, route]);

describe('API version', () => {
  it('is v1', () => {
    expect(API_VERSION).toBe('v1');
    expect(API_BASE_PATH).toBe('/api/v1');
  });

  it('prefixes every route path', () => {
    for (const route of routeList) {
      expect(routeUrl(route)).toBe(`/api/v1${route.path}`);
      expect(route.path.startsWith('/')).toBe(true);
    }
  });
});

describe('route table', () => {
  it('covers the resources of the API', () => {
    expect(routeList.length).toBeGreaterThanOrEqual(20);
    expect(routes['tasks.create'].method).toBe('POST');
  });

  it('has a unique id and a unique method+path per route', () => {
    const ids = routeList.map((r) => r.id);
    const endpoints = routeList.map((r) => `${r.method} ${r.path}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(endpoints).size).toBe(endpoints.length);
  });

  it('keys the table by the route id', () => {
    for (const [id, route] of Object.entries(routes)) expect(route.id).toBe(id);
  });
});

describe.each(cases)('route %s', (_id, route) => {
  it('has a summary', () => {
    expect(route.summary).toMatch(/\S/);
    expect(route.summary.length).toBeLessThanOrEqual(100);
  });

  it('says whether an AI agent may use it', () => {
    expect(typeof route.ai.include).toBe('boolean');
  });

  it('has an example response that validates against the response schema', () => {
    expect(route.example).toBeDefined();
    expect(route.response.schema.safeParse(route.example.response)).toMatchObject({
      success: true,
    });
  });

  it('has an example request when it takes a body, and it validates', () => {
    if (!route.request) {
      expect(route.example.body).toBeUndefined();
      return;
    }
    expect(route.example.body).toBeDefined();
    expect(route.request.safeParse(route.example.body)).toMatchObject({ success: true });
  });

  it('has example params and query when it declares them, and they validate', () => {
    if (route.params) {
      expect(route.params.safeParse(route.example.params)).toMatchObject({ success: true });
    }
    if (route.query) {
      expect(route.query.safeParse(route.example.query ?? {})).toMatchObject({ success: true });
    }
  });

  it('declares path parameters that match the path', () => {
    const inPath = [...route.path.matchAll(/:(\w+)/g)].map((m) => m[1]);
    const declared = route.params ? Object.keys(z.toJSONSchema(route.params).properties ?? {}) : [];
    expect(declared.sort()).toEqual([...inPath].sort());
  });

  it('has a request schema exactly when the method carries a body', () => {
    const carriesBody =
      route.method === 'POST' || route.method === 'PATCH' || route.method === 'PUT';
    expect(Boolean(route.request)).toBe(carriesBody);
  });
});

describe('runtime validation comes from the route table', () => {
  it('parses a valid body with the route own schema', () => {
    const result = parseBody(routes['tasks.create'], { title: 'Write the conformance suite' });
    expect(result).toMatchObject({ ok: true });
  });

  it('rejects an invalid body and reports the field path', () => {
    const result = parseBody(routes['tasks.create'], { title: '' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues[0]?.path).toBe('title');
  });

  it('rejects unknown fields instead of silently dropping them', () => {
    const result = parseBody(routes['tasks.create'], { title: 'x', estimate: 3 });
    expect(result.ok).toBe(false);
  });

  it('rejects a body on a route that takes none', () => {
    expect(parseBody(routes['tasks.list'], { title: 'x' }).ok).toBe(false);
  });

  it('validates path params, so ids can never be path traversal', () => {
    expect(parseParams(routes['tasks.get'], { id: 'T1' })).toMatchObject({ ok: true });
    expect(parseParams(routes['tasks.get'], { id: '../../etc/passwd' }).ok).toBe(false);
    expect(parseParams(routes['documents.read'], { id: 'T1', name: '../x.md' }).ok).toBe(false);
  });

  it('coerces and bounds query parameters', () => {
    const ok = parseQuery(routes['git.commits'], { limit: '10' });
    expect(ok).toMatchObject({ ok: true, data: { limit: 10 } });
    expect(parseQuery(routes['git.commits'], {})).toMatchObject({ ok: true, data: { limit: 50 } });
    expect(parseQuery(routes['git.commits'], { limit: '0' }).ok).toBe(false);
    expect(parseQuery(routes['git.commits'], { limit: '10000' }).ok).toBe(false);
  });

  it('rejects a git ref that could be read as a git option (INVARIANT)', () => {
    expect(parseQuery(routes['git.commits'], { ref: 'feat/x' })).toMatchObject({ ok: true });
    for (const ref of ['--upload-pack=x', '-n1', 'a b', 'a;rm -rf /', '']) {
      expect(parseQuery(routes['git.commits'], { ref }).ok).toBe(false);
    }
  });

  it('returns the parsed value, not the input', () => {
    const result = parseBody(routes['tasks.create'], { title: 'x', labels: ['a'] });
    expect(result.ok && result.data).toEqual({ title: 'x', labels: ['a'] });
  });
});

describe('response media types', () => {
  it('serves documents and reports as text, everything else as JSON', () => {
    expect(routes['documents.read'].response.media).toBe('text/markdown');
    expect(routes['instructions.get'].response.media).toBe('text/markdown');
    expect(routes['events.stream'].response.media).toBe('text/event-stream');
    expect(routes['tasks.list'].response.media).toBe('application/json');
  });
});
