import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { ConsoleEvent } from '../../../contract/v1/console.js';
import { exitCodeOf, spawnConsoleSession } from '../spawnSession.js';
import { logRunner, type RunnerLogEntry } from '../runnerLog.js';
import { createCompatProbe, type CompatResult } from './compat.js';
import { initialNormalizerState, normalize, normalizeLine } from './normalize.js';
import { sanitizeStderr, truncateText } from './sanitize.js';
import { createSpool } from './spool.js';
import { createLineSplitter, parseLine, serializeUserMessage } from './streamJson.js';
import { createUploader } from './uploader.js';

/** How often the probe is asked whether its time has run out (its timeouts are 15 s and 120 s). */
const PROBE_TICK_MS = 1_000;
/** How long the spool is given to reach the board after the process ended (as the end's retry). */
const DRAIN_MS = 30_000;
/** The longest `user.message` of the contract. */
const MESSAGE_MAX = 4_000;

/**
 * The arguments of `claude` in Console mode (plan §2, §8): stream-json both ways, the replay of
 * what was written to stdin, no permission prompts (nobody could answer them) and the session.
 * The prompt is not here: it goes to stdin. Nothing else of the user's own settings is touched.
 */
export function consoleArgv(
  sessionId: string,
  options: { resume?: boolean; model?: string },
): string[] {
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--replay-user-messages',
    '--permission-prompts',
    'none',
    ...(options.model === undefined ? [] : ['--model', options.model]),
    options.resume === true ? '--resume' : '--session-id',
    sessionId,
  ];
}

export interface ConsoleRun {
  root: string;
  taskId: string;
  runId: number;
  sessionId: string;
  /** What the first message to Claude says; it goes to stdin and into the journal, never argv. */
  prompt: string;
  /** Where the cursor of the board stood; 0 for a new run. */
  ackedRunnerSeq: number;
}

export interface ConsoleHooks {
  /** `claude` was spawned with this pid; awaited before the end is recorded. */
  onSpawn: (pid: number) => Promise<void>;
  /** The board confirmed the events up to here: written into the journal of the run. */
  onAcked: (ackedRunnerSeq: number) => Promise<void>;
  /** How it ended: written down and delivered, once the spool has been sent. */
  onEnd: (input: { exitCode?: number; launchError?: string }) => Promise<void>;
}

/** What the person is told at the first Ctrl+C; it promises nothing that was not proved (§8.4). */
export const FIRST_INTERRUPT_TEXT =
  'Ctrl+C: input to the session is closed. Claude Code may have received Ctrl+C itself and ' +
  'stopped. If not, the session ends after its current work. Press Ctrl+C again to stop it now.';

type ConsoleNote = Extract<RunnerLogEntry, { event: 'console' }>['what'];

/**
 * Runs one session of Claude Code in Console mode and resolves to the code it ended with (plan
 * C8). Everything the process says is normalized (C4) into events, kept in the spool and sent to
 * the console journal of the board (C7); whether `claude` speaks the protocol this needs is
 * decided by the probe (C6). The order at the end is fixed: `process.exited` → the spool is sent
 * → the end of the run (`hooks.onEnd`), which matters more than the tape and is sent whatever
 * became of it.
 *
 * Signals (§8.4): the first SIGINT closes stdin, the second kills the process; SIGTERM and
 * SIGHUP are passed on, as in `spawnSession`; and a runner that exits with `claude` alive kills it
 * synchronously. Nothing here reads a message of the board or writes to stdin after the prompt:
 * that is the inbox (C10, C11).
 */
export async function runConsoleSession(
  program: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  run: ConsoleRun,
  hooks: ConsoleHooks,
): Promise<number> {
  const { root, taskId, runId, sessionId } = run;
  const note = (what: ConsoleNote, detail?: string): void => {
    void logRunner(root, {
      event: 'console',
      taskId,
      runId,
      what,
      ...(detail === undefined ? {} : { detail }),
    });
  };

  const spool = createSpool({ root, taskId, runId, acked: run.ackedRunnerSeq });
  const uploader = createUploader({
    root,
    taskId,
    runId,
    sessionId,
    spool,
    onAcked: hooks.onAcked,
    onConnection: note,
  });
  const emit = (...events: ConsoleEvent[]): void => {
    spool.append(events);
    uploader.notify();
  };

  const promptUuid = randomUUID();
  const prompt = truncateText(run.prompt, MESSAGE_MAX);
  emit({ kind: 'user.message', origin: 'prompt', messageId: promptUuid, text: prompt });

  let normalizer = initialNormalizerState();
  let compat: 'probing' | 'passed' | 'failed' = 'probing';
  let closing = false;
  let killing = false;

  const probe = createCompatProbe({ sessionId, promptUuid, now: Date.now });
  const splitter = createLineSplitter();
  const stderrDecoder = new StringDecoder('utf8');
  let stderrTail = '';

  const close = (reason: 'incompatible' | 'signal'): void => {
    if (closing) return;
    closing = true;
    emit({ kind: 'close.requested', reason });
    note('close', reason);
    proc.closeStdin();
  };

  const settleCompat = (result: CompatResult): void => {
    if (compat !== 'probing' || result.status === 'probing') return;
    compat = result.status;
    if (result.status === 'passed') {
      emit({ kind: 'compat.passed' });
      note('compat', 'passed');
      return;
    }
    const reason = result.reason ?? 'unknown';
    emit({ kind: 'compat.failed', reason });
    note('compat', reason);
    close('incompatible');
  };

  const onLine = (line: string): void => {
    if (line.trim() === '') return;
    const parsed = parseLine(line);
    const result = compat === 'probing' && parsed.ok ? probe.observe(parsed.message) : undefined;
    const out = parsed.ok ? normalize(normalizer, parsed.message) : normalizeLine(normalizer, line);
    normalizer = out.state;
    emit(...out.events);
    if (result !== undefined) settleCompat(result);
  };

  // stderr is a warning of Claude Code, never the assistant's text; it is cleaned of terminal codes.
  const emitStderr = (text: string): void => {
    const clean = sanitizeStderr(text);
    if (clean.trim() !== '') emit({ kind: 'runner.stderr', text: clean });
  };

  const proc = spawnConsoleSession(program, args, cwd, env, {
    onStdout: (chunk) => splitter.push(chunk).forEach(onLine),
    onStderr: (chunk) => {
      const text = stderrTail + stderrDecoder.write(chunk);
      const cut = text.lastIndexOf('\n');
      stderrTail = text.slice(cut + 1);
      if (cut >= 0) emitStderr(text.slice(0, cut + 1));
    },
  });

  // The last line of defence against an orphan on POSIX: this runner exits, `claude` must not
  // outlive it. (On Windows the job object does that, T16.)
  const onExit = (): void => proc.kill();
  process.on('exit', onExit);
  let interrupts = 0;
  const onInterrupt = (): void => {
    interrupts += 1;
    if (interrupts === 1) {
      close('signal');
      process.stderr.write(`${FIRST_INTERRUPT_TEXT}\n`);
      return;
    }
    if (killing) return;
    killing = true;
    emit({ kind: 'kill.requested', reason: 'signal' });
    note('kill', 'signal');
    proc.kill();
  };
  const passedOn = (['SIGTERM', 'SIGHUP'] as const).map((signal) => {
    const forward = (): void => proc.kill(signal);
    process.on(signal, forward);
    return [signal, forward] as const;
  });
  process.on('SIGINT', onInterrupt);

  let recorded: Promise<void> = Promise.resolve();
  let ticker: NodeJS.Timeout | undefined;
  const pid = await proc.spawned;
  if (pid !== undefined) {
    emit({ kind: 'process.started', pid });
    recorded = hooks.onSpawn(pid).catch(() => undefined);
    // The probe counts its timeouts from the start of the process and the prompt.
    proc.writeLine(serializeUserMessage({ uuid: promptUuid, text: prompt }));
    ticker = setInterval(() => {
      if (compat === 'probing') settleCompat(probe.tick());
    }, PROBE_TICK_MS);
  }

  const exit = await proc.exited;
  if (ticker !== undefined) clearInterval(ticker);
  process.off('SIGINT', onInterrupt);
  for (const [signal, forward] of passedOn) process.off(signal, forward);
  process.off('exit', onExit);

  if (exit.launchError === undefined) {
    for (const line of splitter.end()) onLine(line);
    const rest = stderrTail + stderrDecoder.end();
    if (rest !== '') emitStderr(rest);
    emit({
      kind: 'process.exited',
      exitCode: exit.exitCode,
      signal: exit.signal,
      lastTurnOpen: normalizer.turnOpen,
    });
    note('exited', exit.signal ?? String(exit.exitCode));
  }

  // First the tape, then the end: the end matters more, so a board that stays away does not hold
  // it back for good. What was not sent stays in the spool, on the disk (§9.2, §9.5).
  const delivered = await uploader.drain(DRAIN_MS);
  uploader.stop();
  if (delivered) spool.finish();
  else note('spool-left');

  const code = exitCodeOf(exit);
  await recorded;
  await hooks
    .onEnd(exit.launchError === undefined ? { exitCode: code } : { launchError: exit.launchError })
    .catch(() => undefined);
  return code;
}
