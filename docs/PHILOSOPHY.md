# Philosophy

> **A personal developer board in seconds. No ceremony. No cloud required. Sharing when you need it.**

local-project-board is a local workspace for one developer and one Git repository:
tasks, notes, Markdown documents, reports, Git context and AI output, side by side.
It is closer to an advanced developer notebook than to a project management system.

This document exists mainly to say **no**. When a feature request conflicts with it,
this document wins — or it is changed on purpose, in a reviewed commit, with the reason
written down.

Two mottos summarize it:

- **Local-first by default, sharing by exception.**
- **A board in seconds, not a project management system.**

---

## Principles

### 1. Local-first

The board is fully useful without internet, cloud or any external service.
Everything the core needs runs on your machine and lives in your project directory.

- The core never makes outbound network calls. Features that need the network
  (AI providers, tunnels, remote databases, issue trackers) are opt-in and live
  outside the core.
- The UI ships all of its assets. No CDN fonts, no analytics, no telemetry.
- The server listens on `127.0.0.1` unless you explicitly ask for something else.
- If an optional network feature is unreachable, the board keeps working.

### 2. Zero ceremony

```bash
npx local-project-board
```

…and you have a board. No sign-up, no account, no workspace, no organization,
no database to install, no server to configure, no onboarding wizard.

- A config file is optional. Every setting has a working default.
- If a feature needs setup, that setup belongs to the feature, never to first run.

### 3. Personal by default

The primary user is one developer — and the AI agents that developer works with.

- There are no users, assignees, roles, permissions or teams in the core model.
- Board state is not part of your Git history by default. `.board/` is untracked,
  so `main`, `feature/F25` and every worktree of the repository see the same board.
  The board belongs to the project; tasks do not belong to a branch.

### 4. Sharing by exception

Sometimes you need to show your board to a colleague. That should be possible
without making every other day more complicated.

- Sharing is an explicit action, never a default mode.
- From simplest to most involved: export a standalone snapshot file; expose the board
  on your LAN; create a temporary link through a tunnel provider.
- A **standalone snapshot** is a file. **Sharing** is network access to a live board.
  They are different things and are designed separately.
- A shared board is a different trust level from a local board and gets its own,
  stricter security model. Local defaults are never loosened to make sharing easier.

### 5. A developer notebook, not just a kanban

Tasks, notes, documents, reports, Git context and AI results live in one lightweight
workspace. The kanban is one view of that workspace, not the whole product.

### 6. Files are valuable

Plain files outlive tools.

- Documents and reports are always plain files on disk, whatever storage holds
  task metadata.
- With the default storage, everything — tasks included — can be read and edited
  with any editor, `grep` or `cat`, with the server stopped.
- Hand edits are respected: unknown frontmatter fields are preserved, and a file the
  board cannot parse is shown as broken, never silently dropped or rewritten.
- Uninstalling the tool loses nothing.

### 7. AI-friendly

AI agents are first-class users of the board. They use the same versioned local API
as the UI.

- The API is small and predictable. Its contract is the single source for validation,
  frontend types and the instructions you give an agent — so the instructions
  cannot drift from the real API.
- The board does not embed a chat. It gives agents context and a place to put results:
  tasks, documents, reports.
- The core does not depend on any AI vendor.

### 8. Extensible, not bloated

The core does tasks, documents, reports, Git context and the local API. Other storage
engines, AI providers, integrations and sharing come in through a small number of
explicit extension points.

- An extension point is **built** when a second real implementation needs it.
  Until then it is **documented**, not coded.
- Extensions use a public API. They never reach into internal modules.
- Frameworks and libraries — React, Express, the UI toolkit, the storage engine — are
  implementation details. They can be replaced without rewriting the core.

### 9. No enterprise ceremony

We do not add organizations, teams, permission matrices, configurable workflow engines,
approval flows, mandatory authentication or cloud accounts. A feature that needs one of
these probably belongs to a different product.

---

## Two questions for every decision

1. **Does this actually make one developer's work simpler?**
2. **Can it be done more simply?**

If the answer to the first is "not really", or to the second is "yes", don't do it yet.

## Warning signs

We are drifting toward a project management system when we see:

- a field that only makes sense with more than one person (assignee, reporter, watcher);
- a setting that must be configured before the board is useful;
- a status transition that is enforced instead of suggested;
- an integration that syncs state both ways with an external tracker instead of linking to it;
- a feature that stops working offline;
- infrastructure the user must run (a database server, an account) for the basic workflow;
- an abstraction with exactly one implementation and no test that needs a second.

## Non-goals

Authentication for local use · multi-user collaboration · SaaS or cloud hosting ·
an embedded AI chat · workflow engines · replacing Jira or Trello · a plugin marketplace.
