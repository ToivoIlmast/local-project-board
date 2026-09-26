import { API_BASE_PATH, claudeCodeCommand, claudeCodePrompt } from '../../src/contract/v1/index.js';

const BOARD = 'http://127.0.0.1:7432';

describe('the prompt that starts Claude Code on a task (T19)', () => {
  it('names the task and points at the live handoff of that very task', () => {
    expect(claudeCodePrompt('T13', BOARD)).toBe(
      'Work on task T13 of the local board: read GET ' +
        `${BOARD}${API_BASE_PATH}/tasks/T13/handoff and follow it.`,
    );
  });

  it('carries only the address of the handoff, never its text or a token (INVARIANT)', () => {
    const prompt = claudeCodePrompt('T13', BOARD);
    expect(prompt).not.toMatch(/token|authorization|bearer/i);
    // Short enough for any command line, whatever the task says: the text is fetched, not sent.
    expect(prompt.length).toBeLessThan(200);
    expect(claudeCodePrompt('T13', BOARD)).toBe(prompt);
  });

  it('is the same on the copied command line and in the launcher: one function decides', () => {
    expect(claudeCodeCommand('T13', BOARD)).toBe(`claude "${claudeCodePrompt('T13', BOARD)}"`);
  });

  it('is safe inside double quotes for every id it accepts', () => {
    for (const id of ['T1', 'T13', 'ABC99', 'TASK123456789']) {
      expect(claudeCodePrompt(id, BOARD)).toMatch(/^[\w :./-]+$/);
    }
  });

  it('refuses an id that is not a task id: it is never put into a command line (INVARIANT)', () => {
    for (const id of ['', 'banana', 'T1; rm -rf /', 'T1 "x"', '$(id)', 'T0', 't1', 'T1\nT2']) {
      expect(() => claudeCodePrompt(id, BOARD)).toThrow(/task id/);
      expect(() => claudeCodeCommand(id, BOARD)).toThrow(/task id/);
    }
  });

  it('refuses an address that is not the loopback board, so nothing else reaches the line', () => {
    for (const url of [
      '',
      'http://example.com:7432',
      'https://127.0.0.1:7432',
      'http://127.0.0.1',
      'http://127.0.0.1:7432/',
      'http://127.0.0.1:7432" ; echo "',
      'http://user:pw@127.0.0.1:7432',
    ]) {
      expect(() => claudeCodePrompt('T1', url)).toThrow(/board address/);
    }
  });
});
