# ADR-0021: Configuration is an adapter concern, validated per layer

Status: accepted (2026-09-23)

## Context

Configuration arrives from CLI flags, environment variables, a project file and a user file. The core must not know about any of them: it is pure TypeScript that also has to run in a browser.

Validating only the merged result gives errors that cannot say where a value came from — "config.server.port must be a number" is not much help when the value is in a file the user forgot about.

## Decision

- `server/config` owns YAML, `process.env` and flags. The core receives normalized values as plain arguments; nothing in `src/core` reads configuration.
- Precedence: CLI > env > `board.config.yaml` > user config > defaults. A layer overrides the values it sets; lists are replaced whole.
- Every layer is validated on its own with a strict schema before merging, so an error names the layer it came from (`board.config.yaml`, `BOARD_PORT`, `--port`) next to the config path (`config.tasks.idPrefix`).
- Unknown keys are an error, at every layer. A typo must not be swallowed because a default exists.
- Environment variables are an explicit list, not a name-to-path convention.
- There is no section for plugins and no open `Record<string, unknown>`. Extension configuration is designed together with a real plugin contract (ADR-0014).
- A configuration problem exits with code 1 and a readable message, never a stack trace.

## Consequences

- Adding a config key means touching one schema and, if it should be settable from the environment, one map.
- The validated `AppConfig` has no optional fields: no defaulting is left for the code downstream.
- Removing a status that tasks still use is refused at startup by a core rule (`assertNoOrphanedStatuses`), which names the status and the tasks.
