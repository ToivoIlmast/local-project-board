import type { ConsoleEvent } from '../../../src/contract/v1/index';
import {
  buildConsoleItems,
  userNote,
  type ConsoleItem,
} from '../../../src/web/features/tasks/model/consoleView';
import { entriesOf, fixtureRead, readOf } from '../support/consoleJournal';

type Of<K extends ConsoleItem['kind']> = Extract<ConsoleItem, { kind: K }>;
const ofKind = <K extends ConsoleItem['kind']>(items: readonly ConsoleItem[], kind: K): Of<K>[] =>
  items.filter((item): item is Of<K> => item.kind === kind);

const build = (name: string) => {
  const { entries, state } = fixtureRead(name);
  return { entries, state, items: buildConsoleItems(entries, state) };
};

const itemsOf = (events: ConsoleEvent[]) => {
  const { entries, state } = readOf(events);
  return buildConsoleItems(entries, state);
};

describe('the console feed of a subagent (fixture subagent)', () => {
  const { entries, items } = build('subagent');
  const agent = ofKind(items, 'tool').find((item) => item.tool === 'Agent');

  it('has one card for the Agent call, with the call and its result in it', () => {
    expect(agent).toBeDefined();
    expect(ofKind(items, 'tool').filter((item) => item.tool === 'Agent')).toHaveLength(1);
    expect(agent?.result).toBeDefined();
  });

  it('puts what the subagent did inside the card and not in the feed', () => {
    const inside = ofKind(agent?.children ?? [], 'tool');
    expect(inside.map((item) => item.tool)).toEqual(['Read']);
    expect(inside[0]?.result).toBeDefined();
    expect(ofKind(items, 'tool').some((item) => item.tool === 'Read')).toBe(false);
  });

  it('keeps what came after turn.ended inside the card too', () => {
    const turnEnded = entries.find((entry) => entry.event.kind === 'turn.ended');
    const late = ofKind(agent?.children ?? [], 'assistant').filter(
      (item) => item.seq > (turnEnded?.seq ?? Infinity),
    );
    expect(late).toHaveLength(1);
    expect(late[0]?.text).not.toBe('');
  });
});

describe('several messages of one turn (fixture multi-message)', () => {
  const { items } = build('multi-message');
  const users = ofKind(items, 'user');

  it('shows the three messages in the order they were sent', () => {
    expect(users.map((item) => item.text)).toEqual([
      'Reply with exactly the word ALPHA and nothing else.',
      'Reply with exactly the word BRAVO and nothing else.',
      'Reply with exactly the word CHARLIE and nothing else.',
    ]);
  });

  it('brackets the two messages that went into one turn; the one that went alone has none', () => {
    expect(users[0]?.bracket).toBeUndefined();
    expect(users[1]?.bracket).toEqual({ size: 2, index: 1 });
    expect(users[2]?.bracket).toEqual({ size: 2, index: 2 });
  });

  it('shows the answer of a message once, whatever the number of events it came in', () => {
    const answers = ofKind(items, 'assistant');
    expect(answers).toHaveLength(2);
    expect(answers[0]?.text).toBe('ALPHA');
    expect(new Set(answers.map((item) => item.apiMessageId)).size).toBe(2);
  });
});

describe('a message sent in the middle of a turn (fixture mid-turn-message)', () => {
  const { items } = build('mid-turn-message');
  const users = ofKind(items, 'user');

  it('is told as added to the work that is going on', () => {
    expect(users).toHaveLength(2);
    expect(users[0] && userNote(users[0])).toBeUndefined();
    expect(users[1]?.join).toBe('joined-turn');
    expect(users[1] && userNote(users[1])).toBe('Added to the current work');
  });
});

describe('grouping by identifiers', () => {
  it('joins the events of one apiMessageId, and keeps two messages apart', () => {
    const items = itemsOf([
      { kind: 'assistant.text', apiMessageId: 'm1', scope: null, text: 'one' },
      { kind: 'tool.call', toolUseId: 't1', tool: 'Bash', summary: 'ls', scope: null },
      { kind: 'assistant.text', apiMessageId: 'm1', scope: null, text: 'two' },
      { kind: 'assistant.text', apiMessageId: 'm2', scope: null, text: 'three' },
    ]);
    expect(ofKind(items, 'assistant').map((item) => item.text)).toEqual(['one\n\ntwo', 'three']);
  });

  it('puts a result with its call, error or not, wherever it arrives', () => {
    const items = itemsOf([
      { kind: 'tool.call', toolUseId: 't1', tool: 'Bash', summary: 'ls', scope: null },
      { kind: 'tool.call', toolUseId: 't2', tool: 'Read', summary: 'a.txt', scope: null },
      { kind: 'tool.result', toolUseId: 't2', isError: true, preview: 'nope', scope: null },
      { kind: 'tool.result', toolUseId: 't1', isError: false, preview: 'ok', scope: null },
    ]);
    expect(
      ofKind(items, 'tool').map((item) => [item.tool, item.result?.isError, item.result?.preview]),
    ).toEqual([
      ['Bash', false, 'ok'],
      ['Read', true, 'nope'],
    ]);
  });

  it('keeps a result whose call it never saw, as a result', () => {
    const items = itemsOf([
      { kind: 'tool.result', toolUseId: 'lost', isError: false, preview: 'x', scope: null },
    ]);
    expect(ofKind(items, 'tool')).toHaveLength(1);
    expect(ofKind(items, 'tool')[0]?.tool).toBeUndefined();
  });

  it('shows what a scope names at top level when its Agent call is not in the journal', () => {
    const items = itemsOf([
      { kind: 'assistant.text', apiMessageId: 'm1', scope: 'unknown-agent', text: 'orphan' },
    ]);
    expect(ofKind(items, 'assistant').map((item) => item.text)).toEqual(['orphan']);
  });
});

describe('series of events fold into one line', () => {
  const retry: ConsoleEvent = {
    kind: 'notice',
    level: 'warning',
    code: 'api_retry',
    text: 'again',
  };

  it('folds a run of the same notice, and not the one that differs', () => {
    const notices = ofKind(itemsOf([retry, retry, retry, { ...retry, level: 'error' }]), 'notice');
    expect(notices.map((item) => [item.level, item.count])).toEqual([
      ['warning', 3],
      ['error', 1],
    ]);
  });

  it('folds stderr lines and unknown protocol events into one count each', () => {
    const items = itemsOf([
      { kind: 'runner.stderr', text: 'a' },
      { kind: 'runner.stderr', text: 'b' },
      { kind: 'protocol.unknown', type: 'x' },
      { kind: 'protocol.unknown', type: 'y' },
    ]);
    expect(ofKind(items, 'series').map((item) => [item.what, item.count])).toEqual([
      ['stderr', 2],
      ['unknown', 2],
    ]);
  });

  it('does not fold across something that was said in between', () => {
    const items = itemsOf([
      retry,
      { kind: 'assistant.text', apiMessageId: 'm', scope: null, text: 'hi' },
      retry,
    ]);
    expect(ofKind(items, 'notice').map((item) => item.count)).toEqual([1, 1]);
  });
});

describe('the place of an item', () => {
  it('is the seq of its first event', () => {
    const entries = entriesOf(
      [
        { kind: 'assistant.text', apiMessageId: 'm1', scope: null, text: 'one' },
        { kind: 'tool.call', toolUseId: 't1', tool: 'Bash', summary: 'ls', scope: null },
        { kind: 'assistant.text', apiMessageId: 'm1', scope: null, text: 'two' },
      ],
      10,
    );
    const items = buildConsoleItems(entries, readOf([]).state);
    expect(items.map((item) => [item.kind, item.seq])).toEqual([
      ['assistant', 10],
      ['tool', 11],
    ]);
  });
});
