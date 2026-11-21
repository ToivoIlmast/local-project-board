import { EventEmitter } from 'node:events';
import { FORWARDED, runChild, signalExitCode } from '../../scripts/run-child.mjs';

/**
 * A child of the local checks never outlives the command that started it
 * (scripts/run-child.mjs). The child and this process are stubs: no process is started and no
 * real signal is sent.
 */

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed: string[] = [];
  kill(signal: NodeJS.Signals): boolean {
    this.killed.push(signal);
    return true;
  }
  end(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

function setup() {
  const child = new FakeChild();
  const proc = new EventEmitter();
  const exits: number[] = [];
  const spawned: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
  const deps = {
    spawn: ((command: string, args: string[], options: Record<string, unknown>) => {
      spawned.push({ command, args, options });
      return child;
    }) as never,
    process: proc as never,
    exit: (code: number) => {
      exits.push(code);
    },
  };
  return { child, proc, exits, spawned, deps };
}

const listening = (proc: EventEmitter) => FORWARDED.map((signal) => proc.listenerCount(signal));

describe('runChild', () => {
  it('runs the command with this terminal and no shell, and resolves to its exit code', async () => {
    const { child, proc, spawned, deps } = setup();
    const done = runChild('node', ['a.js'], { cwd: '/repo' }, deps);
    expect(spawned).toEqual([
      {
        command: 'node',
        args: ['a.js'],
        options: { cwd: '/repo', stdio: 'inherit', shell: false },
      },
    ]);
    expect(listening(proc)).toEqual([1, 1, 1]);
    child.end(2);
    await expect(done).resolves.toBe(2);
    expect(listening(proc)).toEqual([0, 0, 0]);
  });

  it('a child ended by a signal of its own resolves to 128 + the signal', async () => {
    const { child, deps } = setup();
    const done = runChild('node', [], { cwd: '/repo' }, deps);
    child.end(null, 'SIGKILL');
    await expect(done).resolves.toBe(signalExitCode('SIGKILL'));
  });

  it.each(FORWARDED)(
    '%s is passed on, and this process ends only after the child has ended',
    async (signal) => {
      const { child, proc, exits, deps } = setup();
      const done = runChild('node', [], { cwd: '/repo' }, deps);
      proc.emit(signal);
      expect(child.killed).toEqual([signal]);
      expect(exits).toEqual([]);
      child.end(null, signal);
      await expect(done).resolves.toBe(signalExitCode(signal));
      expect(exits).toEqual([signalExitCode(signal)]);
      expect(listening(proc)).toEqual([0, 0, 0]);
    },
  );

  it('a child that already ended is not signalled again', async () => {
    const { child, proc, deps } = setup();
    const done = runChild('node', [], { cwd: '/repo' }, deps);
    child.exitCode = 130; // ended, its exit event still to come
    proc.emit('SIGINT');
    expect(child.killed).toEqual([]);
    child.end(130);
    await done;
  });

  it('a start that fails rejects, and leaves no listener behind', async () => {
    const { child, proc, deps } = setup();
    const done = runChild('missing', [], { cwd: '/repo' }, deps);
    child.emit('error', new Error('spawn missing ENOENT'));
    await expect(done).rejects.toThrow('ENOENT');
    expect(listening(proc)).toEqual([0, 0, 0]);
  });
});
