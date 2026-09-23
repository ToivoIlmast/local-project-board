import { join } from 'node:path';
import { ConfigError, loadConfig } from '../../src/server/config/index.js';
import { cleanTmpDirs, tmpDir, writeYaml } from '../support/tmp.js';

afterAll(cleanTmpDirs);

async function load(options: {
  root?: string;
  cli?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  userConfigPath?: string;
}) {
  const root = options.root ?? (await tmpDir());
  return loadConfig({ root, cli: options.cli ?? {}, env: options.env ?? {}, ...options });
}

describe('defaults', () => {
  it('needs no config file at all', async () => {
    const root = await tmpDir();
    const config = await load({ root });
    expect(config).toEqual({
      project: { name: expect.stringMatching(/^board-test-/) },
      statuses: ['backlog', 'todo', 'in-progress', 'done'],
      tasks: { idPrefix: 'T' },
      storage: { provider: 'markdown' },
      server: { port: 7432, open: true },
      ai: { allowSourceEdits: false },
    });
  });

  it('names the board after its directory', async () => {
    const root = join(await tmpDir(), 'dep-health');
    const config = await load({ root });
    expect(config.project.name).toBe('dep-health');
  });
});

describe('precedence: CLI > env > board.config.yaml > user config > defaults', () => {
  async function fixture() {
    const root = await tmpDir();
    const userDir = await tmpDir();
    await writeYaml(root, 'board.config.yaml', 'server:\n  port: 3000\n');
    const userConfigPath = await writeYaml(userDir, 'config.yaml', 'server:\n  port: 2000\n');
    return { root, userConfigPath };
  }

  it('uses the user config over the defaults', async () => {
    const userDir = await tmpDir();
    const userConfigPath = await writeYaml(userDir, 'config.yaml', 'server:\n  port: 2000\n');
    expect((await load({ userConfigPath })).server.port).toBe(2000);
  });

  it('uses board.config.yaml over the user config', async () => {
    const { root, userConfigPath } = await fixture();
    expect((await load({ root, userConfigPath })).server.port).toBe(3000);
  });

  it('uses env over board.config.yaml', async () => {
    const { root, userConfigPath } = await fixture();
    const config = await load({ root, userConfigPath, env: { BOARD_PORT: '4000' } });
    expect(config.server.port).toBe(4000);
  });

  it('uses CLI over env', async () => {
    const { root, userConfigPath } = await fixture();
    const config = await load({
      root,
      userConfigPath,
      env: { BOARD_PORT: '4000' },
      cli: { port: 5000 },
    });
    expect(config.server.port).toBe(5000);
  });

  it('overrides one value without dropping the rest of the section', async () => {
    const root = await tmpDir();
    await writeYaml(root, 'board.config.yaml', 'server:\n  port: 3000\n  open: false\n');
    const config = await load({ root, cli: { port: 5000 } });
    expect(config.server).toEqual({ port: 5000, open: false });
  });

  it('replaces a list instead of merging it', async () => {
    const root = await tmpDir();
    await writeYaml(root, 'board.config.yaml', 'statuses: [todo, done]\n');
    expect((await load({ root })).statuses).toEqual(['todo', 'done']);
  });

  it('reads the board shape from board.config.yaml', async () => {
    const root = await tmpDir();
    await writeYaml(
      root,
      'board.config.yaml',
      'project:\n  name: dep-health\ntasks:\n  idPrefix: F\nstatuses: [todo, done]\nai:\n  allowSourceEdits: true\n',
    );
    const config = await load({ root });
    expect(config.project.name).toBe('dep-health');
    expect(config.tasks.idPrefix).toBe('F');
    expect(config.ai.allowSourceEdits).toBe(true);
  });

  it('reads the documented env variables', async () => {
    const config = await load({
      env: {
        BOARD_PORT: '4000',
        BOARD_OPEN: 'false',
        BOARD_ID_PREFIX: 'F',
        BOARD_PROJECT_NAME: 'dep-health',
        BOARD_STORAGE_PROVIDER: 'markdown',
        UNRELATED: 'ignored',
      },
    });
    expect(config.server).toEqual({ port: 4000, open: false });
    expect(config.tasks.idPrefix).toBe('F');
    expect(config.project.name).toBe('dep-health');
  });
});

describe('strict validation', () => {
  async function expectIssue(
    options: Parameters<typeof load>[0],
    expected: { path: string; source?: string },
  ) {
    const error = await load(options).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConfigError);
    const issues = (error as ConfigError).issues;
    expect(issues.map((i) => i.path)).toContain(expected.path);
    if (expected.source !== undefined) {
      expect(issues.map((i) => i.source).join(' ')).toContain(expected.source);
    }
    return error as ConfigError;
  }

  it('reports an unknown key with the file it came from', async () => {
    const root = await tmpDir();
    await writeYaml(root, 'board.config.yaml', 'server:\n  prot: 3000\n');
    const error = await expectIssue(
      { root },
      { path: 'config.server.prot', source: 'board.config.yaml' },
    );
    expect(error.message).toContain('board.config.yaml');
    expect(error.message).not.toContain('at Object.');
  });

  it('reports an unknown top-level section', async () => {
    const root = await tmpDir();
    await writeYaml(root, 'board.config.yaml', 'plugins:\n  - some-plugin\n');
    await expectIssue({ root }, { path: 'config.plugins' });
  });

  it.each([
    ['server:\n  port: "abc"\n', 'config.server.port'],
    ['server:\n  port: 0\n', 'config.server.port'],
    ['server:\n  port: 70000\n', 'config.server.port'],
    ['server:\n  open: "yes"\n', 'config.server.open'],
    ['tasks:\n  idPrefix: f\n', 'config.tasks.idPrefix'],
    ['tasks:\n  idPrefix: T1\n', 'config.tasks.idPrefix'],
    ['statuses: []\n', 'config.statuses'],
    ['statuses: [todo, todo]\n', 'config.statuses'],
    ['statuses: [todo, ""]\n', 'config.statuses.1'],
    ['storage:\n  provider: postgres\n', 'config.storage.provider'],
    ['project:\n  name: ""\n', 'config.project.name'],
  ])('rejects %p at %s', async (yaml, path) => {
    const root = await tmpDir();
    await writeYaml(root, 'board.config.yaml', yaml);
    await expectIssue({ root }, { path });
  });

  it('lists the available providers when the provider is unknown', async () => {
    const root = await tmpDir();
    await writeYaml(root, 'board.config.yaml', 'storage:\n  provider: postgres\n');
    const error = await expectIssue({ root }, { path: 'config.storage.provider' });
    expect(error.message).toContain('markdown');
  });

  it('reports a bad env variable by its own name', async () => {
    await expectIssue(
      { env: { BOARD_PORT: 'abc' } },
      { path: 'config.server.port', source: 'BOARD_PORT' },
    );
  });

  it('reports a bad CLI flag as a flag', async () => {
    await expectIssue({ cli: { port: 70000 } }, { path: 'config.server.port', source: '--port' });
  });

  it('reports broken YAML readably, with the file name', async () => {
    const root = await tmpDir();
    await writeYaml(root, 'board.config.yaml', 'statuses: [todo\nserver: {\n');
    const error = await load({ root }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain('board.config.yaml');
    expect((error as ConfigError).exitCode).toBe(1);
  });

  it('rejects a config file that is not a mapping', async () => {
    const root = await tmpDir();
    await writeYaml(root, 'board.config.yaml', '- todo\n- done\n');
    await expectIssue({ root }, { path: 'config' });
  });

  it('ignores an absent user config file', async () => {
    const config = await load({ userConfigPath: join(await tmpDir(), 'missing.yaml') });
    expect(config.server.port).toBe(7432);
  });
});
