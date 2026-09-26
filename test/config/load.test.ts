import { readdir, readFile } from 'node:fs/promises';
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
      // The rules of the project are its own: the board ships none (the API's are not config).
      ai: { rules: [] },
    });
  });

  it('has no source-edit setting: that is the workflow setting editCode (INVARIANT)', async () => {
    const config = await load({});
    expect(Object.keys(config.ai)).toEqual(['rules']);
    expect(config).not.toHaveProperty('workflow');
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

  it('reads the rules of the project as they are written', async () => {
    const root = await tmpDir();
    await writeYaml(
      root,
      'board.config.yaml',
      'ai:\n  rules:\n    - Never delete a task without asking first.\n',
    );
    const config = await load({ root });
    expect(config.ai).toEqual({ rules: ['Never delete a task without asking first.'] });
  });

  it('accepts an empty list of rules, and an ai section without any', async () => {
    for (const yaml of ['ai:\n  rules: []\n', 'ai: {}\n']) {
      const root = await tmpDir();
      await writeYaml(root, 'board.config.yaml', yaml);
      expect((await load({ root })).ai).toEqual({ rules: [] });
    }
  });

  it('lets the user config set rules that board.config.yaml then replaces wholesale', async () => {
    const root = await tmpDir();
    const userDir = await tmpDir();
    await writeYaml(root, 'board.config.yaml', 'ai:\n  rules: [From the project file.]\n');
    const userConfigPath = await writeYaml(
      userDir,
      'config.yaml',
      'ai:\n  rules: [From the user file.]\n',
    );
    const config = await load({ root, userConfigPath });
    expect(config.ai.rules).toEqual(['From the project file.']);
  });

  it('reads the board shape from board.config.yaml', async () => {
    const root = await tmpDir();
    await writeYaml(
      root,
      'board.config.yaml',
      'project:\n  name: dep-health\ntasks:\n  idPrefix: F\nstatuses: [todo, done]\n',
    );
    const config = await load({ root });
    expect(config.project.name).toBe('dep-health');
    expect(config.tasks.idPrefix).toBe('F');
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
    ['ai:\n  rules: [""]\n', 'config.ai.rules.0'],
    ['ai:\n  rules: Ask first.\n', 'config.ai.rules'],
    ['ai:\n  rules: [Ask first., 3]\n', 'config.ai.rules.1'],
  ])('rejects %p at %s', async (yaml, path) => {
    const root = await tmpDir();
    await writeYaml(root, 'board.config.yaml', yaml);
    await expectIssue({ root }, { path });
  });

  describe('the removed ai.allowSourceEdits (T16)', () => {
    const HINT_PARTS = ['editCode', '.board/workflow.yaml', 'removed'];

    it.each([
      ['true', 'ai:\n  allowSourceEdits: true\n'],
      ['false', 'ai:\n  allowSourceEdits: false\n'],
      // The rest of the section being fine does not make the old key acceptable.
      ['next to rules', 'ai:\n  rules: [Ask first.]\n  allowSourceEdits: false\n'],
    ])('stops the board with a hint, whatever its value (%s)', async (_name, yaml) => {
      const root = await tmpDir();
      await writeYaml(root, 'board.config.yaml', yaml);

      const error = await expectIssue(
        { root },
        { path: 'config.ai.allowSourceEdits', source: 'board.config.yaml' },
      );

      expect(error.exitCode).toBe(1);
      for (const part of HINT_PARTS) expect(error.message).toContain(part);
      // One issue for the key: a hint, not a second "unrecognized key" next to it.
      expect(
        error.issues.filter((issue) => issue.path === 'config.ai.allowSourceEdits'),
      ).toHaveLength(1);
    });

    it('says the key never had an effect, and where editCode is set instead', async () => {
      const root = await tmpDir();
      await writeYaml(root, 'board.config.yaml', 'ai:\n  allowSourceEdits: false\n');

      const error = await expectIssue({ root }, { path: 'config.ai.allowSourceEdits' });

      expect(error.message).toMatch(/never had an effect/);
      expect(error.message).toContain('editCode: false');
    });

    it('is refused in the user config too, naming that file', async () => {
      const userDir = await tmpDir();
      const userConfigPath = await writeYaml(
        userDir,
        'config.yaml',
        'ai:\n  allowSourceEdits: false\n',
      );

      await expectIssue(
        { userConfigPath },
        { path: 'config.ai.allowSourceEdits', source: 'config.yaml' },
      );
    });

    it('is not carried into the config by any other layer', async () => {
      // Environment and flags have no ai keys at all, so there is no second way in.
      const config = await load({
        env: { BOARD_AI_ALLOW_SOURCE_EDITS: 'true', BOARD_ALLOW_SOURCE_EDITS: 'true' },
      });
      expect(config.ai).toEqual({ rules: [] });
    });
  });

  it.each([
    ['ai:\n  branch: true\n', 'config.ai.branch'],
    ['ai:\n  editCode: false\n', 'config.ai.editCode'],
    ['ai:\n  push: true\n', 'config.ai.push'],
    // The settings of the workflow live in .board/workflow.yaml and nowhere in the config (ADR-0028).
    ['workflow:\n  editCode: false\n', 'config.workflow'],
    ['ai:\n  workflow: { editCode: false }\n', 'config.ai.workflow'],
  ])('has no way to say how to work: rejects %p (INVARIANT)', async (yaml, path) => {
    const root = await tmpDir();
    await writeYaml(root, 'board.config.yaml', yaml);
    await expectIssue({ root }, { path });
  });

  it('does not name the removed key anywhere in the source but in the hint that refuses it (INVARIANT)', async () => {
    const files = (await readdir(join(process.cwd(), 'src'), { recursive: true })).filter((file) =>
      /\.(ts|tsx)$/.test(file),
    );
    const naming: string[] = [];
    for (const file of files) {
      const text = await readFile(join(process.cwd(), 'src', file), 'utf8');
      if (/allowSourceEdits/.test(text)) naming.push(file.replaceAll('\\', '/'));
    }
    // A reader of `allowSourceEdits` would be a second source for editCode.
    expect(naming).toEqual(['server/config/schema.ts']);
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
