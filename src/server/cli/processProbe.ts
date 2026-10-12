import { readFile, readdir, readlink, stat } from 'node:fs/promises';
import { hostname } from 'node:os';

/**
 * What this machine shows about its processes, read and nothing more (T45): no signal is sent
 * and nothing is started or stopped. Only the CLI uses it, for the person who typed the
 * command; the board server never looks at processes (ADR-0029).
 *
 * Linux shows it in `/proc`. Anywhere else every answer is "cannot tell", and the caller must
 * not read that as "not there".
 */
export interface ProcessProbe {
  platform: NodeJS.Platform;
  /** This process, which is never the one looked for. */
  ownPid: number;
  hostname(): string;
  /** Changes with every boot of the kernel; nothing survives a change of it. */
  bootId(): Promise<string | undefined>;
  /** The PID namespace this process sees; pids of another one mean nothing here. */
  pidNamespace(): Promise<string | undefined>;
  /**
   * The start time of `pid` in clock ticks since boot: with the pid it names one process, which
   * a reused pid does not have. `gone` when there is no such process (or only its zombie);
   * nothing when it cannot be read.
   */
  startOf(pid: number): Promise<string | 'gone' | undefined>;
  /**
   * The argv of every process this user can see. `unreadable` counts the processes of this user
   * whose argv could not be read: one of them might be the one looked for.
   */
  processes(): Promise<{ list: { pid: number; argv: string[] }[]; unreadable: number }>;
}

export function procProbe(): ProcessProbe {
  const linux = process.platform === 'linux';
  return {
    platform: process.platform,
    ownPid: process.pid,
    hostname: () => hostname(),
    bootId: async () =>
      linux ? (await text('/proc/sys/kernel/random/boot_id'))?.trim() || undefined : undefined,
    pidNamespace: async () => {
      if (!linux) return undefined;
      try {
        return await readlink('/proc/self/ns/pid');
      } catch {
        return undefined;
      }
    },
    startOf: async (pid) => {
      if (!linux) return undefined;
      let stats: string;
      try {
        stats = await readFile(`/proc/${pid}/stat`, 'utf8');
      } catch (error) {
        return isGone(error) ? 'gone' : undefined;
      }
      // The name in parentheses may hold spaces and parentheses; the fields follow the last ')'.
      const fields = stats.slice(stats.lastIndexOf(')') + 2).split(' ');
      const state = fields[0];
      const start = fields[19];
      if (state === 'Z' || state === 'X') return 'gone';
      return start !== undefined && /^\d+$/.test(start) ? start : undefined;
    },
    processes: async () => {
      if (!linux) return { list: [], unreadable: 0 };
      const uid = process.getuid?.();
      const list: { pid: number; argv: string[] }[] = [];
      let unreadable = 0;
      for (const name of await readdir('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        const pid = Number(name);
        try {
          const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
          if (argv.at(-1) === '') argv.pop();
          // A kernel thread, or a process that is exiting: no argv to hold a session.
          if (argv.length > 0) list.push({ pid, argv });
        } catch (error) {
          if (isGone(error)) continue;
          // Another user's process is not this user's session of Claude Code; ours might be.
          const owner = await stat(`/proc/${pid}`).then(
            (info) => info.uid,
            () => undefined,
          );
          // A process whose owner cannot be read has exited meanwhile.
          if (owner !== undefined && (uid === undefined || owner === uid)) unreadable += 1;
        }
      }
      return { list, unreadable };
    },
  };
}

function isGone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ESRCH';
}

async function text(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Who this process is, as a journal records it: enough to find it again, or know it is gone. */
export async function identify(
  probe: ProcessProbe,
  pid: number,
): Promise<{ pid: number; start?: string }> {
  const start = await probe.startOf(pid);
  return start === undefined || start === 'gone' ? { pid } : { pid, start };
}
