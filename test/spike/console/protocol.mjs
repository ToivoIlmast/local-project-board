// T16 spike: pure helpers for Claude Code's headless stream-json protocol
// (`claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages`).
// Not production code: shared by the manual live harness (live.mjs) and the offline fixture test.
// No Node APIs here, so the same checks can later move into the Runner unchanged.

/** Message types the spike expects on stdout. Anything else is reported, never fatal.
 * `command_lifecycle` is not in the CLI docs; it was observed on 2.1.330 (see report.md). */
export const KNOWN_TYPES = [
  'system',
  'assistant',
  'user',
  'result',
  'stream_event',
  'rate_limit_event',
  'command_lifecycle',
];

/** init.capabilities entry that announces command_lifecycle events (observed on 2.1.330). */
export const LIFECYCLE_CAPABILITY = 'msg_lifecycle_v1';

/**
 * command_lifecycle states per input uuid, in arrival order (queued → started → completed |
 * cancelled on 2.1.330).
 * @param {any[]} messages
 * @returns {Map<string, string[]>}
 */
export function lifecycle(messages) {
  const states = new Map();
  for (const m of messages) {
    if (m.type !== 'command_lifecycle') continue;
    const list = states.get(m.command_uuid) ?? [];
    list.push(m.state);
    states.set(m.command_uuid, list);
  }
  return states;
}

/**
 * Splits NDJSON text into parsed messages. Tolerates CRLF, blank lines and a trailing partial line.
 * @param {string} text
 * @returns {{ messages: any[], bad: { line: string, error: string }[] }}
 */
export function parseNdjson(text) {
  const messages = [];
  const bad = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') continue;
    try {
      const value = JSON.parse(line);
      if (value === null || typeof value !== 'object' || typeof value.type !== 'string') {
        bad.push({ line, error: 'not an object with a string "type"' });
      } else {
        messages.push(value);
      }
    } catch (error) {
      bad.push({ line, error: String(error) });
    }
  }
  return { messages, bad };
}

/**
 * One user message for stdin, in the format the research found to work, plus an optional uuid.
 * @param {string} text
 * @param {string} [uuid]
 */
export function userMessage(text, uuid) {
  const message = { type: 'user', message: { role: 'user', content: text } };
  return uuid === undefined ? message : { ...message, uuid };
}

/** @param {any} m */
function isToolResultCarrier(m) {
  const content = m?.message?.content;
  return Array.isArray(content) && content.some((b) => b?.type === 'tool_result');
}

/**
 * User messages on stdout that are replays of what was written to stdin (not tool results).
 * @param {any[]} messages
 */
export function replayedUserMessages(messages) {
  return messages.filter((m) => m.type === 'user' && !isToolResultCarrier(m));
}

/** @param {any} m */
export function isInit(m) {
  return m.type === 'system' && m.subtype === 'init';
}

/**
 * Pairs each sent message with its replay: by uuid first, by order (stdin is FIFO) as the fallback.
 * @param {{ uuid?: string, text: string }[]} sent
 * @param {any[]} messages
 */
export function matchReplays(sent, messages) {
  const replays = replayedUserMessages(messages);
  return sent.map((s, index) => {
    const byUuid = s.uuid === undefined ? undefined : replays.find((r) => r.uuid === s.uuid);
    const byOrder = replays[index];
    return {
      uuid: s.uuid,
      byUuid: byUuid !== undefined,
      byOrder: byOrder !== undefined,
      replayUuid: byOrder?.uuid,
      sameText: contentText(byOrder?.message?.content) === s.text,
    };
  });
}

/** @param {unknown} content */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('');
  }
  return undefined;
}

/**
 * The checks a Runner could run on a live session to detect a protocol change in a future
 * Claude Code version. Returns problems (incompatibilities) and notes (unknown, tolerated data).
 * @param {any[]} messages
 * @param {{ sessionId?: string, sentUuids?: string[] }} expected
 */
export function checkCompatibility(messages, expected = {}) {
  const problems = [];
  const init = messages.find(isInit);
  if (!init) problems.push('no system/init message');
  else {
    if (typeof init.session_id !== 'string') problems.push('system/init has no session_id');
    if (expected.sessionId !== undefined && init.session_id !== expected.sessionId) {
      problems.push(
        `session_id ${init.session_id} differs from --session-id ${expected.sessionId}`,
      );
    }
  }
  if (init && !(init.capabilities ?? []).includes(LIFECYCLE_CAPABILITY)) {
    problems.push(`system/init does not announce ${LIFECYCLE_CAPABILITY}`);
  }
  const replays = replayedUserMessages(messages);
  const states = lifecycle(messages);
  for (const uuid of expected.sentUuids ?? []) {
    if (!replays.some((r) => r.uuid === uuid)) problems.push(`no replay with uuid ${uuid}`);
    if (!(states.get(uuid) ?? []).includes('queued'))
      problems.push(`no command_lifecycle queued for ${uuid}`);
  }
  const results = messages.filter((m) => m.type === 'result');
  if (results.length === 0) problems.push('no result message');
  for (const r of results) {
    for (const key of ['subtype', 'is_error', 'session_id']) {
      if (!(key in r)) problems.push(`result without "${key}"`);
    }
  }
  const sessionIds = new Set(messages.map((m) => m.session_id).filter((s) => s !== undefined));
  if (sessionIds.size > 1) problems.push(`several session ids: ${[...sessionIds].join(', ')}`);
  const unknownTypes = [...new Set(messages.map((m) => m.type))].filter(
    (t) => !KNOWN_TYPES.includes(t),
  );
  return { ok: problems.length === 0, problems, unknownTypes };
}

/**
 * Pairs tool_use blocks with their tool_result blocks.
 * @param {any[]} messages
 */
export function toolPairs(messages) {
  const uses = [];
  const results = new Map();
  for (const m of messages) {
    const content = m?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (m.type === 'assistant' && b?.type === 'tool_use') {
        uses.push({ id: b.id, name: b.name, parent: m.parent_tool_use_id ?? null });
      }
      if (m.type === 'user' && b?.type === 'tool_result') {
        results.set(b.tool_use_id, { isError: b.is_error === true, parent: m.parent_tool_use_id });
      }
    }
  }
  return uses.map((u) => ({ ...u, result: results.get(u.id) }));
}

/** Init lists that describe the person's own setup rather than the protocol. */
const PERSONAL_LISTS = [
  'slash_commands',
  'skills',
  'plugins',
  'agents',
  'mcp_servers',
  'memory_paths',
];

/**
 * Makes a recorded message safe to commit: no thinking content or signatures, no local paths,
 * user name or e-mail addresses, and no lists of the person's own plugins, skills and commands.
 * @param {any} value
 * @param {[string, string][]} replacements literal string → placeholder
 */
export function sanitize(value, replacements) {
  /** @param {any} v @param {string | undefined} key */
  const walk = (v, key) => {
    if (typeof v === 'string') {
      let s = v;
      for (const [from, to] of replacements) {
        if (from) s = s.split(from).join(to);
      }
      return s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>');
    }
    if (Array.isArray(v)) {
      if (key !== undefined && PERSONAL_LISTS.includes(key)) return [`<redacted: ${v.length}>`];
      return v.map((x) => walk(x, undefined));
    }
    if (v !== null && typeof v === 'object') {
      if (v.type === 'thinking' || v.type === 'redacted_thinking') {
        return { type: v.type, thinking: '<redacted>' };
      }
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (k === 'signature') continue;
        out[k] =
          PERSONAL_LISTS.includes(k) && !Array.isArray(x) && x !== null ? '<redacted>' : walk(x, k);
      }
      return out;
    }
    return v;
  };
  return walk(value, undefined);
}
