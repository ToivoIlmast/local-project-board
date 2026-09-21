# ADR-0014: Plugins are an extension point, not an MVP feature

Status: accepted (2026-09-21)

## Context

Integrations (GitHub, Jira, AI providers, sharing) may come later; a published plugin API is a compatibility promise.

## Decision

- The plugin API (manifest, capabilities, lifecycle, `PluginContext`) exists only as a design sketch in docs/PROPOSAL.ru.md §22.
- The first two integrations are built inside the repository using only core facades. The plugin API is published only after they work.
- Capabilities describe API access; they are not a sandbox. An in-process Node plugin is trusted code.

## Consequences

- No plugin loader, registry or UI extension system in the MVP.
