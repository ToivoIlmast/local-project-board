# Claude Code stream-json fixtures, version 2.1.330

Real traffic of `claude -p --input-format stream-json --output-format stream-json`, recorded
for the Console mode (task T16) and used by the tests of `src/server/cli/console/` (task T17).

- **Origin:** a byte-for-byte copy of `test/spike/console/fixtures/` made by T17 without any
  change. The originals stay in `test/spike/console/fixtures/` (the T16 spike test reads them);
  they were recorded by the manual harness `test/spike/console/live.mjs`.
- **Claude Code:** 2.1.330 (`claude.exe`, native build), model `claude-haiku-5-5`.
- **OS:** Windows 11 Home 10.0.26200, x64; Node v22.14.0.
- **Arguments:** per experiment in `results.json` (`experiments.<name>.args`). Base:
  `-p --input-format stream-json --output-format stream-json --verbose --replay-user-messages
  --model haiku --setting-sources project --no-session-persistence --max-budget-usd 0.25
  --session-id <uuid>`, plus `--tools ...`, `--permission-prompts none` or
  `--permission-mode acceptEdits` where the experiment needs them.
- **Files:** `<name>.stdin.ndjson` is what was written to the process, `<name>.stdout.ndjson`
  what it printed. In `bad-input.stdin.ndjson` a line `{"__raw": "..."}` stands for text that
  was written to stdin as is (not JSON); `uuid-edge-cases` holds a message without `uuid`, a
  repeated uuid and `"uuid":"not-a-uuid"` on purpose.
- **Sanitization:** the text of `thinking` blocks is replaced with `<redacted>`; `signature`
  fields are removed; local paths became `<WORK>`, `<HOME>`, `<TMP>`; lists of the user's
  plugins, skills and commands became counters. No e-mail addresses. The hygiene test in
  `test/cli/console/streamJson.test.ts` checks this.
- **Do not edit by hand.** To record again, use the harness and add a new directory for the
  new Claude Code version.
