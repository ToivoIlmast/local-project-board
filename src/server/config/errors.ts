export interface ConfigIssue {
  /** Where the value belongs, e.g. config.server.port. */
  path: string;
  message: string;
  /** Where it came from: a file path, an environment variable or a flag. */
  source: string;
}

/** A configuration problem is reported to the user, not thrown as a stack trace. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  readonly exitCode = 1;

  constructor(
    message: string,
    readonly issues: ConfigIssue[] = [],
  ) {
    super(message);
  }

  static fromIssues(issues: ConfigIssue[]): ConfigError {
    const lines = issues.map((issue) => `  ${issue.path}: ${issue.message} (${issue.source})`);
    return new ConfigError(['Invalid configuration:', ...lines].join('\n'), issues);
  }
}
