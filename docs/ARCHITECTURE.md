# RideX — Phase 1: Architecture & Repository Setup

## 1. What we built

A **modular monolith** backend (Node.js/TypeScript/Express) and a
**Vite/React/TypeScript** frontend, in one monorepo, with the folder
structure and dependency wiring needed for every later phase to slot in
without restructuring.

```
ridex/
├── backend/
│   ├── src/
│   │   ├── modules/           # 20 business modules (auth, rides, matching, ...)
│   │   │   └── <module>/
│   │   │       ├── controllers/   # thin - parse request, call service, shape response
│   │   │       ├── services/      # business logic, transactions, orchestration
│   │   │       ├── repositories/  # ONLY layer allowed to write SQL
│   │   │       ├── routes/        # URL + verb -> controller, wires validators
│   │   │       ├── validators/    # zod schemas
│   │   │       └── types/         # module-local DTOs
│   │   ├── config/            # env, logger, redis client
│   │   ├── middleware/        # requestId, errorHandler, rateLimiter
│   │   ├── common/            # ApiError, ApiResponse, asyncHandler, health routes
│   │   ├── db/                # pg Pool, withTransaction helper, migrations, seeds
│   │   ├── websocket/         # Socket.IO bootstrap
│   │   ├── queues/            # BullMQ queue definitions (Phase 13)
│   │   ├── workers/           # BullMQ workers (Phase 13)
│   │   ├── app.ts             # Express app factory
│   │   └── server.ts          # HTTP + WS boot, graceful shutdown
│   └── tests/{unit,integration,concurrency}
├── frontend/
│   └── src/{pages,components,features,store,hooks,lib,types,routes}
├── docs/
└── docker-compose.yml
```

## 2. Why a modular monolith (not microservices, not one giant file)

- **Microservices too early = accidental complexity.** Network calls,
  distributed transactions, and service discovery add real cost with no
  payoff at RideX's current scale (0 users). We'd be paying microservice
  tax without microservice benefit.
- **A single unstructured Express app** would tangle ride logic with
  payment logic with garage logic, making it impossible to reason about
  or safely change later.
- **The middle path** — one deployable process, but with hard module
  boundaries (controllers → services → repositories, no module reaching
  into another module's repository directly) — gives us:
  - Fast local development (one `npm run dev`, one DB, one process to debug)
  - A codebase that's already *shaped* like the eventual microservices
    (Ride Service, Matching Service, Location Service, Payment Service,
    Garage Service, Marketplace Service, Rental Service, Notification
    Service — see section 43 of the spec)
  - A concrete extraction path: when a module needs to scale
    independently (e.g. Location, under GPS-update load), its
    service/repository code moves into its own process with minimal
    rewrite, because it never depended on another module's internals —
    only on shared contracts.

## 3. Layering rules (enforced by convention now, by lint rule later)

| Layer | Allowed to do | NOT allowed to do |
|---|---|---|
| `routes` | map HTTP verb+path to controller, attach validators/auth middleware | contain business logic |
| `controllers` | parse req, call **one** service method, call `sendSuccess` | talk to the DB directly, contain business rules |
| `services` | business logic, call repositories, orchestrate transactions, emit events | write raw SQL |
| `repositories` | raw SQL / query builder calls against Postgres | contain business rules (e.g. fare math, state-machine validation) |

This is what makes "explain the bottleneck / what breaks at scale /
how would we extract this into a microservice" (spec section 41)
answerable module-by-module instead of requiring a rewrite.

## 4. Cross-cutting infrastructure decisions made now

- **PostgreSQL is the single source of truth.** Anything that must
  survive a Redis flush or must be transactionally consistent (rides,
  payments, users, vehicles, listings) lives here. (Schema arrives Phase 3.)
- **Redis is for high-frequency / ephemeral / derived data**: live GPS,
  geospatial nearby-search, distributed locks, rate limiting, caches,
  BullMQ queues. Never a system of record. `checkRedisHealth()` /
  `checkDbHealth()` are separate so `/ready` can report *which*
  dependency is down.
- **Error handling is centralized.** Every module throws `ApiError`
  (not raw `Error` / not ad-hoc `res.status().json()`), so the single
  `errorHandler` middleware guarantees a consistent JSON envelope and
  correct status code everywhere, and `ZodError`s from validators are
  automatically turned into 400s with field-level detail.
- **Structured logging with request IDs from day one.** Every log line
  is JSON and carries `requestId`, so once we're running multiple
  backend instances behind a load balancer, a single request's full
  trace (HTTP in → service calls → DB errors → response) can be
  reconstructed by filtering on one ID — this matters a lot once
  Section 37 (Observability) and Section 35 (Scalability) show up.
- **Graceful shutdown is wired now**, not bolted on later: `SIGTERM`
  stops accepting new connections, drains in-flight requests, then
  closes the pg pool and Redis connection. Without this, rolling
  deploys silently drop in-flight ride requests.
- **/health vs /ready are separate on purpose**: `/health` = "is the
  process alive" (used by orchestrators to decide whether to kill/restart
  the container); `/ready` = "can this instance serve real traffic"
  (used by the load balancer to decide whether to route to it). Conflating
  them causes an instance with a dead DB connection to keep receiving
  traffic it can't serve.

## 5. What's intentionally NOT built yet

- No database schema/migrations (Phase 3)
- No auth (Phase 2)
- No module has real routes/controllers wired into `app.ts` yet — the
  commented-out mount points show exactly where each phase plugs in
- No Dijkstra/routing engine (Phase 8)
- No BullMQ queues/workers registered (Phase 13)

## 6. Test cases delivered this phase

- `tests/unit/apiError.test.ts` — `ApiError` factory methods produce
  correct status codes / codes / preserve details, and remain valid
  `Error` instances (catchable by generic error-handling code).
- `tests/integration/health.test.ts` — the Express app boots and
  `/health` responds `200` with **no live DB/Redis required** (proving
  liveness truly doesn't depend on dependencies), a request ID header
  is always present, and unknown routes return the standard 404 envelope.

Run them:
```
cd backend && npm install && npm test
```

## 7. Interview questions this phase should prepare you to answer

1. **Why modular monolith instead of microservices on day one?**
   Cost of distributed systems (network partitions, distributed
   transactions, service discovery, deployment complexity) isn't
   justified before you have real scale or team-boundary pressure.
   Module boundaries give most of the *organizational* benefit without
   the *operational* cost.
2. **How would you extract the Location module into its own service
   later?** Because `location`'s service/repository never imports from
   another module directly (only shared types/events), the extraction
   is: stand up a new process with the same service code, replace direct
   function calls from other modules with an HTTP/gRPC/event call, keep
   the Redis GEO data as-is since it was already logically owned by this
   module.
3. **Why separate `/health` and `/ready`?** Conflating liveness and
   readiness causes cascading failures: if `/health` also checked the
   DB, a DB blip would make the orchestrator kill and restart *every*
   backend instance simultaneously (all "unhealthy" at once) instead of
   just marking them not-ready and letting the DB recover.
4. **Why does only the repository layer touch SQL?** So business rules
   (e.g. "a ride can't transition COMPLETED → REQUESTED") are testable
   in isolation without a database, and so we can swap the persistence
   layer (e.g. read replicas, a different DB) without touching business
   logic.
5. **What's the failure mode if Redis is down?** `checkRedisHealth()`
   fails → `/ready` returns 503 → load balancer stops routing to this
   instance. It's a *degraded* signal, not a crash: `/health` still
   passes (the process itself is fine), which is the correct distinction
   for an orchestrator deciding whether to restart the container.
