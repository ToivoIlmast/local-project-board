# T16 — Console mode: протокольный spike — отчёт

Дата: 2026-11-22. Ветка `task/T16-console-spike` (без коммитов). Production-код не менялся.
Основа: `docs/notes/RESEARCH_claude_console.ru.md` (далее «исследование»).

## 0. Окружение и как воспроизвести

| | |
|---|---|
| Claude Code | **2.1.330** (`claude.exe`, нативная сборка, `~/.local/bin`) |
| ОС | **Windows 11 Home 10.0.26200**, x64; Node v22.14.0 |
| Модель | `--model haiku` → `claude-haiku-5-5` (из `system/init`) |
| Базовые аргументы | `-p --input-format stream-json --output-format stream-json --verbose --replay-user-messages --model haiku --setting-sources project --no-session-persistence --max-budget-usd 0.25 --session-id <uuid>` |
| Доп. аргументы | `--tools` (`""`, `Bash`, `Bash,Read,Write,Edit`, `Agent,Read`), `--permission-prompts none` (permissions), `--permission-mode acceptEdits` (tools) |
| Разрешения | только project-настройки временного проекта (`.claude/settings.json` в `%TEMP%`); `--setting-sources project` — пользовательские настройки не читались и не менялись |
| Запуск | `spawn(claude.exe, args, { stdio: ['pipe','pipe','pipe'], shell: false })`; окружение очищено от переменных `CLAUDE*` родительской сессии |
| Стоимость | 16 записей, всего ≈ **$0.025** |

Файлы spike (всё в `test/spike/console/`, в production Runner не подключено):

- `protocol.mjs` — чистые функции: разбор NDJSON, формат входного сообщения, сопоставление
  replay/lifecycle, проба совместимости `checkCompatibility`, санитизация фикстур.
- `live.mjs` — **ручной** harness с реальными API-вызовами. Не входит в Jest/CI.
  `node test/spike/console/live.mjs --yes [эксперимент…]` (без имён — все). Перезаписывает
  `fixtures/`. Переменные: `T16_WORKDIR` (куда класть временные проекты и сырой вывод),
  `CLAUDE_BIN`, `T16_MODEL`.
- `fixtures/<имя>.stdout.ndjson` / `.stdin.ndjson` — реальный трафик (санитизирован: thinking →
  `<redacted>`, без `signature`, пути → `<WORK>`/`<HOME>`/`<TMP>`, списки плагинов/скиллов/команд
  пользователя → счётчик). `fixtures/results.json` — замеры (время, коды выхода, таймлайн).
- `consoleSpike.test.ts` — **офлайн**-тест (30 проверок) по фикстурам; без сети, идёт в обычном
  Jest. Сначала был написан по гипотезам исследования и падал (фикстур не было); после
  экспериментов утверждения, которые не подтвердились, переписаны в «REFUTES …» — тест фиксирует
  фактическое поведение 2.1.330.

Проверки: `npm test -- test/spike` — 30/30 (MANUAL selection, не полный прогон); `eslint
test/spike` и Prettier — чисто.

## 1. Что проверено

| # | Эксперимент | Вопрос задачи |
|---|---|---|
| 1 | `multi-message` — 3 сообщения подряд в один процесс | §1.1–1.5, 1.7 |
| 2 | `uuid-edge-cases` — повтор uuid, без uuid, uuid не-UUID | §1.4–1.5 |
| 3 | `mid-turn-message` — сообщение во время `sleep 8` в Bash | §1.6 |
| 4 | `bad-input` — невалидная строка в stdin | устойчивость протокола |
| 5 | `stdin-close-mid-turn` — закрыть stdin во время Bash | §2.1–2.4 |
| 6 | `sigint`, `sigterm` — `child.kill()` во время хода | §2.7–2.8 |
| 7 | `parent-death`, `parent-death-idle` — жёстко убить Node-родителя | §2.5–2.6 |
| 8 | `parent-death-detached[-idle]` — то же, `claude` вне job object | §2.5–2.6 (POSIX-подобно) |
| 9 | `tools` — Bash, Write, Edit, Read, Read несуществующего файла | §3 |
| 10 | `subagent` — Agent-инструмент | §3, `parent_tool_use_id` |
| 11 | `permissions` — `--permission-prompts none`: разрешённая и запрещённая команды, продолжение | §4 |
| 12 | `tools-write-denied` — `host` (по умолчанию) без SDK-хоста | §4 |
| 13 | `api-error` — несуществующая модель | ошибка API |

## 2. Подтверждено экспериментом

1. **stdin stream-json работает**: `{"type":"user","message":{"role":"user","content":"…"},"uuid":"<uuid>"}`.
2. **Несколько сообщений в одном процессе, одна сессия** — `session_id` во всех строках равен
   `--session-id`. Процесс выходит с кодом 0 после закрытия stdin в простое.
3. **`uuid` из входа возвращается без изменений** в replay (`"isReplay":true`) — во всех случаях.
4. **Потерь нет**: каждый uuid получил replay и `command_lifecycle … completed`.
5. **`system/init` приходит на каждый ход** (число `init` = числу `result`).
6. **`parent_tool_use_id` есть у каждой** `assistant`/`user` строки; у сабагента — равен id
   вызова `Agent`.
7. Каждый `tool_use` имеет `tool_result` с тем же id; ошибка инструмента — `is_error: true`.
8. `--permission-prompts none`: разрешённая project-правилом команда выполняется; требующая
   подтверждения — отклоняется, действие не выполнено; **после отказа сессия принимает новое
   сообщение и продолжает работу**.
9. Блоки `thinking` приходят (в нашем выводе — с подписью); сохранять их не нужно — санитизация
   проверена тестом.

## 3. Опровергнутые или уточнённые предположения исследования

| Исследование | Факт (2.1.330, Windows) | Следствие для реализации |
|---|---|---|
| «Два сообщения → два хода» (§2.1, §2.4) | **Сообщения, пришедшие пока идёт ход, склеиваются в один следующий ход**: 3 сообщения → 2 хода; replay склейки несёт текст `B\nC` и uuid **последнего** (C); у B есть отдельный replay с его текстом. `init.user_message_uuids` перечисляет все uuid хода. | «Одно сообщение = один ход/один ответ» неверно. Статус «учтено» вычислять по `command_lifecycle`, а не по «следующему assistant.text». |
| Сообщение во время хода «начинает новый ход» (§2.1) | Сообщение, отправленное во время Bash, **вливается в текущий ход** после tool_result; отдельного `result` между ними нет. В эксперименте модель ответила только на новое сообщение (`MIDWAY`) и **не выполнила** финал исходной инструкции (`DONE1`). | UI-подсказка «будет прочитано после текущего шага» верна. Нужна оговорка: сообщение может изменить ход текущей задачи. |
| Подтверждение получения = replay (§2.1, §4.5) | **Replay приходит при потреблении**, а не при получении (в mid-turn: через ~10 с после отправки). Получение подтверждает **недокументированное** `command_lifecycle` `queued` (< 150 мс). | Состояния: отправлено → `queued` (принято процессом) → `started`/replay (прочитано моделью) → `completed`/`cancelled`. |
| `permission_denied` — отдельный тип (§2.1) | Это **`{"type":"system","subtype":"permission_denied"}`**; плюс `result.permission_denials[]`. Итоговый `result` — `subtype:"success"`, `is_error:false`. | Нормализатор смотрит `system/permission_denied`. |
| `result` при ошибке | Ошибка API: `subtype:"success"`, но `is_error:true`, `terminal_reason:"api_error"`, модель `<synthetic>`; exit code 1. | Ошибку определять по `is_error`/`terminal_reason`, не по `subtype`. |
| «`result` → агент ждёт ответа» (§4.3, §6) | **Ход может начаться без сообщения пользователя**: фоновый сабагент завершился после `result`, и CLI сам начал второй ход (`init` без `user_message_uuids`, второй `result`). Подобно и фоновые Bash (`system/task_*`). | `awaiting-input` нельзя выводить из одного `result`. Нужно учитывать `system/background_tasks_changed` (пустой список задач) и отсутствие `queued`/`started` команд. |
| Закрытие stdin завершает процесс «и ход» (§7, [предп]) | Закрытие stdin во время хода **не прерывает** его: инструмент дорабатывает, модель отвечает, `result` выдаётся, затем exit 0 (через ~11.8 с). | «Завершить сессию» = мягкое завершение после текущего хода. Для немедленной остановки нужен kill. |
| Сабагент — синхронный вызов | Agent запускается **в фоне**: `tool_result` «Async agent launched» приходит сразу, сообщения сабагента (с `parent_tool_use_id`, `agent_id`) могут идти **после** `result` родительского хода. | Лента группирует по `parent_tool_use_id`, а не по ходу. |
| assistant с несколькими блоками | **Каждый content-блок — отдельная строка** `assistant` с тем же `message.id` (thinking и text — две строки). | Склейку блоков делать по `message.id`. |
| Неизвестные типы | Новый тип верхнего уровня `command_lifecycle`; system-подтипы: `thinking_tokens`, `task_started`, `task_progress`, `task_updated`, `task_notification`, `background_tasks_changed`. `rate_limit_event` приходит на каждом ходе (`status:"allowed"`). | Неизвестные типы и подтипы — игнорировать без ошибки (как и предлагалось). |
| Плохой ввод | **Одна невалидная JSON-строка в stdin завершает весь процесс** (exit 1, stderr `Error parsing streaming input line`, stdout пуст). Строка `{"type":"nonsense"}` в этом же прогоне до разбора не дошла. | Runner обязан сериализовать сообщения только через `JSON.stringify` одного объекта + `\n` и никогда не писать в stdin сырой текст. |
| `--permission-prompts host` | По умолчанию (`host`) **без SDK-хоста запрос тоже отклоняется автоматически** (не зависает), событие без `decision_reason`. | Даже без `none` сессия не повиснет; `none` нужен ради явной политики и понятного текста отказа. |
| Правило `Write` в project-настройках | Голое правило `"Write"` в `permissions.allow` **не разрешило** запись (отказ «you haven't granted it yet»); с `--permission-mode acceptEdits` запись прошла. Причина не выяснялась. | В документации режима советовать `acceptEdits` (как пользовательскую настройку), а не голые правила `Write`. |

## 4. UUID и доставка сообщений

- `uuid` входа возвращается **тем же** значением в replay и в `command_lifecycle.command_uuid`.
  Сопоставление «по порядку» не нужно.
- **CLI сам дедуплицирует по uuid**: второе сообщение с тем же uuid получило replay, но не
  выполнено (ответ только на первое; `queued` — один раз). Это совпадает с планом
  «messageId = ключ идемпотентности», но Runner всё равно должен хранить отправленные id: replay
  дубля выглядит как обычный replay.
- Сообщение **без uuid** не получает ни replay, ни `command_lifecycle` и может молча
  склеиться со следующим. → uuid обязателен для каждого сообщения.
- Строка не-UUID (`"not-a-uuid"`) принимается и отражается как есть; валидировать формат на
  стороне Board всё равно стоит.
- Надёжная схема статусов: `queued` (получено) → `started` + replay (передано модели) →
  `completed` / `cancelled` (ход завершён / прерван ошибкой).
- `init.capabilities` содержит `msg_lifecycle_v1` — признак наличия этих событий.

Пример (реальный, `multi-message`, сокращено):

```json
{"type":"command_lifecycle","command_uuid":"e8e9fcdf-…","state":"queued","uuid":"a7a288ac-…","session_id":"5dedb9dd-…"}
{"type":"system","subtype":"init","session_id":"5dedb9dd-…","model":"claude-haiku-5-5","tools":[],"capabilities":["…","msg_lifecycle_v1","…"],"user_message_uuids":["e8e9fcdf-…"],"…":"…"}
{"type":"user","message":{"role":"user","content":"Reply with exactly the word ALPHA and nothing else."},"parent_tool_use_id":null,"uuid":"e8e9fcdf-…","timestamp":"2026-11-22T15:38:45.434Z","isReplay":true,"session_id":"5dedb9dd-…"}
{"type":"assistant","message":{"id":"msg_011ChJDXnX…","content":[{"type":"text","text":"ALPHA"}],"…":"…"},"parent_tool_use_id":null,"session_id":"5dedb9dd-…","uuid":"…"}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour","…":"…"}}
{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","terminal_reason":"completed","permission_denials":[],"total_cost_usd":0.00065,"…":"…"}
{"type":"command_lifecycle","command_uuid":"e8e9fcdf-…","state":"completed"}
{"type":"user","message":{"role":"user","content":"Reply … BRAVO …\nReply … CHARLIE …"},"uuid":"48d6c1e8-…","isReplay":true}
```

## 5. Завершение процесса и stdin (Windows 11)

| Сценарий | Результат |
|---|---|
| Закрыть stdin в простое | exit 0 сразу (< 1 с) |
| Закрыть stdin во время Bash | инструмент дорабатывает, ответ модели, **`result` есть**, exit **0** через ~11.8 с |
| `child.kill('SIGINT')` во время хода | Node на Windows делает **TerminateProcess**: exit `null`, signal `SIGINT`, `result` нет, выход за ~67 мс |
| `child.kill('SIGTERM')` | то же: TerminateProcess, `result` нет, ~60 мс |
| Родитель (Node) убит, `claude` — обычный ребёнок | `claude` убит **ОС за ≤ 4 мс** (и в ходе, и в простое): libuv помещает детей в job object с kill-on-close |
| Родитель убит, `claude` вне job (`detached:true`), простой | выход за ~0.8 с (EOF на stdin) |
| Родитель убит, `claude` вне job, **во время хода** | **продолжает работать ~21.5 с** — дорабатывает ход (Bash + вызов API), затем выходит. Результат хода никому не доставлен |

Выводы:

- На Windows процесс-сирота не остаётся, пока `claude` запущен без `detached` (так и делает
  текущий Runner).
- На POSIX job object нет; эквивалент — вариант `detached`: сирота **доработает текущий ход**
  (и потратит API-вызовы, и выполнит инструменты), потом выйдет. **[не проверено на Linux/macOS —
  вывод по аналогии]**. Runner должен сам завершать ребёнка при своём выходе (обработчики
  `exit`/сигналов, как уже есть для терминального режима), а recover — учитывать `-p`-процессы.
- Настоящий SIGINT (Ctrl+C) на Windows из Node послать ребёнку нельзя; в консоли Ctrl+C
  получает вся группа процессов. Мягкое прерывание хода через сигнал **на Windows не проверено**,
  на Linux/macOS — **не проверено**. Протокольное прерывание (`init.capabilities` содержит
  `interrupt_*`) не документировано и не проверялось.

## 6. Разрешения

- `--permission-prompts none` + project-правило `Bash(echo *)`: `echo allowed-ok` выполнена.
- `mkdir denied-dir` → строка
  `{"type":"system","subtype":"permission_denied","tool_name":"Bash","tool_use_id":"toolu_…","decision_reason_type":"asyncAgent","decision_reason":"no approval surface in this session; permission request denied automatically","message":"Permission for this tool use was denied. … do not retry it: this action, and anything else that requires approval, will be denied the same way for the rest of this session. …"}`,
  затем `tool_result` с `is_error:true`; каталог не создан.
- Итоговый `result`: `subtype:"success"`, `is_error:false`,
  `permission_denials:[{"tool_name":"Bash","tool_use_id":"toolu_…","tool_input":{"command":"mkdir denied-dir",…}}]`.
- Следующее сообщение («Reply with exactly CONTINUED») принято, второй ход `success`.
- В режиме `host` без хоста: `{"type":"system","subtype":"permission_denied","tool_name":"Write","message":"Claude requested permissions to write to …, but you haven't granted it yet."}` — без `decision_reason*`.

## 7. Платформы

| Платформа | Статус |
|---|---|
| Windows 11 (x64), `claude.exe` | **проверено**: `spawn` без shell, pipes на stdin/stdout/stderr, NDJSON (CRLF не встречался, разбор устойчив к `\r`), закрытие stdin, kill, смерть родителя |
| Linux | **не проверялось** (WSL не установлен, другой машины нет) |
| macOS | **не проверялось** |

Для Linux/macOS остаются непроверенными: доставка реальных SIGINT/SIGTERM и поведение хода при
них, судьба сироты после смерти родителя (ожидается — как в варианте `detached`).
`live.mjs` переносим (выбирает `claude` вместо `claude.exe`) — его можно запустить там как есть.

## 8. Обнаружение несовместимости в будущих версиях

Не фиксировать версию жёстко (технического основания нет: протокол уже сообщает о своих
возможностях). Вместо этого Runner в console-режиме делает **пробу** (`checkCompatibility` в
`protocol.mjs` — готовый эскиз) на первом сообщении каждой сессии:

1. в `system/init` есть `session_id` == `--session-id`;
2. `init.capabilities` содержит `msg_lifecycle_v1`;
3. на первый uuid пришли `command_lifecycle queued` и replay с тем же uuid (таймаут — например,
   30 с);
4. у `result` есть `subtype`, `is_error`, `session_id`.

Если что-то не так — `session.state: error` «режим консоли не поддерживается этой версией
Claude Code (<версия>)», а сессия продолжает работать только как наблюдение (или завершается).
Неизвестные типы и подтипы — не ошибка, а запись в runner.log. Записывать `claude --version`
в журнал run'а. При обновлении Claude Code перезапускать `live.mjs` и офлайн-тест: расхождение
сразу видно по падающим «REFUTES/…» проверкам.

## 9. Что не удалось проверить

- Linux и macOS (см. §7); настоящие сигналы SIGINT/SIGTERM.
- Rate limit / `system/api_retry`: не воспроизводились; видели только `rate_limit_event` с
  `status:"allowed"` на каждом ходе.
- Почему голое правило `Write` не разрешило запись.
- Протокольное прерывание хода (`interrupt_*` capabilities) — не документировано, не трогали.
- Долгие реальные сессии (компактификация, большие tool_result).
- Записи сделаны на haiku; поведение склейки сообщений на других моделях не проверялось (это
  логика CLI, а не модели — вероятно, то же).

## 10. Рекомендация

**Переходить к реализации Console mode можно**, механизм подтверждён: отдельный процесс,
сообщения в ту же сессию, uuid, доставка без потерь, работа после отказа в разрешении. Но план
исследования нужно поправить до этапа 1:

1. **Статусы сообщений строить на `command_lifecycle`** (`queued`/`started`/`completed`/
   `cancelled`), replay — как дополнительное подтверждение. Проба совместимости — §8.
2. **Не считать «одно сообщение = один ход»**: сообщения, пришедшие во время хода, вливаются в
   текущий или склеиваются в следующий.
3. **`awaiting-input` выводить не из одного `result`**: учитывать фоновые задачи
   (`system/task_*`, `background_tasks_changed`) — ход может начаться без пользователя.
4. **stdin — только `JSON.stringify(obj) + '\n'`**, всегда с uuid; одна битая строка убивает
   сессию.
5. «Завершить сессию» = закрыть stdin (ход доработает). Немедленная остановка = kill без
   `result` (Windows проверено); Runner при своём выходе обязан убить ребёнка (POSIX).
6. `permission.denied` брать из `system/permission_denied`; ошибку хода — из
   `result.is_error`/`terminal_reason`.
7. До этапа 4 (устойчивость) повторить `live.mjs` на Linux и macOS (CI-раннер вручную или
   машина разработчика).

## Deviations and impact on related tasks

- Отклонения: `report.md` положен в `test/spike/console/`, рядом с фикстурами (`docs/notes/` в
  `.gitignore`, а задачи T16 на доске нет). Офлайн-тест идёт в обычном Jest-проекте `node`
  (он без сети); живые эксперименты вынесены в `live.mjs` вне Jest. Для эксперимента `tools`
  добавлен `--permission-mode acceptEdits` (первый прогон сохранён как `tools-write-denied`).
  Для parent-death добавлены `detached`-варианты — без них на Windows нельзя увидеть поведение
  «pipe закрыт, процесс жив».
- Затронуто: только новые файлы в `test/spike/console/`. `src/`, Runner, контракты v1,
  `package.json`, зависимости и настройки Claude Code не менялись.
- Для следующих задач Console mode: исследование (§2.1, §4.3–4.5, §6, §7) опирается на
  предположения, опровергнутые в §3 этого отчёта; фикстуры отсюда — готовый вход для тестов
  `normalize` (этап 1).
