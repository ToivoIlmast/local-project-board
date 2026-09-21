/** @type {import('jest').Config['projects'][number]} */
const base = {
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: 'tsconfig.test.json' }],
  },
};

/** @type {import('jest').Config} */
export default {
  projects: [
    {
      ...base,
      displayName: 'node',
      testMatch: ['<rootDir>/test/**/*.test.ts'],
      testPathIgnorePatterns: ['<rootDir>/test/pack/', '<rootDir>/test/e2e/'],
    },
    {
      ...base,
      displayName: 'pack',
      testMatch: ['<rootDir>/test/pack/**/*.test.ts'],
      testTimeout: 180_000,
    },
  ],
};
