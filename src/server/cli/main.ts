import { runCli } from './run.js';

/**
 * The executable. It does nothing but connect the process to the CLI: arguments in, text out,
 * signals to a clean shutdown (§13).
 */
const result = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  write: (text) => console.log(text),
  writeError: (text) => console.error(text),
});

if (result.stop === undefined) {
  process.exit(result.exitCode);
}

const stop = result.stop;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
