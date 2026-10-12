import type { ProcessProbe } from '../../src/server/cli/processProbe.js';
import { holdsSession, inspectRun } from '../../src/server/cli/recover.js';
import type { RunJournal } from '../../src/server/cli/runJournal.js';

/**
 * What `claude --recover` concludes from what this machine shows (T45). Only proof makes a run
 * `lost`; anything the probe cannot see makes it `unknown`, and never the age of the run.
 */

const SESSION = '3d0f71eb-97a5-476d-8ea4-e7b3eb0c5bfc';

interface FakeMachine {
  platform?: NodeJS.Platform;
  host?: string;
  bootId?: string | undefined;
  pidNamespace?: string | undefined;
  /** pid → start time; absent means gone; `undefined` means unreadable. */
  starts?: Record<number, string | undefined>;
  processes?: { pid: number; argv: string[] }[];
  unreadable?: number;
}

function probe(machine: FakeMachine = {}): ProcessProbe {
  const starts = machine.starts ?? {};
  return {
    platform: machine.platform ?? 'linux',
    ownPid: 1,
    hostname: () => machine.host ?? 'box',
    bootId: () => Promise.resolve('bootId' in machine ? machine.bootId : 'boot-1'),
    pidNamespace: () =>
      Promise.resolve('pidNamespace' in machine ? machine.pidNamespace : 'pid:[1]'),
    startOf: (pid) => Promise.resolve(pid in starts ? starts[pid] : 'gone'),
    processes: () =>
      Promise.resolve({ list: machine.processes ?? [], unreadable: machine.unreadable ?? 0 }),
  };
}

function journal(extra: Partial<RunJournal> = {}): RunJournal {
  return {
    formatVersion: 1,
    taskId: 'T1',
    runId: 1,
    sessionId: SESSION,
    host: 'box',
    platform: 'linux',
    bootId: 'boot-1',
    pidNamespace: 'pid:[1]',
    runner: { pid: 100, start: '5000' },
    child: { pid: 101, start: '5001' },
    ...extra,
  };
}

const run = { sessionId: SESSION };

describe('holdsSession: the forms of the Claude CLI, not a substring (T45)', () => {
  it.each([
    [['--session-id', SESSION, 'prompt']],
    [[`--session-id=${SESSION}`]],
    [['--model', 'opus', '--resume', SESSION, 'go on']],
    [[`--resume=${SESSION}`]],
    [['-r', SESSION]],
  ])('%j holds the session', (argv) => {
    expect(holdsSession(argv, SESSION)).toBe(true);
  });

  it.each([
    [['grep', SESSION]],
    [['bash', '-c', `grep -l ${SESSION} /proc/*/cmdline`]],
    [['--session-id', `${SESSION}-x`]],
    [[`--session-id=${SESSION}x`]],
    [['--resume']],
    [['echo', `--resume ${SESSION}`]],
  ])('%j does not (INVARIANT: no substring match)', (argv) => {
    // Mutation: argv.join(' ').includes(sessionId) → these are alive → fails.
    expect(holdsSession(argv, SESSION)).toBe(false);
  });
});

describe('inspectRun (T45)', () => {
  it('a process that holds the session is alive, journal or not', async () => {
    const machine = probe({ processes: [{ pid: 7, argv: ['claude', '--resume', SESSION] }] });
    expect((await inspectRun(run, undefined, machine)).kind).toBe('alive');
    expect((await inspectRun(run, journal(), machine)).kind).toBe('alive');
  });

  it('the recorded claude, same pid and same start, is alive (INVARIANT)', async () => {
    const verdict = await inspectRun(run, journal(), probe({ starts: { 101: '5001' } }));
    expect(verdict.kind).toBe('alive');
    expect(verdict.reasons.join(' ')).toContain('101');
  });

  it('the recorded runner, same pid and same start, is alive: it may still deliver end', async () => {
    expect((await inspectRun(run, journal(), probe({ starts: { 100: '5000' } }))).kind).toBe(
      'alive',
    );
  });

  it('both recorded processes gone, nothing holds the session: lost (INVARIANT)', async () => {
    const verdict = await inspectRun(run, journal(), probe());
    expect(verdict.kind).toBe('lost');
  });

  it('a reused pid (same pid, another start time) is not the recorded process: lost (INVARIANT)', async () => {
    // Mutation: compare only pids → the stranger counts as claude → alive → fails.
    const verdict = await inspectRun(run, journal(), probe({ starts: { 100: '9', 101: '9' } }));
    expect(verdict.kind).toBe('lost');
  });

  it('a machine that started again since the run began: lost, whatever pids exist now', async () => {
    const verdict = await inspectRun(
      run,
      journal(),
      probe({ bootId: 'boot-2', starts: { 101: '5001' } }),
    );
    expect(verdict.kind).toBe('lost');
  });

  describe('is unknown, never lost, when the machine cannot show it (INVARIANT)', () => {
    // Mutation: treat any of these as lost → fails.
    it.each<[string, FakeMachine, RunJournal | undefined]>([
      ['another OS', { platform: 'darwin' }, journal()],
      ['Windows', { platform: 'win32' }, journal()],
      ['no /proc', { bootId: undefined, pidNamespace: undefined }, journal()],
      ['no journal of the run', {}, undefined],
      ['a journal of another host', { host: 'other' }, journal()],
      ['another PID namespace', { pidNamespace: 'pid:[2]' }, journal()],
      ['an unreadable start time of claude', { starts: { 101: undefined } }, journal()],
      ['processes of this user that could not be read', { unreadable: 1 }, journal()],
      ['claude never recorded (runner died at spawn)', {}, journal({ child: undefined })],
      [
        'a journal of another session',
        {},
        journal({ sessionId: '00000000-0000-4000-8000-000000000000' }),
      ],
    ])('%s', async (_name, machine, record) => {
      const verdict = await inspectRun(run, record, probe(machine));
      expect(verdict.kind).toBe('unknown');
      expect(verdict.reasons.length).toBeGreaterThan(0);
    });
  });

  it('does not look at the age of the run: its inputs have no time in them (INVARIANT)', async () => {
    // The same machine gives the same verdict for a run begun a second or a year ago: the run
    // passed in carries only its session, and the journal no start date.
    const old = { sessionId: SESSION, startedAt: '2020-01-01T00:00:00.000Z' };
    const fresh = { sessionId: SESSION, startedAt: new Date().toISOString() };
    for (const machine of [
      probe(),
      probe({ starts: { 101: '5001' } }),
      probe({ platform: 'darwin' }),
    ]) {
      expect(await inspectRun(old, journal(), machine)).toEqual(
        await inspectRun(fresh, journal(), machine),
      );
    }
  });
});
