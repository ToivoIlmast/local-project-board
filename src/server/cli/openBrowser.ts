import { spawn } from 'node:child_process';
import { release } from 'node:os';

/** Best effort: the URL is always printed, so failing to open a browser is not an error. */
export function openBrowser(url: string): void {
  const { command, args } = browserCommand(url, {
    platform: process.platform,
    env: process.env,
    release: release(),
  });
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // ignore
  }
}

export interface BrowserHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** `os.release()`: the kernel of WSL names Microsoft. */
  release: string;
}

export function browserCommand(
  url: string,
  host: BrowserHost,
): { command: string; args: string[] } {
  if (host.platform === 'darwin') return { command: 'open', args: [url] };
  if (host.platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '""', url] };
  if (isWsl(host)) return { command: 'explorer.exe', args: [url] };
  return { command: 'xdg-open', args: [url] };
}

/**
 * WSL sets WSL_DISTRO_NAME, but `sudo` and other clean environments drop it; its kernel still
 * says Microsoft. Without this, a board started so tried `xdg-open`, which WSL usually lacks,
 * and opened nothing (T10, measured).
 */
function isWsl(host: BrowserHost): boolean {
  return (
    host.platform === 'linux' &&
    (host.env.WSL_DISTRO_NAME !== undefined || /microsoft/i.test(host.release))
  );
}
