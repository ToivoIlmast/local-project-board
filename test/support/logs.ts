const LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;

export interface CapturedConsole {
  /** Everything written to the console while the capture was in place. */
  lines: string[];
  text(): string;
  restore(): void;
}

/**
 * The board prints to the console and nowhere else, so this is the whole of "the logs".
 * Tests use it to prove that the session token never reaches them.
 */
export function captureConsole(): CapturedConsole {
  const lines: string[] = [];
  const original = LEVELS.map((level) => [level, console[level]] as const);
  for (const level of LEVELS) {
    console[level] = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(' '));
    };
  }
  return {
    lines,
    text: () => lines.join('\n'),
    restore() {
      for (const [level, fn] of original) console[level] = fn;
    },
  };
}
