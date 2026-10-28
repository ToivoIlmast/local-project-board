import { parseCliArgs, USAGE, UsageError } from '../../src/server/cli/args.js';

describe('the command line', () => {
  it('starts the board when it is given nothing', () => {
    expect(parseCliArgs([])).toEqual({ command: 'serve' });
  });

  it('takes the port and whether to open a browser', () => {
    expect(parseCliArgs(['--port', '8080'])).toEqual({
      command: 'serve',
      port: 8080,
      explicitPort: true,
    });
    expect(parseCliArgs(['--no-open'])).toEqual({ command: 'serve', open: false });
  });

  it('hands a bad port on to the configuration, which names the flag', () => {
    // The CLI does not validate values twice: --port 0 and --port abc are config errors.
    expect(parseCliArgs(['--port', 'abc'])).toMatchObject({ command: 'serve', explicitPort: true });
    expect(Number.isNaN((parseCliArgs(['--port', 'abc']) as { port: number }).port)).toBe(true);
  });

  it('knows the two other commands of the board', () => {
    expect(parseCliArgs(['instructions'])).toEqual({ command: 'instructions' });
    expect(parseCliArgs(['export'])).toEqual({ command: 'export' });
    expect(parseCliArgs(['export', '--out', 'board.json'])).toEqual({
      command: 'export',
      out: 'board.json',
    });
  });

  it('takes a task id for the handoff command, and only there (T15)', () => {
    expect(parseCliArgs(['handoff', 'T15'])).toEqual({ command: 'handoff', id: 'T15' });
    // The id is passed on as it was written: whether such a task exists is for the board.
    expect(parseCliArgs(['handoff', 'banana'])).toEqual({ command: 'handoff', id: 'banana' });
    expect(() => parseCliArgs(['handoff'])).toThrow(UsageError);
    expect(() => parseCliArgs(['handoff'])).toThrow(/id of a task/);
    expect(() => parseCliArgs(['handoff', 'T1', 'T2'])).toThrow('Unexpected argument: T2');
    expect(() => parseCliArgs(['instructions', 'T1'])).toThrow('Unexpected argument: T1');
    expect(() => parseCliArgs(['export', 'T1'])).toThrow(UsageError);
    expect(() => parseCliArgs(['handoff', 'T1', '--port', '8080'])).toThrow(UsageError);
    expect(() => parseCliArgs(['handoff', 'T1', '--out', 'x'])).toThrow(/export/);
  });

  it('takes a task id for the claude command, and nothing else (T19)', () => {
    expect(parseCliArgs(['claude', 'T19'])).toEqual({ command: 'claude', id: 'T19' });
    // As for the handoff: the id is passed on as written, and validated before anything starts.
    expect(parseCliArgs(['claude', 'banana'])).toEqual({ command: 'claude', id: 'banana' });
    expect(() => parseCliArgs(['claude'])).toThrow(UsageError);
    expect(() => parseCliArgs(['claude'])).toThrow(/id of a task/);
    expect(() => parseCliArgs(['claude', 'T1', 'T2'])).toThrow('Unexpected argument: T2');
    expect(() => parseCliArgs(['claude', 'T1', '--port', '8080'])).toThrow(UsageError);
    expect(() => parseCliArgs(['claude', 'T1', '--out', 'x'])).toThrow(/export/);
    // Nothing of the launcher is configurable: the flags of claude are the user's own business.
    expect(() => parseCliArgs(['claude', 'T1', '--model', 'opus'])).toThrow(UsageError);
  });

  it('takes --wait for the claude command instead of an id, and only there (T27)', () => {
    expect(parseCliArgs(['claude', '--wait'])).toEqual({ command: 'claude', wait: true });
    // A runner waits for whichever task is sent from the board; it is not told one in advance.
    expect(() => parseCliArgs(['claude', '--wait', 'T1'])).toThrow(UsageError);
    expect(() => parseCliArgs(['claude', 'T1', '--wait'])).toThrow(/--wait/);
    expect(() => parseCliArgs(['--wait'])).toThrow(/claude/);
    expect(() => parseCliArgs(['handoff', 'T1', '--wait'])).toThrow(/claude/);
    expect(() => parseCliArgs(['claude', '--wait', '--port', '8080'])).toThrow(UsageError);
  });

  it('takes --recover <id> for the claude command, and --confirm-stopped only with it (T45)', () => {
    expect(parseCliArgs(['claude', '--recover', 'T37'])).toEqual({
      command: 'claude',
      id: 'T37',
      recover: true,
    });
    expect(parseCliArgs(['claude', '--recover', 'T37', '--confirm-stopped'])).toEqual({
      command: 'claude',
      id: 'T37',
      recover: true,
      confirmStopped: true,
    });
    expect(() => parseCliArgs(['claude', '--recover'])).toThrow(/id of a task/);
    expect(() => parseCliArgs(['claude', '--recover', '--wait'])).toThrow(/--recover/);
    expect(() => parseCliArgs(['claude', 'T1', '--confirm-stopped'])).toThrow(/--recover/);
    expect(() => parseCliArgs(['handoff', 'T1', '--recover'])).toThrow(/claude/);
    expect(() => parseCliArgs(['claude', '--recover', 'T1', 'T2'])).toThrow(
      'Unexpected argument: T2',
    );
  });

  it('takes --research <id> for the claude command, and --comment only with it (ADR-0029 T54)', () => {
    expect(parseCliArgs(['claude', 'T57', '--research'])).toEqual({
      command: 'claude',
      id: 'T57',
      research: true,
    });
    expect(parseCliArgs(['claude', 'T57', '--research', '--comment', 'Only the runner.'])).toEqual({
      command: 'claude',
      id: 'T57',
      research: true,
      comment: 'Only the runner.',
    });
    // A comment that looks like a flag is still the text of the comment, not an option.
    expect(parseCliArgs(['claude', 'T57', '--research', '--comment=--model opus'])).toMatchObject({
      comment: '--model opus',
    });
    expect(() => parseCliArgs(['claude', '--research'])).toThrow(/id of a task/);
    expect(() => parseCliArgs(['claude', 'T1', '--comment', 'x'])).toThrow(/--research/);
    expect(() => parseCliArgs(['handoff', 'T1', '--research'])).toThrow(/claude/);
    for (const other of ['--check', '--recover']) {
      expect(() => parseCliArgs(['claude', 'T1', '--research', other])).toThrow(UsageError);
    }
    expect(() => parseCliArgs(['claude', '--wait', '--research'])).toThrow(UsageError);
    // The form of --comment-file is not decided (ADR-0029 T54): there is no such option.
    expect(() => parseCliArgs(['claude', 'T1', '--research', '--comment-file', 'x.md'])).toThrow(
      UsageError,
    );
  });

  it('checks the comment by the rule of the route: not empty, no NUL, at most 4 000 characters', () => {
    const comment = (text: string) => () =>
      parseCliArgs(['claude', 'T1', '--research', '--comment', text]);
    expect(comment('x'.repeat(4000))).not.toThrow();
    for (const text of ['', 'x'.repeat(4001), 'a\0b']) {
      expect(comment(text)).toThrow(UsageError);
    }
  });

  it('answers --help with the usage, not with an error', () => {
    expect(parseCliArgs(['--help'])).toEqual({ command: 'help' });
    expect(parseCliArgs(['-h'])).toEqual({ command: 'help' });
  });

  it('answers --version with the version command, and the usage mentions it', () => {
    expect(parseCliArgs(['--version'])).toEqual({ command: 'version' });
    expect(USAGE).toContain('--version');
  });

  it('refuses a command it does not have', () => {
    expect(() => parseCliArgs(['serve'])).toThrow(UsageError);
    expect(() => parseCliArgs(['start'])).toThrow('Unknown command: start');
    expect(() => parseCliArgs(['export', 'extra'])).toThrow(UsageError);
  });

  it('refuses an option it does not have, and says what it does have', () => {
    // The board listens on the loopback interface only; there is no flag to change that.
    expect(() => parseCliArgs(['--host', '0.0.0.0'])).toThrow(UsageError);
    expect(() => parseCliArgs(['--host', '0.0.0.0'])).toThrow(/--host/);
    expect(() => parseCliArgs(['--open'])).toThrow(UsageError);
  });

  it('refuses an option that belongs to another command', () => {
    expect(() => parseCliArgs(['--out', 'x.json'])).toThrow(/export/);
    expect(() => parseCliArgs(['instructions', '--port', '8080'])).toThrow(UsageError);
  });

  it('describes every command it takes in the usage text', () => {
    const usage = new UsageError('x').usage;
    for (const word of [
      'local-project-board',
      'instructions',
      'handoff <id>',
      'claude <id>',
      'claude --wait',
      'claude <id> --research',
      '--comment <text>',
      'export',
      '--port',
      '--no-open',
    ]) {
      expect(usage).toContain(word);
    }
    expect(usage).not.toContain('--host');
  });
});
