import { readFile, readdir, realpath, stat, watch } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * How the board directory is watched. `events` is `fs.watch`; `poll` compares what is on disk
 * every few seconds, for filesystems where `fs.watch` is silent: on the Windows drives of WSL2
 * (9p, `/mnt/c`) it reports nothing at all, not even a change made from Linux, and raises no
 * error either (T10, measured).
 */
export type WatchStrategy = 'events' | 'poll';

/** Filesystems where `fs.watch` delivers no events. Only what was measured is listed. */
const SILENT_FILESYSTEMS = new Set(['9p', 'drvfs']);

const POLL_INTERVAL_MS = 2000;

export interface WatchOptions {
  /** See `detectWatchStrategy`. */
  strategy: WatchStrategy;
  intervalMs?: number | undefined;
}

/**
 * Process state of a running board, not board data: `runtime.json` (pid, port, token), the
 * temp file it is written through, and the runner journal. Writing them is not a change of the
 * board, so it must not make every open page reread it.
 */
export function isRuntimeFile(filename: string | null): boolean {
  if (filename === null) return false;
  const parts = filename.split(/[\\/]/);
  if (parts[0] === 'runner') return true;
  return (
    parts.length === 1 && (parts[0] === 'runtime.json' || /^\.[0-9a-f]{12}\.tmp$/.test(parts[0]!))
  );
}

/**
 * Calls `onChange` (debounced) when something in `boardDir` changes. Best effort: live updates
 * only, never correctness (ADR-0019). Watching has begun when this returns, so a change made
 * right after it is not missed.
 */
export function watchBoard(
  boardDir: string,
  onChange: () => void,
  options: WatchOptions,
): AbortController {
  const controller = new AbortController();
  if (options.strategy === 'poll') {
    poll(boardDir, onChange, options.intervalMs ?? POLL_INTERVAL_MS, controller.signal);
  } else {
    void watchEvents(boardDir, onChange, controller.signal);
  }
  return controller;
}

/** The strategy for a path, given the text of `/proc/mounts`: the innermost mount decides. */
export function watchStrategyFor(path: string, mounts: string): WatchStrategy {
  let best: { point: string; type: string } | undefined;
  for (const line of mounts.split('\n')) {
    const fields = line.split(' ');
    if (fields.length < 3) continue;
    const point = unescapeMount(fields[1]!);
    const type = fields[2]!;
    const inside = point === '/' || path === point || path.startsWith(`${point}/`);
    if (inside && (best === undefined || point.length >= best.point.length)) best = { point, type };
  }
  return best !== undefined && SILENT_FILESYSTEMS.has(best.type) ? 'poll' : 'events';
}

/** `/proc/mounts` writes a space as `\040` (and a tab, newline and backslash likewise). */
function unescapeMount(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(parseInt(octal, 8)),
  );
}

/** `poll` when the board directory is on a filesystem where `fs.watch` is silent. */
export async function detectWatchStrategy(boardDir: string): Promise<WatchStrategy> {
  // Only Linux has /proc/mounts; macOS and Windows watch natively.
  if (process.platform !== 'linux') return 'events';
  try {
    const [path, mounts] = await Promise.all([
      realpath(boardDir),
      readFile('/proc/mounts', 'utf8'),
    ]);
    return watchStrategyFor(path, mounts);
  } catch {
    return 'events';
  }
}

async function watchEvents(
  boardDir: string,
  onChange: () => void,
  signal: AbortSignal,
): Promise<void> {
  try {
    let pending: NodeJS.Timeout | undefined;
    for await (const event of watch(boardDir, { recursive: true, signal })) {
      if (isRuntimeFile(event.filename)) continue;
      if (pending) clearTimeout(pending);
      // Several writes arrive as several events; one refresh is enough.
      pending = setTimeout(onChange, 50);
      pending.unref();
    }
  } catch {
    // Watching is best-effort (ADR-0019).
  }
}

function poll(boardDir: string, onChange: () => void, intervalMs: number, signal: AbortSignal) {
  let last: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  const tick = async (): Promise<void> => {
    const now = await snapshot(boardDir).catch(() => '');
    if (signal.aborted) return;
    if (last !== undefined && now !== last) onChange();
    last = now;
    // The next scan is counted from the end of this one, so slow disks are never scanned twice
    // at once.
    timer = setTimeout(() => void tick(), intervalMs);
    timer.unref();
  };
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  void tick();
}

/** Every board file with its size and mtime, runtime files left out. Stats run in parallel:
 * on 9p one at a time is several times slower. */
async function snapshot(dir: string, prefix = ''): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  const parts = await Promise.all(
    entries.map(async (entry) => {
      const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (isRuntimeFile(name)) return '';
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return `${name}/\n${await snapshot(path, name).catch(() => '')}`;
      const info = await stat(path).catch(() => undefined);
      return info === undefined ? '' : `${name} ${info.size} ${info.mtimeMs}\n`;
    }),
  );
  return parts.sort().join('');
}
