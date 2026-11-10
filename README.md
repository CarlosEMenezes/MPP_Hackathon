# ScreenScout — pay-per-request movie & TV data API (MPP)

Agents call ScreenScout for movie/TV **title data, cast, actor profiles and reviews**. No signup, no API key:
every paid route answers `402 Payment Required` with an MPP challenge (`WWW-Authenticate: Payment ...`),
the agent pays in pathUSD on Tempo, retries with the credential, and gets JSON + a `Payment-Receipt` header.

| Route | Price | What you get |
|---|---|---|
| `GET /api/search?q=` | $0.01 | Movies, shows, people matching `q` (trending if omitted) |
| `GET /api/title?q=` / `?type=movie\|tv&id=` | $0.02 | Details, genres, runtime, rating, top cast, directors/creators, US where-to-watch |
| `GET /api/reviews?q=&limit=` | $0.02 | Audience score, reviewer average, review excerpts |
| `GET /api/person?q=` / `?id=` | $0.01 | Bio, birthday, birthplace, top filmography |

Free: `/`, `/health`, `/llms.txt`, `/openapi.json` (auto-generated with `x-payment-info.offers[]`).

## Run locally

```bash
npm install
cp .env.example .env   # fill TMDB_TOKEN, MPP_SECRET_KEY, MPP_RECIPIENT
npm start              # http://localhost:4242
```

- `TMDB_TOKEN`: TMDB v4 "API Read Access Token" (themoviedb.org → Settings → API).
- `MPP_SECRET_KEY`: `openssl rand -hex 32`.
- `MPP_RECIPIENT`: wallet that gets paid. Testnet: a throwaway wallet. Mainnet: your own `tempo wallet whoami` address.
- `MPP_TESTNET`: `true` (testnet, play money) or `false` (mainnet, real pathUSD).

## Validate

```bash
npx mppx validate http://127.0.0.1:4242
```

On testnet the validator funds an ephemeral wallet itself and makes a real paid call to each route.

## Network switch

Testnet → mainnet is config only: set `MPP_TESTNET=false` and `MPP_RECIPIENT=<your own Tempo wallet>`. No code change.

Data from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.
