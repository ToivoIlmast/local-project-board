# ADR-0027: README translations are checked against git history

Status: accepted (2026-09-25)

## Context

`README.fi.md` and `README.sv.md` carry a first line `<!-- Based on README.md @ <commit> -->`
(PROPOSAL §27). Nothing read it: both said `uncommitted`, and by the time this was noticed
both translations had missed two changes to `README.md`. A promise that translations do not
drift, with nothing that can fail, is not a promise.

## Decision

- `test/docs/readmeTranslations.test.ts` compares the commit in each translation's header with
  `git log -1 --format=%H -- README.md`. A mismatch fails `npm test` with the two commits named.
  A header that is not in that form (including `uncommitted`) fails too, and so does a
  `README.md` with changes not yet committed. Translations are found by name
  (`README.<lang>.md`), so a new language cannot be left out of the check.
- Where git cannot answer — no git, not a checkout of this repository (an unpacked package, or a
  directory that only sits inside another repository), a shallow clone — the check reports
  `unavailable`. The test is then **skipped with the reason in its title and a warning**, so the
  run says it did not verify. It never passes in that case.
- Under `CI` the same situation is a **failure**: a check that silently does not run where it
  matters is worth nothing. The CI job therefore checks out full history (`fetch-depth: 0`).
- The header must equal the last commit that changed `README.md`, so the commit that changes
  `README.md` cannot also carry the new header (it does not exist yet). A change is two commits:
  the README, then the translations with their headers.

## Consequences

- Squashing or rebasing a pull request rewrites the commit the headers name, so the project
  merges with merge commits (as it does now); otherwise the headers go stale on `main`.
- Being red between the two commits is the point: `npm test` fails while the translations lag,
  and the failure says which commit to write into the header.
- The check proves the header was updated, not that the translation is right. Reading the
  translation against the README is still a person's job.
