# Equity Mutual Fund Scoring

Scores the Indian equity mutual fund universe against a 13-parameter matrix and
serves the results to a React dashboard. Scores refresh once a day.

```
EquityMFScoringModel/     FastAPI service + the scoring model
  code/
    score_intersection_funds_13param.py   the scoring matrix (also a standalone CLI)
    extra_params.py                       the 4 CMOTS-derived parameters
    data_sources.py               the only module that touches the live feeds
    cache_store.py                the served snapshot, mirrored to disk
    scheduler.py                  the daily refresh (APScheduler cron)
    api.py                        HTTP surface
  data/                   local snapshots of the two upstream feeds
  output/                 CLI export target (.json / .xlsx)
mutual-fund-dashboard/    React + Vite dashboard
```

## How it works

Two upstream feeds — a scheme master and a risk-metrics set — are joined on the
scheme code. Every Regular-plan fund is ranked: each parameter is scored 1–5 against
category peers, then weighted into a composite that maps to a rating band and a
recommendation. A fund missing a parameter is not dropped — it is scored on the
parameters it has, with the weights renormalized, and its Data completeness
shows how much of the score is backed by data.

Two properties the design leans on:

- **`GET /api/funds` reads memory only.** A request never waits on an upstream
  feed, so the dashboard responds in milliseconds no matter how slow the
  upstream is.
- **A failed refresh is non-destructive.** Fetch errors, malformed payloads and
  scoring bugs all leave the previous rows serving and only set `last_error`.
  The dashboard degrades to "stale but valid, with a visible warning" — never to
  a blank table or a 500.

## Configuration

Both halves read a gitignored `.env`; each has a committed `.env.example`
listing every variable with placeholder values.

| | |
|---|---|
| `EquityMFScoringModel/.env` | feed URLs, `APP_ENV`, `REFRESH_TOKEN`, CORS origins, refresh schedule |
| `mutual-fund-dashboard/.env` | `VITE_API_BASE_URL` |

**The two feed URLs are treated as credentials.** They are redacted out of every
log line and every error message the API can return — see the SECRET HYGIENE
note at the top of `data_sources.py`. Never commit a real `.env`.

Leaving `SCHEME_MASTER` or `RISK` unset serves that feed from its snapshot in
`data/` instead. That is a permanent supported mode — the whole backend runs
with no network access — and `/api/status` reports `live` vs `fixture` per feed.

## Running locally

Backend:

```bash
cd EquityMFScoringModel
python3 -m venv .venv && source .venv/bin/activate
pip install -r code/requirements.txt
cp .env.example .env        # fill in, or leave the feed URLs blank for fixtures
uvicorn api:app --reload --port 8000 --app-dir code
```

Frontend:

```bash
cd mutual-fund-dashboard
npm install
cp .env.example .env        # defaults to http://localhost:8000 if unset
npm run dev
```

The scoring model also runs standalone against the local snapshots, writing to
`output/`:

```bash
python code/score_intersection_funds_13param.py --top 50
```

## API

| Method | Path | |
|---|---|---|
| `GET` | `/api/funds` | the scored universe plus the metadata to render it |
| `GET` | `/api/status` | cache and scheduler health |
| `POST` | `/api/refresh` | force a refresh now |
| `GET` | `/api/health` | liveness probe |

`/api/funds` returns `next_refresh_at`, which is what lets the browser skip
refetching until new data can possibly exist.

`POST /api/refresh` takes an `X-Refresh-Token` header. The token is optional in
development; under `APP_ENV=production` it is mandatory, and the endpoint
returns 503 rather than running unauthenticated.

## Deployment

Both halves ship a Dockerfile, so the server needs only Git, Docker Engine and
Docker Compose:

```bash
git clone https://github.com/vandan-arihant/MutualFundScoring.git
cd MutualFundScoring
cp .env.example .env        # fill in, see below
docker compose up -d --build
```

Three values must be set in `.env`; the rest have working defaults:

| | |
|---|---|
| `API_PUBLIC_URL` | the API's public URL **as the browser reaches it** |
| `DASHBOARD_PUBLIC_URL` | the dashboard's public URL, passed to the API as its allowed CORS origin |
| `REFRESH_TOKEN` | shared secret for `POST /api/refresh` (`openssl rand -base64 48`) |

Compose sets `APP_ENV=production`, which drops the localhost CORS origins and
makes `REFRESH_TOKEN` mandatory.

Two things that are easy to get wrong:

- **The dashboard does not proxy the API.** The browser loads the dashboard from
  one hostname and calls the API directly on another, so both must be reachable
  from the browser — and `DASHBOARD_PUBLIC_URL` must match the address bar
  exactly, or every request is blocked by CORS.
- **`API_PUBLIC_URL` is baked into the bundle at build time**, not read at
  runtime. Changing it needs `docker compose up -d --build`, not a restart. It
  must never be `http://api:8000`, which only resolves inside the Compose
  network.

Both containers pin `TZ=Asia/Kolkata`, since the refresh is scheduled in IST.
The API's cache volume (`/app/cache`) only holds the last good result and does
not need backing up — it exists so a restart serves data immediately instead of
an empty table.

For the full UAT deployment requirements — whitelisting, sizing, TLS and the
confirmations needed from the infrastructure team — see Section 3 of the
deployment requirements document.
