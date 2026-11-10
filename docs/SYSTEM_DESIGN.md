# RideX — System Design

RideX is one platform with four products on one account: **ride-hailing, vehicle rental, a second-hand marketplace, and garage/repair**,
plus the money layer under them (payments, owner/driver earnings, payouts) and an admin console. It ships as a **modular monolith**
(Node/TypeScript, PostgreSQL + PostGIS, Redis) with a React web app. This document explains the design, the numbers behind it, and where it breaks first.

## 1. Requirements

### Functional
| Area | Must do |
|---|---|
| Accounts | Register with one or more roles (rider, driver, vehicle owner, seller, buyer, garage owner, mechanic), JWT access + rotating refresh, admin deactivation takes effect immediately |
| Ride | Estimate, request, match the nearest suitable driver, live location, lifecycle (accept → arriving → arrived → start → complete), cancel, pay, rate |
| Rental | List a vehicle, quote, reserve (15-minute hold), pay, hand over, return with late fee / damage claim, deposit refund |
| Marketplace | List, search/filter, favourite, offers (one accepted per listing), mechanic inspection reports |
| Repair | Find garages, book, mechanic assignment, repair order with parts and labour, pay, roadside emergency |
| Money | One payment model for all four products, idempotent, refunds, commission split, owner/driver ledgers, withdrawals |
| Ops | Notifications (in-app + queue), chat/support, maintenance reminders, admin console, audit log, analytics, health |
| Help | A pictured, bilingual how-to guide with read-aloud, usable without reading much |

### Non-functional
| Property | Target | How |
|---|---|---|
| Correctness of money | No double charge, no lost or double settlement, ever | Idempotency keys, DB uniqueness as the final guard, gated settlement, reconciliation job |
| Availability | 99.9% of API requests succeed | Stateless API, health/readiness, graceful drain, fail-open on non-critical Redis paths |
| Latency | p95 < 300 ms for reads, < 800 ms for ride request | Indexes, Redis geo, keyset pagination, cached vehicle rates |
| Real-time | Driver position visible to rider within ~3 s | Socket.IO room per ride, 3 s location tick |
| Security | No client-supplied money, role checks on every route, no resource enumeration | `.strict()` zod schemas, `authorize`, 404 instead of 403 for others' resources |
| Observability | Any incident diagnosable from metrics + a request id | Prometheus, structured logs, business-invariant gauges |
| Accessibility | Usable by people with low literacy and on small phones | Pictures, short sentences, Hindi, large tap targets, read-aloud |

## 2. Architecture

```
 Browser (React + Vite)  ──►  nginx  ──►  API (Express, N identical instances)  ──►  PostgreSQL 16 + PostGIS   (source of truth)
        ▲  websocket            │ /api, /socket.io           │  │                  ──►  Redis                  (geo index, locks, cache, queues, revocation, rate limits)
        └───────────────────────┘                            │  └── enqueue ──►  BullMQ ──►  Worker process(es)  (notifications, expiry, holds, maintenance)
                                                              └── pub/sub ◄────────────────────────────────────┘  (worker → API → socket)
```

- **Modular monolith, not microservices.** One deployable, one database, one transaction boundary for money. Modules (`rides`, `rentals`, `marketplace`, `repairs`, `payments`, `earnings`, `admin`, …) talk through services, never each other's tables, so any module can be lifted out later. Splitting early would turn every "charge and settle" into a distributed transaction for no benefit at this size.
- **Layers:** routes → controllers → services → repositories. Validation (zod) at the edge, business rules in services, SQL only in repositories.
- **Two processes from one image:** `server` (HTTP + sockets) and `worker` (BullMQ consumers). They scale independently.
- **Postgres is the source of truth**; Redis holds only things that can be rebuilt or are allowed to expire.

## 3. Data model (the parts that matter)

Core tables: `users`, `drivers`, `riders`, `vehicles` + `vehicle_driver_assignments`, `rides` + `ride_fares`, `ratings`,
`rental_listings` + `rental_bookings`, `vehicle_listings` + `vehicle_offers` + `inspections`, `garages` + `garage_services` + `mechanics` + `service_bookings` + `repair_orders`,
`payments`, `owner_earnings`, `driver_earnings`, `platform_commissions`, `payouts`, `notifications`, `audit_logs`, and the routing graph `road_nodes` / `road_edges`.

Design rules:
1. **Constraints do the policing.** Partial unique indexes (one active assignment per driver, one pending offer per buyer per listing, one fare per ride), exclusion constraints (no overlapping rental bookings per vehicle), CHECKs (non-negative money, consistent deactivation). Application code can have a bug; the database cannot be talked into a double booking.
2. **Money is `numeric(10,2)` in tables and integer paise in code** (`earningsSplit.ts`), so splits never drift by a paisa and always sum to the total.
3. **Ledgers are append-only** (`*_earnings`, `audit_logs` trigger). Balances are derived (`SUM`) from the ledger minus payouts, never stored, so they cannot disagree with history.
4. **Geography:** PostGIS `geography(Point)` + GiST indexes for marketplace/garage/rental radius search; Redis GEO for the hot driver index.

## 4. API design

REST over JSON, resource-oriented, `/api/<module>/…`. One response envelope: `{ success, data }` or `{ success:false, error:{code,message,details}, requestId }`.
- **Idempotency:** every create that moves money or inventory takes a client key (`Idempotency-Key` header or body field), stored namespaced `<userId>:<key>`.
- **Pagination:** keyset (opaque base64url cursor), never `OFFSET`, so page 1,000 costs the same as page 1.
- **Auth:** `Authorization: Bearer <access JWT, 15 min>`; refresh token in an httpOnly cookie, rotated on use. Rate limits: global per IP, tighter on credential routes.
- **Errors reveal nothing extra:** someone else's resource is `404`, not `403`.

## 5. Caching (Redis)

| What | Key | TTL / rule | Why |
|---|---|---|---|
| Vehicle-type rates | `cache:vehicle-type-rates:<id>` | short TTL, read on almost every ride call | Hot, tiny, rarely changes |
| Driver positions | GEO set + metadata hash | whole-key TTL; drivers heartbeat | A crashed app must not leave a ghost driver |
| Token revocation | `auth:deactivated:<id>`, `auth:valid-after:<id>` | access-token lifetime | Instant lock-out without a DB hit per request (fails open if Redis is down) |
| Rate limits | `rl:*` | window | Shared across API instances |

Rule: cache only what can be wrong for a few seconds. Anything involving money reads Postgres.

## 6. Geolocation and matching

1. Driver app posts its position every ~3 s → Redis `GEOADD` (+ throttled write to Postgres for history).
2. Ride request → `GEOSEARCH` within a radius → filter by vehicle type, online, verified, no active ride → rank by distance (and rating as tie-break) → offer to the best; on timeout, next.
3. Surge: demand ÷ available drivers within 5 km maps to a multiplier tier (1.2 / 1.5 / 2.0), shown in the estimate and frozen into the fare.

**Routing.** The ride estimate uses **Dijkstra** over a seeded Bangalore road graph (16 nodes, 25 edges), returning path, distance and nodes explored. That is deliberately small and honest: it shows the algorithm, complexity (O((V+E) log V)) and the interface. In production this is replaced by a routing engine (OSRM/Valhalla/Google) behind the same `RoutingService` interface, because real road networks have 10⁷–10⁸ edges and need contraction hierarchies or A* with landmarks; plain Dijkstra per request would not meet latency.

## 7. Real time (Socket.IO)

- Handshake authenticates the JWT (and checks revocation). A client joins `ride:<id>` only if it is the rider or the assigned driver.
- Server → client: `ride:accepted/started/completed/cancelled/status_changed/payment_completed`, relayed `driver:location:update`.
- Multi-instance: the Socket.IO Redis adapter fans events out so a rider on instance A hears a driver on instance B. The web app falls back to polling every 15 s on screens that matter, so a dropped socket degrades to "slightly stale", not "broken".

## 8. Queues (BullMQ)

Notifications, marketplace offer expiry (48 h), rental payment-hold expiry (15 min), maintenance reminders. Jobs are retried with exponential back-off; failures stay visible in the queue and on the admin health page. Every job handler is **idempotent** (re-running an expiry on an already-expired row is a no-op), because "at least once" is the only honest delivery guarantee.

## 9. Payments

- One `payments` table, one `PaymentProvider` interface (mock now, Stripe stub), and a **`PayableResolver` registry** (`RIDE`, `RENTAL`, `MARKETPLACE`, `GARAGE_SERVICE`): the payment code does not know what it is paying for; each product tells it the amount, the owner, and what to do after success.
- The **amount is never taken from the client**; it is read from the thing being paid for.
- States: `PROCESSING → COMPLETED | FAILED`. A provider *error* (timeout) leaves the payment `PROCESSING` and returns 502, because the money may have moved; reconciliation resolves it. A *decline* is a clean `FAILED` (402).
- **Settlement** (commission + owner/driver shares) happens after success through a gate (`INSERT … ON CONFLICT DO NOTHING RETURNING`), so it runs exactly once even if the success hook is replayed. A settlement failure never fails the payment; the admin **reconcile** endpoint heals missed ones and the health page counts them.

## 10. Concurrency and idempotency

| Race | Defence |
|---|---|
| Two drivers accept one ride | Guarded `UPDATE … WHERE status = 'SEARCHING_DRIVER'`; loser gets 409 |
| Two renters book the same vehicle/time | Exclusion constraint on (vehicle, time range) |
| Two offers accepted on one listing | `SELECT … FOR UPDATE` on the listing + partial unique index |
| Double-tap pay / retry after timeout | Idempotency key namespaced per user + unique constraint |
| Two withdrawals overdraw a wallet | Lock the user row `FOR UPDATE`, recompute balance inside the lock |
| Two admins demote each other | `FOR UPDATE` on admin rows so the last admin cannot be removed |
| Double rating | `UNIQUE (ride_id, rater_id)` + `ON CONFLICT DO NOTHING` |
| Distributed critical sections | Redis `SET NX PX` lock (`withLock`) with expiry |

Every one of these has a test that fires the requests concurrently, and a *mutation check* (remove the guard → the test fails).

## 11. Failure handling

| Failure | Behaviour |
|---|---|
| Redis down | Reads/writes that need it for correctness return 503 via `/ready`; revocation, rate limits, caches **fail open**; rides cannot match (geo index) but history/payments keep working |
| Postgres down | `/ready` = 503, load balancer drains the instance; no partial writes (all multi-step changes are transactions) |
| Payment provider timeout | Payment stays `PROCESSING`, 502 to the client, reconciled later; never marked failed on a guess |
| Worker down | Jobs wait in Redis; nothing is lost; health page shows backlog |
| API instance dies mid-request | Client retries with the same idempotency key → same result |
| Deploy | SIGTERM → `/ready` goes 503, wait `SHUTDOWN_DRAIN_MS`, close server, then pools |
| Bad payout provider | Withdrawal stays `PENDING`, money stays reserved, can be retried |

## 12. Scalability: 10 k → 1 M → 10 M users

| Stage | Load shape | What changes |
|---|---|---|
| **10 k users** (~1 k DAU) | < 5 req/s avg, peak ~25 | One API + one worker + one Postgres + one Redis. Today's setup, as is. |
| **1 M users** (~100 k DAU, ~20 k rides/day) | ~300 req/s peak, ~10 k driver pings per 3 s peak → ~3.3 k writes/s to Redis | 3–6 API instances behind nginx/ALB; separate worker pool; Postgres primary + 1–2 read replicas (analytics, admin lists, search); **PgBouncer**; Redis with persistence + a replica; Socket.IO Redis adapter; ride-request partition by city; CDN for the SPA. |
| **10 M users** (~1 M DAU, ~300 k rides/day) | ~3 k req/s peak, ~100 k pings/3 s | **Shard by city/region** (each region: its own Postgres + Redis geo cluster; a thin global directory for accounts); driver-location ingestion becomes its own service (UDP/MQTT/gRPC stream → Redis cluster, batched writes); move history/analytics to a column store fed by CDC; extract **Payments** and **Matching** first (the two with different scaling and consistency needs); real routing engine; Kafka for events; multi-AZ with automatic failover. |

The first things to break, in order: (1) Postgres connection count (→ PgBouncer), (2) location write rate to Postgres (→ already throttled; move to a stream), (3) analytics queries on the primary (→ replica / warehouse), (4) single Redis (→ Cluster, geo keys sharded by city).

## 13. Capacity estimation (worked)

Assumptions for the **1 M-user** stage: 10% daily active = 100 k DAU; 20 k rides/day; 5 k online drivers at peak; 3 s location tick; average API call ~2 KB response.

- **Requests.** Per DAU ≈ 40 API calls/day (browse, poll, pay) → 4 M/day ≈ 46/s average. Peak factor 6× → **~280 req/s**. One Node instance sustains ~500–800 simple req/s, so 3 instances meets peak; run 6 for headroom and rolling deploys.
- **Driver location.** 5 000 drivers × (1 ping / 3 s) = **~1 670 writes/s** to Redis GEO (each ~100 µs) — trivial for one Redis. Postgres history writes throttled to 1 per driver per 30 s = 167/s (fine).
- **Rides.** 20 k/day ≈ 0.23/s average, peak ~2/s. Each ride ≈ 12 writes (status transitions, fare, payment, 3 ledger rows, notifications) → **~25 write TPS** at peak. A single Postgres primary handles thousands.
- **Storage (1 year).**
  - Rides: 20 k × 365 = 7.3 M rows × ~0.6 KB (+ indexes ×2) ≈ **9 GB**.
  - Payments + ledgers: ~4 rows × 7.3 M × 0.3 KB ≈ **9 GB**.
  - Location history: 5 000 × 2/min × 60 × 8 h ≈ 4.8 M rows/day × 50 B ≈ 240 MB/day ≈ **88 GB/yr** → partition by month, keep 90 days hot, archive the rest. This is the biggest table.
  - Notifications: ~5 per ride × 7.3 M × 0.3 KB ≈ 11 GB.
  - **Total ≈ 130–150 GB first year**; fits one Postgres volume; plan 500 GB.
- **Redis memory.** 5 000 drivers × ~200 B (geo + meta) ≈ 1 MB; sessions/locks/cache < 100 MB; queues < 100 MB. **< 1 GB.**
- **WebSockets.** Concurrent connections ≈ riders on active trips + online drivers ≈ 2 000 + 5 000 = 7 000 → ~100 KB each ≈ **700 MB** across instances; ~2 000 per instance with 4 instances is comfortable.
- **Bandwidth.** 280 req/s × 2 KB ≈ 0.56 MB/s ≈ 4.5 Mbit/s plus sockets (7 000 × 1 msg/3 s × 300 B ≈ 0.7 MB/s). Negligible; the SPA is served by CDN.
- **Postgres connections.** 6 API × pool 20 = 120 + workers 20 → 140. Postgres tolerates ~100–200 comfortably; add PgBouncer past ~10 instances.

At **10 M users** multiply by 10: ~2 800 req/s, ~17 k location writes/s, ~250 write TPS, ~1.4 TB/yr → this is where regional sharding, Redis Cluster and a stream for location become necessary, as in §12.

## 14. Security

Argon2 password hashing; short-lived access tokens + httpOnly rotating refresh; role checks on every route (admin router gated once at the top); `.strict()` request schemas reject unknown fields (especially money); parameterised SQL only; CORS pinned to `CLIENT_URL`; Helmet headers; rate limits; `/metrics` behind a bearer token and disabled in production without one; audit log is append-only at the database level; deactivation revokes sessions instantly. **Known gaps:** no 2FA for admins, no real KYC, payment/payout providers are mocks, no WAF.

## 15. Monitoring

See `PHASE_21_OBSERVABILITY.md`. Golden signals via Prometheus (`ridex_http_*`, DB pool, queues, websockets), business gauges (`ridex_invariant_violations`, active rides, online drivers), `/health` (liveness), `/ready` (dependencies), request id on every log line and error body. Suggested alerts: 5xx rate > 1% for 5 min; p95 latency > 1 s; any invariant > 0 for 10 min; queue failed > 0; DB pool waiting > 0 for 2 min; `/ready` flapping.

## 16. Trade-offs we chose on purpose

| Choice | Alternative | Why |
|---|---|---|
| Modular monolith | Microservices | One transaction boundary for money; far less ops at this size |
| Postgres for everything durable | Mongo/Dynamo | Money and bookings need constraints and transactions |
| Redis GEO for live drivers | PostGIS for live drivers | 1.7 k+ writes/s of throwaway data belongs in memory |
| Keyset pagination | Offset | Constant cost, no skipped/duplicated rows |
| Server computes every amount | Trust client | Money tampering is impossible by construction |
| Mock payment/payout providers | Real gateway | Demo-safe; the interface is the real contract |
| Seeded graph + Dijkstra | Routing engine now | Shows the algorithm; interface ready for a real engine |
