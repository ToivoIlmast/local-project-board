import { browserCommand } from '../../src/server/cli/openBrowser.js';

const URL = 'http://127.0.0.1:7432/';
const LINUX = '6.8.0-45-generic';
const WSL2 = '6.18.33.2-microsoft-standard-WSL2';
const WSL1 = '4.4.0-22621-Microsoft';

describe('browserCommand', () => {
  it('uses open on macOS', () => {
    expect(browserCommand(URL, { platform: 'darwin', env: {}, release: '24.0.0' })).toEqual({
      command: 'open',
      args: [URL],
    });
  });

  it('uses start through cmd on Windows, with an empty window title', () => {
    expect(browserCommand(URL, { platform: 'win32', env: {}, release: '10.0.22621' })).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '""', URL],
    });
  });

  it('uses xdg-open on Linux', () => {
    expect(browserCommand(URL, { platform: 'linux', env: {}, release: LINUX })).toEqual({
      command: 'xdg-open',
      args: [URL],
    });
  });

  it('opens the browser of Windows from WSL', () => {
    const env = { WSL_DISTRO_NAME: 'Ubuntu-24.04' };
    expect(browserCommand(URL, { platform: 'linux', env, release: WSL2 })).toEqual({
      command: 'explorer.exe',
      args: [URL],
    });
  });

  it('knows WSL by its kernel when WSL_DISTRO_NAME is gone, as under sudo (T10, measured)', () => {
    for (const release of [WSL2, WSL1]) {
      expect(browserCommand(URL, { platform: 'linux', env: {}, release }).command).toBe(
        'explorer.exe',
      );
    }
  });
});
