import { createEventHub, type EventHub } from '../../../src/web/api/eventHub';
import { subscribeToSharedBoard } from '../../../src/web/api/sharedEvents';
import { createBoardStore, type BoardStore } from '../../../src/web/api/index';
import type { BoardEvent } from '../../../src/contract/v1/index';
import { fakeEventSource, type FakeEventSource } from '../support/eventSource';
import { fakeBoard, type FakeBoard } from '../support/fakeBoard';
import { aTask } from '../support/fixtures';
import { fakePage, hubConnection } from '../support/ports';

const URL = 'http://127.0.0.1:7432/api/v1/events';

/** A hub as the worker makes one, with every stream it opens kept for the test. */
function aHub(): { hub: EventHub; sources: FakeEventSource[] } {
  const sources: FakeEventSource[] = [];
  const hub = createEventHub({
    create: (url) => {
      const source = fakeEventSource(url);
      sources.push(source);
      return source;
    },
  });
  return { hub, sources };
}

/** One tab of the board subscribed through the hub, recording what it was told. */
function aTab(hub: EventHub, page = fakePage()) {
  const events: BoardEvent[] = [];
  const statuses: string[] = [];
  let resyncs = 0;
  const own: FakeEventSource[] = [];
  const link = hubConnection((port) => hub.connect(port));
  const stop = subscribeToSharedBoard({
    url: URL,
    connectHub: () => link.connection,
    page,
    create: (url) => {
      const source = fakeEventSource(url);
      own.push(source);
      return source;
    },
    onEvent: (event) => events.push(event),
    onStatus: (status) => statuses.push(status),
    onResync: () => (resyncs += 1),
  });
  return { events, statuses, resyncs: () => resyncs, stop, link, own, page };
}

const created = (title: string): string =>
  JSON.stringify({ type: 'task.created', task: aTask({ id: 'T9', title }) });

describe('one stream for all the tabs of a browser (T62, ADR-0031)', () => {
  it('opens a single stream however many tabs listen', () => {
    const { hub, sources } = aHub();

    const tabs = Array.from({ length: 7 }, () => aTab(hub));

    expect(sources).toHaveLength(1);
    expect(sources[0]?.url).toBe(URL);
    expect(hub.size()).toBe(7);
    // No tab opened a stream of its own.
    expect(tabs.flatMap((tab) => tab.own)).toEqual([]);
  });

  it('brings every tab every event, the first tab and the last alike', () => {
    const { hub, sources } = aHub();
    const tabs = [aTab(hub), aTab(hub), aTab(hub)];

    sources[0]?.open();
    sources[0]?.message(created('Hello'));

    for (const tab of tabs) {
      expect(tab.statuses).toEqual(['connecting', 'connecting', 'live']);
      expect(tab.events).toEqual([
        { type: 'task.created', task: aTask({ id: 'T9', title: 'Hello' }) },
      ]);
    }
  });

  it('tells a tab that comes late how the stream is now', () => {
    const { hub, sources } = aHub();
    aTab(hub);
    sources[0]?.open();

    const late = aTab(hub);

    expect(late.statuses).toEqual(['connecting', 'live']);
  });

  it('drops a frame that is not a board event in every tab (INVARIANT: no invented state)', () => {
    const { hub, sources } = aHub();
    const tab = aTab(hub);

    sources[0]?.open();
    sources[0]?.message('not json');
    sources[0]?.message(JSON.stringify({ type: 'task.exploded' }));

    expect(tab.events).toEqual([]);
  });

  it('asks every tab to read the board again when the stream comes back after a break', () => {
    const { hub, sources } = aHub();
    const tabs = [aTab(hub), aTab(hub)];
    sources[0]?.open();
    expect(tabs.map((tab) => tab.resyncs())).toEqual([0, 0]);

    sources[0]?.error();
    sources[0]?.open();

    for (const tab of tabs) {
      expect(tab.statuses.slice(-2)).toEqual(['offline', 'live']);
      expect(tab.resyncs()).toBe(1);
    }
  });

  it('keeps the stream for the others when a tab is closed, and closes it with the last tab', () => {
    const { hub, sources } = aHub();
    const first = aTab(hub);
    const second = aTab(hub);
    sources[0]?.open();

    // The first tab — the one that opened the stream — goes away.
    first.page.fire('pagehide', false);
    sources[0]?.message(created('Still here'));

    expect(sources[0]?.closed).toBe(false);
    expect(first.events).toEqual([]);
    expect(second.events).toHaveLength(1);

    second.stop();
    expect(hub.size()).toBe(0);
    expect(sources[0]?.closed).toBe(true);
    expect(second.link.closed()).toBe(true);
  });

  it('opens a new stream for a tab that comes after the last one left', () => {
    const { hub, sources } = aHub();
    aTab(hub).stop();

    const next = aTab(hub);
    sources[1]?.open();

    expect(sources).toHaveLength(2);
    // A new stream is a first connection, not a reconnection.
    expect(next.statuses).toEqual(['connecting', 'connecting', 'live']);
    expect(next.resyncs()).toBe(0);
  });

  it('counts a tab back in when it returns from the back/forward cache, and reads the board', () => {
    const { hub, sources } = aHub();
    const tab = aTab(hub);
    sources[0]?.open();

    tab.page.fire('pagehide', true);
    expect(hub.size()).toBe(0);
    tab.page.fire('pageshow', true);

    expect(hub.size()).toBe(1);
    expect(tab.resyncs()).toBe(1);
    // A first load is not a return from the cache.
    tab.page.fire('pageshow', false);
    expect(tab.resyncs()).toBe(1);
  });

  it('stops listening when the page stops, and forgets the page’s lifecycle', () => {
    const { hub, sources } = aHub();
    const tab = aTab(hub);
    sources[0]?.open();

    tab.stop();
    sources[0]?.message(created('Too late'));

    expect(tab.events).toEqual([]);
    expect(tab.link.sent).toEqual([{ kind: 'hello', url: URL }, { kind: 'bye' }]);
    expect(tab.page.count()).toBe(0);
  });
});

describe('a tab that cannot share the stream', () => {
  it('opens its own where the browser has no shared worker', () => {
    const own: FakeEventSource[] = [];
    const events: BoardEvent[] = [];
    subscribeToSharedBoard({
      url: URL,
      connectHub: () => undefined,
      create: (url) => {
        const source = fakeEventSource(url);
        own.push(source);
        return source;
      },
      onEvent: (event) => events.push(event),
      onStatus: () => undefined,
      onResync: () => undefined,
    });

    own[0]?.open();
    own[0]?.message(created('Alone'));

    expect(own).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('opens its own where the worker has no EventSource', () => {
    const tab = aTab(createEventHub({ create: undefined }));

    expect(tab.own).toHaveLength(1);
    expect(tab.link.closed()).toBe(true);
    tab.own[0]?.open();
    tab.own[0]?.error();
    tab.own[0]?.open();
    expect(tab.resyncs()).toBe(1);
  });

  it('opens its own when the worker could not start, and closes it when the page stops', () => {
    const { hub } = aHub();
    const tab = aTab(hub);

    tab.link.fail();
    expect(tab.own).toHaveLength(1);
    tab.stop();

    expect(tab.own[0]?.closed).toBe(true);
  });
});

describe('the state of every tab after a break (T62)', () => {
  /** A tab's store bound to the board through the hub, as `BoardProvider` binds it. */
  function aStoreTab(hub: EventHub, board: FakeBoard): { store: BoardStore; stop: () => void } {
    const store = createBoardStore(board.client);
    const link = hubConnection((port) => hub.connect(port));
    const stop = subscribeToSharedBoard({
      url: URL,
      connectHub: () => link.connection,
      page: fakePage(),
      onEvent: (event) => void store.handleEvent(event),
      onStatus: (status) => store.setConnection(status),
      onResync: () => void store.load(),
    });
    return { store, stop };
  }

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('reads the board, the documents and the history again in every tab when the stream returns', async () => {
    const board = fakeBoard({ tasks: [aTask({ id: 'T1', title: 'Before' })] });
    const { hub, sources } = aHub();
    const tabs = [aStoreTab(hub, board), aStoreTab(hub, board)];
    for (const { store } of tabs) {
      await store.load();
      await store.loadDocuments('T1');
      await store.loadHistory('T1');
    }
    sources[0]?.open();

    // The board changes while the stream is down; nothing is delivered.
    sources[0]?.error();
    board.tasks[0] = aTask({ id: 'T1', title: 'After' });
    board.documents.set('T1/plan.md', {
      meta: { taskId: 'T1', name: 'plan.md', size: 7, updatedAt: '2026-10-28T10:00:00.000Z' },
      content: '# Plan\n',
    });
    board.calls.length = 0;
    sources[0]?.open();
    await settle();

    for (const { store } of tabs) {
      expect(store.getState().connection).toBe('live');
      expect(store.getState().tasks.map((task) => task.title)).toEqual(['After']);
      expect(store.getState().documents['T1']?.map((d) => d.name)).toEqual(['plan.md']);
    }
    // Each tab read its open history again, not only the list of tasks.
    expect(board.calls.filter((call) => call === 'versions')).toHaveLength(2);
    expect(board.calls.filter((call) => call === 'checks')).toHaveLength(2);
  });

  it('brings an event to a tab that did not open the stream', async () => {
    const board = fakeBoard();
    const { hub, sources } = aHub();
    const [first, second] = [aStoreTab(hub, board), aStoreTab(hub, board)];
    await first?.store.load();
    await second?.store.load();
    sources[0]?.open();

    first?.stop();
    sources[0]?.message(created('Heard'));
    await settle();

    expect(second?.store.getState().tasks.map((task) => task.title)).toEqual(['Heard']);
    expect(first?.store.getState().tasks).toEqual([]);
  });
});
