import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * On Windows the CLI starts only `claude.exe`: a `.cmd` would need a shell (T19). A test's
 * stand-in therefore has to be a real executable. This one is a few lines of C#, compiled with
 * the `csc.exe` of the .NET Framework that every Windows has: it runs `node <name>.js` next to
 * it with its own command line passed on untouched, so the script sees exactly the arguments
 * the CLI gave, and exits as the script does. Its own pid goes along as `TEST_SHIM_PID`.
 */
const SOURCE = String.raw`
using System;
using System.Diagnostics;
using System.IO;

class Shim {
  static int Main() {
    string line = Environment.CommandLine;
    int at = 0;
    if (line.StartsWith("\"")) { at = line.IndexOf('"', 1) + 1; }
    else { while (at < line.Length && line[at] != ' ' && line[at] != '\t') at++; }
    string rest = line.Substring(at).TrimStart(' ', '\t');
    string self = Process.GetCurrentProcess().MainModule.FileName;
    string script = Path.ChangeExtension(self, ".js");
    string node = File.ReadAllText(Path.ChangeExtension(self, ".node")).Trim();
    var start = new ProcessStartInfo(node, "\"" + script + "\" " + rest);
    start.UseShellExecute = false;
    // The CLI knows this process, not the node behind it; the script reports this pid.
    start.EnvironmentVariables["TEST_SHIM_PID"] = Process.GetCurrentProcess().Id.ToString();
    // A test hands the CLI a bare environment; Windows sockets need SystemRoot.
    if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("SystemRoot"))) {
      start.EnvironmentVariables["SystemRoot"] = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
    }
    using (Process child = Process.Start(start)) {
      child.WaitForExit();
      return child.ExitCode;
    }
  }
}
`;

function csc(): string {
  const windows = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  return join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
}

/** Compiled once per machine and source, then copied: csc takes a second or two. */
async function compiled(): Promise<string> {
  const hash = createHash('sha256').update(SOURCE).digest('hex').slice(0, 12);
  const exe = join(tmpdir(), `lpb-test-shim-${hash}.exe`);
  if (existsSync(exe)) return exe;
  const unique = `${exe}.${process.pid}.${Date.now()}`;
  const source = `${unique}.cs`;
  await writeFile(source, SOURCE, 'utf8');
  try {
    execFileSync(csc(), ['/nologo', '/optimize', `/out:${unique}.exe`, source], {
      stdio: 'pipe',
    });
    // Another test worker may have finished first; either copy is the same program.
    await rename(`${unique}.exe`, exe).catch(() => rm(`${unique}.exe`, { force: true }));
  } finally {
    await rm(source, { force: true });
  }
  return exe;
}

/** Makes `<bin>/<name>.exe` run `<bin>/<name>.js` with the node that runs the tests. */
export async function installWindowsShim(bin: string, name: string): Promise<void> {
  await copyFile(await compiled(), join(bin, `${name}.exe`));
  await writeFile(join(bin, `${name}.node`), process.execPath, 'utf8');
}
