import { subscribeToBoard } from '../../../src/web/api/events';
import type { BoardEvent } from '../../../src/contract/v1/index';
import { fakeEventSource, type FakeEventSource } from '../support/eventSource';
import { aTask } from '../support/fixtures';

function subscription() {
  const events: BoardEvent[] = [];
  const statuses: string[] = [];
  let resyncs = 0;
  let source: FakeEventSource | undefined;

  const stop = subscribeToBoard({
    url: 'http://127.0.0.1:7432/api/v1/events',
    create: (url) => (source = fakeEventSource(url)),
    onEvent: (event) => events.push(event),
    onStatus: (status) => statuses.push(status),
    onResync: () => (resyncs += 1),
  });

  if (!source) throw new Error('the subscription did not open a stream');
  return { events, statuses, stop, source, resyncs: () => resyncs };
}

describe('the board’s event stream', () => {
  it('opens the stream the client points at and says it is connecting', () => {
    const { source, statuses } = subscription();

    expect(source.url).toBe('http://127.0.0.1:7432/api/v1/events');
    expect(statuses).toEqual(['connecting']);
  });

  it('turns a frame into the event the contract describes', () => {
    const { source, events, statuses } = subscription();
    const task = aTask();

    source.open();
    source.message(JSON.stringify({ type: 'task.created', task }));

    expect(statuses).toEqual(['connecting', 'live']);
    expect(events).toEqual([{ type: 'task.created', task }]);
  });

  it('ignores a frame that is not a board event (INVARIANT: no invented state)', () => {
    const { source, events } = subscription();

    source.open();
    source.message('not json at all');
    source.message(JSON.stringify({ type: 'task.exploded' }));
    source.message(JSON.stringify({ type: 'task.created', task: { id: 'nope' } }));

    expect(events).toEqual([]);
  });

  it('reports the break and asks for a full read when the stream comes back (§14)', () => {
    const { source, statuses, resyncs } = subscription();

    source.open();
    expect(resyncs()).toBe(0);

    source.error();
    source.open();

    expect(statuses).toEqual(['connecting', 'live', 'offline', 'live']);
    // Nothing that happened while the stream was down was delivered, so everything is re-read.
    expect(resyncs()).toBe(1);
  });

  it('closes the stream when the page stops listening', () => {
    const { source, stop, events } = subscription();

    stop();
    source.open();
    source.message(JSON.stringify({ type: 'board.changed' }));

    expect(source.closed).toBe(true);
    expect(events).toEqual([]);
  });
});
