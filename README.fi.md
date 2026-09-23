<!-- Based on README.md @ uncommitted -->

# local-project-board

> Henkilökohtainen kehittäjän taulu sekunneissa. Ei seremonioita. Ei pilveä. Jakaminen silloin, kun sitä tarvitset.

**Tila: pre-alpha.** Taulu käynnistyy ja tarjoilee API:nsa; selainkäyttöliittymä on vielä
paikanpitäjä, joten tällä hetkellä tämä on taulu komentoriville ja tekoälyagenteille.
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
ai: { allowSourceEdits: false }
```

Asetukset luetaan ensin valitsimista, sitten muuttujista `BOARD_PORT`, `BOARD_OPEN`,
`BOARD_PROJECT_NAME`, `BOARD_ID_PREFIX`, `BOARD_STORAGE_PROVIDER`, sitten tiedostosta
`board.config.yaml`, sitten tiedostosta `~/.config/local-project-board/config.yaml` ja lopuksi
oletuksista. Väärin kirjoitettu avain tai sallitun ulkopuolinen arvo pysäyttää taulun viestiin,
joka nimeää avaimen ja sen lähteen. Myös sellaisen tilan poistaminen, jota tehtävät yhä käyttävät,
pysäyttää taulun sen sijaan että ne tehtävät piilotettaisiin.

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

## Periaatteet

Katso [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) (englanniksi).

## Kehitys

Vaatii Node.js >= 22.12.0.

| Komento                                   | Mitä se tekee                                       |
| ----------------------------------------- | --------------------------------------------------- |
| `npm install`                             | Asentaa riippuvuudet                                |
| `npm run build`                           | Kääntää palvelimen ja käyttöliittymän               |
| `npm test`                                | Jest-testit                                         |
| `npm run test:pack`                       | Rakentaa npm-paketin, asentaa sen ja käynnistää sen |
| `npm run lint`                            | ESLint, myös arkkitehtuurisäännöt                   |
| `npm run typecheck`                       | TypeScript                                          |
| `npm run format` / `npm run format:check` | Prettier                                            |

## Lisenssi

[MIT](LICENSE)
