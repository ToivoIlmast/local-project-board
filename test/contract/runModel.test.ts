import { runRequestSchema, runTaskRequestSchema } from '../../src/contract/v1/index.js';

/**
 * The model of a run is the one value of a request that ends up in the argv of a program (T35).
 * Only a closed form may get there: a short alias, or a full `claude-…` name. Anything that could
 * be read by `claude` as another flag, or split by a shell, must not pass the contract.
 */

const VALID = [
  'opus',
  'sonnet',
  'fable',
  'haiku',
  'claude-sonnet-4-6',
  'claude-opus-4-1-20250805',
  'claude-sonnet-4-6[1m]',
  'claude-fable-5.1',
];

const INVALID = [
  '--x',
  '--dangerously-skip-permissions',
  '-p',
  'a b',
  'a;b',
  'sonnet --x',
  'sonnet\n--x',
  '$(id)',
  '',
  ' sonnet',
  'Sonnet',
  'claude-',
  'claude-a b',
  'claude-x[1m]y',
  'claude-x[2m]',
  `claude-${'a'.repeat(193)}`,
  'a'.repeat(200),
  'gpt-4',
  'claude',
];

describe('the model of a run (T35)', () => {
  it.each(VALID)('accepts %s, in a request and in what the runner receives', (model) => {
    expect(runTaskRequestSchema.safeParse({ agent: 'claude-code', model }).success).toBe(true);
    expect(
      runRequestSchema.safeParse({
        type: 'run.requested',
        taskId: 'T1',
        agent: 'claude-code',
        model,
      }).success,
    ).toBe(true);
  });

  it.each(INVALID)(
    'refuses %j in a request and in what the runner receives (INVARIANT)',
    (model) => {
      expect(runTaskRequestSchema.safeParse({ agent: 'claude-code', model }).success).toBe(false);
      expect(
        runRequestSchema.safeParse({
          type: 'run.requested',
          taskId: 'T1',
          agent: 'claude-code',
          model,
        }).success,
      ).toBe(false);
    },
  );

  it('refuses a model that is not a string', () => {
    for (const model of [null, 1, ['sonnet'], { name: 'sonnet' }]) {
      expect(runTaskRequestSchema.safeParse({ agent: 'claude-code', model }).success).toBe(false);
    }
  });

  it('is optional: no model is the default of the user, not a value of its own', () => {
    expect(runTaskRequestSchema.parse({ agent: 'claude-code' })).toEqual({ agent: 'claude-code' });
  });
});
