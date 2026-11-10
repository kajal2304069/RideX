# RideX — Phase 6: Ride Booking

## 1. What we built

The full ride-hailing flow, end to end: fare estimation, ride request
with idempotency, driver acceptance (with real concurrency safety),
the complete `RideStateMachine`, trip completion with fare persistence,
and cancellation — with a manual "list available rides, pick one"
acceptance flow standing in for Phase 9's real driver-matching engine.

```
POST /api/rides/estimate           → fare quote (no ride created)
POST /api/rides/request            → create a ride (idempotent)
GET  /api/rides/current            → rider's active ride
GET  /api/rides/history            → rider's past rides
GET  /api/rides/:id                → either party can view

GET  /api/rides/available          → [DRIVER] the crude matching pool
GET  /api/rides/driver/current     → [DRIVER] driver's active ride
POST /api/rides/:id/accept         → [DRIVER] concurrency-safe acceptance
POST /api/rides/:id/arriving       → DRIVER_ASSIGNED -> DRIVER_ARRIVING
POST /api/rides/:id/arrived        → DRIVER_ARRIVING -> DRIVER_ARRIVED
POST /api/rides/:id/start          → DRIVER_ARRIVED -> TRIP_STARTED
POST /api/rides/:id/complete       → TRIP_STARTED -> TRIP_COMPLETED (+ fare, + counts)

POST /api/rides/:id/cancel         → either party, pre-trip-start only
```

## 2. The concurrency scenario — spec section 12, implemented exactly as specified

> "Three drivers receive the same ride. Driver A, Driver B, Driver C.
> All try to accept at nearly the same time. Only ONE must succeed."

`ridesRepository.acceptRideIfSearching` implements this with `SELECT
status FROM rides WHERE id = $1 FOR UPDATE` inside a transaction:

```
Txn A: SELECT ... FOR UPDATE  → lock acquired immediately
Txn B: SELECT ... FOR UPDATE  → BLOCKS (waiting for A's lock)
Txn C: SELECT ... FOR UPDATE  → BLOCKS (waiting for A's lock)

Txn A: status is SEARCHING_DRIVER → UPDATE, assign driver A, COMMIT
Txn B: lock released, B's SELECT proceeds → re-reads row → status is
       now DRIVER_ASSIGNED, not SEARCHING_DRIVER → B returns "conflict"
Txn C: same as B
```

This is **pessimistic locking**, deliberately different from Phase 5's
**optimistic** `WHERE status = $expected` approach for vehicle status
changes. The two mechanisms solve the same category of problem
differently, and the choice is the right one for each case: ride
acceptance is exactly the high-contention, must-never-double-assign
scenario pessimistic locking exists for (losing bidders block briefly,
then get a clean answer once the lock releases); vehicle status changes
are low-frequency enough that optimistic concurrency (try the write,
detect the stale read afterward) avoids holding a lock for no real
benefit.

**Verified under actual concurrent load**, not just asserted:
`tests/concurrency/rideAcceptance.test.ts` fires three real HTTP accept
requests at the same ride simultaneously via `Promise.all`, five
separate times in a loop to rule out a single lucky pass, and checks:
- Exactly one `200`, exactly two `409` — never ambiguous, never a leaked 500
- The database's `driver_id` matches the HTTP response that reported success
- The winning driver's vehicle flips to `IN_RIDE_SERVICE`; both losing
  drivers' vehicles remain untouched at `AVAILABLE`

## 3. Idempotent ride creation

`POST /api/rides/request` requires a client-supplied `idempotencyKey`
(spec section 13). If the same key is submitted twice, the **existing**
ride is returned instead of creating a duplicate — verified live: two
identical requests with the same key produce identical ride IDs, and a
direct DB count confirms exactly one row was ever inserted. This
protects against the standard mobile-client failure mode: a request
that times out on the client side but actually succeeded server-side,
followed by an automatic retry.

## 4. REQUESTED is treated as instantaneous, not a persisted intermediate state

Spec section 7 lists `REQUESTED` as the first state, followed by
`SEARCHING_DRIVER`. This implementation creates rides **directly** into
`SEARCHING_DRIVER` rather than writing a `REQUESTED` row and immediately
transitioning it. This is a deliberate simplification: there's currently
no asynchronous step between "rider submits a request" and "we start
looking for a driver" (no fraud check, no payment pre-authorization) —
persisting `REQUESTED` as its own row-state would just be two writes to
model one instantaneous event. The state machine (`rideStateMachine.ts`)
still fully defines `REQUESTED → SEARCHING_DRIVER` as a valid, tested
transition; the moment a real asynchronous pre-search step is added
(e.g. Phase 12's payment pre-authorization), that's exactly where this
simplification gets removed and `REQUESTED` becomes a real, observable
state again.

## 5. Fare calculation: Haversine now, Dijkstra later — by design, not oversight

`fare.service.ts`'s `haversineDistanceMeters` computes straight-line
("as the crow flies") distance, explicitly **not** the road-network
routing distance Phase 8's Dijkstra-based `RoutingEngine` will provide.
This is intentional and documented in the code itself: an upfront fare
*estimate* only needs to be close enough to set rider expectations
before they commit to requesting a ride — it doesn't need to be
billing-accurate. The same Haversine estimate is currently also used as
the *actual* trip distance at completion (`ridesService.complete`
reuses `ride.distance_meters` captured at request time), which **is** a
simplification worth calling out: a production system would recompute
the actual route/distance at completion using real GPS trace data
(Phase 7/10) or the routed distance (Phase 8), not the pre-trip
estimate. This will be revisited once those phases exist — noted here
rather than silently left as a surprise.

## 6. Vehicle state machine integration: three coordination points

Every ride-lifecycle event that changes whether a vehicle is "busy"
calls into Phase 5's vehicle state machine via
`updateStatusIfCurrentlyIs`:
- **Accept**: `AVAILABLE → IN_RIDE_SERVICE`
- **Complete**: `IN_RIDE_SERVICE → AVAILABLE`
- **Cancel** (post-acceptance only): `IN_RIDE_SERVICE → AVAILABLE`

All three use the *same* optimistic-concurrency helper from Phase 5 —
no new vehicle-status-writing code was needed, just calling the
existing, already-tested primitive. This is the payoff of Phase 5
having built a clean, reusable state-machine service: Phase 6 composes
it rather than reimplementing vehicle status logic.

## 7. What's intentionally NOT built yet

- **Real driver matching** (Phase 9): `GET /api/rides/available` is
  every `SEARCHING_DRIVER` ride, unranked, filterable only by vehicle
  type — no distance scoring, no candidate radius expansion, no ETA
  ranking. A driver picks manually; Phase 9 replaces this with the real
  `MatchingService`.
- **Real-time location** (Phase 7/10): `DRIVER_ARRIVING`/`DRIVER_ARRIVED`
  are driver-triggered API calls, not derived from actual GPS proximity
  to the pickup point.
- **Payment** (Phase 12): the state machine defines
  `TRIP_COMPLETED → PAYMENT_COMPLETED` and it's fully unit-tested, but
  no endpoint triggers it yet — that's the `PaymentService`'s job once
  it exists.
- **Surge pricing** (spec section 15): `computeFare` accepts a
  `surgeMultiplier` parameter and is tested with one, but nothing
  currently computes a real multiplier from live supply/demand — every
  ride today is priced at `1.0x`.

## 8. Test cases delivered this phase

38 new tests, all passing:
- **Unit (19):** ride state machine (happy path, the spec's explicit
  COMPLETED→REQUESTED rejection, skip-state rejection, cancellation
  window rules, terminal-state detection, self-transition rejection);
  fare service (Haversine distance sanity/symmetry/real-world-scale
  checks, duration scaling, fare breakdown arithmetic including surge
  and discount edge cases)
- **Integration (17, live DB):** fare estimate success/unknown-type,
  request creation, idempotency (same key → same ride, DB count
  verified), one-active-ride-at-a-time enforcement, acceptance
  eligibility checks (no vehicle, offline, wrong vehicle type),
  successful acceptance with vehicle-status verification,
  already-accepted rejection, the full happy-path lifecycle through
  completion (fare persisted, vehicle freed, both parties' ride counts
  incremented), skip-state rejection, cancellation (pre- and
  post-acceptance, vehicle-freeing, post-trip-start rejection,
  non-party rejection), ownership/visibility, history isolation
- **Concurrency (2, live DB):** the flagship three-drivers-one-ride race
  (spec section 12, exact scenario) with full DB-state verification,
  repeated 5× in a loop for confidence

Combined with Phases 1–5: **131/131 passing.**

Also manually walked the complete flow live against the real server:
fare estimate → ride request → driver setup (register → onboard →
verify → assign vehicle → go online) → accept → arriving → arrived →
start → complete, with every response and the final DB state (fare
amount, freed vehicle, incremented ride counts) inspected directly via
`psql`.

Run them:
```
cd backend && npm test
# or just the flagship concurrency demo:
npx jest tests/concurrency/rideAcceptance.test.ts
```

## 9. Interview questions this phase should prepare you to answer

1. **Walk through exactly what happens when three drivers hit "accept"
   on the same ride within milliseconds of each other.** All three
   requests begin a transaction and attempt `SELECT ... FOR UPDATE` on
   the ride row. Postgres grants the lock to exactly one transaction;
   the other two block. The lock holder checks `status ===
   SEARCHING_DRIVER` (true), updates the row, and commits — releasing
   the lock. The next blocked transaction now acquires the lock, but its
   `SELECT` re-reads the row for the first time *after* the winner's
   commit, so it sees `DRIVER_ASSIGNED` — its check fails and it returns
   a clean conflict. The third transaction goes through the same
   sequence. No two transactions ever see `SEARCHING_DRIVER`
   simultaneously.
2. **Why pessimistic locking here but optimistic concurrency for vehicle
   status changes in Phase 5?** Ride acceptance is a genuine
   high-contention race with real correctness stakes (double-booking a
   ride is a serious bug) and a short critical section — losers blocking
   for milliseconds is a perfectly acceptable cost. Vehicle status
   changes happen far less often and aren't usually contended, so paying
   for a lock on every write isn't worth it; detecting a stale write
   after the fact and asking the client to retry is cheaper in the
   common case.
3. **Why aren't fare estimates using the real Dijkstra-routed distance?**
   Because Phase 8 (the routing engine) doesn't exist yet — this is an
   explicit, documented sequencing decision, not an oversight. Haversine
   is deliberately "good enough for a quote, not a bill" — once the
   routing engine exists, it's the natural drop-in replacement for the
   distance calculation, without needing to change anything else about
   how fares are computed.
4. **What happens to the vehicle if a ride is cancelled after a driver
   has already accepted?** `ridesService.cancel` checks whether the ride
   had a `vehicle_id` assigned (meaning acceptance already happened) and
   if so, calls the same `updateStatusIfCurrentlyIs(vehicleId,
   'IN_RIDE_SERVICE', 'AVAILABLE')` that trip completion uses — reusing
   Phase 5's existing state-machine primitive rather than writing new
   vehicle-status logic specific to cancellation.
5. **Why does idempotency return the existing ride instead of just
   erroring on a duplicate key?** Because the whole point of an
   idempotency key is "the caller doesn't know whether their first
   request actually succeeded" (e.g. it timed out client-side after the
   server had already committed). Erroring on retry would leave the
   client stuck not knowing whether a ride exists; returning the
   original ride lets the retry behave exactly as if the first request
   had simply been slow to respond.
6. **What's the concrete risk in reusing the pre-trip Haversine distance
   estimate as the final billed distance at trip completion, and how
   would you fix it?** It doesn't reflect the actual route driven — a
   detour, traffic rerouting, or a driver taking a longer real-world
   path all go unbilled, and conversely a rider could be charged for a
   straight-line distance shorter than what was actually driven if the
   real road network requires a longer path. The fix is exactly what
   Phase 7 (GPS tracking) and Phase 8 (routing) exist to provide:
   compute the final distance from the actual recorded trip path (or at
   minimum the routed road-network distance) at completion time, not
   from the pre-trip quote.
