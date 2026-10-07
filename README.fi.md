<!-- Based on README.md @ 41c5a58f2b4a5d117dbbcb0bb6643cc35259c91f -->

# local-project-board

> Henkilökohtainen kehittäjän taulu sekunneissa. Ei seremonioita. Ei pilveä. Jakaminen silloin, kun sitä tarvitset.

**Tila: pre-alpha.** Taulu käynnistyy, tarjoilee API:nsa ja siinä on toimiva
selainkäyttöliittymä; oikeassa työssä sitä ei ole vielä koeteltu.
Kieliversiot: [English](README.md) · [Svenska](README.sv.md)

## Mikä tämä on

local-project-board on paikallinen työtila yhdelle kehittäjälle ja yhdelle Git-repositoriolle:
tehtävät, muistiinpanot, Markdown-dokumentit, raportit, Git-konteksti ja tekoälyn tuotokset
rinnakkain. Se on lähempänä kehittynyttä kehittäjän muistikirjaa kuin projektinhallintajärjestelmää.

## Pika-aloitus

```bash
cd oma-projekti
npx local-project-board
```

Taulu käynnistyy osoitteessa `http://127.0.0.1:7432/` (tai seuraavassa vapaassa portissa, jos se
on varattu) ja avautuu selaimeen. Ei rekisteröitymistä, ei tiliä, ei tietokantaa, ei verkkoa oman
koneen ulkopuolelle.

| Komento                                 | Mitä se tekee                                                          |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `npx local-project-board`               | Käynnistää taulun                                                      |
| `npx local-project-board instructions`  | Tulostaa API-ohjeet tekoälyagentille annettavaksi                      |
| `npx local-project-board claude <ID>`   | Käynnistää Claude Coden tehtävään tässä terminaalissa                  |
| `npx local-project-board claude --wait` | Käynnistää Claude Coden tässä jokaiseen taululta lähetettyyn tehtävään |
| `npx local-project-board export`        | Tulostaa taulun tilannevedoksen (`--out <tiedosto>` tallentaa sen)     |

Valitsimet: `--port <numero>` (nimeämäsi portin on oltava vapaa, muuten taulu pysähtyy virheeseen),
`--no-open` (älä avaa selainta), `--help`.

## Selaimessa

Taulu on yksi näkymä: projektin tilat sarakkeina ja oikealla paneeli sille, mitä katsot.

- **Tehtävät.** Luo, muokkaa ja poista; raahaa kortti sarakkeesta toiseen tai siirrä se kortin
  valikosta — pelkkä näppäimistö riittää kaikkeen. Järjestyksen päättää palvelin, joten kaksi
  ikkunaa eivät voi olla siitä eri mieltä.
- **Tehtävän tiedot.** Otsikko, tila, tunnisteet, haara, päivämäärät ja markdown-kuvaus, ja
  vieressä tehtävään kuuluvat dokumentit.
- **Dokumentit.** Lue markdownina, kirjoita ja muuta sivulla, poista. `.html`-dokumentti avautuu
  omaan kehykseensä, jonka palvelin eristää.
- **Raportit.** Mitä agentti on tallentanut, HTML tai markdown, avattuna yhtä turvallisesti.
- **Git.** Nykyinen haara, onko työpuu siisti, mikä muuttui, tiedoston diff ja kymmenen viimeistä
  committia.
- **Elossa.** Agentin luoma tehtävä, editorissa muokattu tiedosto, skriptin kirjoittama raportti:
  sivu seuraa perässä ilman uudelleenlatausta ja kertoo, jos taulu lakkaa vastaamasta.
- **Tekoälyohjeet.** Sama teksti, jonka `npx local-project-board instructions` tulostaa, yhden
  painikkeen päässä ja valmiina liitettäväksi.
- **Asetukset.** Miten agentti työskentelee tehtävän parissa — muuttaa tiedostoja, työskennellä
  omassa haarassa, ajaa tarkistukset, tehdä commitin, pushata, kirjoittaa raportin — koko taululle
  ja jokaiselle sarakkeelle. Vain se, minkä muutat, tallennetaan tiedostoon
  `.board/workflow.yaml`; sarake voi yksinkertaisesti seurata taulua. Yksittäinen tehtävä voi myös
  poiketa: avaa se nähdäksesi, mistä kukin voimassa oleva arvo tulee, ohita yksi asetus tai palauta
  tehtävä sarakkeensa asetuksiin. Agentin raportin kieli on yksi 14:stä (oletuksena englanti), ja se voidaan asettaa taululle ja yksittäiselle tehtävälle; se ei ole taulun sivun kieli. Commit-viestien kieli on erillinen, vain taululle kuuluva asetus — samat 14 tai ei mitään, jolloin se jätetään projektin käytännölle; tehtävän tunnusta, tiedostonimiä ja trailereita ei koskaan käännetä, ja haarojen nimet pysyvät englanniksi. Lomakkeesta poistuttaessa tallentamattomat muutokset kysytään
  ensin: Tallenna, Hylkää tai Peruuta.
- **Lähetä tekoälylle.** Tehtävässä tai sen kortin valikossa yksi valinta kopioi handoffin —
  tehtävän, sen dokumentit ja asetusten edellyttämät vaiheet — valmiina liitettäväksi mille
  tahansa agentille. Siinä ei ole tokenia. `npx local-project-board handoff <ID>` tulostaa saman
  tekstin. Toinen valinta, **Claude Code**, käynnistää Claude Coden kyseiseen tehtävään siinä
  terminaalissa, jossa `npx local-project-board claude --wait` on käynnissä; katso
  [Claude Code](#claude-code).
- **Tekoälyn ajo.** Se, mitä tehtävän viimeisin agentti kertoi ajostaan — mikä agentti, miten
  meni, tarkistukset, sen commit, milloin se alkoi ja päättyi — näkyy tehtävässä merkittynä
  agentin omaksi sanaksi: taulu ei tarkista sitä.

Tiedostot, joita taulu ei osaa lukea, näkyvät juuri sellaisina sarakkeiden yläpuolella — eivät
koskaan tehtävinä, joiden arvot on keksitty.

## Missä taulu sijaitsee

Taulu kuuluu repositoriolle, ei haaralle: se tallennetaan hakemistoon `.board/` `.git`-hakemiston
viereen, joten jokainen worktree avaa saman taulun eikä `git checkout` koske siihen. Repositorion
ulkopuolella `.board/` luodaan nykyiseen hakemistoon. `.board/` ei ole versionhallinnassa —
`npx local-project-board export` on tapa varmuuskopioida se.

Repositorion juuressa oleva `board.config.yaml` on valinnainen ja tarkoitettu commitoitavaksi:
se on taulun muoto.

```yaml
project: { name: oma-projekti }
statuses: [backlog, todo, in-progress, done]
tasks: { idPrefix: T }
storage: { provider: markdown }
server: { port: 7432, open: true }
ai:
  rules:
    - Älä koskaan poista tehtävää kysymättä ensin.
    - Kysy ennen tilan uudelleennimeämistä.
```

Asetukset luetaan ensin valitsimista, sitten muuttujista `BOARD_PORT`, `BOARD_OPEN`,
`BOARD_PROJECT_NAME`, `BOARD_ID_PREFIX`, `BOARD_STORAGE_PROVIDER`, sitten tiedostosta
`board.config.yaml`, sitten tiedostosta `~/.config/local-project-board/config.yaml` ja lopuksi
oletuksista. Väärin kirjoitettu avain tai sallitun ulkopuolinen arvo pysäyttää taulun viestiin,
joka nimeää avaimen ja sen lähteen. Myös sellaisen tilan poistaminen, jota tehtävät yhä käyttävät,
pysäyttää taulun sen sijaan että ne tehtävät piilotettaisiin.

`ai.rules` ovat projektisi omat käytännöt agentille — se, mitä mikään asetus ei ilmaise, kuten
kommenttien kieli tai commit-viestien tyyli. Alla olevat tekoälyohjeet luettelevat ne otsikon
"Project rules" alla API:n sääntöjen jälkeen. API:n säännöt ovat aina mukana: `ai.rules` lisää
niihin eikä voi poistaa tai korvata yhtäkään, ja tyhjä lista ei lisää mitään. Kerroksen lista korvaa
alemman kerroksen listan, kuten jokainen tämän tiedoston lista. Se, mitä agentti saa tehdä
tehtävällä — muuttaa tiedostoja, työskennellä omassa haarassa, ajaa tarkistukset, commitoida,
pushata, kirjoittaa raportin — ei kuulu `ai.rules`-asetukseen: ne ovat AI workflow -asetukset, jotka
tallennetaan tiedostoon `.board/workflow.yaml` ja jotka `GET /api/v1/workflow` palauttaa; `npx
local-project-board handoff <id>` tulostaa yhteen tehtävään sopivat vaiheet. Se, saako agentti
muuttaa tiedostoja, on asetus `editCode`; vanhalla `ai.allowSourceEdits`-avaimella ei ollut koskaan
vaikutusta ja se on poistettu, joten asetustiedosto, jossa se yhä on, pysäyttää taulun viestiin,
joka kertoo siitä. Se, mitä taulu jakaa juuri nyt, on aina se, mitä `npx local-project-board
instructions` tulostaa, joten tämän tiedoston ei tarvitse toistaa sääntöjä.

## Kun taulu on käynnissä

Käynnissä oleva taulu kirjoittaa tiedoston `.board/runtime.json` — prosessin pid, portti, URL,
taulun juuri ja tämän ajon istuntotunnus — vain sinun luettavissasi, ja poistaa sen kun painat
`Ctrl+C`. Sen avulla komentorivi löytää käynnissä olevan taulun ja toinen taulu samaan hakemistoon
torjutaan.

Palvelin kuuntelee vain loopback-liitäntää eikä missään muualla; sitä ei voi vaihtaa valitsimella.
API:n lukeminen ei vaadi mitään, muutokset vaativat tämän ajon tunnuksen, ja pyynnöt toiselta
sivulta tai toiselle isännälle torjutaan.

## Tekoälyagentin kanssa

```bash
npx local-project-board instructions
```

tulostaa kaiken, mitä agentti tarvitsee käyttääkseen taulua API:n kautta: perus-URL:n, tunnuksen
(kun taulu on käynnissä), tämän taulun tilat ja jokaisen reitin esimerkkeineen. Anna teksti
Claudelle, ChatGPT:lle tai omalle työkalullesi, niin se voi lukea taulua, luoda ja siirtää
tehtäviä, kirjoittaa dokumentteja ja tallentaa raportteja.

Täydellinen reittiviite — jokainen reitti, myös ne, jotka tämä teksti jättää pois, sekä jokainen
virhekoodi ja mediatyyppi — on [docs/api.md](docs/api.md), joka luodaan samasta reittitaulusta.

## Claude Code

Käynnistä odottaja kerran projektin terminaalissa käynnissä olevan taulun rinnalle:

```bash
npx local-project-board claude --wait
```

Siitä lähtien **Lähetä tekoälylle → Claude Code** tehtävässä (tai sen kortin valikossa)
käynnistää Claude Coden kyseiseen tehtävään tuossa terminaalissa. Kun istunto päättyy, odottaja
odottaa seuraavaa tehtävää. Ilman odottajaa komento

```bash
npx local-project-board claude T13
```

käynnistää saman istunnon tehtävään `T13` suoraan. Kummassakin tapauksessa `claude` käynnistetään
projektin juuressa uutena istuntona yhdellä lyhyellä kehotteella, joka osoittaa tehtävän elävään
handoffiin (`GET /api/v1/tasks/T13/handoff`). Claude lukee sen itse, joten se näkee aina tehtävän,
asetukset sellaisina kuin ne ovat nyt ja API-ohjeet, ja noudattaa sen vaiheita: haara, työ,
tarkistukset, commit, `report.md` ja ajonsa kirjattuna tehtävään (`aiRun`), jonka sivu näyttää
kohdassa **AI run**.

Hyvä tietää:

- Taulun on oltava käynnissä (`npx local-project-board`, toisessa terminaalissa) ja `claude`:n
  PATHissa. Muuten komento kertoo, kumpi puuttuu, eikä käynnistä mitään.
- Taulu ei koskaan käynnistä `claude`a itse: ohjelmia ajava palvelin tekisi tokenistaan oikeuden
  suorittaa koodia koneellasi, eikä sillä ole terminaalia interaktiiviselle ohjelmalle
  ([ADR-0029](docs/adr/0029-claude-code-is-started-by-the-cli-in-the-users-terminal.md)). Sivu
  vain pyytää taulua antamaan tehtävän käynnistämällesi odottajalle; odottaja päättää, mitä
  ajetaan.
- Yksi istunto kerrallaan: istunnon aikana **Lähetä tekoälylle → Claude Code** kertoo, ettei mikään
  odota, eikä käynnistä mitään. Samoin, jos odottajaa ei ole käynnistetty; silloin se kertoo yllä
  olevat kaksi komentoa.
- Malli on ajon parametri, ei workflow'n. Oletuksena se on oma Claude Code -asetuksesi, eikä taulu välitä mitään; jos ajo nimeää mallin, odottaja käynnistää `claude --model <malli>` ja ajo kirjaa sen kohtaan `aiRun.model`. Malli on joko alias (`opus`, `sonnet`, `fable`, `haiku`) tai muodon `claude-…` täysi nimi; muu hylätään. Nimi, jota `claude` itse ei tunne, päättää ajon epäonnistumiseen. Käyttöoikeustila ja muu ovat edelleen omia asetuksiasi.
  Kehotteessa tai argumenteissa ei ole tokenia.
- **Lähetä tekoälylle → Claude Code** avaa ensin pienen dialogin, jossa on kolme valintaa: malli
  (Claude Coden oletus, alias tai muu täysi nimi; edellisen ajon malli, jos sillä oli sellainen),
  raportin kieli ja istunto. Kieli on tehtävän asetus: muutos tallennetaan tehtävään ennen
  käynnistystä, ja jos sitä ei voida tallentaa, mitään ei käynnistetä. Istunto on toistaiseksi
  uusi: edellisen jatkaminen (Resume) näkyy, mutta on pois käytöstä, kunnes odottaja osaa sen.
  Sellaisenaan dialogi käynnistää täsmälleen saman kuin napsautus ennen sitä.
- Clauden on tehtävä HTTP-pyyntöjä osoitteeseen `127.0.0.1` — se käyttää `curl`ia Bash-työkalunsa
  kautta — ja Claude Code kysyy siihen oletuksena luvan. Salli `Bash(curl *)` istunnolle tai omissa
  Claude Code -asetuksissasi, jos et halua kysymyksiä.
- Istunto työskentelee projektisi työkopiossa, joten sen luoma haara on sen jälkeen uloskirjattuna.
  Työpuuta kutakin tehtävää varten ei ole vielä tehty.

## Periaatteet

Katso [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) (englanniksi). Koodin rakenne ja se, mihin uusi
koodi kuuluu, on kuvattu tiedostossa [docs/architecture.md](docs/architecture.md) (englanniksi).

## Kehitys

Vaatii Node.js >= 22.12.0.

| Komento                                   | Mitä se tekee                                         |
| ----------------------------------------- | ----------------------------------------------------- |
| `npm install`                             | Asentaa riippuvuudet                                  |
| `npm run build`                           | Kääntää palvelimen ja käyttöliittymän                 |
| `npm start`                               | Käynnistää taulun käännöksestä                        |
| `npm run start:claude -- --wait`          | `claude --wait` käännöksestä (`-- T13`: yksi tehtävä) |
| `npm test`                                | Jest-testit (palvelin ja sivu)                        |
| `npm run test:e2e`                        | Playwright oikeasti käynnistettyä taulua vasten       |
| `npm run test:pack`                       | Rakentaa npm-paketin, asentaa sen ja käynnistää sen   |
| `npm run lint`                            | ESLint, myös arkkitehtuurisäännöt                     |
| `npm run typecheck`                       | TypeScript                                            |
| `npm run format` / `npm run format:check` | Prettier                                              |

Selaintestit tarvitsevat selaimen kerran: `npx playwright install --with-deps chromium`.

Käännökset (`README.fi.md`, `README.sv.md`) seuraavat tiedostoa `README.md`: kun sitä muuttava commit on tehty, päivitä ne ja aseta niiden ensimmäiseksi riviksi `<!-- Based on README.md @ <commit> -->` kyseisellä commitilla — `npm test` epäonnistuu, niin kauan kuin ne eroavat toisistaan.

## Lisenssi

[MIT](LICENSE)
