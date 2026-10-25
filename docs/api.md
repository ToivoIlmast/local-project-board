# local-project-board API (v1)

Generated from `src/contract/v1/routes.ts` (ADR-0005) — do not edit by hand. After a change
to the route table, run `UPDATE_DOCS=1 npm test` to regenerate this file.

Base path: `/api/v1`

## Media types

- `application/json` — A JSON request or response body.
- `text/markdown` — A task, document or report body read back as markdown text.
- `text/html` — A report read back as HTML.
- `text/event-stream` — Server-sent events; the browser page uses this to stay in sync.

## Board

### GET /api/v1/project

Read the board: statuses, id prefix, git state and any unreadable files

Given to AI agents in the generated instructions.

Response — 200, application/json:

```json
{
  "name": "dep-health",
  "root": "/home/me/dep-health",
  "statuses": [
    "backlog",
    "todo",
    "in-progress",
    "done"
  ],
  "idPrefix": "T",
  "storage": {
    "provider": "markdown"
  },
  "git": {
    "available": true,
    "branch": "main",
    "detached": false
  },
  "version": "0.1.0",
  "readIssues": [
    {
      "file": "tasks/T7/task.md",
      "message": "Invalid YAML frontmatter"
    }
  ]
}
```

## Session

### GET /api/v1/session

Read this run's session token, the one every change must be sent with

Given to AI agents in the generated instructions.

Response — 200, application/json:

```json
{
  "token": "<session token>"
}
```

## Tasks

### GET /api/v1/tasks

List every task, ordered by status and rank

Given to AI agents in the generated instructions.

Response — 200, application/json:

```json
[
  {
    "id": "T12",
    "title": "Extract the git adapter",
    "status": "in-progress",
    "rank": "a1",
    "body": "## Context\n\nThe status parser still lives in the HTTP layer.\n",
    "labels": [
      "refactor"
    ],
    "branch": "feat/git-adapter",
    "createdAt": "2026-09-21T09:00:00.000Z",
    "updatedAt": "2026-09-21T11:30:00.000Z"
  }
]
```

### POST /api/v1/tasks

Create a task

Given to AI agents in the generated instructions.

Request body:

```json
{
  "title": "Extract the git adapter",
  "status": "in-progress",
  "body": "## Context\n\nThe status parser still lives in the HTTP layer.\n",
  "labels": [
    "refactor"
  ]
}
```

Response — 201, application/json:

```json
{
  "id": "T12",
  "title": "Extract the git adapter",
  "status": "in-progress",
  "rank": "a1",
  "body": "## Context\n\nThe status parser still lives in the HTTP layer.\n",
  "labels": [
    "refactor"
  ],
  "branch": "feat/git-adapter",
  "createdAt": "2026-09-21T09:00:00.000Z",
  "updatedAt": "2026-09-21T11:30:00.000Z"
}
```

### GET /api/v1/tasks/:id

Read one task, including its markdown body

Given to AI agents in the generated instructions.

Example: GET /api/v1/tasks/T12

Response — 200, application/json:

```json
{
  "id": "T12",
  "title": "Extract the git adapter",
  "status": "in-progress",
  "rank": "a1",
  "body": "## Context\n\nThe status parser still lives in the HTTP layer.\n",
  "labels": [
    "refactor"
  ],
  "branch": "feat/git-adapter",
  "createdAt": "2026-09-21T09:00:00.000Z",
  "updatedAt": "2026-09-21T11:30:00.000Z"
}
```

### PATCH /api/v1/tasks/:id

Change a task; only the given fields are written (last-write-wins, unless `ifContentHash` is sent)

Given to AI agents in the generated instructions.

Example: PATCH /api/v1/tasks/T12

Request body:

```json
{
  "status": "done",
  "labels": [
    "refactor",
    "git"
  ]
}
```

Response — 200, application/json:

```json
{
  "id": "T12",
  "title": "Extract the git adapter",
  "status": "in-progress",
  "rank": "a1",
  "body": "## Context\n\nThe status parser still lives in the HTTP layer.\n",
  "labels": [
    "refactor"
  ],
  "branch": "feat/git-adapter",
  "createdAt": "2026-09-21T09:00:00.000Z",
  "updatedAt": "2026-09-21T11:30:00.000Z"
}
```

### DELETE /api/v1/tasks/:id

Delete a task and its documents; the id is never reused

Given to AI agents in the generated instructions.

Example: DELETE /api/v1/tasks/T12

Response — 200, application/json:

```json
{
  "deleted": true
}
```

### POST /api/v1/tasks/:id/move

Move a task to a status and between neighbours; the server computes the order

Given to AI agents in the generated instructions.

Example: POST /api/v1/tasks/T12/move

Request body:

```json
{
  "status": "done",
  "after": "T4"
}
```

Response — 200, application/json:

```json
{
  "id": "T12",
  "title": "Extract the git adapter",
  "status": "in-progress",
  "rank": "a1",
  "body": "## Context\n\nThe status parser still lives in the HTTP layer.\n",
  "labels": [
    "refactor"
  ],
  "branch": "feat/git-adapter",
  "createdAt": "2026-09-21T09:00:00.000Z",
  "updatedAt": "2026-09-21T11:30:00.000Z"
}
```

### GET /api/v1/tasks/:id/workflow

Read the settings a task runs with, the source of each and which are inactive

Given to AI agents in the generated instructions.

Example: GET /api/v1/tasks/T12/workflow

Response — 200, application/json:

```json
{
  "values": {
    "editCode": false,
    "branch": true,
    "checks": true,
    "commit": true,
    "push": false,
    "report": true,
    "startStatus": "in-progress",
    "finishStatus": null,
    "baseBranch": null,
    "checkCommand": "npm test",
    "commitLanguage": null,
    "reportLanguage": null
  },
  "sources": {
    "editCode": "status",
    "branch": "default",
    "checks": "default",
    "commit": "default",
    "push": "board",
    "report": "default",
    "startStatus": "default",
    "finishStatus": "default",
    "baseBranch": "default",
    "checkCommand": "board",
    "commitLanguage": "default",
    "reportLanguage": "default"
  },
  "inactive": [
    "branch",
    "checks",
    "commit",
    "push"
  ]
}
```

### GET /api/v1/tasks/:id/handoff

Read a task with the steps its settings call for and these instructions, as one text

Given to AI agents in the generated instructions.

Example: GET /api/v1/tasks/T12/handoff

Response — 200, text/markdown:

```
# Task T12: Extract the git adapter

- Status: `in-progress`

## Description

## Context

The status parser still lives in the HTTP layer.

## Documents

No documents are attached to this task yet.

## How to work on this task

1. You may change the files of the project. _(source: default)_
```

### POST /api/v1/tasks/:id/run

Hand a task to the runner waiting in a terminal of the project, which starts the agent on it

Not given to AI agents in the generated instructions.

Example: POST /api/v1/tasks/T12/run

Request body:

```json
{
  "agent": "claude-code"
}
```

Response — 200, application/json:

```json
{
  "taskId": "T12",
  "agent": "claude-code"
}
```

## AI workflow

### GET /api/v1/workflow

Read the AI workflow overrides of the board and its columns, with the defaults

Given to AI agents in the generated instructions.

Response — 200, application/json:

```json
{
  "defaults": {
    "editCode": true,
    "branch": true,
    "checks": true,
    "commit": true,
    "push": false,
    "report": true,
    "startStatus": "in-progress",
    "finishStatus": null,
    "baseBranch": null,
    "checkCommand": null,
    "commitLanguage": null,
    "reportLanguage": null
  },
  "board": {
    "push": false,
    "checkCommand": "npm test"
  },
  "statuses": {
    "backlog": {
      "editCode": false
    }
  }
}
```

### PUT /api/v1/workflow

Replace the AI workflow overrides of the board and all its columns (last-write-wins)

Not given to AI agents in the generated instructions.

Request body:

```json
{
  "board": {
    "push": false,
    "checkCommand": "npm test"
  },
  "statuses": {
    "backlog": {
      "editCode": false
    }
  }
}
```

Response — 200, application/json:

```json
{
  "defaults": {
    "editCode": true,
    "branch": true,
    "checks": true,
    "commit": true,
    "push": false,
    "report": true,
    "startStatus": "in-progress",
    "finishStatus": null,
    "baseBranch": null,
    "checkCommand": null,
    "commitLanguage": null,
    "reportLanguage": null
  },
  "board": {
    "push": false,
    "checkCommand": "npm test"
  },
  "statuses": {
    "backlog": {
      "editCode": false
    }
  }
}
```

## Versions

### GET /api/v1/tasks/:id/versions

List the versions of a task's content and say whether the task is at the latest

Not given to AI agents in the generated instructions.

Example: GET /api/v1/tasks/T12/versions

Response — 200, application/json:

```json
{
  "current": {
    "hash": "8a2f6c1d90b34e57",
    "version": 2
  },
  "versions": [
    {
      "taskId": "T12",
      "number": 1,
      "createdAt": "2026-09-21T11:30:00.000Z",
      "source": "create",
      "changed": [],
      "hash": "8a2f6c1d90b34e57"
    },
    {
      "taskId": "T12",
      "number": 2,
      "createdAt": "2026-09-21T11:30:00.000Z",
      "source": "edit",
      "changed": [
        "body"
      ],
      "hash": "8a2f6c1d90b34e57"
    }
  ]
}
```

### GET /api/v1/tasks/:id/versions/:n

Read one version of a task: its content as it was

Not given to AI agents in the generated instructions.

Example: GET /api/v1/tasks/T12/versions/2

Response — 200, application/json:

```json
{
  "taskId": "T12",
  "number": 2,
  "createdAt": "2026-09-21T11:30:00.000Z",
  "source": "edit",
  "changed": [
    "body"
  ],
  "snapshot": {
    "title": "Extract the git adapter",
    "body": "## Context\n\nThe status parser still lives in the HTTP layer.\n",
    "labels": [
      "refactor"
    ]
  }
}
```

### POST /api/v1/tasks/:id/versions/:n/restore

Write the content of a version as the content of the task, as a new version; the status stays

Not given to AI agents in the generated instructions.

Example: POST /api/v1/tasks/T12/versions/1/restore

Request body:

```json
{
  "ifContentHash": "8a2f6c1d90b34e57"
}
```

Response — 200, application/json:

```json
{
  "task": {
    "id": "T12",
    "title": "Extract the git adapter",
    "status": "in-progress",
    "rank": "a1",
    "body": "## Context\n\nThe status parser still lives in the HTTP layer.\n",
    "labels": [
      "refactor"
    ],
    "branch": "feat/git-adapter",
    "createdAt": "2026-09-21T09:00:00.000Z",
    "updatedAt": "2026-09-21T11:30:00.000Z"
  },
  "changed": true
}
```

## Checks

### GET /api/v1/tasks/:id/checks

List the checks and researches of a task, with their state and the version each read

Not given to AI agents in the generated instructions.

Example: GET /api/v1/tasks/T12/checks

Response — 200, application/json:

```json
[
  {
    "taskId": "T12",
    "number": 1,
    "state": "reported",
    "version": 2,
    "createdAt": "2026-09-21T11:40:00.000Z",
    "agent": "claude-code",
    "verdict": "partly-outdated"
  }
]
```

### GET /api/v1/tasks/:id/checks/:n

Read one check or research: its begin, its report as the agent sent it, its decisions

Not given to AI agents in the generated instructions.

Example: GET /api/v1/tasks/T12/checks/1

Response — 200, application/json:

```json
{
  "state": "reported",
  "begin": {
    "taskId": "T12",
    "number": 1,
    "version": 2,
    "createdAt": "2026-09-21T11:40:00.000Z",
    "agent": "claude-code",
    "sessionId": "a1b2c3d4-e5f6-4890-abcd-ef0123456789",
    "repo": {
      "branch": "feat/git-adapter",
      "head": "9f1c1a2b3c4d5e6f",
      "clean": true
    }
  },
  "report": {
    "agent": "claude-code",
    "verdict": "partly-outdated",
    "summary": "The description still matches the code, but one path moved.",
    "uncertainty": "The test suite was not run.",
    "findings": [
      {
        "id": "f1",
        "title": "The adapter was moved",
        "explanation": "The task names src/git.ts, which now lives in src/server/git/.",
        "evidence": [
          {
            "kind": "file",
            "ref": "src/server/git/reader.ts",
            "note": "new location"
          }
        ]
      }
    ],
    "recommendations": [
      {
        "id": "r1",
        "findings": [
          "f1"
        ],
        "text": "Update the path in the description.",
        "edit": {
          "field": "body",
          "find": "The status parser",
          "replace": "The status parser (src/server/git/)"
        }
      }
    ],
    "taskId": "T12",
    "check": 1,
    "version": 2,
    "createdAt": "2026-09-21T11:45:00.000Z",
    "repo": {
      "branch": "feat/git-adapter",
      "head": "9f1c1a2b3c4d5e6f",
      "clean": true
    }
  },
  "decisions": [
    {
      "taskId": "T12",
      "check": 1,
      "number": 1,
      "recommendation": "r1",
      "decision": "accepted",
      "createdAt": "2026-09-21T11:50:00.000Z"
    }
  ]
}
```

### POST /api/v1/tasks/:id/checks

Runner: begin an actuality check or a research, pinned to the version on disk

Not given to AI agents in the generated instructions.

Example: POST /api/v1/tasks/T12/checks

Request body:

```json
{
  "agent": "claude-code",
  "sessionId": "a1b2c3d4-e5f6-4890-abcd-ef0123456789",
  "model": "opus"
}
```

Response — 200, application/json:

```json
{
  "number": 1,
  "version": 2
}
```

### GET /api/v1/tasks/:id/checks/:n/handoff

Read what the agent of a check is told: the version under review, the rules, the report format

Not given to AI agents in the generated instructions.

Example: GET /api/v1/tasks/T12/checks/1/handoff

Response — 200, text/markdown:

```
# Check T12-C1: is task T12 still current?

You are checking whether the description of task T12 still matches the repository, as of version v2 of the task.
```

### POST /api/v1/tasks/:id/checks/:n/report

Agent: send the report of a check, once; it is checked against the version that was read

Not given to AI agents in the generated instructions.

Example: POST /api/v1/tasks/T12/checks/1/report

Request body:

```json
{
  "agent": "claude-code",
  "verdict": "partly-outdated",
  "summary": "The description still matches the code, but one path moved.",
  "uncertainty": "The test suite was not run.",
  "findings": [
    {
      "id": "f1",
      "title": "The adapter was moved",
      "explanation": "The task names src/git.ts, which now lives in src/server/git/.",
      "evidence": [
        {
          "kind": "file",
          "ref": "src/server/git/reader.ts",
          "note": "new location"
        }
      ]
    }
  ],
  "recommendations": [
    {
      "id": "r1",
      "findings": [
        "f1"
      ],
      "text": "Update the path in the description.",
      "edit": {
        "field": "body",
        "find": "The status parser",
        "replace": "The status parser (src/server/git/)"
      }
    }
  ]
}
```

Response — 200, application/json:

```json
{
  "state": "reported",
  "begin": {
    "taskId": "T12",
    "number": 1,
    "version": 2,
    "createdAt": "2026-09-21T11:40:00.000Z",
    "agent": "claude-code",
    "sessionId": "a1b2c3d4-e5f6-4890-abcd-ef0123456789",
    "repo": {
      "branch": "feat/git-adapter",
      "head": "9f1c1a2b3c4d5e6f",
      "clean": true
    }
  },
  "report": {
    "agent": "claude-code",
    "verdict": "partly-outdated",
    "summary": "The description still matches the code, but one path moved.",
    "uncertainty": "The test suite was not run.",
    "findings": [
      {
        "id": "f1",
        "title": "The adapter was moved",
        "explanation": "The task names src/git.ts, which now lives in src/server/git/.",
        "evidence": [
          {
            "kind": "file",
            "ref": "src/server/git/reader.ts",
            "note": "new location"
          }
        ]
      }
    ],
    "recommendations": [
      {
        "id": "r1",
        "findings": [
          "f1"
        ],
        "text": "Update the path in the description.",
        "edit": {
          "field": "body",
          "find": "The status parser",
          "replace": "The status parser (src/server/git/)"
        }
      }
    ],
    "taskId": "T12",
    "check": 1,
    "version": 2,
    "createdAt": "2026-09-21T11:45:00.000Z",
    "repo": {
      "branch": "feat/git-adapter",
      "head": "9f1c1a2b3c4d5e6f",
      "clean": true
    }
  },
  "decisions": [
    {
      "taskId": "T12",
      "check": 1,
      "number": 1,
      "recommendation": "r1",
      "decision": "accepted",
      "createdAt": "2026-09-21T11:50:00.000Z"
    }
  ]
}
```

### GET /api/v1/tasks/:id/checks/:n/report.md

Read the markdown of a published research report, exactly as it was written

Not given to AI agents in the generated instructions.

Example: GET /api/v1/tasks/T12/checks/2/report.md

Response — 200, text/markdown:

```
# Research

## What the task asks for

Move the parser into server/git.
```

### POST /api/v1/tasks/:id/checks/:n/end

Runner: end a check, once; the session must be the one that began it

Not given to AI agents in the generated instructions.

Example: POST /api/v1/tasks/T12/checks/1/end

Request body:

```json
{
  "sessionId": "a1b2c3d4-e5f6-4890-abcd-ef0123456789",
  "exitCode": 0,
  "endedAt": "2026-09-21T11:46:00.000Z"
}
```

Response — 200, application/json:

```json
{
  "state": "reported",
  "begin": {
    "taskId": "T12",
    "number": 1,
    "version": 2,
    "createdAt": "2026-09-21T11:40:00.000Z",
    "agent": "claude-code",
    "sessionId": "a1b2c3d4-e5f6-4890-abcd-ef0123456789",
    "repo": {
      "branch": "feat/git-adapter",
      "head": "9f1c1a2b3c4d5e6f",
      "clean": true
    }
  },
  "report": {
    "agent": "claude-code",
    "verdict": "partly-outdated",
    "summary": "The description still matches the code, but one path moved.",
    "uncertainty": "The test suite was not run.",
    "findings": [
      {
        "id": "f1",
        "title": "The adapter was moved",
        "explanation": "The task names src/git.ts, which now lives in src/server/git/.",
        "evidence": [
          {
            "kind": "file",
            "ref": "src/server/git/reader.ts",
            "note": "new location"
          }
        ]
      }
    ],
    "recommendations": [
      {
        "id": "r1",
        "findings": [
          "f1"
        ],
        "text": "Update the path in the description.",
        "edit": {
          "field": "body",
          "find": "The status parser",
          "replace": "The status parser (src/server/git/)"
        }
      }
    ],
    "taskId": "T12",
    "check": 1,
    "version": 2,
    "createdAt": "2026-09-21T11:45:00.000Z",
    "repo": {
      "branch": "feat/git-adapter",
      "head": "9f1c1a2b3c4d5e6f",
      "clean": true
    }
  },
  "decisions": [
    {
      "taskId": "T12",
      "check": 1,
      "number": 1,
      "recommendation": "r1",
      "decision": "accepted",
      "createdAt": "2026-09-21T11:50:00.000Z"
    }
  ],
  "end": {
    "taskId": "T12",
    "check": 1,
    "sessionId": "a1b2c3d4-e5f6-4890-abcd-ef0123456789",
    "exitCode": 0,
    "endedAt": "2026-09-21T11:46:00.000Z"
  }
}
```

### POST /api/v1/tasks/:id/checks/:n/decisions

Accept or reject one recommendation of a reported check; it changes no task

Not given to AI agents in the generated instructions.

Example: POST /api/v1/tasks/T12/checks/1/decisions

Request body:

```json
{
  "recommendation": "r1",
  "decision": "accepted"
}
```

Response — 200, application/json:

```json
{
  "taskId": "T12",
  "check": 1,
  "number": 1,
  "recommendation": "r1",
  "decision": "accepted",
  "createdAt": "2026-09-21T11:50:00.000Z"
}
```

## Documents

### GET /api/v1/tasks/:id/documents

List the documents attached to a task

Given to AI agents in the generated instructions.

Example: GET /api/v1/tasks/T12/documents

Response — 200, application/json:

```json
[
  {
    "taskId": "T12",
    "name": "plan.md",
    "size": 482,
    "updatedAt": "2026-09-21T11:30:00.000Z"
  }
]
```

### GET /api/v1/tasks/:id/documents/:name

Read a document as text

Given to AI agents in the generated instructions.

Example: GET /api/v1/tasks/T12/documents/plan.md

Response — 200, text/markdown:

```
# Plan

1. Move the parser into server/git.
```

### PUT /api/v1/tasks/:id/documents/:name

Create or overwrite a document (idempotent)

Given to AI agents in the generated instructions.

Example: PUT /api/v1/tasks/T12/documents/plan.md

Request body:

```json
{
  "content": "# Plan\n\n1. Move the parser into server/git.\n"
}
```

Response — 200, application/json:

```json
{
  "taskId": "T12",
  "name": "plan.md",
  "size": 482,
  "updatedAt": "2026-09-21T11:30:00.000Z"
}
```

### DELETE /api/v1/tasks/:id/documents/:name

Delete a document

Given to AI agents in the generated instructions.

Example: DELETE /api/v1/tasks/T12/documents/plan.md

Response — 200, application/json:

```json
{
  "deleted": true
}
```

## Git (read-only)

### GET /api/v1/git/status

Read the working tree status of the repository

Given to AI agents in the generated instructions.

Response — 200, application/json:

```json
{
  "branch": "feat/git-adapter",
  "detached": false,
  "clean": false,
  "files": [
    {
      "path": "src/server/git/status.ts",
      "staged": false,
      "status": "modified"
    }
  ]
}
```

### GET /api/v1/git/branches

List local branches

Given to AI agents in the generated instructions.

Response — 200, application/json:

```json
[
  {
    "name": "main",
    "current": false
  },
  {
    "name": "feat/git-adapter",
    "current": true
  }
]
```

### GET /api/v1/git/commits

List recent commits

Given to AI agents in the generated instructions.

Query: ?ref=main&limit=20

Response — 200, application/json:

```json
[
  {
    "sha": "9f1c1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b",
    "subject": "Extract the git status parser",
    "author": "Toivo",
    "date": "2026-09-21T11:30:00.000Z"
  }
]
```

### GET /api/v1/git/diff

Read a diff of the working tree or of a ref

Given to AI agents in the generated instructions.

Query: ?path=src%2Fserver%2Fgit%2Fstatus.ts

Response — 200, application/json:

```json
{
  "text": "@@ -1,4 +1,6 @@\n-const a = 1;\n+const a = 2;\n",
  "truncated": false
}
```

## Reports

### GET /api/v1/reports

List the reports stored on the board

Given to AI agents in the generated instructions.

Response — 200, application/json:

```json
[
  {
    "id": "R3",
    "title": "Dependency audit",
    "format": "html",
    "createdAt": "2026-09-21T11:30:00.000Z"
  }
]
```

### POST /api/v1/reports

Store an HTML or markdown report

Given to AI agents in the generated instructions.

Request body:

```json
{
  "title": "Dependency audit",
  "format": "html",
  "content": "<h1>Dependency audit</h1>\n<p>3 outdated packages.</p>\n"
}
```

Response — 201, application/json:

```json
{
  "id": "R3",
  "title": "Dependency audit",
  "format": "html",
  "createdAt": "2026-09-21T11:30:00.000Z"
}
```

### GET /api/v1/reports/:id

Read a report as text

Given to AI agents in the generated instructions.

Example: GET /api/v1/reports/R3

Response — 200, text/html:

```
<h1>Dependency audit</h1>
<p>3 outdated packages.</p>
```

### DELETE /api/v1/reports/:id

Delete a report

Given to AI agents in the generated instructions.

Example: DELETE /api/v1/reports/R3

Response — 200, application/json:

```json
{
  "deleted": true
}
```

## Events

### GET /api/v1/events

Subscribe to board events (SSE); the UI uses it to stay in sync

Not given to AI agents in the generated instructions.

Response — 200, text/event-stream:

```
{
  "type": "task.updated",
  "task": {
    "id": "T12",
    "title": "Extract the git adapter",
    "status": "in-progress",
    "rank": "a1",
    "body": "## Context\n\nThe status parser still lives in the HTTP layer.\n",
    "labels": [
      "refactor"
    ],
    "branch": "feat/git-adapter",
    "createdAt": "2026-09-21T09:00:00.000Z",
    "updatedAt": "2026-09-21T11:30:00.000Z"
  }
}
```

## Instructions

### GET /api/v1/instructions

Read these instructions as markdown

Not given to AI agents in the generated instructions.

Response — 200, text/markdown:

```
# local-project-board API (v1)
```

## Ai-run

### POST /api/v1/tasks/:id/ai-run

Runner: begin a run on a task; the server assigns a monotonic runId

Not given to AI agents in the generated instructions.

Example: POST /api/v1/tasks/T12/ai-run

Request body:

```json
{
  "sessionId": "a1b2c3d4-e5f6-4890-abcd-ef0123456789",
  "mode": "new",
  "model": "claude-sonnet-4-6"
}
```

Response — 200, application/json:

```json
{
  "agent": "runner",
  "state": "working",
  "runId": 1,
  "sessionId": "a1b2c3d4-e5f6-4890-abcd-ef0123456789",
  "mode": "new",
  "model": "claude-sonnet-4-6",
  "startedAt": "2026-09-21T09:00:00.000Z"
}
```

### POST /api/v1/tasks/:id/ai-run/:runId/end

Runner: end a run on a task; the runId must be the current one

Not given to AI agents in the generated instructions.

Example: POST /api/v1/tasks/T12/ai-run/1/end

Request body:

```json
{
  "exitCode": 0
}
```

Response — 200, application/json:

```json
{
  "agent": "runner",
  "state": "failed",
  "runId": 1,
  "failure": {
    "kind": "exit",
    "message": "process exited with code 0 without a final state"
  },
  "endedAt": "2026-09-21T09:05:00.000Z"
}
```

### POST /api/v1/tasks/:id/ai-run/:runId/abandon

Recovery: mark the working run with this runId and session as failed{lost}

Not given to AI agents in the generated instructions.

Example: POST /api/v1/tasks/T12/ai-run/1/abandon

Request body:

```json
{
  "sessionId": "a1b2c3d4-e5f6-4890-abcd-ef0123456789",
  "message": "lost: claude (pid 4242) and its runner (pid 4200) no longer exist"
}
```

Response — 200, application/json:

```json
{
  "agent": "runner",
  "state": "failed",
  "runId": 1,
  "sessionId": "a1b2c3d4-e5f6-4890-abcd-ef0123456789",
  "mode": "new",
  "startedAt": "2026-09-21T09:00:00.000Z",
  "failure": {
    "kind": "lost",
    "message": "lost: claude (pid 4242) and its runner (pid 4200) no longer exist"
  }
}
```

### PATCH /api/v1/tasks/:id/ai-run/:runId/report

Agent: report the result of a run; runId must match the current run; runner fields are rejected

Not given to AI agents in the generated instructions.

Example: PATCH /api/v1/tasks/T12/ai-run/1/report

Request body:

```json
{
  "agent": "claude-code",
  "state": "finished",
  "checks": "passed",
  "commit": "9f1c1a2b",
  "finishedAt": "2026-09-21T09:05:00.000Z"
}
```

Response — 200, application/json:

```json
{
  "id": "T12",
  "title": "Extract the git adapter",
  "status": "in-progress",
  "rank": "a1",
  "body": "## Context\n\nThe status parser still lives in the HTTP layer.\n",
  "labels": [
    "refactor"
  ],
  "branch": "feat/git-adapter",
  "createdAt": "2026-09-21T09:00:00.000Z",
  "updatedAt": "2026-09-21T11:30:00.000Z"
}
```

## Runs

### GET /api/v1/runs

Wait for Send to AI (SSE, with the token): one request, then the stream ends; the CLI runner uses it

Not given to AI agents in the generated instructions.

Response — 200, text/event-stream:

```
{
  "type": "run.requested",
  "taskId": "T12",
  "agent": "claude-code"
}
```

## Errors

A request that fails answers with `{ "error": { "code", "message", "details" } }` and
nothing else. The code is one of:

- UNKNOWN_STATUS
- ORPHANED_STATUSES
- INVALID_ID_PREFIX
- INVALID_ID_SEQUENCE
- TASK_NOT_FOUND
- DOCUMENT_NOT_FOUND
- REPORT_NOT_FOUND
- INVALID_DOCUMENT_NAME
- NEIGHBOR_NOT_FOUND
- INVALID_POSITION
- INVALID_GIT_ARGUMENT
- STALE_AI_RUN
- AI_RUN_IN_PROGRESS
- AI_RUN_ALREADY_FINAL
- NO_SESSION_TO_RESUME
- NO_RUN_TO_RESTART
- AI_RUN_NOT_CLEARABLE
- INVALID_REQUEST
- VERSION_NOT_FOUND
- CHECK_NOT_FOUND
- RECOMMENDATION_NOT_FOUND
- TASK_CONTENT_CHANGED
- CHECK_ALREADY_FINAL
- CHECK_NOT_REPORTED
- STALE_CHECK
- INVALID_CHECK_REPORT
- INVALID_JSON
- UNAUTHORIZED
- FORBIDDEN_HOST
- FORBIDDEN_ORIGIN
- NOT_FOUND
- METHOD_NOT_ALLOWED
- PAYLOAD_TOO_LARGE
- INTERNAL_ERROR
- NO_AGENT_RUNNER
