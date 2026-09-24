import { defineConfig, devices } from '@playwright/test';

/**
 * The board in a real browser. Each test starts the real CLI in a temporary directory, so
 * what is tested is the application a user installs: the built UI, served by the board
 * itself, over its own local security checks.
 */
export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
