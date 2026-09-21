<!-- Based on README.md @ uncommitted -->

# local-project-board

> En personlig utvecklartavla på några sekunder. Ingen ceremoni. Inget moln krävs. Delning när du behöver det.

**Status: pre-alpha.** Inget är användbart ännu. Den här README-filen beskriver målet, inte en färdig funktion.
Språkversioner: [English](README.md) · [Suomi](README.fi.md)

## Vad det är

local-project-board är en lokal arbetsyta för en utvecklare och ett Git-repository: uppgifter,
anteckningar, Markdown-dokument, rapporter, Git-kontext och AI-resultat sida vid sida. Det liknar
mer en avancerad anteckningsbok för utvecklare än ett projekthanteringssystem.

## Snabbstart (planerad)

```bash
cd mitt-projekt
npx local-project-board
```

Tavlan öppnas i webbläsaren. Ingen registrering, inget konto, ingen databas.

## Principer

Se [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) (på engelska).

## Utveckling

Kräver Node.js >= 22.12.0.

| Kommando                                  | Vad det gör                                     |
| ----------------------------------------- | ----------------------------------------------- |
| `npm install`                             | Installerar beroenden                           |
| `npm run build`                           | Bygger servern och användargränssnittet         |
| `npm test`                                | Jest-tester                                     |
| `npm run test:pack`                       | Bygger npm-paketet, installerar och startar det |
| `npm run lint`                            | ESLint, inklusive arkitekturregler              |
| `npm run typecheck`                       | TypeScript                                      |
| `npm run format` / `npm run format:check` | Prettier                                        |

## Licens

[MIT](LICENSE)
