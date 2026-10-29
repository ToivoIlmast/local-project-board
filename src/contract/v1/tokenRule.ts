import { API_BASE_PATH } from './routes.js';

/**
 * What an agent may do with the session token (ADR-0008, T70). One sentence, said the same in
 * the instructions, in the handoff of a task and in the handoff of a check or a research: three
 * wordings of one rule would drift apart.
 *
 * The token reaches an agent through `GET /session` and nowhere else. It must not stay anywhere
 * afterwards: not on the screen, not in a file, and not in the argv of a process, where
 * `/proc/<pid>/cmdline` shows it to the whole machine. A shell variable does not outlive the
 * command, so the token is taken in the command that uses it; the header goes to `curl` through
 * stdin, because `printf` is a bash builtin and `curl -H @-` reads the headers from stdin.
 */
export const TOKEN_RULE =
  `Never keep the session token anywhere: get it with \`GET ${API_BASE_PATH}/session\` into a shell` +
  ' variable in the same command that needs it (the shell keeps no state between tool calls); do' +
  ` not print it, not even the answer of \`GET ${API_BASE_PATH}/session\`; do not write it to any` +
  ' file, scratchpad and temporary files included, nor into a task, a document, a report or a URL;' +
  ' do not type it as a literal into a command; and keep it out of the argv of child processes by' +
  ' sending the header through stdin, like `printf \'Authorization: Bearer %s\\n\' "$TOKEN" |' +
  ' curl -H @- ...`, where `printf` is a bash builtin.';
