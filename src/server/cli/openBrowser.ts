import { spawn } from 'node:child_process';

/** Best effort: the URL is always printed, so failing to open a browser is not an error. */
export function openBrowser(url: string): void {
  const { command, args } = browserCommand(url);
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // ignore
  }
}

function browserCommand(url: string): { command: string; args: string[] } {
  if (process.platform === 'darwin') return { command: 'open', args: [url] };
  if (process.platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '""', url] };
  if (process.env.WSL_DISTRO_NAME) return { command: 'explorer.exe', args: [url] };
  return { command: 'xdg-open', args: [url] };
}
