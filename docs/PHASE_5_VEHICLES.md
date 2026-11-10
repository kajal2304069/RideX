# RideX — Phase 5: Vehicle Management

## 1. What we built

Full CRUD + state machine + owner→driver assignment on top of Phase
3's `vehicles`/`vehicle_driver_assignments` tables.

```
POST   /api/vehicles                      → register a vehicle (VEHICLE_OWNER)
GET    /api/vehicles/mine                 → list my vehicles
GET    /api/vehicles/:vehicleId           → get one (owner-only)
PATCH  /api/vehicles/:vehicleId           → update color/mileage
PATCH  /api/vehicles/:vehicleId/status    → state-machine-guarded status change
POST   /api/vehicles/:vehicleId/assign-driver   → assign a verified driver
POST   /api/vehicles/:vehicleId/unassign-driver → end the active assignment
```

New: `modules/vehicles/services/vehicleStateMachine.ts` — a pure,
DB-independent transition table, following the exact pattern the spec
calls for with `RideStateMachine` (Phase 6).

## 2. The state machine: AVAILABLE as the hub

```
                    ┌─────────────┐
        ┌──────────▶│  AVAILABLE  │◀──────────┐
        │           └─────────────┘           │
        │        ▲       ▲       ▲            │
        │        │       │       │            │
   ┌────┴───┐ ┌──┴───┐ ┌─┴──────────────┐ ┌───┴─────────┐
   │ RENTED │ │IN_RIDE│ │UNDER_MAINTENANCE│ │ UNAVAILABLE │
   └────────┘ │SERVICE│ └────────┬─────────┘ └─────────────┘
              └───────┘          │
                                  └──────────▶ UNAVAILABLE
```

Every "busy" state can only be entered from `AVAILABLE` and can only
return to `AVAILABLE` (with one extra edge: `UNDER_MAINTENANCE` can also
go straight to `UNAVAILABLE`, e.g. a vehicle failing inspection gets
pulled from service rather than reinserted into the pool). This
directly encodes spec section 25's invariant — a vehicle can never
"jump" `RENTED → IN_RIDE_SERVICE` (skipping a return/inspection step) —
as a data structure (`VALID_TRANSITIONS`), not scattered `if`
statements. Verified both ways:
- **Unit** (`vehicleStateMachine.test.ts`): every valid edge, every
  invalid edge, self-transitions rejected, no dead-end states
- **Integration** (live DB): `AVAILABLE → UNDER_MAINTENANCE` succeeds,
  then `UNDER_MAINTENANCE → RENTED` is rejected with `400`

## 3. Optimistic concurrency on status changes

`updateStatusIfCurrentlyIs(id, expectedCurrent, next)` writes with
`WHERE id = $1 AND status = $2` instead of a plain `WHERE id = $1`. If
two requests race to change the same vehicle's status starting from the
same read, only one `UPDATE` actually matches a row — the loser's WHERE
clause matches zero rows (the winner already moved the status
elsewhere), which the service turns into a `409` instead of silently
letting the second writer clobber the first. This is the same
"optimistic concurrency" idea as `SELECT ... FOR UPDATE`-style
pessimistic locking used for ride acceptance (Phase 9), just
implemented as a conditional write instead of an explicit row lock —
appropriate here because status changes are infrequent and short, so
lock contention isn't a real concern the way it would be for
high-frequency ride-matching writes.

## 4. Bug found via a concurrency test: a real race, and a leaked 500

Per spec section 12's explicit demand to "demonstrate the race condition
and solution," `tests/concurrency/vehicleAssignment.test.ts` fires two
`assign-driver` requests at the same vehicle, for two different
verified drivers, essentially simultaneously.

**What actually happened the first time this ran:** exactly one request
succeeded (`201`) — correct — but the loser came back as an **unhandled
`500`**, not a clean `409`. The application-level "check for an
existing active assignment, then insert" (`findActiveAssignmentByVehicle`)
is a classic TOCTOU: both concurrent requests can pass that check before
either commits. The database's partial unique index
(`vehicle_driver_assignments_one_active_per_vehicle`, Phase 3) is the
*actual* guarantee that only one assignment wins — but the raw Postgres
`23505 unique_violation` error it throws was bubbling straight past the
service layer, landing in the generic error handler as a 500.

**Fix:** `createAssignmentOrConflict()` in the service now catches
`error.code === '23505'` specifically and translates it into
`ApiError.conflict(...)`. The application-level check stays — it's a
useful fast-path that avoids a doomed database round-trip in the
overwhelmingly common (non-racing) case — but it is explicitly *not*
trusted as the actual correctness guarantee anymore. Rerunning the test
after the fix: `[201, 409]`, every time, and the DB state was verified
correct (exactly one `ACTIVE` assignment row, `vehicles.current_driver_id`
pointing at whichever driver actually won) even *before* the fix — the
bug was purely in how the loser's failure was reported over HTTP, not
in the underlying data integrity.

This is the concrete version of the general lesson: **an
application-level check is a fast-path, not a guarantee, under
concurrency — the database constraint is the guarantee, and your error
handling needs to know how to translate its failure mode into your
API's error vocabulary.**

## 5. Ownership hiding: 404, not 403, for someone else's vehicle

`GET /api/vehicles/:id`, `PATCH .../status`, etc. all return `404 Not
Found` (not `403 Forbidden`) when the vehicle exists but belongs to
someone else — the same principle as Phase 2's identical
wrong-password/unknown-email login error: don't let a response's status
code reveal that a resource exists if the requester has no right to
know that. A `403` would leak "yes, vehicle ID X is real, you're just
not allowed to see it"; a `404` reveals nothing.

## 6. What's intentionally NOT built yet

- No linkage yet between `current_driver_id`/an active assignment and
  ride dispatch — a vehicle having an assigned driver doesn't yet do
  anything ride-related; that connection is Phase 6/9
- `IN_RIDE_SERVICE` and `RENTED` transitions exist in the state machine
  but nothing currently triggers them — the Ride service (Phase 6) and
  Rental service (Phase 16) will call `updateStatus` as part of their
  own flows once they exist
- No vehicle image upload / document management — deferred, not core to
  the state-machine and assignment concerns this phase focused on

## 7. Test cases delivered this phase

33 new tests, all passing:
- **Unit (19):** exhaustive state-machine transition matrix (9 valid, 7
  invalid edges, self-transition rejection, no-dead-ends check, error
  detail assertions)
- **Integration (13, live DB):** creation/ownership/duplicate-registration/
  404-hiding/listing, live state-machine enforcement (valid transition
  succeeds, invalid transition rejected, non-owner rejected), driver
  assignment success (with both-sides-of-relationship verification
  directly against the DB), unverified-driver rejection,
  already-assigned-elsewhere rejection, unassignment, assign-to-
  non-AVAILABLE-vehicle rejection
- **Concurrency (1, live DB):** the race condition described in §4,
  including the DB-state assertions (`count(*) = 1` active assignment,
  correct `current_driver_id`) that hold true regardless of which driver wins

Combined with Phases 1–4: **93/93 passing.**

Run them:
```
cd backend && npm test
# or just the new coverage:
npm run test:unit -- vehicleStateMachine
npm run test:concurrency
```

## 8. Interview questions this phase should prepare you to answer

1. **Why is `AVAILABLE` the hub of the state machine instead of a fully
   connected graph?** Because the business rule is specifically that a
   vehicle can't move directly between two "busy" states — every
   transition out of a busy state has to pass through the neutral
   `AVAILABLE` state, which is exactly what making `AVAILABLE` the only
   state other states point back to (and the only state with more than
   one outgoing edge) encodes structurally.
2. **What's the difference between the application-level assignment
   check and the database's partial unique index, and why do you need
   both?** The application check is a fast-path: it avoids sending a
   doomed INSERT to the database in the common (non-racing) case,
   giving a fast, clean error without a round-trip. The database
   constraint is the actual correctness guarantee under concurrency,
   because it's evaluated atomically as part of the write itself — no
   window exists for two transactions to both pass a check and then
   both succeed. Skip the DB constraint and you have a real race
   condition; skip the application check and you have correct behavior
   but worse latency/UX in the common case.
3. **Why did the concurrency test's first run reveal a bug even though
   the underlying data ended up correct?** The database enforced
   correctness (only one ACTIVE assignment ever existed), but the
   *API's error handling* didn't know how to translate the database's
   failure mode (a raw `23505` unique-violation) into the application's
   vocabulary (`ApiError.conflict`) — so a correctly-rejected request
   was reported to the client as a server crash instead of an expected
   conflict. Data integrity and API correctness are different
   properties; you can have one without the other.
4. **Why does `updateStatusIfCurrentlyIs` use a conditional WHERE clause
   instead of `SELECT ... FOR UPDATE`?** Both solve "don't let two
   concurrent writers silently overwrite each other," but `FOR UPDATE`
   pessimistically locks the row for the duration of a transaction,
   which is the right tool when you expect real contention and want
   competing writers to queue (ride acceptance, Phase 9). Vehicle status
   changes are low-frequency and short, so optimistic concurrency (try
   the write, detect a stale read via zero rows affected, ask the
   caller to retry) achieves the same correctness without holding a
   lock.
5. **Why 404 instead of 403 for another owner's vehicle?** Returning 403
   confirms the resource exists ("you're not allowed to see vehicle
   X"), which is itself information leakage — an attacker enumerating
   vehicle IDs could map out which ones are real. 404 reveals nothing
   beyond "this isn't accessible to you," which from the requester's
   point of view is indistinguishable from "this doesn't exist."
