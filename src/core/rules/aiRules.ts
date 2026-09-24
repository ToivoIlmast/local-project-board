/**
 * What an agent must not violate about the mechanics of the API — the board's own default for
 * `ai.rules` (ADR-0021, ADR-0026). It lives in `core` because both `contract` (which renders it
 * into the generated instructions) and `server/config` (which seeds `ai.rules` with it) may
 * depend on `core`, but neither may depend on the other's layer.
 */
export const DEFAULT_AI_RULES: readonly string[] = [
  'Requests and responses are JSON, except where a route says otherwise.',
  'Unknown fields are rejected, so send exactly what a route describes.',
  'A task carries its own markdown in `body`; there is no separate route for it.',
  'To reorder a task or put it in another column, use the move route with the ids of its ' +
    'neighbours (`before`, `after`). The board computes the position; never invent one.',
  'A document name is a plain file name ending in `.md` or `.html`. No directories, and ' +
    '`task.md` is reserved by the board itself.',
  'A report is markdown or HTML. HTML is shown in a sandbox with no network access, so put ' +
    'the styles and the data inside the file and load nothing from the internet.',
  'Documents and reports are text of at most a million characters; this is not a file store.',
  'Deleting a task deletes its documents with it, and its id is not given to another task.',
];
