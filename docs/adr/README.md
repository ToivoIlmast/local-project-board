# Architecture Decision Records

| #    | Decision                                                                                                                         | Status   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 0001 | [Board state lives in an untracked .board/ directory](0001-board-state-lives-in-an-untracked-board-directory.md)                 | accepted |
| 0002 | [Markdown files are the default and only MVP storage](0002-markdown-files-are-the-default-and-only-mvp-storage.md)               | accepted |
| 0003 | [Documents and reports are always files](0003-documents-and-reports-are-always-files.md)                                         | accepted |
| 0004 | [A small Storage port, proven by a conformance suite](0004-a-small-storage-port-proven-by-a-conformance-suite.md)                | accepted |
| 0005 | [The API contract is a zod route table](0005-the-api-contract-is-a-zod-route-table.md)                                           | accepted |
| 0006 | [Two rings: a pure core and adapters](0006-two-rings-a-pure-core-and-adapters.md)                                                | accepted |
| 0007 | [Git is read through the system git binary, read-only](0007-git-is-read-through-the-system-git-binary-read-only.md)              | accepted |
| 0008 | [Local security: loopback, Host/Origin checks, session token](0008-local-security-loopback-host-origin-checks-session-token.md)  | accepted |
| 0009 | [BoardSnapshot is a backup/export format only](0009-boardsnapshot-is-a-backup-export-format-only.md)                             | accepted |
| 0010 | [One npm package, no workspaces](0010-one-npm-package-no-workspaces.md)                                                          | accepted |
| 0011 | [Card position is a fractional index computed by the server](0011-card-position-is-a-fractional-index-computed-by-the-server.md) | accepted |
| 0012 | [The public API is versioned under /api/v1](0012-the-public-api-is-versioned-under-api-v1.md)                                    | accepted |
| 0013 | [Frontend layers: app, pages, features, shared, api](0013-frontend-layers-app-pages-features-shared-api.md)                      | accepted |
| 0014 | [Plugins are an extension point, not an MVP feature](0014-plugins-are-an-extension-point-not-an-mvp-feature.md)                  | accepted |
| 0015 | [Standalone snapshots and sharing are separate concepts](0015-standalone-snapshots-and-sharing-are-separate-concepts.md)         | accepted |
| 0016 | [Tests first; architecture rules are tested](0016-tests-first-architecture-rules-are-tested.md)                                  | accepted |
| 0017 | [No OpenAPI document in the MVP](0017-no-openapi-document-in-the-mvp.md)                                                         | accepted |
| 0018 | [Task updates are last-write-wins](0018-task-updates-are-last-write-wins.md)                                                     | accepted |
| 0019 | [Markdown storage reads from disk on every request](0019-markdown-storage-reads-from-disk-on-every-request.md)                   | accepted |
| 0020 | [Task ids are monotonic and never reused](0020-task-ids-are-monotonic-and-never-reused.md)                                       | accepted |
| 0021 | [Configuration is an adapter concern, validated per layer](0021-configuration-is-an-adapter-concern-validated-per-layer.md)      | accepted |
| 0022 | [Unreadable files are reported separately from tasks](0022-unreadable-files-are-reported-separately-from-tasks.md)               | accepted |
| 0023 | [Agent-written HTML is served sandboxed and offline](0023-agent-written-html-is-served-sandboxed-and-offline.md)                 | accepted |
| 0024 | [One board per directory, claimed by runtime.json](0024-one-board-per-directory-claimed-by-runtime-json.md)                      | accepted |
| 0025 | [The page mirrors the board, without optimistic updates](0025-the-page-mirrors-the-board-without-optimistic-updates.md)          | accepted |
