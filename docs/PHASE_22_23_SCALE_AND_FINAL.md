# Phases 22–23 — Scalability changes and final hardening

See `SYSTEM_DESIGN.md` §12–13 for the full 10 k → 1 M → 10 M plan and the capacity arithmetic. This page lists what was **actually changed in the code** and what is deliberately left as a documented next step.

## In the code now
- Keyset pagination everywhere (constant-cost deep pages).
- Redis GEO for live drivers; Postgres location writes throttled; heartbeat TTL so stale drivers vanish.
- Cached vehicle-type rates; fare frozen at completion.
- API and worker are separate processes; migrations are a one-shot job; compose runs N replicas with `docker compose up --scale backend=3` (nginx resolves the service name; for sticky-less websockets the Redis adapter is used).
- Graceful shutdown + readiness drain.
- Configurable limits (`RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_MAX`, `PG_POOL_MAX`).
- Frontend: admin console lazy-loaded; hashed, immutable assets.

## Documented, not built (and why)
| Item | Trigger to build it |
|---|---|
| PgBouncer | > ~10 API instances or connection errors |
| Read replica for admin/analytics | analytics queries > 5% of primary CPU |
| Location-history partitioning | table > ~50 GB (≈ 6 months at 1 M users) |
| Regional sharding | single-region primary > 60% write capacity |
| Real routing engine | any real-world launch |
| Kafka/CDC to a warehouse | analytics needs beyond the 30-day dashboard |
| Admin 2FA, KYC, WAF, real PSP | before handling real money |

## Honest limits of this build
Payment and payout providers are mocks; the road graph is a 16-node Bangalore sample; map tiles need internet (OpenStreetMap); no native mobile app; Hindi and English only (the guide is data-driven, adding a language means adding one field per step); Docker images were not built in the authoring environment; no load test was run — the capacity numbers are arithmetic from stated assumptions, not measurements.
