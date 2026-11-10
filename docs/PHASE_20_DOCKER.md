# Phase 20 — Docker and deployment

## Files
`backend/Dockerfile` (stages: `dev`, `build`, `prod`) · `frontend/Dockerfile` (`dev`, `build`, `prod`=nginx) · `frontend/nginx.conf` · `docker-compose.yml` (production-style) · `docker-compose.dev.yml` (hot reload) · `.env.example` · `.dockerignore`s.

## Run
```
cp .env.example .env          # set POSTGRES_PASSWORD, JWT_ACCESS_SECRET, JWT_REFRESH_SECRET
docker compose up --build     # → http://localhost:8080
docker compose -f docker-compose.dev.yml up --build   # dev, hot reload, API :4000, web :5173
```
Compose refuses to start if the JWT secrets are missing (no silent default secrets in production).

## Services
| Service | Role |
|---|---|
| `postgres` (PostGIS 16) | source of truth, volume `ridex_postgres_data` |
| `redis` | AOF on, volume; geo, locks, queues, rate limits |
| `migrate` | one-shot: migrations + vehicle types + road graph; backend/worker wait for `service_completed_successfully` |
| `backend` | `node dist/server.js`, healthcheck on `/health`, non-root user |
| `worker` | same image, `node dist/worker.js` (BullMQ consumers) — scale independently |
| `frontend` | nginx: static SPA + proxy of `/api` and `/socket.io` (websocket upgrade) → one origin, so cookies need no CORS tricks |

## Decisions
- **Multi-stage**: the runtime image has no TypeScript, dev dependencies or tests; migrations/seeds are plain JS copied in.
- **Migrations are a job, not a startup side-effect**, so N API replicas never race to migrate.
- **Workers are a separate process** (`START_WORKER=false` in the API) so a job storm cannot starve HTTP.
- **Hashed assets cached for a year; `index.html` never cached**, so a deploy takes effect on next load.
- Graceful shutdown: `SHUTDOWN_DRAIN_MS=5000` keeps `/ready` at 503 while the load balancer notices.

## Verified / not verified
Verified here: compose file validates; the compiled `dist/` server boots in production mode against a **freshly created database** using exactly the migrate → seed → start sequence the containers use; SPA builds.
**Not verified:** the images themselves were not built in this environment (no Docker daemon was available), so the first `docker compose up --build` on your machine is the first real image build.

## Demo data
`node backend/scripts/seedDemo.mjs` (API must be running; uses the public API, then promotes one admin in SQL). Accounts `rider@/driver@/owner@/garage@/mechanic@/admin@ridex.dev`, password `Passw0rd123`. **Never run against production.**
