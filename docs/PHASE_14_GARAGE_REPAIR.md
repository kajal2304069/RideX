# RideX — Phase 14: Garage + Repair

## 1. What we built

A vehicle-repair marketplace on top of the same patterns as rides: find a garage by location, book a service,
track the job through a state machine, pay for it with the Phase 12 payment system, and keep a maintenance history
per vehicle.

- **Garages module:** garage CRUD, PostGIS nearby search, per-garage service catalogue, mechanic roster
- **Repairs module:** bookings, the booking state machine, repair orders (parts + labour), emergency dispatch,
  maintenance history
- **Payments integration:** `GARAGE_SERVICE` is now a payable type (a resolver, no change to `PaymentService`)
- **Notifications:** 7 new types for the booking lifecycle
- **Migrations:** `…013` (two integrity indexes) and `…014` (breakdown location + description on bookings)
- **Middleware:** `optionalAuthenticate` for public pages that behave differently for a logged-in viewer

## 2. Booking lifecycle

```
REQUESTED ─► ACCEPTED ─► MECHANIC_ASSIGNED ─► VEHICLE_RECEIVED ─► REPAIR_IN_PROGRESS ─► READY ─► COMPLETED
    │            │               │                                                        (frozen)   (by payment)
    └────────────┴───────────────┴──► CANCELLED   (only until the vehicle is received)
```

| Step | Actor | Side effects |
|---|---|---|
| create | customer | notifies garage owner (`BOOKING_REQUESTED`) |
| accept | garage owner | notifies customer |
| assign-mechanic | garage owner | mechanic must belong to the garage and be active |
| vehicle-received | garage owner | a registered vehicle goes `AVAILABLE → UNDER_MAINTENANCE` |
| start-repair | garage owner | creates the repair order |
| repair-order (PUT) | garage owner | server computes parts and total |
| ready | garage owner | **freezes the amount**; emails the customer what is due |
| payment | customer | `READY → COMPLETED`, maintenance record written, vehicle back to `AVAILABLE` |
| cancel | customer or garage | only before the vehicle is received |

`COMPLETED` is reachable only through a successful payment. A garage cannot mark a job done without being paid, and a
customer cannot walk away from a finished job.

## 3. Database design

| Constraint | Guarantees |
|---|---|
| `service_bookings_one_active_job_per_mechanic` — partial unique on `(mechanic_id)` where status in `MECHANIC_ASSIGNED, VEHICLE_RECEIVED, REPAIR_IN_PROGRESS` | A mechanic cannot be double-booked. Leaving the active states (READY, COMPLETED, CANCELLED) frees them with no cleanup code. |
| `garage_services_unique_type` — unique `(garage_id, service_type)` | A garage lists each service once. |
| `garages.location` GIST index (Phase 3) | Fast radius + nearest-first queries |
| `repair_orders.service_booking_id` UNIQUE (Phase 3) | One repair order per booking |
| `service_bookings.idempotency_key` UNIQUE | Duplicate-request guard (stored as `<customerId>:<key>`) |

### Nearby search

```sql
WHERE g.is_active AND ST_DWithin(g.location, p.pt, $radius)   -- filter, uses the GIST index
ORDER BY g.location <-> p.pt                                  -- KNN order, same index
```

Optional `serviceType` is an `EXISTS` subquery. Distance is returned in metres. A test asserts the planner can use the
index for the radius filter.

### Emergency dispatch

`POST /api/bookings/emergency` takes a location and picks the **nearest active garage that offers `EMERGENCY_REPAIR`**
within 20 km, skipping closer garages that do not. The stranded driver does not browse. The booking records
`breakdown_location`, is flagged `is_emergency`, sorts first in the garage's queue, and the garage owner is emailed.

## 4. Concurrency and consistency

| Scenario | Mechanism | Outcome |
|---|---|---|
| 10 identical create requests | Redis lock + unique idempotency key | one booking |
| One mechanic assigned to 5 bookings at once | unique partial index → `23505` → 409 | exactly 1×200, 4×409 |
| Cancel racing accept | guarded `UPDATE … WHERE status = $expected` | the loser gets a 409; final status matches what each caller was told |
| Editing costs racing "mark ready" | cost update is one `UPDATE … FROM service_bookings WHERE status='REPAIR_IN_PROGRESS'` | no window between the check and the write; stored amount equals what the editor was told |
| 10 payments for one booking | Phase 12 lock + unique index | one payment, one completion, one maintenance row |
| Replayed payment event | completion transaction only applies from `READY` | no duplicate maintenance record |

**Why the amount freezes at READY:** the payment resolver reads `repair_orders.total_cost`. If the garage could edit it
after the customer was told the price, the customer could be charged something different from what they saw. After
READY the cost-update statement matches no row.

**Completion is one transaction:** `READY → COMPLETED`, `completed_at`, and the maintenance record commit together or not
at all. The vehicle release happens just after and is a no-op if already done.

**Vehicle claim ordering:** on `vehicle-received` the vehicle is claimed first (`AVAILABLE → UNDER_MAINTENANCE`, a
guarded update), then the booking transitions. If the booking transition loses a race, the claim is undone. A vehicle
that is mid-ride or rented gives a 409 and the booking does not move.

**Money arithmetic** is done in integer cents (`0.1 + 0.2` would be `0.30000000000000004`). The client sends labour and
line items; `partsCost` and `totalCost` are never accepted from the client (strict schema).

## 5. API

Garages (`/api/garages`)

| Method | Path | Auth |
|---|---|---|
| POST | `/` | GARAGE_OWNER |
| GET | `/mine` | GARAGE_OWNER |
| GET | `/nearby?lat&lng&radiusMeters&serviceType&limit` | any user |
| GET | `/:id` | public (optional token). Inactive garages visible only to owner/admin; mechanic roster only to owner/admin |
| PATCH | `/:id` | owner |
| POST / DELETE | `/:id/services`, `/:id/services/:serviceId` | owner |
| POST / GET / PATCH | `/:id/mechanics`, `/:id/mechanics/:mechanicId` | owner (GET also admin) |

Bookings (`/api/bookings`)

| Method | Path | Auth |
|---|---|---|
| POST | `/`, `/emergency` | any user (idempotency key in body) |
| GET | `/` | my bookings |
| GET | `/garage/:garageId?status=` | garage owner |
| GET | `/:id` | customer, garage owner, admin |
| POST | `/:id/accept`, `/assign-mechanic`, `/vehicle-received`, `/start-repair`, `/ready` | garage owner |
| PUT | `/:id/repair-order` | garage owner |
| POST | `/:id/cancel` | customer or garage owner |
| GET | `/vehicles/:vehicleId/maintenance` | vehicle owner, admin |

Everything that would reveal another party's data returns **404, not 403**.

## 6. Bugs found while testing

- `array_agg` over a Postgres **enum** comes back from `pg` as the raw string `"{OIL_CHANGE,BRAKE_REPAIR}"`, not an
  array (enum arrays have no built-in parser). `serviceTypes` was a string on the wire. Fixed by casting to `text`, and
  ordering by `::text` so results are alphabetical rather than enum-declaration order.
- The mutation check (drop the mechanic index) fails exactly the three tests that depend on it, and the index was restored.

## 7. Known gaps

- **Ratings:** `garages.rating_avg` exists but nothing updates it (a `ratings` table exists in the schema; wiring it up is
  for a later phase).
- **Opening hours** are stored and validated but not enforced; no "open now" filter.
- **No scheduling capacity:** `scheduled_at` is stored but there is no slot or bay model, so a garage can be overbooked.
- **Vehicle is held until payment.** If a customer never pays after READY, the vehicle stays `UNDER_MAINTENANCE`. An admin
  flow or a timeout job is the fix.
- **Maintenance reminders:** `next_due_at` is recorded; the reminder job that would use it (a BullMQ repeatable job
  feeding Phase 13 notifications) is not built.
- **Emergency dispatch picks one garage.** No fan-out, no accept-timeout re-dispatch to the next nearest.
- **Mechanic self-service:** `mechanics.user_id` exists but mechanics have no login-side endpoints yet.
- **Cancellation fees / disputes** are not modelled.

## 8. Test cases

Unit (12): booking state machine (happy path, cancel window, terminal states, no skipping, no no-ops, transition count,
typed error); cost arithmetic (sum, float drift, many small items, empty, every service type has a due-interval).

Integration, garages (23): create / roles / validation; own-garage list; update rules; ownership 404s; nearby ordering,
radius, filters, inactive, limit, validation, GIST usability; public detail rules; services; mechanics.

Integration, bookings (32): full lifecycle with payment, vehicle status, costs, maintenance history; replayed payment;
pay-before-ready; wrong payer; decline-then-retry; skipped steps; ready without costs; client-supplied totals; frozen
order; bad money values; authorization matrix; creation validation; idempotency; cancellation windows; mechanic
double-booking and freeing; wrong-garage and inactive mechanics; vehicle in use; walk-in customers; listings; emergency
dispatch (nearest capable, none in range, inactive, idempotent).

Concurrency (6): described in section 4.

Notifications (+4): new templates and an end-to-end booking-to-notification test with worker and email.

Full suite: **368 passing** (291 before this phase).

## 9. Interview questions

**Why a partial unique index for mechanics instead of a check in code?**
Two requests can both read "mechanic is free" before either writes. The index makes the database refuse the second one.
Partial means finishing or cancelling a job releases the mechanic automatically.

**Why guarded `UPDATE … WHERE status = $from` instead of `SELECT … FOR UPDATE`?**
Optimistic: no lock held across application code, and the loser learns it lost (0 rows) and returns 409. Pessimistic
locking (Phase 6's ride acceptance) fits when losers should wait; here a stale state change should fail fast.

**Why can't the garage edit the bill after READY?**
Payment reads the amount at READY. Freezing prevents bait-and-switch. It is enforced inside the UPDATE, not just
in a pre-check, so a concurrent "ready" cannot slip between check and write.

**Why is the customer's cancellation allowed up to MECHANIC_ASSIGNED but not later?**
Once the garage holds the vehicle, cancelling would strand a half-repaired car. The state machine encodes the business
rule structurally: there is simply no edge from `VEHICLE_RECEIVED` to `CANCELLED`.

**How does payment know what to charge for a repair?**
A `PayableResolver` for `GARAGE_SERVICE` returns the customer as payer and `repair_orders.total_cost` as the amount,
only when the booking is READY. `PaymentService` does not change. The same extension point serves rentals and
marketplace next.

**What if the payment succeeds but completing the booking fails?**
The payment row is `SUCCESS` and the booking is `READY`. A replay of the same request re-runs `onSuccess`, which is
idempotent (the completion transaction applies only from READY). A sweeper could repair it without the client.

**Why 404 instead of 403?**
403 confirms the resource exists. For a stranger probing booking ids, 404 reveals nothing.

**Why is `completeBooking` a DB transaction while the rest is not?**
Status, completed-at and the maintenance record must agree. The provider call (payment) cannot be in a transaction;
this part can, so it is.

**How does nearby search scale?**
`ST_DWithin` and `<->` both use the GIST index, so cost grows with results in the radius, not table size. At very large
scale shard by geohash/region, or move hot "live availability" data to Redis GEO as Phase 7 did for drivers. Garages
change rarely, so Postgres alone is right here.

**Why is emergency dispatch a single garage, and what would you change?**
Simplicity. In production: notify the top K nearest, first to accept wins (the guarded-update pattern again), and
re-dispatch on a timeout via a delayed BullMQ job.

**How would you prevent overbooking?**
Model capacity: bays or mechanic shifts with a time-range table and an exclusion constraint (`btree_gist`), the same
technique used for rental overlap.

**Microservice extraction?**
Garages and repairs are self-contained (they reference users and vehicles by id). Extraction means: replace the direct
`vehiclesRepository` calls with an API/event, publish `booking.completed` instead of calling payments' resolver,
and keep the maintenance history owned by the garage service.
