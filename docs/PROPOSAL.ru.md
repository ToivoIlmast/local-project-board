# local-project-board — архитектурный proposal (v2)

Статус: **v2.2 — approved (2026-09-21). Решения §34 и D1–D3 (§35) закрыты. Фазы 0–6 завершены, следующая — фаза 7 (HTTP `/api/v1` + security).**
Дата: 2026-09-21

- v1 (2026-09-21) — первичный анализ.
- **v2.2 (2026-09-21)** — владелец принял D1–D3 (§35): без OpenAPI в MVP, last-write-wins, чтение с диска без кэша.
- **v2.1 (2026-09-21)** — закрыты открытые вопросы (§34), применены упрощения sanity check (§35).
- **v2 (2026-09-21)** — встроены решения владельца второго раунда. Где v1 им противоречил,
  приоритет у решений второго раунда. Продуктовая философия вынесена в
  [PHILOSOPHY.md](PHILOSOPHY.md) (English, канонический документ проекта).

Обозначения:
**РЕШЕНИЕ** — принято/предложено; **ОТКРЫТО** — нужен ответ;
**ИНВАРИАНТ** — закрепляется тестом, не прозой;
**NOW / BOUNDARY / FUTURE** — реализуем сейчас / только фиксируем границу (в документе и типах,
без кода) / будущая возможность.

Что изменилось относительно v1 (кратко):

| Тема | v1 | v2 |
|---|---|---|
| API | `/api/...` | `/api/v1/...` |
| Бизнес-логика | `src/server/services` | `src/core` — чистый TS, без Node/Express/React |
| Токен | `X-Board-Token` | `Authorization: Bearer <token>` (стандарт, агентам привычнее) |
| Node | ≥ 20 | **≥ 22.12.0** — Node 20 вышел из поддержки в апреле 2026 |
| React | 18 | 19 (текущий major) |
| Второй провайдер storage | SQLite в v0.2 | in-memory провайдер для тестов **сейчас** — вторая реализация порта без выхода за MVP |
| Экспорт | should-have | `board export` → `BoardSnapshot` **в MVP** как backup/export-формат (§12) |
| Plugins / Standalone / Sharing / AI provider | не рассматривались | точки расширения, классифицированы в §21 |
| E2E | отложено | в MVP, 3 сценария, отдельный раннер `@playwright/test` |
| Редактирование документов в UI | открытый вопрос | future (просмотр + создание через API в MVP) |

---

## 0. Философия и главный риск

Полный текст — [PHILOSOPHY.md](PHILOSOPHY.md). Главное:

> **Local-first by default, sharing by exception.**
> **A board in seconds, not a project management system.**

Главный риск проекта по-прежнему не технический: инструмент выживет, только если
(1) задачи в основном создаёт и обновляет AI через API, (2) доска не ломается при
`git checkout`, (3) запуск — одна команда. Архитектурная гибкость, которую мы закладываем,
не должна ухудшать ни один из этих трёх пунктов.

---

## 1. Принцип implementation details и где нужна dependency inversion

> **Frameworks, libraries and infrastructure are implementation details.**

React, Vite, Express, UI-библиотека, SQLite/Postgres, конкретный git-адаптер,
AI- и sharing-провайдеры не определяют ядро.

Но «слои Domain → Application → Ports → Adapters → Infrastructure» буквально — это
пять колец для пяти сущностей. **РЕШЕНИЕ: два кольца + контракт.**

```text
core/        домен + прикладные сервисы вместе. Чистый TypeScript.
             Не импортирует node:*, express, react, fs, fetch.
             Объявляет порты — ровно три.

adapters/    всё, что знает про конкретную технологию:
             server/ (Node, Express, fs, git), web/ (React, браузер).

contract/    wire-формат API v1 — между ними.
```

Dependency inversion — **только на реальных границах**, то есть там, где уже сейчас есть
≥2 реализации или среда исполнения обязана быть заменяемой:

| Порт | Почему это реальная граница | Реализации сейчас |
|---|---|---|
| `Storage` | выбирается конфигом; tests-first требует быструю реализацию | markdown, in-memory (тесты) |
| `GitReader` | проект может быть не git-репозиторием; в standalone git нет | system git, null |
| `EventSink` | сервисы публикуют события, SSE их доставляет; ядро не знает про HTTP | in-process bus, recording (тесты) |

Сознательно **не** делаем портами: HTTP-сервер (Express просто *является* адаптером,
заменяется переписыванием `server/http/`), config loader, logger, clock, id generator,
filesystem вообще, markdown-парсер, AI. Отдельные `TaskRepository`/`DocumentRepository`/
`ReportRepository` не заводим — один `Storage`.

Нюанс про «Markdown — деталь». Формат хранения *задачи* (frontmatter) — деталь адаптера,
ядро про него не знает. А «документы — это markdown-файлы» — **продуктовое обещание**
(PHILOSOPHY §6), а не деталь. Эти две вещи не путаем.

Нюанс про «React — деталь». Это значит: доменные правила (статусы, ранжирование,
валидация имён) не живут в компонентах, UI-toolkit спрятан за `shared/ui`, фичи ходят
в сервер через один клиентский модуль. Это **не** значит писать framework-agnostic
view-model слой под React — это был бы оверинжиниринг.

---

## 2. Итоговая архитектура (dependency direction)

```text
                    ┌──────────────── composition root: server/cli ────────────────┐
                    │  читает конфиг, выбирает адаптеры, собирает всё, стартует      │
                    └───────┬──────────────────────────────────────────┬────────────┘
                            │                                          │
                  ┌─────────▼─────────┐                                │
                  │ server/http       │  Express 5, security, SSE,     │
                  │ (единственное     │  static SPA, тонкие хендлеры   │
                  │  место с express) │                                │
                  └───┬───────────┬───┘                                │
                      │           │                                    │
              ┌───────▼─────┐     │                                    │
              │ contract/v1 │     │                                    │
              │ zod DTO,    │     │                                    │
              │ routes,     │     │                                    │
              │ instructions│     │                                    │
              └───────┬─────┘     │                                    │
                      │           │                                    │
                ┌─────▼───────────▼─────┐        реализуют порты      │
                │         core          │◄──────────────┬──────────────┘
                │ model · rules ·       │               │
                │ services · ports      │   server/storage/markdown
                │ (чистый TS)           │   server/git
                └───────────────────────┘   server/events

  web (React SPA) ──► web/api (BoardClient) ──► contract/v1 (типы + пути) ──► core/model (типы)
  web ✗ server       web ✗ core/services       ядро ✗ всё, что выше
```

Стрелка = «импортирует». Адаптеры указывают на ядро (реализуют его порты), ядро не знает ни
про одного из них.

Поток запроса:

```text
Claude ──POST /api/v1/tasks──► http/security ──► http/v1/tasks (parse by contract)
     ──► core TaskService.create ──► Storage.createTask (markdown adapter → .board/tasks/F26/task.md)
     ──► EventSink.publish(task.created) ──► http/sse ──► браузер ──► invalidate query ──► карточка появилась
```

---

## 3. Tech stack

| Слой | Выбор | Комментарий |
|---|---|---|
| Язык | TypeScript **6.0.x**, strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` | TS 7 пока несовместим: typescript-eslint требует `<6.1`, ts-jest `<7` |
| Runtime | Node.js **≥ 22.12.0**, ESM | CI: 22 и 24 |
| Схемы | zod 4 | один источник для валидации, типов и инструкций (OpenAPI — не в MVP, ADR-0017) |
| HTTP | Express 5 | деталь, живёт только в `server/http` |
| Frontend | React 19 + Vite | детали |
| Server state | TanStack Query | инвалидация по SSE, optimistic DnD |
| DnD | `@dnd-kit` | |
| Стили | CSS Modules + CSS custom properties, нативный `<dialog>` | ноль рантайм-зависимостей; UI-kit — деталь за `shared/ui` |
| Markdown | `react-markdown` + `remark-gfm` + `rehype-sanitize` | |
| Frontmatter | `yaml` | |
| Ranking | `fractional-indexing` | перемещение = запись одного файла |
| Тесты | Jest: unit, integration, API, conformance (+ supertest, RTL/jsdom); `@playwright/test`: только e2e в реальном браузере | два раннера — два разных вида тестирования |
| Lint/format | ESLint 10 flat config + typescript-eslint + `@eslint-react` + react-hooks + `eslint-plugin-boundaries` + Prettier | `eslint-plugin-react` не поддерживает ESLint 10 |

Не берём: Redux/zustand, Next.js, tRPC, ORM, native-модули, CSS-in-JS, UI-kit с рантаймом.
Версии — текущие majors на момент скаффолда, фиксируются lockfile'ом.

---

## 4. Repository structure

```text
local-project-board/
├── bin/board.js                    # shebang → dist/server/cli/main.js
├── src/
│   ├── core/                       # чистый TS: ✗ node:*, express, react, fs, fetch
│   │   ├── model/                  # Task, DocumentMeta, Report, Project, BoardSnapshot (zod)
│   │   ├── rules/                  # статусы, ranking, имена документов, формат id — чистые функции
│   │   ├── services/               # TaskService, DocumentService, ReportService, SnapshotService
│   │   ├── ports.ts                # Storage, GitReader, EventSink
│   │   ├── events.ts               # BoardEvent (discriminated union)
│   │   └── index.ts                # публичный API ядра (будущая основа PluginContext)
│   ├── contract/
│   │   └── v1/
│   │       ├── schemas.ts          # wire DTO, собираются из core/model
│   │       ├── routes.ts           # таблица роутов: method, path, схемы, пример, ai-метаданные
│   │       └── instructions.ts     # генератор Claude Instructions (чистая функция)
│   ├── server/                     # Node-адаптеры
│   │   ├── cli/                    # main.ts, commands/{instructions,export}.ts
│   │   ├── config/                 # schema.ts, load.ts (precedence)
│   │   ├── project/                # поиск корня доски через --git-common-dir
│   │   ├── storage/
│   │   │   ├── index.ts            # фабрика: config.storage.provider → Storage
│   │   │   └── markdown/
│   │   ├── git/                    # execFile + парсеры + NullGitReader
│   │   ├── events/                 # in-process EventSink
│   │   └── http/                   # ← единственное место, знающее Express
│   │       ├── createApp.ts
│   │       ├── security.ts         # Host/Origin/token, параметризован профилем
│   │       ├── sse.ts
│   │       ├── static.ts
│   │       └── v1/                 # тонкие хендлеры по ресурсам
│   └── web/
│       ├── app/                    # bootstrap, router, providers
│       ├── pages/                  # BoardPage, TaskPage
│       ├── api/                    # BoardClient поверх contract/v1 — единственный fetch к серверу
│       ├── features/
│       │   ├── task-board/         # ui/ model/ index.ts
│       │   ├── task-form/          # создание + редактирование
│       │   ├── task-documents/
│       │   ├── reports/
│       │   ├── git-status.tsx      # плоская feature из одного файла
│       │   └── ai-instructions.tsx # плоская feature из одного файла
│       └── shared/
│           ├── ui/                 # Button, Input, Modal, Typography, Badge, Dropdown, IconButton
│           ├── lib/                # http transport, форматирование, cn()
│           ├── hooks/              # useCopyToClipboard, useHotkey
│           └── types/              # не-доменные утилитарные типы
├── test/
│   ├── support/                    # temp git repo, temp board, in-memory Storage, recording EventSink
│   ├── conformance/storage.ts      # один набор × все провайдеры
│   ├── core/  contract/  config/  git/  api/  web/
│   ├── lint/                       # фикстуры нарушений архитектурных правил
│   ├── e2e/
│   └── pack/                       # npm pack → install → запуск → проверки
├── docs/
│   ├── PHILOSOPHY.md  architecture.md  api.md (генерируется)  configuration.md
│   ├── adr/
│   └── PROPOSAL.ru.md
├── .github/workflows/ci.yml
├── README.md  README.fi.md  README.sv.md
└── package.json  tsconfig.*.json  eslint.config.js  jest.config.js  vite.config.ts
```

Чего нет и почему:

- **`plugins/`** — не создаётся в MVP. Plugin API существует только в ADR (§22).
- **`widgets/`, `entities/`** — нет. Условие появления `widgets/`: одна композиция из ≥2
  features нужна на ≥2 страницах. `entities/` не нужен: доменные типы приходят из
  `contract` (← `core/model`).
- **`web/api/`** — это новый по сравнению с v1 каталог, и он оправдан: единственная точка,
  где фронт говорит с сервером. Это не `shared` (он знает слова «task», «document») и не
  feature (им пользуются все). Именно он — будущая граница standalone-режима (§23).
- Монорепо с workspaces — нет. Один пакет, три tsconfig-проекта, границы держит ESLint.

---

## 5. Domain model (`core/model`)

```ts
type TaskStatus = string;                // допустимые значения — из конфига

interface Task {
  id: string;                            // 'F25'
  title: string;
  status: TaskStatus;
  rank: string;                          // fractional index внутри колонки
  body: string;                          // markdown
  labels: string[];
  branch?: string;                       // мягкая связь с git, не валидируется
  createdAt: string;                     // ISO
  updatedAt: string;                     // ISO; last-write-wins (ADR-0018)
  extra?: Record<string, unknown>;       // неизвестные поля frontmatter, сохраняются как есть
}

interface DocumentMeta { taskId: string; name: string; size: number; updatedAt: string }
interface Report       { id: string; title: string; format: 'html' | 'md'; createdAt: string }

interface Project {
  name: string; root: string;
  statuses: TaskStatus[]; idPrefix: string;
  storage: { provider: string };
  git: { available: boolean; branch?: string; detached?: boolean };
  version: string;
  readIssues: { file: string; message: string }[];   // файлы, которые не читаются как задачи
}

interface BoardSnapshot {                // портируемый срез доски
  formatVersion: 1;
  exportedAt: string;
  project: Pick<Project, 'name' | 'statuses' | 'idPrefix'>;
  tasks: Task[];
  documents: { taskId: string; name: string; content: string }[];
  reports: (Report & { content: string })[];
}
```

- **Board как сущность не нужна**: доска = проект + статусы + задачи по `rank`.
- **Git reference не хранится**: у задачи `branch?`; коммиты и diff вычисляются по запросу
  (сохранённые SHA протухают после rebase).
- `status` — строка; валидность — правило в `core/rules`. **ИНВАРИАНТ:** статус вне конфига → 422.
- Id: `${tasks.idPrefix}${max+1}`, дефолтный префикс `T` (T1, T2, T3). Префикс — деталь конфигурации: в доменной модели `id` — просто строка, ядро не разбирает её на части, кроме аллокации следующего номера.
- Форматы id (фаза 1, id служат именами каталогов и файлов): префикс — 1–10 заглавных латинских букв
  (`^[A-Z]{1,10}$`; без цифр, иначе `A1`+`1` и `A`+`11` дают один id), id задачи —
  `^[A-Z]{1,10}[1-9][0-9]{0,8}$`, id отчёта — `R1, R2, …`. Это же отсекает `../`, `/` и `\0`.
- **ИНВАРИАНТ (ADR-0020): выданный id никогда не выдаётся повторно.** Доска хранит монотонный
  `sequence` — сколько id она выдала за всю жизнь; удаление задачи его не уменьшает. Политика —
  одна чистая функция `allocateId` в `core/rules/ids.ts`, провайдер хранит только число и делает
  аллокацию атомарно. `allocateId` продолжает с `max(sequence, наибольший существующий id)`:
  это покрывает правку доски руками и будущий `board import`. Id идут с пропусками — пропуск и
  есть след удалённой задачи.
- Id аллоцирует провайдер. **ИНВАРИАНТ:** 20 параллельных create → 20 разных id.
- Типы задач (из списка future) — если появятся, то как строковое поле без собственных схем
  полей. Разные наборы полей для разных типов — это Jira issue schemes (§32, п. 11).

---

## 6. Порты (`core/ports.ts`)

```ts
export interface Storage {
  init(): Promise<void>;
  close(): Promise<void>;

  listTasks(): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  createTask(input: NewTask): Promise<Task>;          // провайдер аллоцирует id
  updateTask(id: string, patch: TaskPatch): Promise<Task>;
  deleteTask(id: string): Promise<void>;               // удаляет и документы

  listDocuments(taskId: string): Promise<DocumentMeta[]>;
  readDocument(taskId: string, name: string): Promise<string | null>;
  writeDocument(taskId: string, name: string, content: string): Promise<DocumentMeta>;
  deleteDocument(taskId: string, name: string): Promise<void>;

  listReports(): Promise<Report[]>;
  readReport(id: string): Promise<string | null>;
  writeReport(input: NewReport): Promise<Report>;
  deleteReport(id: string): Promise<void>;
}

export interface GitReader {
  available(): Promise<boolean>;
  currentBranch(): Promise<{ name: string | null; detached: boolean }>;
  branches(): Promise<Branch[]>;
  status(): Promise<GitStatus>;
  commits(opts: { ref?: string; limit: number }): Promise<Commit[]>;
  diff(opts: { ref?: string; path?: string; staged?: boolean }): Promise<{ text: string; truncated: boolean }>;
}

export interface EventSink {
  publish(event: BoardEvent): void;
}
```

Чего в `Storage` нет намеренно: query/search (фильтрация — в сервисе над списком),
транзакций, конфига, `watch`. Слежение за внешними правками — внутреннее дело
markdown-адаптера: composition root передаёт ему callback `onExternalChange`, который
публикует `board.changed`. Отдельного типа в ядре под это нет (§35).

Контракт порта, зафиксированный conformance-тестами: методы **отклоняют промис**, а не бросают
синхронно (иначе вызывающий обязан и `try/catch`, и `.catch`); порядок списков определён —
задачи в порядке выдачи id, документы по имени; чтение отсутствующего — `null`, изменение
отсутствующего — ошибка.

Документы в контракте — `(taskId, name) → string`. Файловая природа — свойство
markdown-адаптера и продуктовое обещание (§10), а не форма интерфейса. Это то, что
позволяет in-memory и будущему IndexedDB реализовать тот же порт.

---

## 7. Storage comparison

Критерии — под одного разработчика с AI-агентом.

**Markdown/FS.** За: AI читает/пишет без сервера; ноль зависимостей и миграций; diff,
grep, backup из коробки; ничего не теряется при удалении инструмента.
Против и ответ: запросы → чтение с диска на каждый запрос, без кэша (сотни файлов ≈
миллисекунды; кэш появится, только если профилирование покажет необходимость — §35 D3);
конкурентность → один процесс-сервер, атомарная запись temp+rename, `fs.watch` только для
обновления UI при внешних правках, `runtime.json` не даёт запустить второй сервер; порядок → fractional index;
битый frontmatter → файл не становится задачей и попадает в `readIssues` (ADR-0022),
сервер не падает (**ИНВАРИАНТ**); UI показывает «2 files could not be read».

**SQLite.** За: запросы, транзакции, объёмы. Против: бинарный файл (агент без API слеп),
native-модуль или `node:sqlite` (в Node 22+ доступен без флага, но всё ещё помечен
нестабильным), вопрос двух источников правды. Реальной пользы на объёмах личной доски нет.

**MySQL.** Нужен только для общей доски на нескольких машинах — это нецель.
**PostgreSQL.** Если когда-нибудь нужен сетевой провайдер — брать его, не MySQL.
Оба ломают zero-config и никогда не будут дефолтом.

**Git-backed.** Три разных варианта: `.board/` в рабочей ветке (ломает branch-независимость),
orphan-ветка в отдельном worktree (корректно, но сложно — future-режим `git-branch`),
git objects/refs как БД (отклонено). Git — хороший канал синхронизации, плохой storage engine.

| | Markdown FS | SQLite | MySQL/PG | Git orphan |
|---|---|---|---|---|
| Zero-config | ✅ | ✅ | ❌ | ⚠️ |
| Читаемо AI без сервера | ✅ | ❌ | ❌ | ✅ |
| Запросы | ⚠️ в памяти | ✅ | ✅ | ⚠️ |
| Зависимости | нет | native / Node 22 | сервер | git |
| Сложность | низкая | средняя | высокая | высокая |

**РЕШЕНИЕ:** markdown/FS — дефолт и единственный реализованный провайдер MVP.

---

## 8. `.board/` и Git — принято

```text
project/
├── src/
├── package.json
├── board.config.yaml        ← отслеживается (форма доски)
└── .board/                  ← НЕ отслеживается (состояние доски)
    ├── .gitignore           ← содержит "*": каталог игнорирует сам себя
    ├── tasks/F25/{task.md, audit.md, plan.md, review.md}
    ├── reports/audit-2026-09-21.html
    └── runtime.json         ← url, pid, token; права 600; удаляется при выходе
```

- untracked-файлы `git checkout` не трогает → `main`, `feature/F25`, `feature/F26` видят одну доску;
- корень доски = `dirname(git rev-parse --git-common-dir)` → все worktree одного репо видят одну доску;
- не git-репозиторий → `.board/` в текущем каталоге, `GitReader` = null-реализация. **ИНВАРИАНТ.**
- мы не трогаем ни `.gitignore` пользователя, ни `.git/info/exclude`.

Цена: доска не попадает в clone и не бэкапится с кодом → `board export` (§12).
Future-режимы: `repo-tracked`, `git-branch`, `user-local` (`board.location` в конфиге).
Разрешение пути — в одном модуле `server/project/`, поэтому их добавление не трогает ядро.

---

## 9. Configurable storage

```yaml
storage:
  provider: markdown     # MVP: единственное допустимое значение
```

- Фабрика `server/storage/index.ts` — единственное место, знающее список провайдеров.
- Настройки провайдеров — discriminated union в zod: `provider: markdown` + `host: ...` —
  ошибка конфига, а не молчаливое игнорирование.
- Неизвестный провайдер → ошибка старта со списком доступных.

**Conformance suite** (`test/conformance/storage.ts`) — параметризован фабрикой (она умеет
открыть провайдер повторно на тех же данных — это нужно инварианту 10), гоняется по
in-memory и markdown. Новый провайдер обязан пройти его без изменения тестов. Инварианты:

1. create → get → list согласованы;
2. 20 параллельных create → 20 уникальных id;
3. update меняет только переданные поля и двигает `updatedAt`;
4. delete задачи удаляет её документы;
5. имена с `..`, `/`, `\`, `\0`, абсолютные пути отвергаются (path traversal);
6. запись атомарна: сбой посреди записи не оставляет полуфайла (markdown: temp+rename; тест через инъекцию сбоя);
7. повторный `init()` на существующих данных идемпотентен;
8. неизвестные поля (`extra`) переживают update;
9. данные не повреждаются: round-trip любого валидного `Task` — побайтово эквивалентен после нормализации;
10. id не переиспользуются (ADR-0020): create ×3 → удалить задачу с наибольшим id → create даёт новый id;
    `sequence` переживает закрытие и повторное открытие того же хранилища (перезапуск сервера);
11. порядок списков одинаков у всех провайдеров: задачи — в порядке выдачи id, документы — по имени.

In-memory провайдер живёт в `test/support/`, не публикуется и не выбирается конфигом.
Его задача — сделать абстракцию проверенной второй реализацией и дать быстрые тесты ядра.

---

## 10. Документы и отчёты — всегда файлы

```text
.board/
├── .gitignore                  # "*" — доска игнорирует сама себя (ADR-0001)
├── board.json                  # { formatVersion, taskSequence, reportSequence } — счётчики id
├── tasks/<id>/task.md          # frontmatter (метаданные) + markdown-тело
├── tasks/<id>/<name>           # документы — обычные файлы
└── reports/<id>.{html,md}      # отчёт + <id>.json рядом с ним (title, format, createdAt)
```

При любом будущем провайдере метаданных документы остаются файлами. Имя документа:
`^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}\.(md|html)$` (без ведущей точки — скрытые файлы не создаём).
**ИНВАРИАНТ:** имя `task.md` зарезервировано (регистронезависимо): иначе документ перезаписал бы
файл метаданных задачи. Правило живёт в `core/rules`, чтобы поведение совпадало у всех провайдеров. Standalone-снимок (§23) содержит *копии* документов;
источником правды он не является.

---

## 11. Configuration

```text
CLI flags > env (BOARD_*) > ./board.config.yaml > ~/.config/local-project-board/config.yaml > defaults
```

- `board.config.yaml` — **опционален**, отслеживается git'ом: форма доски (статусы, `tasks.idPrefix`,
  provider, AI-политика). Меняется редко → привязка к ветке безвредна.
- user-level — порт, открывать ли браузер, команда редактора, секреты будущих провайдеров
  (через `${ENV}`-интерполяцию). Токен сессии **не** хранится ни в одном конфиге — только в
  `.board/runtime.json`.
- zod `.strict()` **на каждом слое отдельно, до слияния** (ADR-0021): ошибка называет и путь
  (`config.tasks.idPrefix`), и источник (`board.config.yaml`, `BOARD_PORT`, `--port`).
  **ИНВАРИАНТ:** невалидный конфиг → человекочитаемая ошибка с путём к ключу
  и exit code 1, не стектрейс.
- Env-переменные — явный список, а не соглашение об именах: `BOARD_PORT`, `BOARD_OPEN`,
  `BOARD_PROJECT_NAME`, `BOARD_ID_PREFIX`, `BOARD_STORAGE_PROVIDER`.
- Секции под плагины нет и `Record<string, unknown>` тоже: конфигурация расширений
  проектируется вместе с реальным plugin contract. `${ENV}`-интерполяция и команда редактора —
  тоже не в MVP: у них пока нет потребителя.
- `core` не знает о конфиге: YAML, env и флаги живут только в `server/config`, ядро получает
  готовые значения аргументами.
- удалён статус, в котором есть задачи → сервер не стартует молча: чистое правило ядра
  `assertNoOrphanedStatuses` называет и статус, и конкретные задачи (`review: 2 tasks (T3, T7)`).

```yaml
# board.config.yaml — всё опционально
project: { name: dep-health }
tasks:
  idPrefix: F           # дефолт: T → T1, T2, T3; здесь → F1, F2, F3
statuses: [backlog, todo, in-progress, review, done]
storage: { provider: markdown }
ai: { allowSourceEdits: false }
```

---

## 12. Export / BoardSnapshot — в MVP

**РЕШЕНИЕ (owner, 2026-09-21):** `board export` входит в MVP, потому что `.board/` untracked
и без экспорта доску нечем бэкапить.

```text
board export  →  BoardSnapshot (один JSON-файл)  →  backup / перенос / передача
```

`BoardSnapshot` — это **портируемый формат backup/export**, и только он.

- Он **не** является persistence model: source of truth MVP — `.board/` + markdown/filesystem.
- Вокруг него **не** строятся синхронизация, merge engine, conflict resolution, distributed
  state, collaborative editing.
- Реализация MVP: zod-схема в `core/model`, чистая функция `createSnapshot(storage, project)`
  в `core/services` (фаза 4), CLI `board export [--out <file>]` (фаза 10). Ни один провайдер
  не хранит снимок и не обязан о нём знать: снимок строится поверх порта. Поле `formatVersion: 1` — одна строка, без механизма миграций.
- **ИНВАРИАНТ:** снимок валиден по собственной схеме и содержит каждую задачу, документ и отчёт
  доски (тест: заполненная доска → export → parse → сравнение с `Storage`).
- **ИНВАРИАНТ:** export — только чтение; `.board/` после него не меняется.

FUTURE (не MVP): `board import`, `board migrate --to <provider>` (export + import через порт
`Storage`), standalone HTML (§23).

---

## 13. REST API v1

Общие правила: только `127.0.0.1`; префикс `/api/v1`; JSON (кроме чтения документов и
отчётов — `text/markdown` / `text/html`); ошибки
`{ "error": { "code": "TASK_NOT_FOUND", "message": "...", "details": {} } }` со стабильными
кодами; 400 форма / 401 токен / 403 origin / 404 / 409 конфликт состояния (напр. дубль имени; версионного 409 нет — ADR-0018) / 422 недопустимое значение;
мутации требуют `Authorization: Bearer <token>`.

```text
GET    /api/v1/project

GET    /api/v1/tasks
POST   /api/v1/tasks                        {title, status?, body?, labels?, branch?}
GET    /api/v1/tasks/:id
PATCH  /api/v1/tasks/:id                    частичный; last-write-wins (§35 D2)
DELETE /api/v1/tasks/:id
POST   /api/v1/tasks/:id/move               {status, before?: id, after?: id} → rank считает сервер

GET    /api/v1/tasks/:id/documents
GET    /api/v1/tasks/:id/documents/:name
PUT    /api/v1/tasks/:id/documents/:name    создать/перезаписать, идемпотентно
DELETE /api/v1/tasks/:id/documents/:name

GET    /api/v1/git/status
GET    /api/v1/git/branches
GET    /api/v1/git/commits?ref=&limit=
GET    /api/v1/git/diff?ref=&path=&staged=

GET    /api/v1/reports
POST   /api/v1/reports                      {title, format: html|md, content}
GET    /api/v1/reports/:id
DELETE /api/v1/reports/:id                  ← добавлено для консистентности ресурсов

GET    /api/v1/events                       SSE
GET    /api/v1/instructions                 ← сгенерированные Claude Instructions (markdown)
```

Канонический список — `src/contract/v1/routes.ts` (21 роут); список выше — его читаемая форма.
Генератор AI Instructions сделан здесь же, в фазе 2, а не в фазе 9: он — часть того же
источника правды, и drift-тест без него не имеет смысла. В фазе 9 остаётся только эндпоинт.

Версионирование: `/api/v1` — это префикс в таблице роутов, а не инфраструктура. `v2`,
если появится, — второй каталог `contract/v2` + `server/http/v2` над тем же `core`.
Именно поэтому `contract` отделён от `core/model`: wire-формат может разойтись с доменом.

---

## 14. SSE

`GET /api/v1/events` — однонаправленный поток server → browser.

```text
task.created | task.updated | task.moved | task.deleted
document.written | document.deleted
report.created | report.deleted
board.changed            ← внешние правки файлов в .board/ (fs.watch) → UI перезапрашивает всё
```

- Ядро публикует события через порт `EventSink`; SSE — лишь сериализатор. Поэтому SSE
  стоит ~50 строк, а шина событий — то, что plugins позже получат как `context.events`.
- Внешние правки (агент пишет файлы напрямую) → `fs.watch` → перечитать → событие.
  Кэша нет, поэтому двойное событие (своя запись + watcher) безвредно — лишняя
  инвалидация, а не рассинхрон. Дедуп не нужен.
- Клиент: на событие — `invalidateQueries`; при реконнекте — полная инвалидация.
- WebSocket не нужен: канал от браузера к серверу — обычный REST.

---

## 15. Security

**Профиль `local` (NOW, единственный):**

1. bind `127.0.0.1`; флага `--host` в MVP нет вообще;
2. `Host` ∈ {`localhost`, `127.0.0.1`}:port — защита от DNS rebinding;
3. `Origin` отсутствует (curl, агент) или равен origin доски, иначе 403;
4. токен сессии генерируется при старте, лежит только в `.board/runtime.json` (600),
   встраивается в отдаваемый HTML и в Instructions; требуется для мутаций;
5. path traversal — отказ на уровне правил ядра и повторная проверка в адаптере
   (resolved path обязан лежать внутри `.board/`);
6. git — только `execFile`, `--` перед путями, таймаут, лимит буфера;
7. HTML-отчёты — `<iframe sandbox>` (без `allow-same-origin`) + CSP на ответе
   `/reports/:id`; markdown рендерится через `rehype-sanitize`.

`security.ts` принимает `{ port, token }` и выводит из них разрешённые Host/Origin.
Понятия «профиль» в коде нет: `shared`-профиль существует только как ADR-текст (§35).

**Профиль `shared` (BOUNDARY, только ADR):** токен на все запросы включая чтение, read-only
по умолчанию, ограниченный срок жизни ссылки, TLS через туннель, явное предупреждение в CLI.
> Local-only security и shared-board security — разные уровни доверия. Локальные дефолты
> никогда не ослабляются ради sharing.

**ИНВАРИАНТЫ (тесты):** чужой Origin → 403; чужой Host → 403; мутация без токена → 401;
`..%2f` в имени → 400; ответ `/reports/:id` содержит CSP.

---

## 16. AI integration

MVP: **API + сгенерированные Claude Instructions.** Запуска Claude/GPT-процессов нет.

Таблица роутов в `contract/v1/routes.ts` — единственный источник:

```ts
{
  id: 'tasks.create', method: 'POST', path: '/api/v1/tasks',
  summary: 'Create a task',
  body: NewTaskSchema, response: TaskSchema,
  example: { request: {...}, response: {...} },
  ai: { include: true, note: 'One task per actionable finding.' },
}
```

Из неё: рантайм-валидация (те же объекты схем), типы `web/api`, текст инструкций
(живой base URL `http://127.0.0.1:<port>/api/v1`, токен, имя проекта, статусы, idPrefix,
операции с примерами, правила, playbook'и audit/plan/review, политика `allowSourceEdits`).

**ИНВАРИАНТ (drift-тест):** каждый роут с `ai.include` присутствует в сгенерированном тексте
(метод + путь); ни один путь в тексте не отсутствует в таблице.

Доставка: кнопка Copy Claude Instructions, `GET /api/v1/instructions`,
`npx local-project-board instructions`.

AI-friendly payloads: плоские объекты, все поля кроме `title` опциональны, `PUT` документа
по имени (агенту не нужно запоминать id), `move` по соседям, а не по rank, стабильные коды
ошибок, которые можно упомянуть в инструкциях.

Граница AI-провайдера — см. §21: сейчас реальная граница AI — это сам HTTP API.
Агенты — внешние клиенты.

---

## 17. Git adapter

Read-only в MVP: status, current branch, branches, recent commits, diff.
Не MVP: commit, push, checkout, merge, создание веток.

- системный `git` через `execFile`, парсинг `status --porcelain=v2 --branch -z` и `log` с
  `\x1f`-разделителями; парсеры — чистые функции, тестируются на записанном выводе;
- без кэша и без слежения за `.git/`: UI перезапрашивает git-данные при фокусе окна и по кнопке «refresh» (§35);
- **ИНВАРИАНТ:** нет git / нет бинарника git / пустой репо без коммитов / detached HEAD /
  worktree / сломанный `.git` — нейтральный ответ (`available: false`, пустые списки),
  не исключение. Имя ветки никогда не придумывается;
- **ИНВАРИАНТ:** `ref` и `path` валидируются схемами `gitRefSchema`/`gitPathSchema` в адаптере,
  до запуска git; невалидное значение — `INVALID_GIT_ARGUMENT`, а не аргумент git;
  пути идут после `--`, shell не используется вообще (§15);
- нормализация вместо протечки git-деталей наружу: дата коммита приводится к UTC (`Z`),
  индекс и рабочее дерево дают отдельные записи (`staged: true|false`), unmerged-файл
  считается изменением в рабочем дереве, `R`/`C` — `renamed`/`added`, ignored пропускаются;
- диффы длиннее лимита обрезаются с `truncated: true` — клиент запрашивает более узкий `path`;
- корень доски: `server/project/boardRoot.ts` — `dirname(git rev-parse --git-common-dir)`,
  вне репозитория — сам каталог (ADR-0001); адаптер git и поиск корня — единственные места,
  которые знают о git CLI;
- связь с задачей — мягкая (`branch?`); UI подсвечивает задачу текущей ветки.

---

## 18. Frontend architecture

Слои: `app/`, `pages/` (два реальных маршрута: `/` и `/task/:id`), `features/`, `shared/`,
плюс `api/` (§4). `widgets/` и `entities/` не создаём.

**Features.** Размер — по необходимости: `task-board/` с `ui/ model/ index.ts`, а
`git-status.tsx` — один файл, который сам себе public API. Сегменты `ui/model/api/utils/types`
не создаются автоматически.

**Public API.** `import { TaskBoard } from '@/features/task-board'`. Deep import в чужую
feature запрещён ESLint. `index.ts` экспортирует минимум — обычно один компонент.

**Shared.** Только примитивы и инфраструктура: `Button, Input, Modal, Typography, Badge,
Dropdown, IconButton`, http-транспорт, хуки общего назначения. Не `TaskCard`, не
`AuditReport`, не `GitStatus`. `shared` не импортирует `features`, `api`, `contract`, `core`.

**UI library — деталь.** Фичи используют только `shared/ui`; стиль/toolkit меняется внутри
`shared/ui`.

**No GOD components.** Композиция:

- данные — в хуках `features/*/model` (TanStack Query), разметка — в компонентах;
- слоты для каркасов:

```tsx
<TaskDetailsLayout
  header={<TaskHeader task={task} />}
  content={<TaskBody task={task} />}
  sidebar={<><GitStatus branch={task.branch} /><TaskDocuments taskId={task.id} /></>}
/>
```

- `children` по умолчанию, именованные слоты — когда мест больше одного, render-props — когда
  потребителю нужно состояние; вместо boolean-флагов — специализированный компонент или `variant`;
- `TaskCard` имеет слот `actions` — core-UI сам через него рендерит «Details»; это же место,
  куда когда-то придут plugin-actions (§21, UI);
- порог дробления: >150 строк, или больше одной причины для изменения, или кусок нужен в
  другом месте. Микрокомпоненты по 10 строк ради «чистоты» — нет;
- серверное состояние только в TanStack Query, UI-состояние локально, глобального store нет;
- loading / empty / error обязательны для каждого списка.

**`web/api`** — `BoardClient`: типизированные функции `tasks.list()`, `tasks.move()`, …
поверх путей и схем `contract/v1`. `fetch` к серверу разрешён только здесь (ESLint).

---

## 19. Backend architecture

```text
server/http (Express)  →  core/services  →  core/ports  ←  server/{storage,git,events}
```

- хендлер: распарсить по схеме контракта → вызвать сервис → сериализовать; бизнес-логики нет;
- `core` не знает Express, HTTP, fs; `storage` не знает Express; `git` не знает HTTP;
- Express импортируется только в `server/http/**` — замена фреймворка = переписать этот каталог;
- `server/cli` — composition root: единственное место, которое собирает конкретные адаптеры.

---

## 20. Architectural boundaries

| Модуль | Может импортировать | НЕ может импортировать | Чем обеспечено |
|---|---|---|---|
| `core` | zod | `node:*`, express, react, fetch, `contract`, `server`, `web` | ESLint + `test/lint` |
| `contract` | `core/model`, zod | `core/services`, `server`, `web`, `node:*` | ESLint |
| `server/{storage,git,events,config,project}` | `core`, `node:*` | express, `web` | ESLint |
| `server/http` | `core`, `contract`, express | исходники `web` (отдаёт только собранный `dist/web`) | ESLint |
| `server/cli` | всё в `server` | `web` | ESLint |
| `web/api` | `contract` | `core/services`, `server` | ESLint |
| `web/features/*` | `web/api`, `shared`, другие features **только через index** | deep imports, `server`, `core/services` | ESLint |
| `web/shared` | сторонние библиотеки | `features`, `api`, `contract`, `core` | ESLint |
| `web/pages` | `features`, `shared` | `api` напрямую | ESLint |

Архитектурные правила проверяются **тестом**: `test/lint/` содержит файлы-нарушители
(deep import, `node:fs` в `core`, `express` в сервисе…), тест прогоняет ESLint и требует
ошибку на каждом. Иначе правило может тихо сломаться при правке конфига.

---

## 21. Extension points

| Точка | NOW | BOUNDARY ONLY | FUTURE |
|---|---|---|---|
| **Storage** | порт `Storage`; markdown-провайдер; in-memory (тесты); фабрика по конфигу; conformance suite | — | SQLite, PostgreSQL, MySQL, IndexedDB (standalone) |
| **AI** | versioned API; генерируемые Instructions; `ai`-метаданные в таблице роутов | ADR: эскиз `AiProvider { run(context): Promise<Output> }` — только текст | Claude CLI, OpenAI API, MCP-сервер над `core`, оркестрация |
| **Plugins** | ничего плагинного. Есть лишь две вещи, нужные MVP самому по себе: публичный фасад `core/index.ts` и шина событий | ADR: манифест, capabilities, lifecycle, `PluginContext`, правило «только через plugin API» | загрузчик, `board plugins`, публикация plugin API |
| **UI** | слот `actions` у `TaskCard`, слоты у `TaskDetailsLayout` — используются самим core-UI | ADR: декларативный `TaskAction` (id, label, capability; выполняется через API на сервере) | реестр plugin-actions; plugin-панели |
| **Standalone** | `BoardSnapshot` схема; `board export` (рекомендация); ядро без Node — enforced | ADR: standalone-сборка SPA, `BoardClient` на ядре + IndexedDB-`Storage` | `board.html`, импорт изменений из снимка |
| **Sharing** | loopback-only bind без флага `--host`; security middleware уже параметризован портом/токеном | ADR: профиль `shared` | LAN, временные ссылки, tunnel-plugins (Cloudflare, Tailscale) |

Правило: точка из BOUNDARY переходит в NOW, когда появляется **вторая реальная реализация**
или **конкретный пользовательский сценарий**, который без неё не работает.

---

## 22. Plugins — граница (BOUNDARY ONLY)

```ts
// эскиз для ADR-0014, не код MVP
interface PluginManifest {
  id: string; name: string; version: string;
  apiVersion: 1;                             // версия plugin API, не приложения
  capabilities: Capability[];               // 'tasks:read' | 'tasks:write' | 'documents:write'
                                            // | 'events' | 'git:read' | 'api:routes' | 'ui:actions' | ...
}
interface BoardPlugin { manifest: PluginManifest; activate(ctx: PluginContext): void | Promise<void>; deactivate?(): void }
interface PluginContext {                   // только то, что разрешено capabilities
  tasks?: TaskFacade; documents?: DocumentFacade; events?: EventSubscription;
  git?: GitReader; api?: RouteRegistrar; ui?: TaskActionRegistrar; log: Logger;
}
```

`Plugin → Plugin API (core/index.ts фасады) → Core`, никогда `Plugin → internal files`.

Честная оговорка о безопасности: **capabilities — это дизайн API, а не sandbox.**
In-process Node-plugin может сделать `import 'node:fs'` и что угодно ещё. Модель доверия
MVP-эпохи: «plugin = код, который ты сам поставил». Реальная изоляция потребовала бы
отдельного процесса/worker + permission model (Node `--permission`) — это future,
и capabilities-манифест заранее делает её возможной без смены API.

Как не превратить plugin API в отдельный продукт: первые две интеграции (например MCP и
SQLite) пишутся **внутри репозитория** как обычные модули, пользующиеся только фасадами ядра.
Plugin API публикуется лишь после того, как две реальные интеграции на нём заработали.
Опубликованный API — это обязательство совместимости; до этого момента его нет.

---

## 23. Standalone (FUTURE, граница — NOW)

```text
Normal board ──board export──► board.html (SPA + BoardSnapshot внутри) ──► браузер ──► IndexedDB
```

Standalone = **portable local snapshot board**: смотреть задачи и документы, двигать
карточки, менять статусы, изменения — в IndexedDB. Merge/конфликты — не нужны сейчас.

Что делаем сейчас, чтобы standalone не потребовал переписывать ядро:

1. `core` не импортирует `node:*` — ESLint + lint-тест. Тогда `TaskService` и правила
   ранжирования запускаются в браузере без изменений;
2. `Storage`-порт не содержит путей, `Buffer`, fs-типов — IndexedDB-реализация возможна;
3. фронт говорит с данными только через `web/api` (`BoardClient`). В standalone-сборке
   HTTP-реализация заменяется на «core + IndexedDB-Storage» — фичи не меняются;
4. `BoardSnapshot` — формат уже есть.

Нюанс: HTML-отчёты внутри standalone — через `iframe sandbox srcdoc`, та же модель безопасности.
Нюанс: git-панели в standalone нет (`GitReader` = null).

---

## 24. Sharing (FUTURE)

```text
Personal board ──normal use──► полностью локально
               └─need to share──► standalone file   (не требует сети)
                               └─► LAN / tunnel     (требует профиль shared)
```

Standalone и sharing — разные концепции и не объединяются в одну доменную абстракцию:
снимок — файл, sharing — сетевой доступ к живой доске. Никакой sharing-инфраструктуры в MVP.
Из архитектуры сейчас нужно лишь не заблокировать её: профиль безопасности параметризован,
Host-проверка вынесена в конфигурируемое место, provider-туннели — будущие plugins.

---

## 25. Testing (tests-first)

> Every new test layer must correspond to a concrete defect, invariant or architectural contract it protects.

Цикл для каждого нового поведения/контракта:
`invariant → failing test → implement → targeted tests → full tests → typecheck → ESLint → Prettier → pack smoke`.

| Слой | Что защищает | Инструмент |
|---|---|---|
| `core` unit | правила статусов, ranking, имена документов, сервисы (на in-memory storage) | Jest |
| `conformance/storage` | контракт порта `Storage`, 9 инвариантов §9 | Jest × провайдеры |
| markdown-специфичное | битый frontmatter, `extra`, fs.watch-дедуп, атомарность | Jest + tmp |
| `contract` | примеры валидны по схемам; drift Instructions; каждый роут имеет summary/example | Jest |
| `config` | precedence, строгая валидация, осиротевшие статусы | Jest |
| `git` | парсеры на записанном выводе; temp-репо: нет git / пустой / detached / worktree | Jest |
| `api` | CRUD, move, документы, отчёты, коды ошибок, security-инварианты §15, SSE-события | Jest + supertest |
| `snapshot` | export содержит всё, валиден по схеме, не меняет `.board/` | Jest |
| `lint` | архитектурные границы §20 действительно ловятся | Jest + ESLint API |
| `web` | формы создания/редактирования, пустые/ошибочные состояния, чистая функция позиции DnD | Jest + RTL |
| `e2e` | (1) задача, созданная через API, появляется в открытом UI без refresh; (2) DnD меняет статус и переживает reload; (3) документ, созданный через API, открывается в деталях | `@playwright/test` |
| `pack` | опубликованный пакет запускается; HTML без внешних URL (local-first) | Jest + npm pack |

Обязательный минимум из исходного задания (create/edit/move task, create document/report,
Git detection, API→task, API→document, storage provider, configuration) покрыт строками
`core`, `api`, `conformance`, `git`, `config`.

Честно про DnD: в jsdom полноценно не тестируется; логика позиции — чистая функция (unit),
реальное перетаскивание — один e2e-сценарий.

Цель по скорости: Jest без e2e/pack — до 30 с.

---

## 26. Tooling и CI

- `npm run typecheck` — `tsc -b` по трём проектам, ошибки = failure;
- `npm run lint` — ESLint flat: typescript-eslint, react, react-hooks, unused-imports,
  архитектурные `no-restricted-imports` (§20);
- `npm run format` / `format:check` — Prettier, единственный владелец форматирования,
  `eslint-config-prettier` выключает конфликтующие правила;
- `npm test` (Jest), `npm run test:e2e` (`@playwright/test`), `npm run test:pack`, `npm run build` (tsc server+contract+core → `dist/server`, Vite → `dist/web`).

```text
CI (Node 22, 24):  install → format:check → lint → typecheck → test → build → test:pack → test:e2e
```

---

## 27. Documentation

```text
README.md (EN, канонический) · README.fi.md · README.sv.md
docs/PHILOSOPHY.md · architecture.md · api.md (генерируется из routes.ts) · configuration.md · adr/
```

- README покрывает 21 пункт исходного задания;
- переводы: шапка `Based on README.md @ <commit>`, CI проверяет, что README.md не менялся
  после этого коммита без обновления fi/sv → «не расходятся» становится проверяемым;
- `docs/api.md` генерируется и проверяется в CI на актуальность.

---

## 28. MVP scope

**Входит**

```text
✓ npx local-project-board          ✓ /api/v1 REST API
✓ local web server (127.0.0.1)     ✓ SSE
✓ React board, Kanban              ✓ generated Claude Instructions
✓ configurable statuses            ✓ HTML reports (sandboxed)
✓ create/edit/delete tasks         ✓ Markdown storage + Storage boundary + conformance
✓ drag & drop (server-side rank)   ✓ .board/ untracked, worktree-aware
✓ task details                     ✓ local security profile
✓ Markdown documents (API + просмотр)   ✓ Jest, ESLint, Prettier, TypeScript, CI, pack smoke, e2e
✓ Git read-only                    ✓ README EN/FI/SV, PHILOSOPHY.md, architecture, ADR
✓ board export → BoardSnapshot (backup/export, не persistence, §12)
```

**Сознательно не входит**

```text
✗ authentication / users / multi-user     ✗ Git write operations
✗ cloud / SaaS                            ✗ Claude / GPT process execution
✗ Jira / Trello / GitHub integration      ✗ MCP
✗ AI chat UI                              ✗ SQLite / MySQL / PostgreSQL
✗ workflow engine                         ✗ standalone HTML, IndexedDB
✗ plugin platform / marketplace           ✗ sharing infrastructure
✗ редактор документов в UI                ✗ search / filters / labels UI
```

---

## 29. Future capabilities (не roadmap)

- **Storage:** SQLite, PostgreSQL, MySQL, IndexedDB.
- **AI:** MCP-сервер, Claude CLI, OpenAI API, оркестрация handoff'ов.
- **Integrations (plugins):** GitHub, Jira — ссылки и импорт, не двусторонняя синхронизация.
- **Standalone:** `board.html`, import изменений снимка.
- **Sharing:** LAN, временные ссылки, tunnel-плагины.
- **Board location:** `repo-tracked`, `git-branch`, `user-local`.
- **UX:** поиск, фильтры, метки, редактор документов, «Open in editor», горячие клавиши, темы.

---

## 30. ADR

| # | Решение |
|---|---|
| 0001 | `.board/` внутри проекта, untracked по умолчанию, корень через `--git-common-dir` |
| 0002 | Markdown/FS — дефолтный и единственный провайдер MVP |
| 0003 | Документы и отчёты — всегда файлы |
| 0004 | Порт `Storage` без query/транзакций; conformance suite + in-memory как вторая реализация |
| 0005 | Контракт API — таблица роутов на zod; типы/Instructions генерируются |
| 0006 | Два кольца (`core` чистый + адаптеры), DI только на трёх портах |
| 0007 | Git — `execFile`, read-only в MVP |
| 0008 | Security profile `local`; `shared` — отдельный, строже; локальные дефолты не ослабляются |
| 0009 | `BoardSnapshot` — портируемый backup/export-формат, не persistence model и не основа синхронизации |
| 0010 | Один npm-пакет, три tsconfig-проекта, без workspaces |
| 0011 | Позиция карточки — fractional index, считается сервером |
| 0012 | API versioning `/api/v1` |
| 0013 | Фронт: app/pages/features/shared + `api`; `widgets`/`entities` — по условию; UI-kit за `shared/ui` |
| 0014 | Plugin API — только граница; публикация после двух внутренних интеграций; capabilities ≠ sandbox |
| 0015 | Standalone и sharing — разные концепции |
| 0016 | Tests-first; архитектурные правила проверяются тестом |
| 0017 | OpenAPI не в MVP (§35 D1) |
| 0018 | Обновления задач — last-write-wins (§35 D2) |
| 0019 | Markdown-хранилище читает с диска на каждый запрос, без индекса в памяти (§35 D3) |

---

## 31. Implementation plan (tests-first)

Отличия от предложенного тобой порядка — три, с причинами:
(а) conformance-тесты **до** markdown-провайдера — иначе это не tests-first;
(б) pack smoke — **в фазе 0** на «hello»-сервере, а не в конце: ошибки упаковки дешевле всего ловить до того, как появился код;
(в) **ранний dogfood после API**, до UI: проверить API на реальном агенте раньше, чем вкладываться в интерфейс.

| Фаза | Сначала тест | Потом реализация | Выход |
|---|---|---|---|
| 0. Repo/tooling | pack-smoke на hello-сервере; lint-фикстуры границ | package.json, tsconfig×3, ESLint, Prettier, Jest, Vite, CI, заглушки README×3, PHILOSOPHY, ADR | зелёный CI на пустом проекте |
| 1. Core model + rules | ranking, статусы, имена документов, id | `core/model`, `core/rules` | чистое ядро |
| 2. Contract v1 | примеры валидны; у роута есть summary/example | `contract/v1/schemas`, `routes` | контракт |
| 3. Config | precedence, strict-ошибки | `server/config` | |
| 4. Storage | conformance suite (red) | in-memory → markdown (green); watch + дедуп | доказанный порт |
| 5. Services | сервисы на in-memory storage + recording EventSink | `core/services` | |
| 6. Git | парсеры; temp-репо и 5 edge-кейсов | `server/git`, NullGitReader, `server/project/boardRoot` | |
| 7. HTTP /api/v1 + security | supertest: CRUD, move, коды, security-инварианты | `server/http` | |
| 8. SSE | событие на каждую мутацию; поток | `server/events`, `http/sse` | |
| 9. Instructions | тест эндпоинта | `http/v1/instructions` (генератор — в фазе 2) | |
| 10. CLI + export | порт/токен/runtime.json; round-trip export | `server/cli` | **доска работает через curl** |
| ☐ checkpoint | — | Claude на dep-health работает с API по Instructions (без UI) | правка API до UI |
| 11. React UI | RTL: формы, состояния; unit: позиция DnD | web: board, DnD, details, documents, git, reports, copy instructions | |
| 12. E2E | 3 сценария §25 | — | |
| 13. Docs | CI-проверки переводов и api.md | README×3, architecture, configuration | |
| 14. Dogfood | — | полный сценарий на dep-health-analyzer | решение про следующие шаги |

---

## 32. Architectural sanity check

1. **Слишком сложная Clean Architecture?** В формулировке «Domain/Application/Ports/Adapters/Infrastructure» — да.
   Сведено к двум кольцам + контракт. Нет use-case-класса на операцию, нет маппинга DTO↔entity
   там, где они совпадают.
2. **Слишком много интерфейсов?** Три порта. Не делаем: репозиторий на сущность, IClock, IIdGenerator,
   ILogger, IConfig, IHttpServer, IMarkdownParser.
3. **Абстракции ради будущего?** В коде — только две вещи, мотивированные будущим, и обе с текущей
   пользой: `BoardSnapshot` (бэкап untracked-доски) и запрет `node:*` в ядре (он же держит ядро
   тестируемым без fs). Plugin API, AiProvider, UI-actions, shared-профиль, IndexedDB — только ADR.
4. **Слишком сложный API contract?** Таблица роутов — самый «фреймворкоподобный» кусок MVP и
   главный кандидат на разрастание. Ограничения: это обычный массив объектов; без кодогенерации
   на этапе build; OpenAPI в MVP нет (ADR-0017); если генератор инструкций
   перерастает ~300 строк — стоп и пересмотр.
5. **SSE нужен сейчас?** Да: сценарий dogfooding (§32 задания) без него не работает. Честная
   альтернатива — поллинг раз в 2 с — была бы проще в клиенте, но шина событий нужна ядру всё
   равно, и SSE поверх неё — ~50 строк.
6. **Какие границы действительно нужны?** core↔адаптеры (storage, git, events), server↔web,
   contract между ними, feature↔feature. Не нужны: domain↔application, репозиторий на сущность.
7. **Что достаточно задокументировать?** Plugins, AI provider, UI-actions, sharing-профиль,
   standalone-сборка, IndexedDB, режимы расположения доски.
8. **Что оставить конкретным до второй реализации?** Config loader, генератор Instructions (один
   формат), SSE-транспорт, markdown-парсер, ранжирование, BoardClient (одна HTTP-реализация —
   интерфейс выделим, когда появится standalone).
9. **Plugin architecture — отдельный продукт?** Риск реален: опубликованный plugin API = обязательство
   совместимости. Поэтому публикация только после двух внутренних интеграций (§22).
10. **Sharing слишком рано?** Нет: в коде только loopback-bind и middleware, параметризованный
    портом/токеном; флага `--host` нет (§35).
11. **Дрейф в Jira/Trello?** Кандидаты: «дополнительные task types» (допустимы только как строка без
    своих схем полей), Jira-интеграция (только ссылки/импорт, без двусторонней синхронизации),
    статусы (подсказываются, переходы не навязываются). Проверка — список Warning signs в PHILOSOPHY.
12. **Нарушение local-first?** AI-провайдеры, туннели, удалённые БД, GitHub/Jira — все opt-in и
    обязаны деградировать без сети. Исполняемые проверки: ESLint запрещает сетевые клиенты в `core`;
    pack-тест проверяет, что HTML не ссылается на внешние URL.
13. **Обязательная инфраструктура?** В MVP — никакой: ни БД, ни аккаунта, ни конфига.
    Postgres/MySQL никогда не станут дефолтом.

Одно противоречие внутри принятых решений, которое надо держать в голове: «документы всегда файлы»
+ будущий сетевой Postgres-провайдер = документы не расшарятся между машинами, что обесценивает
единственный сценарий Postgres. Сейчас ничего не решаем — фиксирую как риск.

---

## 33. Risks

| Риск | Что делаем |
|---|---|
| Таблица роутов разрастается в мини-фреймворк | лимит §32 п. 4; OpenAPI не в MVP |
| Plugin API проектируется без реального плагина и оказывается неверным | только ADR до двух внутренних интеграций |
| Untracked-доска теряется | `board export`, предупреждение в README |
| Двойные события (своя запись + watcher) | при чтении без кэша безвредны (§35 D3) |
| **`fs.watch` не работает на WSL2 для путей `/mnt/c/...`** (inotify через 9p) | при D3 влияет только на живое обновление UI, не на корректность; README: держать репозиторий в Linux-FS |
| Агент и человек пишут одновременно | SSE; last-write-wins (§35 D2, ADR-0018) |
| e2e нестабильны (DnD, SSE) | 3 сценария, не больше; DnD-логика покрыта unit |
| Переводы README — трёхкратная стоимость каждой правки | CI-проверка коммита-основы; переводы можно держать короче при той же функциональности |
| «Документы всегда файлы» vs сетевые провайдеры | зафиксировано в §32, решение отложено |
| Дрейф в PM-систему | PHILOSOPHY.md, warning signs, две контрольные вопроса |
| Инструмент становится вторым местом для дублирования | checkpoint после фазы 10 + dogfood |

---

## 34. Закрытые решения (owner, 2026-09-21)

1. `board export` + `BoardSnapshot` — **в MVP**, строго как backup/export-формат (§12).
2. Id: дефолт `T` (T1, T2, T3); `tasks.idPrefix` в конфиге (для dep-health — `F`). Деталь конфигурации.
3. Node **≥ 22.12.0**. Старые версии специально не поддерживаем.
4. E2E — отдельный раннер **`@playwright/test`**. Jest — unit, integration, API, conformance.
5. Лицензия **MIT**. Имя в npm `local-project-board` — **свободно** (проверено 2026-09-21:
   registry отдаёт 404, контрольный запрос `express` — 200). Имя не зарезервировано, пока пакет
   не опубликован.

---

## 35. Sanity check перед реализацией

Вопрос: что в v2 добавлено только ради гипотетического будущего?

### Применено без согласования — чистые упрощения, согласованное поведение не меняется

| Было в v2 | Стало | Почему |
|---|---|---|
| тип `WatchableStorage` в ядре | callback `onExternalChange` в опциях markdown-адаптера | тип в ядре с одной реализацией |
| «security profile» в коде + ошибка на `--host` | middleware от `{port, token}`; флага `--host` нет | профиль `shared` — только ADR |
| кэш git + watch `.git/` + событие `git.changed` | перезапрос при фокусе окна / по кнопке | инфраструктура ради частоты обновления, которую никто не просил |
| `?status=&label=&q=&branch=` у `GET /tasks` | без параметров (как в твоём списке v1 API) | UI фильтров — future; агент фильтрует список сам |
| `GET /instructions?format=md\|json` | только markdown | JSON-формату нет потребителя |
| DTO-схемы в `contract/v1/schemas.ts` | реэкспорт схем `core/model`, где wire = domain | дублирование ради возможного v2 |

### Оставлено, хотя мотивировано будущим, — потому что стоит ~0

- запрет `node:*` в `core` — сервисам fs и так не нужен: всё за портами;
- `web/api` как единственная точка `fetch` — клиентский модуль нужен всё равно;
- `contract/` отдельно от `core/` — таблица роутов нужна сейчас (валидация + Instructions).

### Спорные места — решены владельцем 2026-09-21: все три упрощения приняты (ADR-0017…0019)

**D1. OpenAPI (`GET /api/v1/openapi.json`).** У него нет потребителя в MVP: UI использует типы
напрямую, агент — Instructions. Генерация дешёвая (`z.toJSONSchema`), но это ещё эндпоинт, тест
и поверхность, которую надо держать корректной. Предлагаю: **убрать из MVP**. Контракт остаётся
способным отдать OpenAPI одним вызовом, когда появится потребитель (MCP, внешний клиент).
Ты явно перечислял OpenAPI среди потребителей контракта — поэтому спрашиваю.

**D2. Optimistic concurrency (`expectedUpdatedAt` → 409).** Защищает от одновременной правки
одной задачи человеком и агентом. Но UI тогда обязан уметь показать конфликт и предложить
разрешение, а это уже заметный кусок UI. Предлагаю: **last-write-wins** в MVP. SSE сразу
покажет в UI, что задачу изменил агент. Вернуть 409 можно без ломки API: поле опциональное.

**D3. Markdown-хранилище без индекса в памяти.** В v2 был индекс в памяти + `fs.watch` для
поддержки его актуальности + дедуп событий. Если агент правит файлы напрямую (а
AI-friendliness файлов — наше обещание), любой промах watcher'а означает, что API отдаёт
устаревшие данные. На WSL2 для `/mnt/c` watcher не работает вовсе. Предлагаю: **читать с диска
на каждый запрос**. Тогда корректность никогда не зависит от watcher'а — он нужен только
для живого обновления UI. Цена: `GET /tasks` читает все `task.md` (сотни файлов — единицы
миллисекунд). Кэш добавим, если профилирование покажет необходимость.

**Решение:** D1 — OpenAPI убран из MVP; D2 — last-write-wins, 409 можно добавить позже без ломки API;
D3 — чтение с диска на каждый запрос, `fs.watch` только для live-update/SSE.
