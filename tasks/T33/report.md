# T33: Runner фиксирует запуск, завершение и технические ошибки Claude Code

## Что сделано

Runner (`claude <ID>` и `claude --wait`) теперь сам записывает технический lifecycle процесса Claude Code.

### Изменения

**`src/server/cli/claude.ts`** — основная реализация:
- `startSession` генерирует UUID, вызывает `beginRun` (POST `/tasks/:id/ai-run`), затем запускает `spawn(claude, ['--session-id', uuid, prompt])`.
- Если begin не отвечает или вернул ошибку — Claude **не запускается**; инвариант «нет сессии без run» соблюдён.
- `endRun` вызывается всегда: при нормальном выходе, сигнале (SIGINT, SIGTERM, SIGHUP) и ошибке spawn. Retry ~30 с backoff; при провале — сообщение в stderr с `taskId`, `runId`, `sessionId`.
- SIGINT игнорируется runner'ом (терминал сам пересылает его дочернему процессу), поэтому end выполняется даже при Ctrl+C.
- `patchBoard` (PATCH) удалён как неиспользуемый — end использует POST.

**`src/core/services/aiRunService.ts`** — исправление бага:
- При вызове `end` на задаче с уже финальным состоянием (агент успел отчитаться) и `exitCode !== 0` добавлялся `failure: { kind: 'exit', message: '' }`. Пустая строка нарушала `message: z.string().min(1)`, файл задачи отклонялся schema и задача исчезала из `listTasks`. Исправлено: сообщение теперь `"process exited with code N"`.

**`test/cli/runner.test.ts`** — новые тесты T33 (6 штук):
1. argv ровно `['--session-id', uuid, prompt]` — инвариант;
2. exit 0 без отчёта → `failed{exit, exitCode:0}` с сохранённым sessionId (регрессия T30);
3. begin fail → Claude не запущен (инвариант «нет сессии без run»);
4. ошибка spawn → `failed{launch}`;
5. агент отчитался `finished`, выход с кодом 1 → `finished` + `exitCode: 1`;
6. выход по сигналу → end всё равно отправлен.

**`test/support/fakeClaude.ts`** — исправлен разбор argv: был `process.argv[2]` (ломался после T33), стал `process.argv[process.argv.length - 1]`.

**`test/cli/claude.test.ts`**, **`test/cli/claudeWait.test.ts`** — обновлены под новый формат argv и изменённое поведение runner'а:
- Тест «changes nothing on the board» переписан: runner теперь записывает `aiRun`, но статус задачи не трогает.
- Сравнение handoff `toBe(served)` убрано: `beginRun` обновляет handoff до того, как Claude его читает.

### Все пять сценариев

| Сценарий | Итог на доске |
|---|---|
| Ошибка spawn (нет интерпретатора) | `failed{launch}` |
| Завершился без финала (exit 0) | `failed{exit, exitCode:0}` |
| Агент сообщил failed | `failed{agent}` |
| finished, exit code ≠ 0 | `finished` + `exitCode` |
| Доска недоступна при end | `working` + сообщение в stderr |

## Проверки

- `format:check` ✓
- `lint` ✓
- `typecheck` ✓
- `check:cycles` ✓
- `test` — 1942/1942 ✓
- `test:pack` — 3/3 ✓

## Real E2E

Real E2E на реальном Claude Code 2.1.283 в рамках данной задачи не проводился: T33 завершён самим runner'ом (`claude <T33>` не запускался). Сценарии покрыты юнит-тестами с fakeClaude.

**Флаг `--session-id`**: проверено по документации и исходникам Claude Code 2.1.283 — флаг принимается, сессия открывается с указанным UUID. `--resume <sessionId>` корректно продолжает сессию по тому же UUID.

## Риски и открытые вопросы

- Если runner убивают (`kill -9`) до вызова end — `aiRun` остаётся `working`. Это out-of-scope для T33.
- `--session-id` с UUID уже существующей сессии ведёт себя как `--resume`; это нормально для реального использования.
