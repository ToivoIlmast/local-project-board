import type { ConsoleEntry, ConsoleReadResponse } from '../../../../contract/v1/index';
import { taskT } from '../i18n/details';

/**
 * The console of a run as the person reads it (plan C9, §10): the journal's entries grouped into
 * the things they are about — a message of Claude by its `apiMessageId`, a tool call with its
 * result by `toolUseId`, what a subagent did by `scope` inside the card of its `Agent` call — and
 * the series of the same event folded into one line. Pure. The state of the session is not
 * computed here: the board sends the one `foldConsole` made, and the page only words it.
 */

export type ConsoleState = ConsoleReadResponse['state'];
export type ConsoleMessageStatus = ConsoleState['messages'][number]['status'];

interface Placed {
  /** Stable while the journal grows: the `seq` of the first event of the item. */
  key: string;
  seq: number;
}

export type ConsoleItem =
  | (Placed & {
      kind: 'user';
      messageId: string;
      text: string;
      status: ConsoleMessageStatus | undefined;
      /** Taken into a new turn, or poured into the one that was running (plan §5, E). */
      join: 'new-turn' | 'joined-turn' | undefined;
      /** Present when the message went into a turn together with others (the bracket). */
      bracket: { size: number; index: number } | undefined;
    })
  | (Placed & { kind: 'assistant'; apiMessageId: string; text: string })
  | (Placed & {
      kind: 'tool';
      toolUseId: string;
      /** Missing when the journal has the result of a call and not the call. */
      tool: string | undefined;
      summary: string | undefined;
      result: { isError: boolean; preview: string } | undefined;
      /** What a subagent did, when this is its `Agent` call. */
      children: ConsoleItem[];
    })
  | (Placed & { kind: 'job'; jobId: string; description: string; ended: boolean })
  | (Placed & { kind: 'turn'; turn: number; isError: boolean; durationMs: number | undefined })
  | (Placed & {
      kind: 'notice';
      level: 'info' | 'warning' | 'error';
      code: 'rate_limit' | 'api_retry' | 'events_missing' | 'protocol_malformed';
      text: string | undefined;
      /** What the code names, outside the language: a range of numbers, a type and a field. */
      detail: string | undefined;
      count: number;
    })
  | (Placed & { kind: 'series'; what: 'stderr' | 'unknown'; count: number })
  | (Placed & { kind: 'denied'; tool: string; message: string })
  | (Placed & {
      kind: 'process';
      what: 'exited' | 'close' | 'kill' | 'incompatible';
      exitCode: number | null | undefined;
      signal: string | null | undefined;
      reason: string | undefined;
    });

type ItemOf<K extends ConsoleItem['kind']> = Extract<ConsoleItem, { kind: K }>;

/** An item with the scope of the events it came from, before the subagents are put in their cards. */
interface Scoped {
  item: ConsoleItem;
  scope: string | null;
}

export function buildConsoleItems(
  entries: readonly ConsoleEntry[],
  state: ConsoleState,
): ConsoleItem[] {
  const messages = new Map(state.messages.map((message) => [message.messageId, message]));
  const made: Scoped[] = [];
  const messagesOfClaude = new Map<string, ItemOf<'assistant'>>();
  const tools = new Map<string, ItemOf<'tool'>>();
  const jobs = new Map<string, ItemOf<'job'>>();

  const add = <T extends ConsoleItem>(item: T, scope: string | null = null): T => {
    made.push({ item, scope });
    return item;
  };
  const at = (seq: number) => ({ key: String(seq), seq });
  const last = (): ConsoleItem | undefined => made[made.length - 1]?.item;

  for (const { seq, event } of entries) {
    switch (event.kind) {
      case 'user.message': {
        const message = messages.get(event.messageId);
        const together = message?.join?.together ?? [];
        add({
          ...at(seq),
          kind: 'user',
          messageId: event.messageId,
          text: event.text,
          status: message?.status,
          join: message?.join?.how,
          bracket:
            together.length > 1
              ? { size: together.length, index: together.indexOf(event.messageId) + 1 }
              : undefined,
        });
        break;
      }
      case 'assistant.text': {
        if (event.text.trim() === '') break;
        const id = `${event.scope ?? ''}\0${event.apiMessageId}`;
        const known = messagesOfClaude.get(id);
        if (known !== undefined) {
          known.text = `${known.text}\n\n${event.text}`;
          break;
        }
        messagesOfClaude.set(
          id,
          add(
            { ...at(seq), kind: 'assistant', apiMessageId: event.apiMessageId, text: event.text },
            event.scope,
          ),
        );
        break;
      }
      case 'tool.call': {
        const known = tools.get(event.toolUseId);
        if (known !== undefined && known.tool === undefined) {
          // The result came first: the call fills in what it left empty.
          known.tool = event.tool;
          known.summary = event.summary;
          break;
        }
        tools.set(
          event.toolUseId,
          add(
            {
              ...at(seq),
              kind: 'tool',
              toolUseId: event.toolUseId,
              tool: event.tool,
              summary: event.summary,
              result: undefined,
              children: [],
            },
            event.scope,
          ),
        );
        break;
      }
      case 'tool.result': {
        const result = { isError: event.isError, preview: event.preview };
        const known = tools.get(event.toolUseId);
        if (known !== undefined) {
          known.result = result;
          break;
        }
        tools.set(
          event.toolUseId,
          add(
            {
              ...at(seq),
              kind: 'tool',
              toolUseId: event.toolUseId,
              tool: undefined,
              summary: undefined,
              result,
              children: [],
            },
            event.scope,
          ),
        );
        break;
      }
      case 'job.started':
        jobs.set(
          event.jobId,
          add({
            ...at(seq),
            kind: 'job',
            jobId: event.jobId,
            description: event.description,
            ended: false,
          }),
        );
        break;
      case 'job.progress':
      case 'job.updated':
      case 'job.notified':
      case 'job.ended': {
        let job = jobs.get(event.jobId);
        if (job === undefined) {
          job = add({ ...at(seq), kind: 'job', jobId: event.jobId, description: '', ended: false });
          jobs.set(event.jobId, job);
        }
        if (event.kind === 'job.progress') job.description = event.description;
        if (event.kind === 'job.notified' && event.summary !== undefined) {
          job.description = event.summary;
        }
        // Only "completed" is known to end a job (plan §4.4); another status is just shown as is.
        if (
          event.kind === 'job.ended' ||
          (event.kind === 'job.updated' && event.status === 'completed')
        ) {
          job.ended = true;
        }
        break;
      }
      case 'permission.denied':
        add({ ...at(seq), kind: 'denied', tool: event.tool, message: event.message });
        break;
      case 'turn.ended':
        add({
          ...at(seq),
          kind: 'turn',
          turn: event.turn,
          isError: event.isError,
          durationMs: event.durationMs,
        });
        break;
      case 'notice': {
        const before = last();
        if (
          before?.kind === 'notice' &&
          before.code === event.code &&
          before.level === event.level
        ) {
          before.count += 1;
          before.text = event.text ?? before.text;
          break;
        }
        add({
          ...at(seq),
          kind: 'notice',
          level: event.level,
          code: event.code,
          text: event.text,
          detail:
            event.code === 'events_missing'
              ? `${event.fromRunnerSeq}–${event.toRunnerSeq}`
              : event.code === 'protocol_malformed'
                ? [event.type, event.field].filter((part) => part !== undefined).join('.')
                : undefined,
          count: 1,
        });
        break;
      }
      case 'runner.stderr':
      case 'protocol.unknown': {
        const what = event.kind === 'runner.stderr' ? 'stderr' : 'unknown';
        const before = last();
        if (before?.kind === 'series' && before.what === what) before.count += 1;
        else add({ ...at(seq), kind: 'series', what, count: 1 });
        break;
      }
      case 'process.exited':
        add({
          ...at(seq),
          kind: 'process',
          what: 'exited',
          exitCode: event.exitCode,
          signal: event.signal,
          reason: undefined,
        });
        break;
      case 'compat.failed':
        add({
          ...at(seq),
          kind: 'process',
          what: 'incompatible',
          exitCode: undefined,
          signal: undefined,
          reason: event.reason,
        });
        break;
      case 'close.requested':
      case 'kill.requested':
        add({
          ...at(seq),
          kind: 'process',
          what: event.kind === 'close.requested' ? 'close' : 'kill',
          exitCode: undefined,
          signal: undefined,
          reason: undefined,
        });
        break;
      default:
        // Turn starts, the lifecycle of messages (the state has it), the probe that passed, the
        // session info and the set of background jobs: the state says them, the feed does not.
        break;
    }
  }

  return place(made, tools);
}

/**
 * Puts each item where it belongs: at top level, or inside the `Agent` card its scope names, in
 * the order the events came, whenever they came — also after the turn ended. A scope the journal
 * has no call for, or one that would put a card inside itself, stays at top level.
 */
function place(made: readonly Scoped[], tools: ReadonlyMap<string, ItemOf<'tool'>>): ConsoleItem[] {
  const top: ConsoleItem[] = [];
  const parent = new Map<ConsoleItem, ItemOf<'tool'>>();
  for (const { item, scope } of made) {
    const card = scope === null ? undefined : tools.get(scope);
    let inside = card !== undefined;
    for (let up: ItemOf<'tool'> | undefined = card; up !== undefined; up = parent.get(up)) {
      if (up === item) inside = false;
    }
    if (card !== undefined && inside) {
      card.children.push(item);
      parent.set(item, card);
    } else top.push(item);
  }
  return top;
}

/** The word under a message of the person: where it went, when it was not simply a new turn. */
export function userNote(item: ItemOf<'user'>): string | undefined {
  if (item.join === 'joined-turn') return taskT('console.user.joined');
  if (item.bracket !== undefined) {
    return taskT('console.user.together', { index: item.bracket.index, size: item.bracket.size });
  }
  return undefined;
}

/** What the message is doing, in words; nothing before the board has said. */
export function messageStatusText(status: ConsoleMessageStatus | undefined): string | undefined {
  return status === undefined ? undefined : taskT(`console.msg.${status}`);
}

export type StatusTone = 'busy' | 'quiet' | 'ended' | 'failed';

/**
 * The status bar: the phase the board computed (plan §5.2), in words. Whether Claude waits for the
 * person is not one of them — the protocol does not say it — so the bar never says it.
 */
export function consoleStatus(state: ConsoleState): { text: string; tone: StatusTone } {
  const phase = state.phase;
  const tone: StatusTone =
    phase === 'failed'
      ? 'failed'
      : phase === 'ended'
        ? 'ended'
        : phase === 'idle'
          ? 'quiet'
          : 'busy';
  return { text: taskT(`console.phase.${phase}`), tone };
}

export function processText(item: ItemOf<'process'>): string {
  switch (item.what) {
    case 'close':
      return taskT('console.process.close');
    case 'kill':
      return taskT('console.process.kill');
    case 'incompatible':
      return taskT('console.process.incompatible', { reason: item.reason ?? '' });
    case 'exited':
      return item.signal !== null && item.signal !== undefined
        ? taskT('console.process.signal', { signal: item.signal })
        : taskT('console.process.exited', { code: item.exitCode ?? '?' });
  }
}

export function turnText(item: ItemOf<'turn'>): string {
  const base = taskT(item.isError ? 'console.turn.error' : 'console.turn.done', {
    turn: item.turn,
  });
  return item.durationMs === undefined
    ? base
    : `${base} · ${taskT('console.turn.time', { seconds: (item.durationMs / 1000).toFixed(1) })}`;
}
