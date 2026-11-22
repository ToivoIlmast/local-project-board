// T16 spike: MANUAL live experiments against the installed `claude` (real API calls, small cost).
// Not part of Jest or CI. Usage (from the repository root):
//
//   node test/spike/console/live.mjs --yes [experiment ...]
//
// With no names every experiment runs. Each run uses `--model haiku`, `--max-budget-usd`, an
// isolated temporary project (T16_WORKDIR or the OS temp dir) with its own .claude/settings.json,
// `--setting-sources project` (the person's user settings are neither read nor changed) and
// `--no-session-persistence`. Raw output stays in the work dir; sanitized NDJSON goes to
// fixtures/<name>.stdout.ndjson / .stdin.ndjson and the measurements to fixtures/results.json.
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNdjson, sanitize, userMessage, contentText } from './protocol.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const workRoot = join(process.env.T16_WORKDIR ?? tmpdir(), 't16-console-spike');
const CLAUDE = process.env.CLAUDE_BIN ?? (process.platform === 'win32' ? 'claude.exe' : 'claude');
const MODEL = process.env.T16_MODEL ?? 'haiku';
const BUDGET = '0.25';

const BASE = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--replay-user-messages',
  '--model',
  MODEL,
  '--setting-sources',
  'project',
  '--no-session-persistence',
  '--max-budget-usd',
  BUDGET,
];

/** The child must look like one started from a plain terminal, not nested in this session. */
function childEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if ((key.startsWith('CLAUDE') && key !== 'CLAUDE_CODE_GIT_BASH_PATH') || key === 'CLAUDECODE') {
      delete env[key];
    }
  }
  return env;
}

function project(name, settings, files = {}) {
  const dir = join(workRoot, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(settings, null, 2));
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Spawns one headless session the way a console Runner would (pipes, no shell) and records
 * every stdout line with its time.
 */
function session({ cwd, args, command = CLAUDE, commandArgs }) {
  const started = Date.now();
  const child = spawn(command, commandArgs ?? args, {
    cwd,
    env: childEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  const lines = []; // { t, raw, msg? }
  const stdinLog = [];
  let stderr = '';
  let buffer = '';
  const waiters = new Set();
  const notify = () => {
    for (const w of waiters) w();
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const raw = buffer.slice(0, i).replace(/\r$/, '');
      buffer = buffer.slice(i + 1);
      if (raw.trim() === '') continue;
      const { messages } = parseNdjson(raw);
      lines.push({ t: Date.now() - started, raw, msg: messages[0] });
    }
    notify();
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => (stderr += c));
  child.stdin.on('error', (e) =>
    stdinLog.push({ t: Date.now() - started, error: String(e.code ?? e) }),
  );
  const exit = new Promise((resolve) => {
    child.on('error', (e) =>
      resolve({ exitCode: null, signal: null, spawnError: String(e), t: Date.now() - started }),
    );
    child.on('close', (exitCode, signal) => {
      notify();
      resolve({ exitCode, signal, t: Date.now() - started });
    });
  });
  let exited = null;
  void exit.then((e) => {
    exited = e;
    notify();
  });

  return {
    child,
    lines,
    stdinLog,
    exit,
    get stderr() {
      return stderr;
    },
    get exited() {
      return exited;
    },
    now: () => Date.now() - started,
    messages: () => lines.filter((l) => l.msg).map((l) => l.msg),
    send(text, uuid) {
      const m = userMessage(text, uuid);
      stdinLog.push({ t: Date.now() - started, msg: m });
      child.stdin.write(JSON.stringify(m) + '\n');
      return m;
    },
    sendRaw(raw) {
      stdinLog.push({ t: Date.now() - started, raw });
      child.stdin.write(raw);
    },
    close() {
      stdinLog.push({ t: Date.now() - started, closed: true });
      child.stdin.end();
    },
    /** Resolves with the first line (index ≥ from) that matches, or null on timeout or exit. */
    waitFor(predicate, timeoutMs, from = 0) {
      return new Promise((resolve) => {
        const check = () => {
          for (let k = from; k < lines.length; k++) {
            if (lines[k].msg && predicate(lines[k].msg, lines[k]))
              return finish({ ...lines[k], index: k });
          }
          if (exited) finish(null);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        const finish = (v) => {
          clearTimeout(timer);
          waiters.delete(check);
          resolve(v);
        };
        waiters.add(check);
        check();
      });
    },
    countOf: (type) => lines.filter((l) => l.msg?.type === type).length,
  };
}

const isResult = (m) => m.type === 'result';
const toolUse = (name) => (m) =>
  m.type === 'assistant' &&
  m.message?.content?.some((b) => b.type === 'tool_use' && (!name || b.name === name));
const toolResult = (m) =>
  m.type === 'user' &&
  Array.isArray(m.message?.content) &&
  m.message.content.some((b) => b.type === 'tool_result');
const assistantSays = (word) => (m) =>
  m.type === 'assistant' && (contentText(m.message?.content) ?? '').includes(word);
const replayOf = (uuid) => (m) => m.type === 'user' && m.uuid === uuid;

async function finish(s, timeoutMs = 30_000) {
  const timer = sleep(timeoutMs).then(() => 'timeout');
  const r = await Promise.race([s.exit, timer]);
  if (r === 'timeout') {
    s.child.kill();
    return { ...(await s.exit), timedOut: true };
  }
  return r;
}

function timeline(s) {
  return s.lines.map(({ t, msg, raw }) => {
    if (!msg) return { t, unparsed: raw.slice(0, 80) };
    const e = { t, type: msg.type };
    if (msg.subtype) e.subtype = msg.subtype;
    if (msg.type === 'user' && msg.uuid && !toolResult(msg)) e.replayUuid = msg.uuid;
    const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
    if (blocks.length)
      e.blocks = blocks.map((b) => (b.type === 'tool_use' ? `tool_use:${b.name}` : b.type));
    if (msg.parent_tool_use_id) e.parent = true;
    if (msg.type === 'result')
      Object.assign(e, { is_error: msg.is_error, stop_reason: msg.stop_reason ?? null });
    return e;
  });
}

// ---------------------------------------------------------------- experiments

const PLAIN = { permissions: { allow: [] } };
const WITH_SLEEP = { permissions: { allow: ['Bash(sleep *)', 'Bash(echo *)'] } };
const SLEEP_PROMPT =
  'Run exactly this bash command: `sleep 8 && echo SLEPT`. After it finishes reply with exactly DONE1.';

const experiments = {
  /** §1.1–1.5, 1.7: three messages back to back into one process. */
  async 'multi-message'() {
    const sessionId = randomUUID();
    const args = [...BASE, '--tools', '', '--session-id', sessionId];
    const s = session({ cwd: project('multi', PLAIN), args });
    const words = ['ALPHA', 'BRAVO', 'CHARLIE'];
    const uuids = words.map(() => randomUUID());
    words.forEach((w, i) => s.send(`Reply with exactly the word ${w} and nothing else.`, uuids[i]));
    for (const w of words) await s.waitFor(assistantSays(w), 90_000);
    await s.waitFor(
      isResult,
      30_000,
      s.lines.findLastIndex((l) => l.msg && assistantSays('CHARLIE')(l.msg)),
    );
    s.close();
    const end = await finish(s);
    return { s, args, sessionId, ...end, turns: s.countOf('result') };
  },

  /** §1.6: a message written while a Bash tool call is still running. */
  async 'mid-turn-message'() {
    const args = [...BASE, '--tools', 'Bash', '--session-id', randomUUID()];
    const s = session({ cwd: project('midturn', WITH_SLEEP), args });
    s.send(SLEEP_PROMPT, randomUUID());
    const use = await s.waitFor(toolUse('Bash'), 90_000);
    const uuid = randomUUID();
    const sentAt = s.now();
    s.send('Reply with exactly the word MIDWAY.', uuid);
    const replay = await s.waitFor(replayOf(uuid), 90_000);
    const result1 = await s.waitFor(toolResult, 90_000);
    const answered = await s.waitFor(assistantSays('MIDWAY'), 90_000);
    await s.waitFor(isResult, 60_000, answered?.index ?? 0);
    await sleep(1500);
    s.close();
    const end = await finish(s);
    return {
      s,
      args,
      ...end,
      toolUseAt: use?.t ?? null,
      midSentAt: sentAt,
      replayAt: replay?.t ?? null,
      toolResultAt: result1?.t ?? null,
      replayAfterToolResult: replay && result1 ? replay.t > result1.t : null,
      midMessageAnswered: answered !== null,
      resultsBeforeMidReplay: s.lines
        .slice(0, replay?.index ?? 0)
        .filter((l) => l.msg?.type === 'result').length,
    };
  },

  /** §1.4–1.5: duplicate uuid, no uuid, a non-UUID uuid. How reliable is matching? */
  async 'uuid-edge-cases'() {
    const args = [...BASE, '--tools', '', '--session-id', randomUUID()];
    const s = session({ cwd: project('uuid', PLAIN), args });
    const dup = randomUUID();
    s.send('Reply with exactly ONE.', dup);
    s.send('Reply with exactly TWO.', dup);
    s.send('Reply with exactly THREE.');
    s.send('Reply with exactly FOUR.', 'not-a-uuid');
    await s.waitFor(assistantSays('FOUR'), 120_000);
    await sleep(2000);
    s.close();
    const end = await finish(s);
    const replays = s.messages().filter((m) => m.type === 'user' && !toolResult(m));
    return {
      s,
      args,
      ...end,
      replays: replays.map((m) => ({
        uuid: m.uuid ?? null,
        text: contentText(m.message?.content),
      })),
      sentUuids: [dup, dup, null, 'not-a-uuid'],
    };
  },

  /** §1: what a malformed stdin line does. */
  async 'bad-input'() {
    const args = [...BASE, '--tools', '', '--session-id', randomUUID()];
    const s = session({ cwd: project('bad', PLAIN), args });
    s.sendRaw('this is not json\n');
    s.sendRaw('{"type":"nonsense"}\n');
    s.send('Reply with exactly OKAY.', randomUUID());
    const answered = await s.waitFor(assistantSays('OKAY'), 60_000);
    await s.waitFor(isResult, 30_000, answered?.index ?? 0);
    s.close();
    const end = await finish(s);
    return {
      s,
      args,
      ...end,
      answeredAfterBadLines: answered !== null,
      stderrTail: s.stderr.slice(-400),
    };
  },

  /** §2.1–2.4: closing stdin while a Bash call runs. */
  async 'stdin-close-mid-turn'() {
    const args = [...BASE, '--tools', 'Bash', '--session-id', randomUUID()];
    const s = session({ cwd: project('closemid', WITH_SLEEP), args });
    s.send(SLEEP_PROMPT, randomUUID());
    const use = await s.waitFor(toolUse('Bash'), 90_000);
    const closedAt = s.now();
    s.close();
    const end = await finish(s, 60_000);
    const after = s.lines.filter((l) => l.t >= closedAt);
    return {
      s,
      args,
      ...end,
      toolUseAt: use?.t ?? null,
      closedAt,
      exitedAfterCloseMs: end.timedOut ? null : end.t - closedAt,
      resultEmitted: after.some((l) => l.msg?.type === 'result'),
      toolResultAfterClose: after.some((l) => l.msg && toolResult(l.msg)),
      turnCompleted: after.some((l) => l.msg && assistantSays('DONE1')(l.msg)),
    };
  },

  /** §2.7–2.8 (as far as the platform allows): child.kill('SIGINT' | 'SIGTERM') mid-turn. */
  async sigint() {
    return killMidTurn('SIGINT');
  },
  async sigterm() {
    return killMidTurn('SIGTERM');
  },

  /** §2.5–2.6: the parent (Runner) dies mid-turn; does claude keep running? */
  async 'parent-death'() {
    return parentDeath(true);
  },
  async 'parent-death-idle'() {
    return parentDeath(false);
  },
  /** As parent-death, but claude is spawned detached: on Windows it is then outside the parent's
   * kill-on-close job object, so only the closed pipes can end it (what POSIX parents give). */
  async 'parent-death-detached'() {
    return parentDeath(true, true);
  },
  async 'parent-death-detached-idle'() {
    return parentDeath(false, true);
  },

  /** §3: Bash, Write, Edit, Read, a failing Read, and a text + tool_use turn. */
  async tools() {
    // A bare "Write" allow rule in project settings did not permit the write (recorded as
    // tools-write-denied); acceptEdits is the per-process way to let the edits through.
    const args = [
      ...BASE,
      '--tools',
      'Bash,Read,Write,Edit',
      '--permission-mode',
      'acceptEdits',
      '--session-id',
      randomUUID(),
    ];
    const cwd = project('tools', {
      permissions: { allow: ['Bash(echo *)', 'Read', 'Write', 'Edit'] },
    });
    const s = session({ cwd, args });
    s.send(
      [
        'Do these steps in order, one tool call per step, no parallel calls:',
        '1) Bash: echo hello-from-bash',
        '2) Write the file note.txt in the current directory with the content: one',
        '3) Edit note.txt replacing one with two',
        '4) Read note.txt',
        '5) Read missing-file.txt (it does not exist; the error is expected)',
        'Then reply with exactly DONE.',
      ].join('\n'),
      randomUUID(),
    );
    const done = await s.waitFor(assistantSays('DONE'), 180_000);
    await s.waitFor(isResult, 60_000, done?.index ?? 0);
    s.close();
    return { s, args, ...(await finish(s)) };
  },

  /** §3: a subagent (Agent tool) and its parent_tool_use_id. */
  async subagent() {
    const args = [...BASE, '--tools', 'Agent,Read', '--session-id', randomUUID()];
    const cwd = project(
      'subagent',
      { permissions: { allow: ['Read'] } },
      { 'note.txt': 'subagent-content-42\n' },
    );
    const s = session({ cwd, args });
    s.send(
      'Use the Agent tool exactly once (subagent_type "general-purpose") with the prompt: ' +
        '"Read the file note.txt in the current directory and reply with its content only." ' +
        'Then reply with exactly: AGENT-SAID <what it returned>.',
      randomUUID(),
    );
    const done = await s.waitFor(assistantSays('AGENT-SAID'), 240_000);
    await s.waitFor(isResult, 60_000, done?.index ?? 0);
    s.close();
    return { s, args, ...(await finish(s)) };
  },

  /** §4: --permission-prompts none; allowed command, denied command, then continue. */
  async permissions() {
    const args = [
      ...BASE,
      '--tools',
      'Bash',
      '--permission-prompts',
      'none',
      '--session-id',
      randomUUID(),
    ];
    const cwd = project('perm', { permissions: { allow: ['Bash(echo *)'] } });
    const s = session({ cwd, args });
    s.send(
      'Run these two bash commands as two separate tool calls, one after the other: ' +
        '`echo allowed-ok` and then `mkdir denied-dir`. Do not retry anything. Then reply with exactly DONE.',
      randomUUID(),
    );
    const r1 = await s.waitFor(isResult, 120_000);
    s.send('Reply with exactly the word CONTINUED.', randomUUID());
    const r2 = await s.waitFor(isResult, 90_000, (r1?.index ?? 0) + 1);
    s.close();
    const end = await finish(s);
    const pairs = [];
    const uses = new Map();
    for (const m of s.messages()) {
      for (const b of Array.isArray(m.message?.content) ? m.message.content : []) {
        if (b.type === 'tool_use') uses.set(b.id, b.input?.command);
        if (b.type === 'tool_result')
          pairs.push({
            command: uses.get(b.tool_use_id),
            isError: b.is_error === true,
            text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content),
          });
      }
    }
    return {
      s,
      args,
      ...end,
      toolResults: pairs.map((p) => ({ ...p, text: p.text.slice(0, 200) })),
      allowedCommandRan: pairs.some(
        (p) =>
          /echo allowed-ok/.test(p.command ?? '') && !p.isError && p.text.includes('allowed-ok'),
      ),
      deniedDirCreated: existsSync(join(cwd, 'denied-dir')),
      firstResult: r1
        ? {
            is_error: r1.msg.is_error,
            subtype: r1.msg.subtype,
            permission_denials: r1.msg.permission_denials,
          }
        : null,
      continuedAfterDenial:
        r2 !== null && r2.msg.is_error === false && s.messages().some(assistantSays('CONTINUED')),
    };
  },

  /** §3: an API-side error (unknown model) as it appears in stream-json. No tokens are spent. */
  async 'api-error'() {
    const args = [
      ...BASE.map((a) => (a === MODEL ? 'claude-t16-no-such-model' : a)),
      '--tools',
      '',
      '--session-id',
      randomUUID(),
    ];
    const s = session({ cwd: project('apierr', PLAIN), args });
    s.send('Reply with exactly OK.', randomUUID());
    await s.waitFor(isResult, 60_000);
    await sleep(1000);
    s.close();
    return { s, args, ...(await finish(s)), stderrTail: s.stderr.slice(-400) };
  },
};

async function killMidTurn(signal) {
  const args = [...BASE, '--tools', 'Bash', '--session-id', randomUUID()];
  const s = session({ cwd: project(`kill-${signal}`, WITH_SLEEP), args });
  s.send(SLEEP_PROMPT, randomUUID());
  const use = await s.waitFor(toolUse('Bash'), 90_000);
  const killedAt = s.now();
  const delivered = s.child.kill(signal);
  const end = await finish(s, 60_000);
  const after = s.lines.filter((l) => l.t >= killedAt);
  return {
    s,
    args,
    ...end,
    killDelivered: delivered,
    toolUseAt: use?.t ?? null,
    exitedAfterKillMs: end.timedOut ? null : end.t - killedAt,
    resultEmitted: after.some((l) => l.msg?.type === 'result'),
    linesAfterKill: after.length,
    note:
      process.platform === 'win32'
        ? 'On Windows, Node implements child.kill(SIGINT|SIGTERM) as TerminateProcess: no signal reaches the child.'
        : undefined,
  };
}

/**
 * A middle process plays the Runner: it spawns claude with pipes, forwards stdin/stdout, and is
 * then killed hard (TerminateProcess on Windows, SIGKILL elsewhere). The harness then watches the
 * claude pid.
 */
async function parentDeath(midTurn, detached = false) {
  const name = `parent-death${detached ? '-detached' : ''}${midTurn ? '' : '-idle'}`;
  const cwd = project(name, WITH_SLEEP);
  const claudeArgs = [...BASE, '--tools', midTurn ? 'Bash' : '', '--session-id', randomUUID()];
  const parentScript = join(cwd, 'parent.mjs');
  writeFileSync(
    parentScript,
    [
      "import { spawn } from 'node:child_process';",
      `const c = spawn(${JSON.stringify(CLAUDE)}, ${JSON.stringify(claudeArgs)}, { stdio: ['pipe','pipe','pipe'], shell: false, windowsHide: true, detached: ${detached} });`,
      "process.stderr.write(JSON.stringify({ claudePid: c.pid }) + '\\n');",
      'c.stdout.pipe(process.stdout);',
      'process.stdin.pipe(c.stdin);',
    ].join('\n'),
  );
  const s = session({ cwd, command: process.execPath, commandArgs: [parentScript] });
  // childEnv() is applied to the middle process; claude inherits it.
  let claudePid = null;
  for (let i = 0; i < 100 && claudePid === null; i++) {
    const m = /"claudePid":(\d+)/.exec(s.stderr);
    if (m) claudePid = Number(m[1]);
    else await sleep(100);
  }
  if (midTurn) {
    s.send(SLEEP_PROMPT, randomUUID());
    await s.waitFor(toolUse('Bash'), 90_000);
  } else {
    s.send('Reply with exactly IDLE.', randomUUID());
    await s.waitFor(isResult, 60_000);
  }
  const killedAt = s.now();
  s.child.kill('SIGKILL');
  await s.exit;
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const t0 = Date.now();
  let goneAfterMs = null;
  while (Date.now() - t0 < 30_000) {
    if (claudePid === null || !alive(claudePid)) {
      goneAfterMs = Date.now() - t0;
      break;
    }
    await sleep(250);
  }
  const stillAlive = claudePid !== null && alive(claudePid);
  if (stillAlive) process.kill(claudePid);
  return {
    s,
    args: claudeArgs,
    exitCode: null,
    signal: null,
    claudePid,
    killedAt,
    claudeExitedWithinMs: goneAfterMs,
    claudeAliveAfterParentDeath: stillAlive,
    detached,
    note: 'exit code of the orphaned claude cannot be observed: its parent is gone.',
  };
}

// ---------------------------------------------------------------- recording

function replacements() {
  const home = homedir();
  const user = userInfo().username;
  const list = [
    [workRoot, '<WORK>'],
    [workRoot.replace(/\\/g, '/'), '<WORK>'],
    [home, '<HOME>'],
    [home.replace(/\\/g, '/'), '<HOME>'],
    ['/' + home[0].toLowerCase() + home.slice(2).replace(/\\/g, '/'), '<HOME>'],
    [tmpdir(), '<TMP>'],
    [tmpdir().replace(/\\/g, '/'), '<TMP>'],
  ];
  if (user.length >= 3) list.push([user, '<user>']);
  return list.sort((a, b) => b[0].length - a[0].length);
}

function record(name, outcome, results) {
  const { s, ...measured } = outcome;
  const rep = replacements();
  mkdirSync(join(workRoot, 'raw'), { recursive: true });
  writeFileSync(
    join(workRoot, 'raw', `${name}.stdout.ndjson`),
    s.lines.map((l) => l.raw).join('\n') + '\n',
  );
  writeFileSync(join(workRoot, 'raw', `${name}.stderr.txt`), s.stderr);
  const out = s.lines.map((l) =>
    l.msg
      ? JSON.stringify(sanitize(l.msg, rep))
      : JSON.stringify({ type: '__unparsed', text: sanitize(l.raw, rep) }),
  );
  writeFileSync(join(fixtures, `${name}.stdout.ndjson`), out.join('\n') + '\n');
  const inLines = s.stdinLog
    .filter((e) => e.msg || e.raw)
    .map((e) => (e.msg ? JSON.stringify(sanitize(e.msg, rep)) : JSON.stringify({ __raw: e.raw })));
  writeFileSync(join(fixtures, `${name}.stdin.ndjson`), inLines.join('\n') + '\n');
  const init = s.messages().find((m) => m.type === 'system' && m.subtype === 'init');
  results.experiments[name] = sanitize(
    {
      ...measured,
      model: init?.model ?? null,
      platform: `${process.platform} ${process.arch}`,
      stdinEvents: s.stdinLog.map((e) =>
        e.msg ? { t: e.t, uuid: e.msg.uuid ?? null } : e.raw ? { t: e.t, raw: true } : e,
      ),
      timeline: timeline(s),
      types: [...new Set(s.messages().map((m) => (m.subtype ? `${m.type}/${m.subtype}` : m.type)))],
      costUsd: s
        .messages()
        .filter(isResult)
        .reduce((sum, r) => sum + (r.total_cost_usd ?? 0), 0),
    },
    rep,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.includes('--yes')) {
    console.error('This makes real API calls (haiku, small budget). Re-run with --yes.');
    process.exit(2);
  }
  const names = argv.filter((a) => a !== '--yes');
  const chosen = names.length ? names : Object.keys(experiments);
  mkdirSync(fixtures, { recursive: true });
  const file = join(fixtures, 'results.json');
  const results = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { experiments: {} };
  results.claudeVersion = execFileSync(CLAUDE, ['--version'], { encoding: 'utf8' })
    .trim()
    .split(' ')[0];
  results.node = process.version;
  results.recordedAt = new Date().toISOString().slice(0, 10);
  results.baseArgs = BASE;
  for (const name of chosen) {
    const run = experiments[name];
    if (!run) throw new Error(`unknown experiment ${name}`);
    process.stdout.write(`${name} … `);
    const outcome = await run();
    record(name, outcome, results);
    const e = results.experiments[name];
    console.log(
      `exit=${e.exitCode} signal=${e.signal} cost=$${e.costUsd.toFixed(4)}${e.timedOut ? ' TIMED OUT' : ''}`,
    );
    writeFileSync(file, JSON.stringify(results, null, 2) + '\n');
  }
}

await main();
