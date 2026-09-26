import { parseCliArgs, UsageError } from '../../src/server/cli/args.js';

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

  it('answers --help with the usage, not with an error', () => {
    expect(parseCliArgs(['--help'])).toEqual({ command: 'help' });
    expect(parseCliArgs(['-h'])).toEqual({ command: 'help' });
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
      'export',
      '--port',
      '--no-open',
    ]) {
      expect(usage).toContain(word);
    }
    expect(usage).not.toContain('--host');
  });
});
