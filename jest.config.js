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
      testPathIgnorePatterns: [
        '<rootDir>/test/pack/',
        '<rootDir>/test/e2e/',
        '<rootDir>/test/web/',
      ],
    },
    {
      // The board's own page: a browser environment, React and the built UI's source.
      ...base,
      displayName: 'web',
      testEnvironment: 'jsdom',
      testEnvironmentOptions: { url: 'http://127.0.0.1:7432/' },
      testMatch: ['<rootDir>/test/web/**/*.test.ts', '<rootDir>/test/web/**/*.test.tsx'],
      extensionsToTreatAsEsm: ['.ts', '.tsx'],
      transform: {
        '^.+\\.tsx?$': ['ts-jest', { useESM: true, tsconfig: 'tsconfig.test-web.json' }],
      },
      moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1',
        '^@/(.*)$': '<rootDir>/src/web/$1',
        '\\.css$': '<rootDir>/test/web/support/styleStub.cjs',
      },
      setupFilesAfterEnv: ['<rootDir>/test/web/support/setup.ts'],
    },
    {
      ...base,
      displayName: 'pack',
      testMatch: ['<rootDir>/test/pack/**/*.test.ts'],
      testTimeout: 180_000,
    },
  ],
};
