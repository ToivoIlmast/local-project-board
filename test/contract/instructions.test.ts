import { generateInstructions } from '../../src/contract/v1/index.js';
import { routeList } from '../../src/contract/v1/index.js';

const instructions = generateInstructions({ baseUrl: 'http://127.0.0.1:7432', token: 'secret-1' });

describe('generated AI instructions', () => {
  it('documents every route marked ai.include (drift test, INVARIANT)', () => {
    const included = routeList.filter((r) => r.ai.include);
    expect(included.length).toBeGreaterThan(0);
    for (const route of included) {
      expect(instructions).toContain(`${route.method} /api/v1${route.path}`);
      expect(instructions).toContain(route.summary);
    }
  });

  it('leaves out routes that are not for agents', () => {
    for (const route of routeList.filter((r) => !r.ai.include)) {
      expect(instructions).not.toContain(`${route.method} /api/v1${route.path}`);
    }
  });

  it('shows an example for every documented route', () => {
    for (const route of routeList.filter((r) => r.ai.include && r.request)) {
      expect(instructions).toContain(JSON.stringify(route.example.body, null, 2));
    }
  });

  it('gives the agent the base URL and the token it must send', () => {
    expect(instructions).toContain('http://127.0.0.1:7432');
    expect(instructions).toContain('Authorization: Bearer secret-1');
  });

  it('is plain markdown', () => {
    expect(instructions.startsWith('# ')).toBe(true);
    expect(instructions).not.toContain('undefined');
  });

  it('omits the token line when there is none', () => {
    const anonymous = generateInstructions({ baseUrl: 'http://127.0.0.1:7432' });
    expect(anonymous).not.toContain('Bearer');
  });
});
