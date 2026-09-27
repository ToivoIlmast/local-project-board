import { readFileSync } from 'node:fs';

/**
 * The npm scripts that start the board from a checkout are aliases of the CLI and nothing more:
 * `npm run start:claude -- --wait` must be `local-project-board claude --wait`, so the script
 * adds no argument of its own and npm hands on whatever follows `--` (T27).
 */
const scripts = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;

describe('npm scripts that start the board', () => {
  it('start the CLI of this checkout, with no arguments of their own', () => {
    expect(scripts['start']).toBe('node bin/board.js');
    expect(scripts['start:claude']).toBe('node bin/board.js claude');
  });
});
