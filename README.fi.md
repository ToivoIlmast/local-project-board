<!-- Based on README.md @ b00a923d6b329e3572cebf3241f3a755e837e71e -->

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

| Komento                                | Mitä se tekee                                                      |
| -------------------------------------- | ------------------------------------------------------------------ |
| `npx local-project-board`              | Käynnistää taulun                                                  |
| `npx local-project-board instructions` | Tulostaa API-ohjeet tekoälyagentille annettavaksi                  |
| `npx local-project-board export`       | Tulostaa taulun tilannevedoksen (`--out <tiedosto>` tallentaa sen) |

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

## Periaatteet

Katso [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) (englanniksi). Koodin rakenne ja se, mihin uusi
koodi kuuluu, on kuvattu tiedostossa [docs/architecture.md](docs/architecture.md) (englanniksi).

## Kehitys

Vaatii Node.js >= 22.12.0.

| Komento                                   | Mitä se tekee                                       |
| ----------------------------------------- | --------------------------------------------------- |
| `npm install`                             | Asentaa riippuvuudet                                |
| `npm run build`                           | Kääntää palvelimen ja käyttöliittymän               |
| `npm test`                                | Jest-testit (palvelin ja sivu)                      |
| `npm run test:e2e`                        | Playwright oikeasti käynnistettyä taulua vasten     |
| `npm run test:pack`                       | Rakentaa npm-paketin, asentaa sen ja käynnistää sen |
| `npm run lint`                            | ESLint, myös arkkitehtuurisäännöt                   |
| `npm run typecheck`                       | TypeScript                                          |
| `npm run format` / `npm run format:check` | Prettier                                            |

Selaintestit tarvitsevat selaimen kerran: `npx playwright install --with-deps chromium`.

Käännökset (`README.fi.md`, `README.sv.md`) seuraavat tiedostoa `README.md`: kun sitä muuttava commit on tehty, päivitä ne ja aseta niiden ensimmäiseksi riviksi `<!-- Based on README.md @ <commit> -->` kyseisellä commitilla — `npm test` epäonnistuu, niin kauan kuin ne eroavat toisistaan.

## Lisenssi

[MIT](LICENSE)
