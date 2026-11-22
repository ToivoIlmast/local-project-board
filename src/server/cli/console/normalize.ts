import type { ConsoleEvent } from '../../../contract/v1/console.js';
import { parseLine } from './streamJson.js';
import { summarizeToolInput, truncateText } from './sanitize.js';

/**
 * Normalizer of Claude Code's stream-json output into Board's console events (plan C4, §4).
 * `normalize(state, message) → {state, events, dropped?}` is pure: the state is never changed, a
 * new one is returned. Input is read leniently (only the needed fields), output is strict: an
 * event that could not pass `consoleEventSchema` is not produced, a `protocol_malformed` notice
 * is (once per type and field) instead.
 */

const KB = 1024;
const UUID_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|0{8}-0{4}-0{4}-0{4}-0{12}|f{8}-f{4}-f{4}-f{4}-f{12})$/i;

export interface NormalizerState {
  /** Number of the last turn opened by `system/init`; 0 before the first one. */
  readonly turn: number;
  readonly turnOpen: boolean;
  /** The model of the last `turn.started` that carried one. */
  readonly model: string | undefined;
  /** `type` or `type/subtype` pairs already reported as `protocol.unknown`. */
  readonly unknownSeen: ReadonlySet<string>;
  /** `type/field` pairs already reported as `protocol_malformed`. */
  readonly malformedSeen: ReadonlySet<string>;
  /** Jobs that already got `job.ended`. */
  readonly endedJobs: ReadonlySet<string>;
  /** The last progress of each job (`description`, `lastTool`), to skip repeats. */
  readonly lastProgress: ReadonlyMap<string, string>;
}

export interface NormalizeResult {
  readonly state: NormalizerState;
  readonly events: ConsoleEvent[];
  /** Set when the input gave no event by design: why (an input is shown or listed here). */
  readonly dropped?: string;
}

export function initialNormalizerState(): NormalizerState {
  return {
    turn: 0,
    turnOpen: false,
    model: undefined,
    unknownSeen: new Set(),
    malformedSeen: new Set(),
    endedJobs: new Set(),
    lastProgress: new Map(),
  };
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const noNul = (text: string) => text.replace(/\0/g, '');

/** A non-empty string of 1..200 characters, or undefined (contract `id`). */
function idOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200 ? value : undefined;
}

const uuidOf = (value: unknown): string | undefined =>
  typeof value === 'string' && UUID_RE.test(value) ? value : undefined;

const limited = (value: unknown, max: number): string =>
  typeof value === 'string' ? truncateText(noNul(value), max) : '';

/** Collects the events of one input, and the changes of the state, without touching the old one. */
class Run {
  readonly events: ConsoleEvent[] = [];
  dropped: string | undefined;
  turn: number;
  turnOpen: boolean;
  model: string | undefined;
  private unknownSeen: Set<string> | undefined;
  private malformedSeen: Set<string> | undefined;
  private endedJobs: Set<string> | undefined;
  private lastProgress: Map<string, string> | undefined;

  constructor(private readonly before: NormalizerState) {
    this.turn = before.turn;
    this.turnOpen = before.turnOpen;
    this.model = before.model;
  }

  emit(event: ConsoleEvent): void {
    this.events.push(event);
  }

  unknown(type: string, subtype?: string): void {
    const key = subtype === undefined ? type : `${type}/${subtype}`;
    if (this.before.unknownSeen.has(key) || this.unknownSeen?.has(key)) {
      this.dropped ??= 'unknown type, already reported';
      return;
    }
    (this.unknownSeen ??= new Set(this.before.unknownSeen)).add(key);
    this.emit(
      subtype === undefined
        ? { kind: 'protocol.unknown', type }
        : { kind: 'protocol.unknown', type, subtype },
    );
  }

  malformed(type: string, field: string): void {
    const key = `${type}/${field}`;
    if (this.before.malformedSeen.has(key) || this.malformedSeen?.has(key)) {
      this.dropped ??= 'malformed field, already reported';
      return;
    }
    (this.malformedSeen ??= new Set(this.before.malformedSeen)).add(key);
    this.emit({ kind: 'notice', level: 'warning', code: 'protocol_malformed', type, field });
  }

  /** True the first time a job ends. */
  endJob(jobId: string): boolean {
    if (this.before.endedJobs.has(jobId) || this.endedJobs?.has(jobId)) return false;
    (this.endedJobs ??= new Set(this.before.endedJobs)).add(jobId);
    return true;
  }

  /** True when the progress differs from the last one of the job. */
  progress(jobId: string, signature: string): boolean {
    const last = this.lastProgress?.get(jobId) ?? this.before.lastProgress.get(jobId);
    if (last === signature) return false;
    (this.lastProgress ??= new Map(this.before.lastProgress)).set(jobId, signature);
    return true;
  }

  state(): NormalizerState {
    return {
      turn: this.turn,
      turnOpen: this.turnOpen,
      model: this.model,
      unknownSeen: this.unknownSeen ?? this.before.unknownSeen,
      malformedSeen: this.malformedSeen ?? this.before.malformedSeen,
      endedJobs: this.endedJobs ?? this.before.endedJobs,
      lastProgress: this.lastProgress ?? this.before.lastProgress,
    };
  }
}

const scopeOf = (message: Json): string | null => idOf(message.parent_tool_use_id) ?? null;

function lifecycle(run: Run, message: Json): void {
  const messageId = uuidOf(message.command_uuid);
  if (messageId === undefined) return run.malformed('command_lifecycle', 'command_uuid');
  const state = message.state;
  if (state !== 'queued' && state !== 'started' && state !== 'completed' && state !== 'cancelled') {
    return run.malformed('command_lifecycle', 'state');
  }
  run.emit({ kind: 'user.lifecycle', messageId, state });
}

function init(run: Run, message: Json): void {
  const ids = Array.isArray(message.user_message_uuids)
    ? message.user_message_uuids.flatMap((v) => uuidOf(v) ?? [])
    : [];
  const model = idOf(message.model);
  run.turn += 1;
  run.turnOpen = true;
  const changed = model !== undefined && model !== run.model;
  if (changed) run.model = model;
  run.emit({
    kind: 'turn.started',
    turn: run.turn,
    userMessageIds: ids,
    ...(changed ? { model } : {}),
  });
}

function assistant(run: Run, message: Json): void {
  const inner = isObject(message.message) ? message.message : {};
  const content = Array.isArray(inner.content) ? inner.content : [];
  const scope = scopeOf(message);
  let mapped = false;
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === 'text') {
      const apiMessageId = idOf(inner.id);
      if (apiMessageId === undefined) {
        run.malformed('assistant', 'message.id');
        mapped = true;
        continue;
      }
      if (typeof block.text !== 'string' || block.text === '') continue;
      run.emit({
        kind: 'assistant.text',
        apiMessageId,
        scope,
        text: limited(block.text, 32 * KB),
      });
      mapped = true;
    } else if (block.type === 'tool_use') {
      const toolUseId = idOf(block.id);
      const tool = idOf(block.name);
      if (toolUseId === undefined || tool === undefined) {
        run.malformed('assistant', 'tool_use');
        mapped = true;
        continue;
      }
      run.emit({
        kind: 'tool.call',
        toolUseId,
        tool,
        summary: summarizeToolInput(tool, block.input),
        scope,
      });
      mapped = true;
    }
  }
  if (!mapped) run.dropped ??= 'assistant message without text or tool_use (thinking and the like)';
}

function toolResultPreview(content: unknown): string {
  if (typeof content === 'string') return limited(content, 2 * KB);
  if (!Array.isArray(content)) return '';
  const parts = content.flatMap((part) =>
    isObject(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
  );
  return limited(parts.join('\n'), 2 * KB);
}

function user(run: Run, message: Json): void {
  if (message.isReplay === true) {
    const messageId = uuidOf(message.uuid);
    if (messageId === undefined) return run.malformed('user', 'uuid');
    run.emit({ kind: 'user.replayed', messageId });
    return;
  }
  const inner = isObject(message.message) ? message.message : {};
  const content = Array.isArray(inner.content) ? inner.content : [];
  const scope = scopeOf(message);
  let mapped = false;
  for (const block of content) {
    if (!isObject(block) || block.type !== 'tool_result') continue;
    mapped = true;
    const toolUseId = idOf(block.tool_use_id);
    if (toolUseId === undefined) {
      run.malformed('user', 'tool_use_id');
      continue;
    }
    run.emit({
      kind: 'tool.result',
      toolUseId,
      isError: block.is_error === true,
      preview: toolResultPreview(block.content),
      scope,
    });
  }
  if (!mapped) run.dropped ??= 'user message that is neither a replay nor a tool result';
}

function taskStarted(run: Run, message: Json): void {
  const jobId = idOf(message.task_id);
  if (jobId === undefined) return run.malformed('system/task_started', 'task_id');
  const toolUseId = idOf(message.tool_use_id);
  run.emit({
    kind: 'job.started',
    jobId,
    ...(toolUseId === undefined ? {} : { toolUseId }),
    jobType: idOf(message.task_type) ?? 'unknown',
    description: limited(message.description, 2 * KB),
    backgrounded: message.is_backgrounded === true,
  });
}

function taskProgress(run: Run, message: Json): void {
  const jobId = idOf(message.task_id);
  if (jobId === undefined) return run.malformed('system/task_progress', 'task_id');
  const description = limited(message.description, 2 * KB);
  const lastTool = idOf(message.last_tool_name);
  if (!run.progress(jobId, JSON.stringify([description, lastTool ?? null]))) {
    run.dropped ??= 'job.progress repeated without a change';
    return;
  }
  run.emit({
    kind: 'job.progress',
    jobId,
    description,
    ...(lastTool === undefined ? {} : { lastTool }),
  });
}

function taskUpdated(run: Run, message: Json): void {
  const jobId = idOf(message.task_id);
  if (jobId === undefined) return run.malformed('system/task_updated', 'task_id');
  const patch = isObject(message.patch) ? message.patch : {};
  const status = idOf(patch.status);
  if (status === undefined) {
    run.dropped ??= 'task_updated without patch.status';
    return;
  }
  run.emit({ kind: 'job.updated', jobId, status });
  if (status === 'completed' && run.endJob(jobId)) {
    run.emit({ kind: 'job.ended', jobId, status: 'completed' });
  }
}

function taskNotification(run: Run, message: Json): void {
  const jobId = idOf(message.task_id);
  if (jobId === undefined) return run.malformed('system/task_notification', 'task_id');
  const status = idOf(message.status);
  const summary =
    typeof message.summary === 'string' ? limited(message.summary, 2 * KB) : undefined;
  run.emit({
    kind: 'job.notified',
    jobId,
    ...(status === undefined ? {} : { status }),
    ...(summary === undefined ? {} : { summary }),
  });
  if (status === 'completed' && run.endJob(jobId)) {
    run.emit({ kind: 'job.ended', jobId, status: 'completed' });
  }
}

function backgroundTasks(run: Run, message: Json): void {
  if (!Array.isArray(message.tasks))
    return run.malformed('system/background_tasks_changed', 'tasks');
  const jobIds = message.tasks.flatMap((task) =>
    isObject(task) ? (idOf(task.task_id) ?? []) : [],
  );
  run.emit({ kind: 'jobs.background', jobIds });
}

function permissionDenied(run: Run, message: Json): void {
  const tool = idOf(message.tool_name);
  if (tool === undefined) return run.malformed('system/permission_denied', 'tool_name');
  const toolUseId = idOf(message.tool_use_id);
  const reasonType = idOf(message.decision_reason_type);
  run.emit({
    kind: 'permission.denied',
    tool,
    ...(toolUseId === undefined ? {} : { toolUseId }),
    message: limited(message.message, KB),
    ...(reasonType === undefined ? {} : { reasonType }),
  });
}

function apiRetry(run: Run, message: Json): void {
  const details = ['attempt', 'max_retries', 'error', 'error_status']
    .flatMap((key) => {
      const value = message[key];
      return typeof value === 'string' || typeof value === 'number' ? [`${key}=${value}`] : [];
    })
    .join(' ');
  run.emit({
    kind: 'notice',
    level: 'warning',
    code: 'api_retry',
    text: limited(details === '' ? 'API request is being retried' : `API retry: ${details}`, KB),
  });
}

function result(run: Run, message: Json): void {
  // The turn is closed by `type: "result"` itself, whatever its fields are (§6.1).
  const subtype = idOf(message.subtype);
  if (subtype === undefined) run.malformed('result', 'subtype');
  if (typeof message.is_error !== 'boolean') run.malformed('result', 'is_error');
  const terminalReason = idOf(message.terminal_reason);
  if (terminalReason === undefined) run.malformed('result', 'terminal_reason');
  const stopReason = message.stop_reason;
  const duration = message.duration_ms;
  const cost = message.total_cost_usd;
  run.emit({
    kind: 'turn.ended',
    turn: Math.max(run.turn, 1),
    isError: message.is_error === true,
    ...(terminalReason === undefined ? {} : { terminalReason }),
    ...(stopReason === null
      ? { stopReason: null }
      : idOf(stopReason) === undefined
        ? {}
        : { stopReason: idOf(stopReason) }),
    ...(subtype === undefined ? {} : { subtype }),
    ...(typeof duration === 'number' && Number.isInteger(duration) && duration >= 0
      ? { durationMs: duration }
      : {}),
    ...(typeof cost === 'number' && cost >= 0 && Number.isFinite(cost) ? { costUsd: cost } : {}),
    denials: Array.isArray(message.permission_denials) ? message.permission_denials.length : 0,
  });
  run.turnOpen = false;
}

function rateLimit(run: Run, message: Json): void {
  const info = isObject(message.rate_limit_info) ? message.rate_limit_info : {};
  const status = idOf(info.status);
  if (status === undefined) return run.malformed('rate_limit_event', 'rate_limit_info.status');
  if (status === 'allowed') {
    run.dropped ??= 'rate limit allowed';
    return;
  }
  const kind = idOf(info.rateLimitType);
  run.emit({
    kind: 'notice',
    level: 'warning',
    code: 'rate_limit',
    text: limited(
      kind === undefined ? `Rate limit: ${status}` : `Rate limit (${kind}): ${status}`,
      KB,
    ),
  });
}

const SYSTEM: Record<string, ((run: Run, message: Json) => void) | 'drop'> = {
  init,
  task_started: taskStarted,
  task_progress: taskProgress,
  task_updated: taskUpdated,
  task_notification: taskNotification,
  background_tasks_changed: backgroundTasks,
  permission_denied: permissionDenied,
  api_retry: apiRetry,
  thinking_tokens: 'drop',
};

const TOP: Record<string, (run: Run, message: Json) => void> = {
  command_lifecycle: lifecycle,
  assistant,
  user,
  result,
  rate_limit_event: rateLimit,
};

const DROPPED_TYPES: Record<string, string> = { stream_event: 'partial stream event' };

function dispatch(run: Run, message: Json, type: string): void {
  if (type === 'system') {
    const subtype = idOf(message.subtype);
    if (subtype === undefined) return run.unknown('system', '<invalid>');
    const handler = Object.hasOwn(SYSTEM, subtype) ? SYSTEM[subtype] : undefined;
    if (handler === 'drop') {
      run.dropped ??= `system/${subtype}`;
    } else if (handler === undefined) {
      run.unknown('system', subtype);
    } else {
      handler(run, message);
    }
    return;
  }
  if (Object.hasOwn(DROPPED_TYPES, type)) {
    run.dropped ??= DROPPED_TYPES[type];
    return;
  }
  const handler = Object.hasOwn(TOP, type) ? TOP[type] : undefined;
  if (handler === undefined) return run.unknown(type);
  handler(run, message);
}

/**
 * Turns one parsed line of Claude's stdout into Board events. Anything that is not an object
 * with a string `type` is `protocol.unknown` with `type: '<invalid>'`.
 */
export function normalize(state: NormalizerState, message: unknown): NormalizeResult {
  const run = new Run(state);
  if (!isObject(message) || typeof message.type !== 'string' || idOf(message.type) === undefined) {
    run.emit({ kind: 'protocol.unknown', type: '<invalid>' });
  } else {
    dispatch(run, message, message.type);
  }
  const events = run.events;
  return {
    state: run.state(),
    events,
    ...(events.length === 0 && run.dropped !== undefined ? { dropped: run.dropped } : {}),
  };
}

/** `normalize` for a raw line: a line that is not a JSON object is `<invalid>`. */
export function normalizeLine(state: NormalizerState, line: string): NormalizeResult {
  const parsed = parseLine(line);
  return normalize(state, parsed.ok ? parsed.message : null);
}
