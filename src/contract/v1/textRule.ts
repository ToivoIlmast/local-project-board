/**
 * What an agent must do with text that is not ASCII (the Cyrillic of a report, for one). One
 * sentence, said the same in the instructions, in the handoff of a task and in the handoff of a
 * check or a research, like `TOKEN_RULE`.
 *
 * On Windows the arguments of a process go through the ANSI codepage: a document sent as an
 * argument of `node -e` or `curl -d` arrives with `?` instead of the letters that codepage has no
 * place for. The board reads the request body as UTF-8 and stores what it is sent, so the text
 * has to travel as the bytes of a UTF-8 file, never as an argument.
 */
export const TEXT_RULE =
  'Never pass the content of a document, or any other text that is not plain ASCII, through ' +
  'command-line arguments (`node -e ... process.argv`, `curl -d "..."`): on Windows they go ' +
  'through the ANSI codepage and Cyrillic and other letters turn into `?`. Write the content to a ' +
  'UTF-8 file and send it from the file, like `curl --data-binary @file.json` with the header ' +
  '`Content-Type: application/json; charset=utf-8`, or with Node reading the file with `fs`.';
