import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ConsoleEntry,
  ConsoleEvent,
  ConsoleReadResponse,
} from '../../../src/contract/v1/index';
import { foldConsole } from '../../../src/core/rules/console';
import { initialNormalizerState, normalize } from '../../../src/server/cli/console/normalize';

/**
 * The journal of a console run, made the way the product makes it: the recorded stream of a real
 * `claude` (test/fixtures/claude-stream-json) goes through the normalizer of the runner, and the
 * messages of the person — which the runner writes itself — are put in front of their lifecycle.
 * The state is what `foldConsole` computes, as the server would send it.
 */
const dir = join(process.cwd(), 'test', 'fixtures', 'claude-stream-json', '2.1.330');
const AT = '2026-09-21T09:00:00.000Z';

const lines = (file: string): Record<string, unknown>[] =>
  readFileSync(join(dir, file), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

/** The events of a fixture, with `user.message` before the first event about each message. */
export function eventsOfFixture(name: string): ConsoleEvent[] {
  const typed: { uuid: string; text: string }[] = lines(`${name}.stdin.ndjson`).flatMap((line) => {
    const message = line['message'] as { content?: unknown } | undefined;
    return typeof line['uuid'] === 'string' && typeof message?.content === 'string'
      ? [{ uuid: line['uuid'], text: message.content }]
      : [];
  });
  let state = initialNormalizerState();
  const events: ConsoleEvent[] = [{ kind: 'process.started', pid: 1 }, { kind: 'compat.passed' }];
  const said = new Set<string>();
  for (const line of lines(`${name}.stdout.ndjson`)) {
    const out = normalize(state, line);
    state = out.state;
    for (const event of out.events) {
      if (event.kind === 'user.lifecycle' && !said.has(event.messageId)) {
        said.add(event.messageId);
        const sent = typed.find((message) => message.uuid === event.messageId);
        events.push({
          kind: 'user.message',
          origin: 'board',
          messageId: event.messageId,
          text: sent?.text ?? 'message',
        });
      }
      events.push(event);
    }
  }
  return events;
}

export function entriesOf(events: readonly ConsoleEvent[], from = 1): ConsoleEntry[] {
  return events.map((event, index) => ({
    seq: from + index,
    at: AT,
    source: 'runner' as const,
    runnerSeq: from + index,
    event,
  }));
}

/** The answer of the read route for these entries: all of them, and the state of the whole. */
export function readOf(events: readonly ConsoleEvent[]): ConsoleReadResponse {
  const entries = entriesOf(events);
  return { entries, state: foldConsole(entries) as ConsoleReadResponse['state'] };
}

export const fixtureRead = (name: string): ConsoleReadResponse => readOf(eventsOfFixture(name));
