# RideX — Phase 7: Geolocation

## 1. What we built

Redis GEO-backed live driver location, with throttled periodic
persistence to Postgres and staleness-aware nearby-driver search — the
foundation Phase 9's real `MatchingService` will build on.

```
POST /api/location/drivers/me       → [DRIVER] broadcast current position
GET  /api/location/drivers/nearby   → nearby drivers within a radius
```

New: `modules/location/services/location.service.ts` — the whole point
of this phase, and the first module whose core logic genuinely lives in
Redis rather than Postgres.

## 2. Why Redis GEO, not a PostgreSQL query, for live position

Spec section 8 is explicit: **"Do not write every GPS update directly
to PostgreSQL... use Redis GEO for nearby driver discovery."** The
reasoning, made concrete here:
- A single active driver might send a position update every few
  seconds. At any real scale, that's a write rate PostgreSQL's
  transaction log and indexes aren't designed to absorb as a sustained
  hot path — every `UPDATE` touches WAL, and every `INSERT` into an
  indexed spatial column re-balances that index.
- Redis's `GEOADD`/`GEOSEARCH` are in-memory sorted-set operations —
  O(log N) inserts, genuinely fast radius queries — with none of that
  durability overhead, which is exactly the right trade-off for data
  that's valid for a few seconds and then superseded anyway.
- **What's actually worth the durability cost** — a periodic sample,
  useful for trip replay/analytics — still goes to `vehicle_locations`
  (Postgres, Phase 3's PostGIS `geography` column), just throttled to
  once every 30 seconds per driver instead of every single ping.
  Verified live: two location updates sent back-to-back for the same
  driver produced exactly one Postgres row.

## 3. Redis key design: a GEO set plus a companion hash

```
geo:drivers                  → GEO sorted set, member = driverId
loc:driver:<driverId>        → hash: lat, lng, heading, speedKmh,
                                vehicleId, vehicleTypeId, updatedAt
loc:persisted:<driverId>     → plain string, last-persisted-to-Postgres
                                timestamp (the throttle marker)
```

Redis's GEO commands only store coordinates — there's no room in a
sorted-set entry for heading, speed, vehicle type, or a timestamp. The
companion hash carries everything else, keyed by the same `driverId`,
so a `GEOSEARCH` hit gets enriched with a second lookup (pipelined, not
one round-trip per candidate).

## 4. The staleness problem: Redis GEO sets don't support per-member TTL

This is the least obvious design decision in the module, worth calling
out explicitly. Redis lets you `EXPIRE` an entire key, but a GEO set is
a single sorted-set key holding *every* driver — there's no way to make
one member of that set expire independently of the others. So if a
driver's app crashes mid-session without ever calling `/offline`, their
last-known coordinates would sit in `geo:drivers` forever with no
built-in cleanup.

**The fix:** staleness is tracked via the companion hash's `updatedAt`
field instead, with two layers:
1. The hash itself carries a 120-second `EXPIRE` — a driver who goes
   fully silent has their metadata auto-vanish from Redis within two
   minutes, no matter what.
2. `getNearbyDrivers` cross-checks every `GEOSEARCH` hit against the
   hash: if the hash is missing (already expired) *or* its `updatedAt`
   is older than 30 seconds, that driver is excluded from results **and**
   lazily `ZREM`'d from the GEO set as a cleanup side effect of the
   search itself — so the set doesn't grow unboundedly with abandoned
   entries, without needing a separate scheduled sweep job.

Verified directly (not just via the TTL, which would take real wall-clock
time to test): a test backdates a hash's `updatedAt` to 60 seconds ago,
confirms the driver is excluded from a subsequent search, and confirms
their entry was actually removed from the GEO set (`ZSCORE` returns
`null`) as a result of that search running.

## 5. Explicit going-offline vs. staleness timeout — why both exist

`driversService.goOffline` (Phase 4) now calls
`locationService.removeDriverLocation` directly, immediately removing
the driver from `geo:drivers` and deleting their hash. This is
deliberately **not** left to the 30-second staleness window: a driver
who explicitly says "I'm done for the day" shouldn't remain visible to
riders browsing nearby drivers for up to half a minute afterward. The
staleness mechanism exists for the *involuntary* disconnect case (app
crash, network loss, force-quit) that has no explicit "I'm offline"
signal to hook into — spec section 36's driver-disconnect failure
handling, applied specifically at the geolocation layer. Verified live:
immediately after `/api/drivers/offline`, a nearby-drivers query that
found the driver a moment earlier now returns empty.

## 6. Server-derived vehicle data, not client-supplied

`locationService.recordDriverPing` (the actual entrypoint the HTTP
route calls) looks up the calling driver's `current_vehicle_id` and
that vehicle's `vehicle_type_id` from Postgres itself — the client only
ever sends `lat`/`lng`/`heading`/`speedKmh`. A driver cannot broadcast a
position tagged with an arbitrary vehicle or vehicle type. This matters
because Phase 9's matching will trust `vehicleTypeId` from this exact
data to route ride requests to the right pool of drivers; if a client
could spoof it, a bike-registered driver could make themselves
discoverable for premium-sedan requests.

## 7. What's intentionally NOT built yet

- **No WebSocket transport** (Phase 10): location updates are plain
  REST `POST` requests. The Socket.IO bootstrap from Phase 1 exists but
  isn't wired to this module yet — `driver:location:update` (spec
  section 11) becomes a socket event once Phase 10 lands, calling the
  same `locationService.recordDriverPing` underneath.
- **No real matching/ranking** (Phase 9): `getNearbyDrivers` returns
  raw distance-sorted results — no ETA, no driver-rating weighting, no
  progressive radius expansion (1km → 2km → 5km → 10km per spec section
  9). That ranking logic is exactly what the `MatchingService` adds on
  top of this phase's raw nearby-search primitive.
- **No rate limiting specific to location pings**: a malfunctioning
  driver client sending updates far faster than any real GPS chip could
  isn't currently throttled beyond the global rate limiter. Worth
  revisiting once real load patterns are understood.

## 8. Test cases delivered this phase

10 new integration tests (all against live Redis + Postgres, not
mocks — this module's entire value proposition is its interaction with
real GEO commands, so a mocked Redis client would prove nothing):
- Nearby search finds an in-radius driver, excludes an out-of-radius
  one, returns nearest-first ordering, filters by vehicle type, and
  carries through heading/speed
- `removeDriverLocation` makes a driver disappear from search
  immediately
- Staleness: a driver with a backdated `updatedAt` is excluded from
  results, and is lazily removed from the GEO set as a side effect
- Throttled persistence: a first ping persists to Postgres; an
  immediate second ping does not (still exactly 1 row)

Plus one updated Phase 4 unit test (`driversService.test.ts`'s
`goOffline` case) to assert `locationService.removeDriverLocation` is
called, with `locationService` properly mocked so the unit test doesn't
silently start depending on a real Redis connection.

Combined with Phases 1–6: **141/141 passing.**

Also manually walked the live flow end-to-end: a rider's nearby-search
query returns empty before any driver ping, returns the correct driver
at the correct measured distance (62m) with heading/speed after a real
ping, confirms exactly one row landed in `vehicle_locations`, and
confirms the driver vanishes from nearby search the instant they go
offline.

Run them:
```
cd backend && npm test
```

## 9. Interview questions this phase should prepare you to answer

1. **Why can't you just put a TTL on each driver's GEO set entry to
   handle staleness?** Redis's `EXPIRE` applies to an entire key, and a
   GEO set is one key shared by every driver — there's no primitive for
   per-member expiry within a sorted set. The workaround is tracking
   freshness in a companion structure (the hash) that *can* expire
   independently per driver, and treating GEO-set membership as
   provisional, always cross-checked against that hash before trusting
   a search result.
2. **Why don't you just always write every GPS ping to Postgres and let
   the database handle it?** Sustained high-frequency writes to a
   durable, indexed store cost real overhead (WAL, index maintenance)
   that in-memory Redis operations don't pay. The data is also
   short-lived in value — a position from 3 seconds ago is superseded
   the moment a new one arrives — which is exactly the profile Redis is
   suited for and a durable store isn't optimized for.
3. **What's the actual difference between "a driver went offline" and
   "a driver's location went stale," and why handle them differently?**
   Going offline is a deliberate, known event — the driver's app told
   the server directly, so cleanup can and should happen instantly.
   Staleness is the absence of information (no more pings arrived) which
   could mean anything from "app crashed" to "phone died" to "network
   dropped" — there's no explicit signal, so the system can only infer
   it after enough time has passed without an update, which is
   necessarily slower and less certain than an explicit "I'm offline"
   call.
4. **Why derive `vehicleTypeId` server-side instead of trusting what the
   client sends?** Because this data feeds directly into ride matching
   (Phase 9) — if a client could claim any vehicle type, a rider
   requesting a premium sedan could be matched to a driver who's
   actually on a bike, discovered purely because their app lied about
   its vehicle type in a location ping. Deriving it from the driver's
   actual DB-recorded vehicle assignment (Phase 5) closes that off
   entirely.
5. **How would this change once Phase 10 adds WebSockets?** The
   transport changes (a `driver:location:update` socket event replaces
   the `POST` body), but the underlying logic doesn't need to —
   `locationService.recordDriverPing` is already a plain function with no
   HTTP-specific assumptions baked in, so the socket handler becomes a
   thin adapter calling the same service method the REST route calls
   today.
