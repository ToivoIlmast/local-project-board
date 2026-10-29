<!-- Based on README.md @ 5d76690c7aeda449a51f3b7ac7e86c75bbbb9226 -->

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

| Kommando                                         | Vad det gör                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| `npx local-project-board`                        | Startar tavlan                                                            |
| `npx local-project-board instructions`           | Skriver ut API-instruktionerna att ge till en AI-agent                    |
| `npx local-project-board claude <ID>`            | Startar Claude Code på en uppgift, i den här terminalen                   |
| `npx local-project-board claude <ID> --check`    | Startar Claude Code på en kontroll av om uppgiften är aktuell             |
| `npx local-project-board claude <ID> --research` | Startar Claude Code på en undersökning av hur uppgiften ska angripas      |
| `npx local-project-board claude --wait`          | Startar Claude Code här på varje uppgift som skickas från tavlan          |
| `npx local-project-board claude --recover <ID>`  | Kontrollerar en körning vars väntare dog; markerar den förlorad vid bevis |
| `npx local-project-board export`                 | Skriver ut en ögonblicksbild (`--out <fil>` sparar den)                   |

Flaggor: `--port <nummer>` (porten du anger måste vara ledig, annars stannar tavlan med ett fel),
`--no-open` (öppna ingen webbläsare), `--version` (skriv ut versionen och avsluta), `--help`.

## I webbläsaren

Tavlan är en enda vy: projektets statusar som kolumner, och till höger en panel för det du tittar
på.

- **Uppgifter.** Skapa, ändra och ta bort; dra ett kort mellan kolumner, eller flytta det från
  kortets meny — enbart tangentbordet räcker till allt. Ordningen bestäms av servern, så två
  fönster kan aldrig vara oense om den.
- **En uppgift i detalj.** Titel, status, etiketter, gren, datum och en beskrivning i Markdown,
  och bredvid den uppgiftens dokument.
- **Versioner.** Varje verklig ändring av en uppgifts titel, etiketter eller beskrivning ger en
  version, och ingen version skrivs någonsin över eller tas bort (bara att uppgiften tas bort tar
  dem med sig). Ett val överst i uppgiften visar den aktuella eller en historisk version, en lista
  visar vad var och en ändrade och varifrån den kom (en redigering, en återställning, en ändring
  gjord utanför tavlan), två valfria kan jämföras som en diff, och en historisk kan återställas —
  som en ny version; statusen ändras inte. **Redigera** visar utkastet som en diff mot det
  aktuella innehållet innan det sparas, skickar bara det du ändrade, och om uppgiften hunnit
  ändras behåller det ditt utkast och visar det mot det nya innehållet i stället för att skriva
  över något. Uppgifter som fanns förut får sin första version första gången de ändras.
- **Kontrollera aktualitet.** En knapp i varje uppgift, i vilken status som helst, ber Claude Code
  (genom samma väntare som Skicka till AI) att jämföra uppgiften med repositoriet. Den skriver en
  rapport som sparas som den skickades, skild från versionerna och knuten till den version den
  läste: ett utlåtande, iakttagelserna med belägg, det den inte kunde avgöra, och rekommendationer.
  Du godkänner eller avvisar varje rekommendation; **Tillämpa godkända** öppnar redigeraren med dem
  tillämpade, och ingenting ändras förrän du sparar. En rapport för en version som uppgiften har
  lämnat markeras som föråldrad och tillämpas inte åt dig. Kontrollen ändrar ingen fil och inget
  git-tillstånd; tavlan tvingar inte det, den visar repositoriet före och efter. Se
  [Claude Code](#claude-code).
- **AI-undersökning.** Bredvid kontrollerna ber **Ny undersökning…** Claude Code (genom samma
  väntare) att ta reda på hur uppgiften ska angripas: vad den begär, vad repositoriet redan har,
  hur arbetet kan göras och vad som kan gå fel. Du kan ge den ett fokus och en modell.
  Undersökningen läser den version av uppgiften som gällde när den började, och skriver en
  Markdown-rapport med iakttagelser och rekommendationer som sparas en gång och aldrig skrivs om.
  Den ger inget utlåtande och säger inte om uppgiften är redo att genomföras — det avgör du. Du
  godkänner eller avvisar varje rekommendation, en avvisning med skäl om du vill. En som ändrar
  titeln, etiketterna eller beskrivningen tillämpas genom redigeraren, som vid en kontroll; en som
  gäller ett dokument eller en fil i projektet förs över för hand. Nästa undersökning av uppgiften
  får se de tidigare med dina beslut och skäl, och uppmanas att inte föreslå det du avvisat igen
  utan nya belägg. En undersökning startar aldrig arbetet och rör aldrig uppgiftens
  **AI-körning**: arbetet är ett separat **Skicka till AI → Claude Code**, vars dialog nämner en
  undersökning som fortfarande pågår eller har obeslutade rekommendationer, och startar ändå.
  Undersökningen uppmanas att inte ändra något; tavlan visar om något ändrades: grenen, committen
  och om arbetskatalogen var ren vid starten, vid rapporten och vid slutet, filerna som ändrades
  under tiden, uppgiftens dokument som ändrats sedan dess, och ett repositorium som gått vidare
  efter rapporten. Vem som ändrade, det säger tavlan inte. Se [Claude Code](#claude-code).
- **Dokument.** Läs dem som Markdown, skriv och ändra dem på sidan, ta bort dem. Ett
  `.html`-dokument öppnas i en egen ram som servern isolerar.
- **Rapporter.** Det en agent har sparat, HTML eller Markdown, öppnat lika säkert.
- **Git.** Nuvarande gren, om trädet är rent, vad som ändrats, diffen för en fil och de tio
  senaste commitarna.
- **Levande.** En uppgift som en agent skapat, en fil du ändrat i editorn, en rapport som ett
  skript skrivit: sidan följer med utan omladdning, och säger till när tavlan slutar svara.
- **AI-instruktioner.** Samma text som `npx local-project-board instructions` skriver ut, en knapp
  bort och redo att klistra in.
- **Inställningar.** Hur en agent arbetar med en uppgift — ändra filer, arbeta i en egen gren,
  köra kontrollerna, committa, pusha, skriva en rapport — för hela tavlan och för varje kolumn.
  Bara det du ändrar sparas, i `.board/workflow.yaml`; en kolumn kan helt enkelt följa tavlan. En
  enskild uppgift kan också avvika: öppna den för att se varifrån varje gällande värde kommer,
  åsidosätt en inställning eller skicka tillbaka uppgiften till sin kolumns inställningar. Språket i agentens rapport är ett av 14 (engelska som standard) och kan ställas in för tavlan och för en enskild uppgift; det är inte språket på tavlans sida. Språket i commit-meddelanden är en separat inställning som bara gäller tavlan — samma 14, eller inget, vilket lämnar det åt projektets konvention; uppgiftens id, filnamn och trailers översätts aldrig, och grennamn förblir engelska. Att
  lämna ett formulär med osparade ändringar frågar först: Spara, Förkasta eller Avbryt.
- **Skicka till AI.** I en uppgift, eller i menyn på dess kort, kopierar ett val handoffen —
  uppgiften, dess dokument och de steg som inställningarna kräver — redo att klistra in i vilken
  agent som helst. Den innehåller ingen token. `npx local-project-board handoff <ID>` skriver ut
  samma text. Det andra valet, **Claude Code**, startar Claude Code på uppgiften i terminalen där
  `npx local-project-board claude --wait` körs; se [Claude Code](#claude-code).
- **AI-körning.** Det som den senaste agenten på en uppgift rapporterade om sin körning — vilken
  agent, hur det gick, kontrollerna, dess commit, när den började och slutade — visas i uppgiften,
  markerat som agentens eget ord: tavlan kontrollerar det inte.

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

`ai.rules` är ditt projekts egna konventioner för en agent — sådant som ingen inställning uttrycker,
till exempel kommentarernas språk eller stilen på commit-meddelanden. AI-instruktionerna nedan
listar dem under "Project rules", efter API:ets regler. De reglerna finns alltid med: `ai.rules`
lägger till och kan varken ta bort eller ersätta någon, och en tom lista lägger inte till något. Ett
lagers lista ersätter listan i lagret under, som alla listor i den här filen. Vad en agent får göra
med en uppgift — ändra filer, arbeta i en egen gren, köra kontrollerna, checka in, pusha, skriva en
rapport — hör inte hemma i `ai.rules`: det är AI workflow-inställningarna, som sparas i
`.board/workflow.yaml` och som `GET /api/v1/workflow` svarar med; `npx local-project-board handoff
<id>` skriver ut stegen som gäller för en uppgift. Om en agent får ändra filer avgör inställningen
`editCode`; den gamla `ai.allowSourceEdits` hade aldrig någon effekt och är borttagen, så en
konfiguration som fortfarande har den stoppar tavlan med ett meddelande om det. Det en tavla delar
ut just nu är alltid det `npx local-project-board instructions` skriver ut, så den här filen behöver
aldrig upprepa reglerna.

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

skriver ut allt en agent behöver för att använda tavlan genom dess API: bas-URL:en,
platshållaren `<session token>` och rutten `GET /api/v1/session` som ger den riktiga token, den här
tavlans statusar och varje rutt med exempel. Texten innehåller aldrig själva token, vare sig tavlan
kör eller inte, så den kan klistras in i en chatt utan risk. Ge texten till Claude, ChatGPT
eller ditt eget verktyg, så kan den läsa tavlan, skapa och flytta uppgifter, skriva dokument och
spara rapporter. Projektet stöder också AI-assisterad uppgiftskörning via Claude Code
([Claude Code](#claude-code)).

Den fullständiga ruttreferensen — varje rutt, även de som den här texten utelämnar, varje felkod och
mediatyp — är [docs/api.md](docs/api.md), genererad från samma rutttabell.

## AI-arbetsflöde

Hur en agent arbetar med en uppgift ställs in på tre nivåer; en senare nivå vinner, inställning för
inställning:

1. **Tavla** — alla inställningar.
2. **Kolumn** (status) — bara de sex av/på-inställningarna.
3. **Uppgift** — de sex av/på-inställningarna och rapportspråket.

Av/på-inställningarna och deras standardvärden: ändra filer (`editCode`) på, arbeta i en gren på,
köra kontrollerna på, commit på, push av, skriva en rapport på. Bara tavlan ställer dessutom in
statusen som en uppgift flyttas till när arbetet börjar (`in-progress` om tavlan har den) och när
det slutar (`done` om tavlan har den; annars ingen), basgrenen och kontrollkommandot (båda
oinställda som standard) samt språket för commit-meddelanden (oinställt). Rapportspråket är
engelska om inget annat ställs in.

Bara det du ändrar lagras: tavlans och kolumnernas i `.board/workflow.yaml`, en uppgifts i fältet
`workflow:` i dess `task.md`. Standardvärdena skrivs aldrig. Medan ändra filer är av gäller inte
gren, kontroller, commit och push; de behåller sina värden och handoff säger det.
`GET /api/v1/workflow` svarar med tavlans och kolumnernas inställningar tillsammans med
standardvärdena, och `GET /api/v1/tasks/<ID>/workflow` med en uppgifts inställningar och källan
till varje värde.

För att skicka en uppgift till en agent använder du **Send to AI** i uppgiften eller i menyn på
dess kort: **Copy handoff** kopierar uppgiften, dess dokument och de steg inställningarna kräver
(samma text som `npx local-project-board handoff <ID>`), och **Claude Code** startar en session på
den; se [Claude Code](#claude-code). Begränsningar: stegen är instruktioner till agenten, inget
tavlan tvingar fram, och en agent mergar aldrig och behåller aldrig token: den skriver inte ut den, skriver den inte i en fil och skriver den inte in i ett kommando, och den skickar headern via stdin så att den inte hamnar i argv hos någon process. Skälen finns i
[ADR-0028](docs/adr/0028-ai-workflow-settings-three-levels-overrides-only.md).

## Claude Code

Starta en väntare en gång, i en terminal i projektet, bredvid den tavla som körs:

```bash
npx local-project-board claude --wait
```

Från och med då startar **Skicka till AI → Claude Code** i en uppgift (eller i menyn på dess kort)
Claude Code på uppgiften i den terminalen. När sessionen slutar väntar väntaren på nästa uppgift.
Utan väntare startar

```bash
npx local-project-board claude T13
```

samma session på uppgift `T13` direkt. I båda fallen startas `claude` i projektets rot, som en ny
session, med en kort prompt som pekar på uppgiftens levande handoff
(`GET /api/v1/tasks/T13/handoff`). Claude läser den själv, så den ser alltid uppgiften,
inställningarna som de är nu och API-instruktionerna, och följer dess steg: en gren, arbetet,
kontrollerna, en commit, en `report.md` och sin körning registrerad i uppgiften (`aiRun`), som sidan
visar som **AI run**.

Bra att veta:

- Tavlan måste köra (`npx local-project-board`, i en annan terminal) och `claude` måste finnas i
  din PATH. Annars säger kommandot vilket av dem som saknas, och startar ingenting.
- Tavlan startar aldrig `claude` själv: en server som kör program skulle göra sin token till en
  rätt att köra kod på din maskin, och den har ingen terminal att ge ett interaktivt program
  ([ADR-0029](docs/adr/0029-claude-code-is-started-by-the-cli-in-the-users-terminal.md)). Sidan
  ber bara tavlan att lämna uppgiften till väntaren du startade; väntaren bestämmer vad som körs.
- En session i taget: medan en session körs säger **Skicka till AI → Claude Code** att ingenting
  väntar, och startar ingenting. Det gör den också när ingen väntare är startad; då nämner den de
  två kommandona ovan.
- Modellen är en parameter för körningen, inte för arbetsflödet. Som standard är den din egen
  Claude Code-inställning och tavlan skickar ingen; nämner en körning en modell startar väntaren
  `claude --model <modell>` och körningen noterar den som `aiRun.model`. Den är antingen ett alias
  (`opus`, `sonnet`, `fable`, `haiku`) eller ett fullständigt namn på formen `claude-…`; allt annat
  nekas. Ett namn som `claude` själv inte känner till gör att körningen misslyckas.
  Behörighetsläget och resten är fortfarande dina egna inställningar. Det finns ingen token i prompten eller i argumenten.
- **Skicka till AI → Claude Code** öppnar först en liten dialog med tre kontroller: modellen
  (Claude Codes standard, ett alias eller ett annat fullständigt namn; den förra körningens modell
  om den hade en), rapportens språk och sessionen. Språket är en inställning för uppgiften: en
  ändring sparas på uppgiften före starten, och kan den inte sparas startar ingenting. Sessionen är en
  ny, eller — när den förra körningen lämnade en session — Resume, som fortsätter den. Lämnad som
  den öppnas startar dialogen exakt det som klicket startade före den.
- Blocket **AI run** på en uppgift berättar sessionens livscykel: försöket (`#runId`), tillståndet,
  modellen och läget (mode), som löparen skrev, samt agenten, kontrollerna och commiten, som agenten
  rapporterade och som blocket märker som sådana. En körning som misslyckats säger varför i ord
  (startade inte, slutade utan slutrapport med sin kod, agentens eget meddelande eller förlorad).
  För en körning som är `failed` eller `needs-review` finns två knappar: **Resume** öppnar dialogen
  ovan med den körningens session, och **Restart** frågar först — den gamla grenen byter namn till
  `…-attempt-N`, inget raderas — och startar sedan om arbetet i en ny session. Ingen av dem finns
  medan Claude Code arbetar, och en körning från före sessionerna har ingen Resume. Blocket kopierar
  också `claude --resume <session>` för att fortsätta för hand. Kortet visar `AI: failed #N`.
- Claude måste göra HTTP-anrop till `127.0.0.1` — den använder `curl` via sitt Bash-verktyg — och
  Claude Code frågar som standard om lov för det. Tillåt `Bash(curl *)` för sessionen, eller i
  dina Claude Code-inställningar om du inte vill ha frågor.
- Sessionen arbetar i din utcheckning av projektet, så grenen den skapar är den som är utcheckad
  efteråt. Ett arbetsträd för varje uppgift är inte gjort än.
- Om väntaren dör mitt i en session (dess terminal stängs, datorn somnar, den dödas) blir
  uppgiften kvar som **working** och inget kan startas på den. Kör
  `npx local-project-board claude --recover <ID>` i en terminal i projektet. Den levererar först
  ett slut som väntaren skrev ned men inte kunde skicka (väntaren sparar det i `.board/runner/`,
  så det överlever väntaren och en omstart av tavlan), och tittar sedan på den här datorn:
  **alive** — tavlan lämnas orörd; **lost** — väntaren och den `claude` den registrerade är borta,
  och körningen markeras `failed` (`failure.kind: lost`) med beviset; **unknown** — den här
  datorn kan inte visa det (ingen `/proc`, ett annat OS eller PID-namnrymd, en körning startad
  någon annanstans), och inget ändras om du inte lägger till `--confirm-stopped`, vilket
  körningen då registrerar. Körningen behåller sitt `runId` och sin session, så Resume fortsätter
  den som nästa körning. En körnings ålder tas aldrig som tecken på att den är förlorad.
- **Kontrollera aktualitet** i en uppgift startar samma väntare på en kontroll, och
  `npx local-project-board claude <ID> --check` startar en direkt. En kontroll är en session av
  eget slag: den rör inte uppgiftens AI-körning, så den nekas inte medan en körning pågår, och den
  behöver ingen återställning — om dess väntare dör blir kontrollen bara utan rapport och hindrar
  inget. Den får i sin handoff veta att den inte ska ändra någon fil, inte köra något git-kommando
  som skriver och inte skriva något till tavlan utom sin rapport; det är en instruktion och
  rättigheterna i din egen Claude Code, inte något tavlan kan tvinga fram, så rapporten visar
  grenen, committen och om arbetskatalogen var ren när kontrollen började och när den rapporterade.
  Dess slut sparas i `.board/runner/<ID>-check-<n>.json` tills tavlan tar emot det, skilt från
  körningarnas journaler.
- **Ny undersökning…** i en uppgift startar samma väntare på en undersökning, och
  `npx local-project-board claude <ID> --research --comment "<fokus>"` startar en direkt
  (`--comment` är valfri, högst 4000 tecken). En undersökning är en kontroll av eget slag: den
  numreras tillsammans med uppgiftens kontroller (`T13-C2`), har samma slags journal, nekas inte
  medan en körning pågår och ändrar ingenting i uppgiften förrän du tillämpar en rekommendation.
  Fokuset går till tavlan med starten av undersökningen och når Claude genom dess handoff, aldrig
  genom kommandoraden. Dess rapport, dina beslut och slutet på dess session överlever en omstart
  av tavlan. En undersökning vars session dog förblir **working**, hindrar inget och återställs
  inte: starta en ny. En väntare av en tidigare version får aldrig en undersökning; sidan säger då
  att den ska uppdateras.

## Principer

Se [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) (på engelska). Hur koden är uppbyggd och var ny kod
hör hemma beskrivs i [docs/architecture.md](docs/architecture.md) (på engelska).

## Utveckling

Kräver Node.js >= 22.12.0.

| Kommando                                  | Vad det gör                                        |
| ----------------------------------------- | -------------------------------------------------- |
| `npm install`                             | Installerar beroenden                              |
| `npm run build`                           | Bygger servern och användargränssnittet            |
| `npm start`                               | Startar tavlan från bygget                         |
| `npm run start:claude -- --wait`          | `claude --wait` från bygget (`-- T13`: en uppgift) |
| `npm test`                                | Jest-tester (servern och sidan)                    |
| `npm run test:e2e`                        | Playwright mot en tavla som startats på riktigt    |
| `npm run test:pack`                       | Bygger npm-paketet, installerar och startar det    |
| `npm run lint`                            | ESLint, inklusive arkitekturregler                 |
| `npm run typecheck`                       | TypeScript                                         |
| `npm run format` / `npm run format:check` | Prettier                                           |

Webbläsartesterna behöver en webbläsare en gång: `npx playwright install --with-deps chromium`.

Översättningarna (`README.fi.md`, `README.sv.md`) följer `README.md`: när en commit som ändrar den är gjord, uppdatera dem och sätt deras första rad till `<!-- Based on README.md @ <commit> -->` med den committen — `npm test` misslyckas så länge de skiljer sig åt.

## Licens

[MIT](LICENSE)
