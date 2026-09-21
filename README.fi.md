<!-- Based on README.md @ uncommitted -->

# local-project-board

> Henkilökohtainen kehittäjän taulu sekunneissa. Ei seremonioita. Ei pilveä. Jakaminen silloin, kun sitä tarvitset.

**Tila: pre-alpha.** Mitään käyttökelpoista ei vielä ole. Tämä README kuvaa tavoitetta, ei valmista ominaisuutta.
Kieliversiot: [English](README.md) · [Svenska](README.sv.md)

## Mikä tämä on

local-project-board on paikallinen työtila yhdelle kehittäjälle ja yhdelle Git-repositoriolle:
tehtävät, muistiinpanot, Markdown-dokumentit, raportit, Git-konteksti ja tekoälyn tuotokset
rinnakkain. Se on lähempänä kehittynyttä kehittäjän muistikirjaa kuin projektinhallintajärjestelmää.

## Pika-aloitus (suunniteltu)

```bash
cd oma-projekti
npx local-project-board
```

Taulu avautuu selaimeen. Ei rekisteröitymistä, ei tiliä, ei tietokantaa.

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
