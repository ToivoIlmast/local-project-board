<!-- Based on README.md @ c27751963a16197a42ea305ce499057bfb35e9dd -->

# local-project-board

> En personlig utvecklartavla på några sekunder. Ingen ceremoni. Inget moln krävs. Delning när du behöver det.

**Status: pre-alpha.** Tavlan startar, serverar sitt API och har ett fungerande webbgränssnitt;
den är ännu inte prövad i skarpt arbete.
Språkversioner: [English](README.md) · [Suomi](README.fi.md)

## Vad det är

local-project-board är en lokal arbetsyta för en utvecklare och ett Git-repository: uppgifter,
anteckningar, Markdown-dokument, rapporter, Git-kontext och AI-resultat sida vid sida. Det liknar
mer en avancerad anteckningsbok för utvecklare än ett projekthanteringssystem.

## Snabbstart

```bash
cd mitt-projekt
npx local-project-board
```

Tavlan startar på `http://127.0.0.1:7432/` (nästa lediga port om den är upptagen) och öppnas i
webbläsaren. Ingen registrering, inget konto, ingen databas, inget nätverk utanför din egen dator.

| Kommando                               | Vad det gör                                             |
| -------------------------------------- | ------------------------------------------------------- |
| `npx local-project-board`              | Startar tavlan                                          |
| `npx local-project-board instructions` | Skriver ut API-instruktionerna att ge till en AI-agent  |
| `npx local-project-board export`       | Skriver ut en ögonblicksbild (`--out <fil>` sparar den) |

Flaggor: `--port <nummer>` (porten du anger måste vara ledig, annars stannar tavlan med ett fel),
`--no-open` (öppna ingen webbläsare), `--help`.

## I webbläsaren

Tavlan är en enda vy: projektets statusar som kolumner, och till höger en panel för det du tittar
på.

- **Uppgifter.** Skapa, ändra och ta bort; dra ett kort mellan kolumner, eller flytta det från
  kortets meny — enbart tangentbordet räcker till allt. Ordningen bestäms av servern, så två
  fönster kan aldrig vara oense om den.
- **En uppgift i detalj.** Titel, status, etiketter, gren, datum och en beskrivning i Markdown,
  och bredvid den uppgiftens dokument.
- **Dokument.** Läs dem som Markdown, skriv och ändra dem på sidan, ta bort dem. Ett
  `.html`-dokument öppnas i en egen ram som servern isolerar.
- **Rapporter.** Det en agent har sparat, HTML eller Markdown, öppnat lika säkert.
- **Git.** Nuvarande gren, om trädet är rent, vad som ändrats, diffen för en fil och de tio
  senaste commitarna.
- **Levande.** En uppgift som en agent skapat, en fil du ändrat i editorn, en rapport som ett
  skript skrivit: sidan följer med utan omladdning, och säger till när tavlan slutar svara.
- **AI-instruktioner.** Samma text som `npx local-project-board instructions` skriver ut, en knapp
  bort och redo att klistra in.

Filer som tavlan inte kan läsa visas som just det, ovanför kolumnerna — aldrig som uppgifter med
påhittade värden.

## Var tavlan bor

Tavlan hör till repositoriet, inte till grenen: den sparas i `.board/` bredvid din `.git`, så alla
worktrees öppnar samma tavla och `git checkout` rör den aldrig. Utanför ett repository skapas
`.board/` i den aktuella katalogen. `.board/` versionshanteras inte —
`npx local-project-board export` är hur du säkerhetskopierar den.

`board.config.yaml` i repositoriets rot är valfri och är tänkt att checkas in: den är tavlans form.

```yaml
project: { name: mitt-projekt }
statuses: [backlog, todo, in-progress, done]
tasks: { idPrefix: T }
storage: { provider: markdown }
server: { port: 7432, open: true }
ai:
  allowSourceEdits: false
  rules:
    - Ta aldrig bort en uppgift utan att fråga först.
    - Fråga innan du byter namn på en status.
```

Inställningarna läses först från flaggorna, sedan `BOARD_PORT`, `BOARD_OPEN`,
`BOARD_PROJECT_NAME`, `BOARD_ID_PREFIX`, `BOARD_STORAGE_PROVIDER`, sedan `board.config.yaml`,
sedan `~/.config/local-project-board/config.yaml` och till sist standardvärdena. En felstavad
nyckel eller ett värde utanför det tillåtna stoppar tavlan med ett meddelande som namnger nyckeln
och varifrån den kom. Att ta bort en status som uppgifter fortfarande använder stoppar också
tavlan, i stället för att dölja de uppgifterna.

`ai.rules` är avsnittet "## Rules" i AI-instruktionerna nedan — det en agent inte får bryta mot
när det gäller API:ets mekanik. Tavlan levereras med en liten inbyggd standard; sätter du `ai.rules`
i någon av konfigurationsfilerna ersätts hela listan, den utökas inte. Reglerna som en tavla delar ut
just nu är alltid de som `npx local-project-board instructions` skriver ut — även de inbyggda
standardreglerna när inget åsidosätter dem — så den här filen behöver aldrig upprepa dem.

## Medan den kör

En körande tavla skriver `.board/runtime.json` — pid, port, URL, tavlans rot och sessionstoken för
den här körningen — läsbar endast för dig, och tar bort filen vid `Ctrl+C`. Det är så kommandoraden
hittar en körande tavla, och så en andra tavla i samma katalog nekas.

Servern lyssnar bara på loopback-gränssnittet och ingen annanstans; det finns ingen flagga som
ändrar det. Att läsa API:t kräver ingenting, att ändra något kräver körningens token, och
förfrågningar från en annan sida eller till en annan värd nekas.

## Med en AI-agent

```bash
npx local-project-board instructions
```

skriver ut allt en agent behöver för att använda tavlan genom dess API: bas-URL:en, token (när
tavlan kör), den här tavlans statusar och varje rutt med exempel. Ge texten till Claude, ChatGPT
eller ditt eget verktyg, så kan den läsa tavlan, skapa och flytta uppgifter, skriva dokument och
spara rapporter.

Den fullständiga ruttreferensen — varje rutt, även de som den här texten utelämnar, varje felkod och
mediatyp — är [docs/api.md](docs/api.md), genererad från samma rutttabell.

## Principer

Se [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) (på engelska). Hur koden är uppbyggd och var ny kod
hör hemma beskrivs i [docs/architecture.md](docs/architecture.md) (på engelska).

## Utveckling

Kräver Node.js >= 22.12.0.

| Kommando                                  | Vad det gör                                     |
| ----------------------------------------- | ----------------------------------------------- |
| `npm install`                             | Installerar beroenden                           |
| `npm run build`                           | Bygger servern och användargränssnittet         |
| `npm test`                                | Jest-tester (servern och sidan)                 |
| `npm run test:e2e`                        | Playwright mot en tavla som startats på riktigt |
| `npm run test:pack`                       | Bygger npm-paketet, installerar och startar det |
| `npm run lint`                            | ESLint, inklusive arkitekturregler              |
| `npm run typecheck`                       | TypeScript                                      |
| `npm run format` / `npm run format:check` | Prettier                                        |

Webbläsartesterna behöver en webbläsare en gång: `npx playwright install --with-deps chromium`.

Översättningarna (`README.fi.md`, `README.sv.md`) följer `README.md`: när en commit som ändrar den är gjord, uppdatera dem och sätt deras första rad till `<!-- Based on README.md @ <commit> -->` med den committen — `npm test` misslyckas så länge de skiljer sig åt.

## Licens

[MIT](LICENSE)
