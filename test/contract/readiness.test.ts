import * as contract from '../../src/contract/v1/index.js';
import * as core from '../../src/core/index.js';
import * as rules from '../../src/core/rules/readiness.js';

describe('readiness in the contract', () => {
  // The page reaches the core only through the contract (ADR-0013): one function for both sides.
  it.each(['readiness', 'launchState', 'findCycles'] as const)(
    'the page gets the very %s the server runs',
    (name) => {
      expect(contract[name]).toBe(rules[name]);
      expect(core[name]).toBe(rules[name]);
    },
  );
});
