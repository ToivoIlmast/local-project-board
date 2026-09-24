# ADR-0026: AI workflow rules are configurable (`ai.rules`)

Status: accepted (2026-09-24)

## Context

The "## Rules" section of the generated AI instructions — what an agent must not violate about
the mechanics of the API — was a hardcoded array of strings in `contract/v1/instructions.ts`.
A project may want its own rules (its own workflow conventions on top of the board's), and
until now the only way to add one was to hand-edit the instructions text after copying it,
which is lost the next time it is generated or copied.

## Decision

- The default rules move to `DEFAULT_AI_RULES`, an exported constant in
  `contract/v1/instructions.ts` — still the single source a route table (ADR-0005) and now also
  the config schema's default both draw from, so an unconfigured board and this constant cannot
  drift.
- `server/config/schema.ts` adds `ai.rules: string[]` next to the existing `ai.allowSourceEdits`,
  seeded from `DEFAULT_AI_RULES` (`defaultConfig`). It follows the config system already in
  place (ADR-0021): `board.config.yaml` or the user config may set `ai.rules`, and like every
  other list in the config, doing so replaces the whole list — there is no per-rule override.
- `generateInstructions` takes an optional `rules` option; when it is omitted it falls back to
  `DEFAULT_AI_RULES`. Every real call site (the `/instructions` route, the CLI's offline path)
  always passes `config.ai.rules` explicitly, so the fallback only matters to a caller — a test,
  mainly — that does not care about rules at all.
- No `BOARD_*` environment variable and no CLI flag are added for `ai.rules`: arrays are not
  exposed through either today (`statuses` is the existing precedent), and a rule list does not
  fit a single flag value.

## Consequences

- A project can add its own rules by committing `ai:\n  rules: [...]` to `board.config.yaml`;
  a personal default lives in the user config instead.
- The board's current rules — built-in or overridden — are always exactly what
  `npx local-project-board instructions` prints, so nothing needs to document the default text
  separately; a second, hand-maintained copy of it would drift the moment either side changed.
- `server/config` now imports one constant from `contract/v1`. The dependency still runs one
  way only (config depends on contract, never the reverse), consistent with how `cli/board.ts`
  already shapes `AppConfig` into the contract's `BoardFacts` for the same generator.
