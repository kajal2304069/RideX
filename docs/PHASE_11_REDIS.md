# RideX — Phase 11: Redis

## 1. What we built

Three concrete Redis capabilities that were explicitly flagged as
follow-ups in earlier phases, plus the connection groundwork for Phase
13's job queue, plus the "what belongs in Postgres vs. Redis, and why"
explanation spec section 28 asks for directly.

- **Distributed rate limiting** (`rate-limit-redis`) — replaces the
  in-memory counters from Phase 2, closing the exact gap flagged in
  that phase's own code comments
- **A distributed lock utility** (`common/redisLock.ts`) — genuine
  `SET NX PX` mutual exclusion, applied to close a real TOCTOU race in
  ride-request idempotency (Phase 6)
- **A generic read-through cache** (`common/cache.ts`) — applied to
  vehicle-type rate lookups, a hot, rarely-changing read
- **A dedicated BullMQ Redis connection** (`config/bullmqConnection.ts`)
  — infrastructure only; no queues defined yet (that's Phase 13)

## 2. Rate limiting: from in-memory to Redis-backed

Phase 2's rate limiter comment said it directly: "once the backend is
scaled horizontally this MUST move to a Redis-backed store... noted
here deliberately as a Phase 11 follow-up, not forgotten." This phase
makes good on that. Both the global limiter and auth's credential
limiter now use `rate-limit-redis`'s `RedisStore`, backed by the same
`ioredis` client (`config/redis.ts`) everything else uses.

**Why this matters concretely:** an in-memory counter is scoped to a
single Node process. Once this backend runs as more than one instance
behind a load balancer (the entire point of Phase 1's "designed for
horizontal scaling" framing), each instance independently tracks its
own count — a client whose requests get spread across N instances
effectively gets N times the intended limit, silently defeating the
whole protection. A Redis-backed store makes the counter genuinely
shared state, enforced against the fleet as a whole.

**Verified live, not just asserted:** booted the real server, made
several requests, and confirmed real keys (`rl:global:127.0.0.1`,
`rl:credential:127.0.0.1`) appear in Redis with correct values and
TTLs — this is externally-observable proof the limiter is backed by
Redis, not an assumption based on reading the config.

## 3. The distributed lock: a genuinely different tool from what came before

`common/redisLock.ts` implements the classic `SET key token NX PX ttl`
pattern, with two details worth calling out specifically:

- **A random token per acquisition**, not a fixed value — release()
  checks the token matches before deleting (via an atomic Lua script,
  so the check-then-delete can't itself race). This prevents a subtle
  bug: if a lock expired on its own (its holder was too slow) and a
  DIFFERENT caller acquired it in the meantime, the original holder's
  eventual, late `release()` call must not delete the new holder's
  still-valid lock. Verified directly: a test lets a lock expire, lets
  a second caller acquire it, then calls the ORIGINAL handle's
  `release()` and confirms it returns `false` and the second caller's
  lock is untouched.
- **A TTL as crash safety** — if the lock holder dies before releasing
  (a crashed process, an unhandled exception bypassing the `finally`),
  the lock still expires on its own rather than deadlocking every
  future acquisition forever.

This is a genuinely different mechanism from the concurrency tools used
elsewhere in the project, worth contrasting explicitly:

| | Scope | Mechanism | Used for |
|---|---|---|---|
| `SELECT...FOR UPDATE` (Phase 6) | One DB row, inside one transaction | Postgres row lock | Ride acceptance |
| Optimistic `WHERE status = $expected` (Phase 5) | One DB row, no lock held | Conditional write + detect staleness | Vehicle status changes |
| Redis distributed lock (this phase) | An arbitrary critical section of code | `SET NX` atomicity | Ride-request idempotency |

The Redis lock is the right tool specifically when the thing being
coordinated isn't (only) a single database row — here, the critical
section is "check for an existing ride with this idempotency key, then
create one," which spans a read and a write that don't have to happen
inside one Postgres transaction, but do need to be mutually exclusive
per (rider, idempotency key).

## 4. The bug this lock closes — and the same lesson from Phase 5, applied again

`rides.service.ts`'s `request()` method had exactly the TOCTOU race
Phase 5 already taught this project to watch for: check for an existing
ride by idempotency key, then (if none found) create one — with no
lock in between. Two identical concurrent requests (a client retrying a
request it wrongly believes timed out — precisely the scenario an
idempotency key exists to protect against) could both pass the
existence check before either commits, and both attempt to insert.

**Fixed two ways, deliberately layered:**
1. The whole check-then-create sequence now runs inside
   `withLock('lock:ride:request:<riderId>:<key>', ...)` — the actual
   fix, closing the race before it can happen.
2. A `catch` around the insert still checks for a raw Postgres `23505`
   unique-violation and treats it as "someone else already won,"
   returning their ride instead of leaking a raw 500 — defense in
   depth, for the edge case where the lock's TTL expired under extreme
   slowness. This is the exact same category of fix Phase 5 needed for
   vehicle-driver assignment; the lesson from that bug ("an application
   check is a fast-path, not the guarantee — always also handle the
   database's own failure mode gracefully") was applied here
   proactively rather than needing to be rediscovered.

**Verified under real concurrent load:**
`tests/concurrency/rideIdempotency.test.ts` fires 8 (then, in a
separate repeated-trial test, 5x3) genuinely simultaneous identical
`POST /api/rides/request` calls with the same idempotency key. Every
single response returns `201` with the exact same ride ID; a direct
Postgres count confirms exactly one row was ever created.

## 5. The cache: vehicle-type rates as the canonical candidate

`common/cache.ts`'s `getOrSetCache` is a small generic read-through
cache, applied to `getVehicleTypeRates` in `rides.service.ts` — read on
nearly every fare estimate and ride request, backed by Postgres rows
that change essentially never after seeding. A 5-minute TTL removes a
repeated, low-value database round-trip from a genuinely hot path.

Two design choices worth naming:
- **Cache reads degrade gracefully on Redis failure** — if the Redis
  `GET` itself fails, the code falls back to computing the value
  directly rather than failing the request. Caching is a performance
  optimization; it must never become a new way for the API to break
  that didn't exist before the cache was added.
- **A "not found" result is cached too** (as a null sentinel), not just
  successful lookups — otherwise a client retry-looping on a typo'd
  vehicle type ID would hit Postgres on every single attempt instead of
  being served the same "doesn't exist" answer from cache.

Verified live: booted the real server, made a fare-estimate request,
and confirmed a real `cache:vehicle-type-rates:<id>` key appeared in
Redis with the correct JSON value and a ~300-second TTL — not asserted
from reading the code, observed directly via `redis-cli`.

## 6. The Postgres-vs-Redis decision matrix (spec section 28's explicit requirement)

| Data | Where | Why |
|---|---|---|
| User accounts, roles, credentials | Postgres | Must survive forever, must be transactionally consistent (Phase 2) |
| Rides, fares, ratings | Postgres | Source of truth for billing/history; needs joins, constraints, durability |
| Vehicles, drivers, assignments | Postgres | Relational integrity (FKs, the partial-unique-index and exclusion-constraint guarantees from Phase 3/5) |
| Refresh tokens | Postgres | Must be individually revocable and auditable (Phase 2) — a use case needing real query/update, not just key lookup |
| Live driver GPS position | Redis (GEO set) | High write frequency, short-lived value, needs fast radius queries — exactly Redis GEO's purpose (Phase 7) |
| Periodic location samples (trip replay) | Postgres (`vehicle_locations`) | The durable, occasionally-useful subset of location data — sampled from the Redis hot path, not every ping (Phase 7) |
| Nearby-driver/garage search | Redis (GEO) | Same reasoning as live position — this data only has to be right right now |
| Rate limit counters | Redis | Must be shared across horizontally-scaled instances; naturally expiring, ephemeral (this phase) |
| Vehicle-type rate cache | Redis | Read-heavy, rarely-changing — a performance optimization layered over Postgres's authoritative copy (this phase) |
| Ride-request idempotency lock | Redis | A transient coordination primitive that only needs to exist for the duration of one request, not permanent data (this phase) |
| BullMQ job queues | Redis (dedicated connection) | Queue semantics (blocking pop, delayed jobs, retries) are what Redis's data structures + BullMQ are built for — Phase 13 |
| Access tokens | Neither | Stateless JWTs, verified by signature alone (Phase 2) — nothing to store server-side at all |

**The general principle, stated once rather than re-derived per table
row:** if losing the data would be a real, unrecoverable problem (a
ride's billing history, a user's account), it belongs in Postgres. If
the data is inherently short-lived, high-frequency, or exists purely to
make a CURRENT query fast (not to be THE record of anything), it
belongs in Redis — and if Redis were flushed entirely, the system
should degrade (slower, or needing a fresh location ping) rather than
lose anything that can't be regenerated.

## 7. What's intentionally NOT built yet

- No Redis Cluster / Sentinel (high availability) — a single Redis
  instance is assumed throughout, appropriate for this project's
  current scale; a Phase 23 (scalability) concern.
- No Socket.IO Redis adapter for horizontal WebSocket scaling (flagged
  already in Phase 10's docs) — needed once the backend runs as more
  than one instance so a Phase 10 room broadcast reaches sockets
  connected to a different process.
- No actual BullMQ queues/workers — `bullmqConnection.ts` is connection
  infrastructure only; Phase 13 defines the real job types.
- No cache invalidation hook for vehicle-type rate changes — there's no
  endpoint that updates rates yet, so this doesn't matter today, but is
  worth flagging: whenever such an endpoint exists, it must call
  `invalidateCache` for the affected vehicle type ID, or admins will
  see stale rates for up to 5 minutes after an update.

## 8. Test cases delivered this phase

18 new tests, all against live Redis:
- **Distributed lock (9):** acquire/fail-on-held/reacquire-after-release,
  TTL-based crash-safety expiry, the token-safety edge case (a
  late-arriving release from an expired lock's original holder must not
  delete a different holder's newly-acquired lock), genuine mutual
  exclusion under 5 real concurrent callers (max-concurrency assertion,
  not just "it eventually finished"), lock release on thrown error,
  acquisition timeout, return-value passthrough
- **Cache (7):** miss calls compute and returns its value, hit skips
  compute entirely, value is actually persisted as JSON in Redis, TTL
  is set correctly, falsy-but-defined values (`0`) are correctly
  distinguished from a cache miss, both invalidation functions work
- **Concurrency (2, the flagship demonstration):** 8 and 5x3 genuinely
  simultaneous identical ride-request calls, every one returning the
  same ride ID, confirmed against a direct Postgres row count

Combined with Phases 1–10: **219/219 passing.**

Also manually verified live against the real server: rate-limit keys
appearing in Redis with correct values/TTLs after real requests, and a
vehicle-type-rate cache key appearing with the correct cached value
after a real fare estimate call.

Run them:
```
cd backend && npm test
# or just this phase's new coverage:
npx jest tests/integration/redisLock.test.ts tests/integration/cache.test.ts tests/concurrency/rideIdempotency.test.ts
```

## 9. Interview questions this phase should prepare you to answer

1. **Walk through exactly why an in-memory rate limiter breaks once you
   scale horizontally.** Each backend instance maintains its own
   in-memory counter, with no way to know what any other instance has
   counted. A client's requests, spread across N instances by the load
   balancer, would each independently believe they're under the limit -
   the client effectively gets N times the intended quota, and the
   limit stops meaning what it's supposed to mean. A shared Redis store
   makes every instance read and write the same counter, so the limit
   is enforced against total traffic, not per-instance traffic.
2. **Why does the distributed lock use a random token instead of just
   checking "does this key exist" for release?** Because a lock can
   expire on its own (TTL-based crash safety) while its original holder
   is still running and hasn't called `release()` yet. If a new holder
   acquires the lock after that expiry, and then the ORIGINAL holder's
   release() call finally arrives, a naive "delete the key if it
   exists" would delete the NEW holder's still-valid lock - a different
   process now believes it holds an exclusive lock that's actually
   gone. The token makes release() specific to "delete this lock only
   if it's still the one I created," which is what actually prevents
   that.
3. **When would you reach for a Redis distributed lock instead of a
   Postgres `SELECT...FOR UPDATE`?** When what needs to be mutually
   exclusive isn't cleanly a single database row inside a single
   transaction - here, it's a check-then-create sequence keyed by an
   arbitrary string (rider + idempotency key), which could in principle
   span multiple database operations or even multiple services. `FOR
   UPDATE` is the better (and simpler, more standard) tool whenever the
   contention genuinely is over one row's state, which is why ride
   acceptance still uses it and didn't need to move to a Redis lock.
4. **What's the failure mode if Redis goes down while this system is
   running?** Split by what's stored there: live driver locations
   become unavailable (nearby search returns nothing until Redis is
   back and drivers re-ping - no data loss, since Postgres's periodic
   samples are the only durable record and Redis was never the source
   of truth); rate limiting behavior depends on the library's
   configured failure mode (worth checking, since fail-open vs
   fail-closed each have trade-offs); the vehicle-type cache falls back
   to hitting Postgres directly every time (slower, not broken, per
   this phase's explicit graceful-degradation design); the distributed
   lock would fail to acquire, and `withLock` throws - meaning ride
   creation would start failing until Redis recovers, an accepted
   trade-off for correctness over availability in this one specific
   path.
5. **Why cache "not found" results, not just successful lookups?**
   Because a cache is meant to protect the database from repeated,
   low-value load - a client retry-looping on a request with a typo'd
   or stale vehicle-type ID would otherwise hit Postgres on every
   single attempt, since a failed lookup would never populate the cache
   under a naive "only cache success" implementation. Caching the
   negative result (with the same TTL discipline) protects against
   that exact pattern.
