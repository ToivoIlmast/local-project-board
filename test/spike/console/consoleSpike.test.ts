// T16 spike: offline checks of REAL Claude Code stream-json recordings (fixtures/), made by the
// manual harness live.mjs (see report.md). No network, no `claude` binary: safe for CI.
// Each test states one assumption of docs/notes/RESEARCH_claude_console.ru.md, or what replaced it,
// and checks it on what Claude Code 2.1.330 actually printed. Not wired into the production Runner.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KNOWN_TYPES,
  checkCompatibility,
  contentText,
  isInit,
  lifecycle,
  matchReplays,
  parseNdjson,
  replayedUserMessages,
  toolPairs,
} from './protocol.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');

/* eslint-disable @typescript-eslint/no-explicit-any -- recorded protocol data is untyped */
type Msg = any;
type Experiment = Record<string, any>;

function stdout(name: string): Msg[] {
  const { messages, bad } = parseNdjson(
    readFileSync(join(fixtures, `${name}.stdout.ndjson`), 'utf8'),
  );
  expect(bad).toEqual([]);
  return messages;
}
function sentOf(name: string): { uuid?: string; text: string }[] {
  return parseNdjson(readFileSync(join(fixtures, `${name}.stdin.ndjson`), 'utf8'))
    .messages.filter((m: Msg) => m.type === 'user')
    .map((m: Msg) => ({ uuid: m.uuid, text: m.message.content }));
}
const results = JSON.parse(readFileSync(join(fixtures, 'results.json'), 'utf8')) as {
  claudeVersion: string;
  experiments: Record<string, Experiment>;
};
function exp(name: string): Experiment {
  const e = results.experiments[name];
  if (!e) throw new Error(`experiment ${name} was not recorded`);
  return e;
}
function nth<T>(arr: readonly T[], i: number): T {
  const v = arr.at(i);
  if (v === undefined) throw new Error(`no element at index ${i}`);
  return v;
}
function uuidOf(s: { uuid?: string }): string {
  if (s.uuid === undefined) throw new Error('message was sent without a uuid');
  return s.uuid;
}
const ofType = (out: Msg[], type: string, subtype?: string) =>
  out.filter((m) => m.type === type && (subtype === undefined || m.subtype === subtype));
const stdoutFixtures = readdirSync(fixtures)
  .filter((f) => f.endsWith('.stdout.ndjson'))
  .map((f) => f.replace('.stdout.ndjson', ''));

describe('recording metadata and hygiene', () => {
  it('names the Claude Code version and the exact arguments of every experiment', () => {
    expect(results.claudeVersion).toBe('2.1.330');
    for (const [name, e] of Object.entries(results.experiments)) {
      expect({ name, args: Array.isArray(e.args) }).toEqual({ name, args: true });
    }
  });

  it('commits no thinking content, signatures, local paths or e-mail addresses', () => {
    for (const file of readdirSync(fixtures)) {
      const text = readFileSync(join(fixtures, file), 'utf8');
      expect({ file, home: /[A-Z]:\\\\Users\\\\|\/Users\/|\/home\/|AppData/i.test(text) }).toEqual({
        file,
        home: false,
      });
      expect({ file, email: /[\w.+-]+@[\w-]+\.(com|org|net|io)\b/.test(text) }).toEqual({
        file,
        email: false,
      });
      expect({ file, signature: text.includes('"signature"') }).toEqual({ file, signature: false });
      for (const m of parseNdjson(text).messages) {
        for (const b of Array.isArray(m?.message?.content) ? m.message.content : []) {
          if (b?.type === 'thinking') expect(b.thinking).toBe('<redacted>');
        }
      }
    }
  });

  it('every stdout line is JSON with a known top-level type (unknown types are listed here)', () => {
    const seen = new Set<string>();
    for (const name of stdoutFixtures) for (const m of stdout(name)) seen.add(m.type);
    expect([...seen].filter((t) => !KNOWN_TYPES.includes(t))).toEqual([]);
    // command_lifecycle is not documented; the research expected a top-level permission_denied.
    expect(seen).toContain('command_lifecycle');
    expect(seen).not.toContain('permission_denied');
  });

  it('records the system subtypes a normalizer must tolerate', () => {
    const subtypes = new Set<string>();
    for (const name of stdoutFixtures)
      for (const m of ofType(stdout(name), 'system')) subtypes.add(m.subtype);
    expect([...subtypes].sort()).toEqual(
      [
        'background_tasks_changed',
        'init',
        'permission_denied',
        'task_notification',
        'task_progress',
        'task_started',
        'task_updated',
        'thinking_tokens',
      ].sort(),
    );
  });
});

describe('stdin protocol: several messages, one session, uuid replay', () => {
  const name = 'multi-message';

  it('passes the compatibility probe a Runner would run at start-up', () => {
    const sent = sentOf(name);
    const report = checkCompatibility(stdout(name), {
      sessionId: exp(name).sessionId,
      sentUuids: sent.map(uuidOf),
    });
    expect(report).toEqual({ ok: true, problems: [], unknownTypes: [] });
  });

  it('replays the uuid given on stdin unchanged, in the order sent', () => {
    const matches = matchReplays(sentOf(name), stdout(name));
    expect(matches).toHaveLength(3);
    for (const m of matches) {
      expect(m).toMatchObject({ byUuid: true, byOrder: true });
      expect(m.replayUuid).toBe(m.uuid);
    }
  });

  it('acknowledges receipt at once with command_lifecycle queued, keyed by the input uuid', () => {
    const states = lifecycle(stdout(name));
    for (const s of sentOf(name)) {
      expect(states.get(uuidOf(s))).toEqual(['queued', 'started', 'completed']);
    }
    // queued arrives before the first system/init: receipt, not consumption.
    const out = stdout(name);
    expect(
      out.findIndex((m) => m.type === 'command_lifecycle' && m.state === 'queued'),
    ).toBeLessThan(out.findIndex(isInit));
  });

  it('keeps every message in the --session-id session; exit code 0 after stdin closes', () => {
    const e = exp(name);
    expect(
      new Set(
        stdout(name)
          .map((m) => m.session_id)
          .filter(Boolean),
      ),
    ).toEqual(new Set([e.sessionId]));
    expect(e.exitCode).toBe(0);
  });

  it('REFUTES "one message = one turn": messages queued during a turn are merged into one turn', () => {
    const out = stdout(name);
    expect(ofType(out, 'result')).toHaveLength(2); // 3 messages, 2 turns
    const merged = replayedUserMessages(out).at(-1);
    const sent = sentOf(name);
    expect(contentText(merged.message.content)).toBe(`${nth(sent, 1).text}\n${nth(sent, 2).text}`);
    expect(merged.uuid).toBe(nth(sent, 2).uuid); // the merged replay carries the LAST uuid
    // init of the merged turn lists every uuid it consumed
    expect(out.filter(isInit).map((m) => m.user_message_uuids)).toEqual([
      [nth(sent, 0).uuid],
      [nth(sent, 1).uuid, nth(sent, 2).uuid],
    ]);
  });

  it('loses no message: every uuid is replayed and completed', () => {
    const out = stdout(name);
    expect(replayedUserMessages(out)).toHaveLength(sentOf(name).length);
    expect(out.filter(isInit)).toHaveLength(ofType(out, 'result').length); // init on every turn
  });
});

describe('uuid edge cases', () => {
  const out = () => stdout('uuid-edge-cases');

  it('a duplicate uuid is replayed but NOT executed (the CLI de-duplicates by uuid)', () => {
    const texts = ofType(out(), 'assistant').map((m) => contentText(m.message.content));
    expect(texts).toContain('ONE');
    expect(texts).not.toContain('TWO');
    const dup = uuidOf(nth(sentOf('uuid-edge-cases'), 0));
    expect(lifecycle(out()).get(dup)).toEqual(['queued', 'started', 'completed']);
  });

  it('a message without uuid gets no lifecycle and no replay of its own', () => {
    const replays = replayedUserMessages(out());
    expect(
      replays.some((r: Msg) => contentText(r.message.content) === 'Reply with exactly THREE.'),
    ).toBe(false);
    expect([...lifecycle(out()).keys()]).toHaveLength(2); // the dup uuid and "not-a-uuid"
  });

  it('a non-UUID string is accepted and echoed as is', () => {
    expect(lifecycle(out()).get('not-a-uuid')).toEqual(['queued', 'started', 'completed']);
  });
});

describe('malformed stdin', () => {
  it('one non-JSON line ends the whole process with exit code 1 and nothing on stdout', () => {
    const e = exp('bad-input');
    expect(e.exitCode).toBe(1);
    expect(e.answeredAfterBadLines).toBe(false);
    expect(e.stderrTail).toContain('Error parsing streaming input line');
    expect(stdout('bad-input')).toEqual([]);
  });
});

describe('a message sent while a turn is running', () => {
  const name = 'mid-turn-message';

  it('is received at once (queued) but consumed only after the running tool call', () => {
    const e = exp(name);
    expect(e.replayAfterToolResult).toBe(true);
    const queued = e.timeline.find((x: Msg) => x.type === 'command_lifecycle' && x.t > e.midSentAt);
    expect(queued.t - e.midSentAt).toBeLessThan(1000);
    expect(e.replayAt - e.midSentAt).toBeGreaterThan(5000);
  });

  it('joins the SAME turn (no result in between) and is answered', () => {
    const e = exp(name);
    expect(e.resultsBeforeMidReplay).toBe(0);
    expect(ofType(stdout(name), 'result')).toHaveLength(1);
    expect(e.midMessageAnswered).toBe(true);
  });
});

describe('stream-json content', () => {
  it('pairs every tool_use with a tool_result, including a failing Read', () => {
    const pairs = toolPairs(stdout('tools'));
    expect(pairs.map((p: Msg) => p.name)).toEqual(['Bash', 'Write', 'Edit', 'Read', 'Read']);
    for (const p of pairs) expect(p.result).toBeDefined();
    expect(nth(pairs, -1).result.isError).toBe(true);
  });

  it('splits one assistant message into one stdout line per content block, sharing message.id', () => {
    const lines = ofType(stdout('subagent'), 'assistant');
    const byId = new Map<string, number>();
    for (const m of lines) {
      expect(m.message.content).toHaveLength(1);
      byId.set(m.message.id, (byId.get(m.message.id) ?? 0) + 1);
    }
    expect([...byId.values()].some((n) => n > 1)).toBe(true);
  });

  it('marks subagent traffic with parent_tool_use_id pointing at the Agent call', () => {
    const out = stdout('subagent');
    const agentCalls = toolPairs(out).filter((p: Msg) => p.parent === null && p.name === 'Agent');
    expect(agentCalls).toHaveLength(1);
    const children = out.filter((m) => m.parent_tool_use_id != null);
    expect(children.length).toBeGreaterThanOrEqual(3);
    for (const c of children) expect(c.parent_tool_use_id).toBe(nth(agentCalls, 0).id);
  });

  it('a background subagent starts a new turn WITHOUT any user message', () => {
    const out = stdout('subagent');
    expect(replayedUserMessages(out)).toHaveLength(1);
    expect(ofType(out, 'result')).toHaveLength(2);
    expect(out.filter(isInit).at(-1).user_message_uuids).toBeUndefined();
    const firstResult = out.findIndex((m) => m.type === 'result');
    expect(out.slice(firstResult).some((m) => m.parent_tool_use_id != null)).toBe(true);
  });

  it('carries parent_tool_use_id on every assistant and user message', () => {
    for (const name of stdoutFixtures) {
      for (const m of stdout(name).filter((x) => x.type === 'assistant' || x.type === 'user')) {
        expect({ name, has: 'parent_tool_use_id' in m }).toEqual({ name, has: true });
      }
    }
  });

  it('reports an API error as result.is_error with subtype "success" and terminal_reason', () => {
    const r = ofType(stdout('api-error'), 'result')[0];
    expect(r).toMatchObject({ subtype: 'success', is_error: true, terminal_reason: 'api_error' });
    expect(lifecycle(stdout('api-error')).values().next().value).toEqual([
      'queued',
      'started',
      'cancelled',
    ]);
    expect(exp('api-error').exitCode).toBe(1);
  });
});

describe('permissions', () => {
  const name = 'permissions';

  it('--permission-prompts none: a command allowed by project settings runs', () => {
    expect(exp(name).allowedCommandRan).toBe(true);
  });

  it('a command needing approval is denied: system/permission_denied + result.permission_denials', () => {
    const out = stdout(name);
    const [denied] = ofType(out, 'system', 'permission_denied');
    expect(denied).toMatchObject({ tool_name: 'Bash', decision_reason_type: 'asyncAgent' });
    const first = ofType(out, 'result')[0];
    expect(first).toMatchObject({ subtype: 'success', is_error: false });
    expect(first.permission_denials).toEqual([
      expect.objectContaining({ tool_name: 'Bash', tool_use_id: denied.tool_use_id }),
    ]);
    expect(exp(name).deniedDirCreated).toBe(false);
  });

  it('accepts a new message after the denial and continues the same session', () => {
    expect(ofType(stdout(name), 'result')).toHaveLength(2);
    expect(exp(name).continuedAfterDenial).toBe(true);
  });

  it('the default --permission-prompts host without an SDK host also denies (no hang)', () => {
    const [denied] = ofType(stdout('tools-write-denied'), 'system', 'permission_denied');
    expect(denied).toMatchObject({ tool_name: 'Write' });
    expect(denied.decision_reason_type).toBeUndefined();
  });
});

describe('process lifetime (Windows 11, results.json)', () => {
  it('closing stdin during a turn lets the turn finish: result, then exit 0', () => {
    const e = exp('stdin-close-mid-turn');
    expect(e).toMatchObject({
      exitCode: 0,
      resultEmitted: true,
      turnCompleted: true,
      toolResultAfterClose: true,
    });
  });

  it('child.kill(SIGINT|SIGTERM) on Windows is TerminateProcess: no result, immediate exit', () => {
    for (const name of ['sigint', 'sigterm']) {
      const e = exp(name);
      expect(e).toMatchObject({ exitCode: null, resultEmitted: false });
      expect(e.exitedAfterKillMs).toBeLessThan(2000);
    }
  });

  it('a dead Node parent takes claude with it at once (libuv kill-on-close job object)', () => {
    for (const name of ['parent-death', 'parent-death-idle']) {
      expect(exp(name)).toMatchObject({ claudeAliveAfterParentDeath: false, detached: false });
      expect(exp(name).claudeExitedWithinMs).toBeLessThan(1000);
    }
  });

  it('outside the job (detached; like a POSIX orphan) claude finishes the running turn first', () => {
    expect(exp('parent-death-detached-idle').claudeExitedWithinMs).toBeLessThan(2000);
    const busy = exp('parent-death-detached');
    expect(busy.claudeAliveAfterParentDeath).toBe(false);
    expect(busy.claudeExitedWithinMs).toBeGreaterThan(5000);
  });
});
