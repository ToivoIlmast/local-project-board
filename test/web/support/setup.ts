import { clearImmediate, clearInterval, setImmediate, setInterval } from 'node:timers';
import { TextDecoder, TextEncoder } from 'node:util';
import { deserialize, serialize } from 'node:v8';
import '@testing-library/jest-dom';
import { reloadLanguage } from '../../../src/web/shared/i18n/store';

/**
 * A browser environment with the few Node globals a real server needs. The integration
 * tests run the board's own Express app in this process, and jsdom provides neither
 * `TextEncoder` (a real browser does), nor `setImmediate` (Node does), nor `structuredClone`
 * (which the markdown provider uses to hand out its own copy of the workflow settings).
 */
const environment = globalThis as unknown as Record<string, unknown>;
environment['TextEncoder'] ??= TextEncoder;
environment['TextDecoder'] ??= TextDecoder;
environment['structuredClone'] ??= <T>(value: T): T => deserialize(serialize(value)) as T;
environment['setImmediate'] ??= setImmediate;
environment['clearImmediate'] ??= clearImmediate;
// The event stream keeps a Node timer it can `unref`; jsdom's would be a plain number.
environment['setInterval'] = setInterval;
environment['clearInterval'] = clearInterval;

// The language of the interface is a saved choice: no test inherits another's.
beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
  reloadLanguage();
});

// What the page is looking at lives in the address bar, so every test starts at the board.
beforeEach(() => {
  window.history.replaceState({}, '', '/');
});
