import { clearImmediate, clearInterval, setImmediate, setInterval } from 'node:timers';
import { TextDecoder, TextEncoder } from 'node:util';
import '@testing-library/jest-dom';

/**
 * A browser environment with the few Node globals a real server needs. The integration
 * tests run the board's own Express app in this process, and jsdom provides neither
 * `TextEncoder` (a real browser does) nor `setImmediate` (Node does).
 */
const environment = globalThis as unknown as Record<string, unknown>;
environment['TextEncoder'] ??= TextEncoder;
environment['TextDecoder'] ??= TextDecoder;
environment['setImmediate'] ??= setImmediate;
environment['clearImmediate'] ??= clearImmediate;
// The event stream keeps a Node timer it can `unref`; jsdom's would be a plain number.
environment['setInterval'] = setInterval;
environment['clearInterval'] = clearInterval;

// What the page is looking at lives in the address bar, so every test starts at the board.
beforeEach(() => {
  window.history.replaceState({}, '', '/');
});
