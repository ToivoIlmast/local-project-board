/**
 * The rule about the session token, as the owner decided it (T70, decisions 2 and 3), written
 * out in full on purpose: the tests hold the text against the constant of the contract rather
 * than derive it from it, so a changed or weakened rule is a failing test.
 */
export const TOKEN_RULE =
  'Never keep the session token anywhere: get it with `GET /api/v1/session` into a shell variable ' +
  'in the same command that needs it (the shell keeps no state between tool calls); do not print it, ' +
  'not even the answer of `GET /api/v1/session`; do not write it to any file, scratchpad and temporary ' +
  'files included, nor into a task, a document, a report or a URL; do not type it as a literal into a ' +
  'command; and keep it out of the argv of child processes by sending the header through stdin, ' +
  'like `printf \'Authorization: Bearer %s\\n\' "$TOKEN" | curl -H @- ...`, where `printf` is a bash builtin.';

/** The parts of the rule a weakened version would lose; each one is a decision of the owner. */
export const TOKEN_RULE_PARTS: readonly string[] = [
  'GET /api/v1/session',
  'in the same command that needs it',
  'do not print it',
  'do not write it to any file, scratchpad and temporary files included',
  'a task, a document, a report or a URL',
  'do not type it as a literal into a command',
  'argv of child processes',
  'through stdin',
  'curl -H @-',
  '`printf` is a bash builtin',
];
