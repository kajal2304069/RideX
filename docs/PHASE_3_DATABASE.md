# RideX — Phase 3: Database + PostGIS

## 1. What we built

The full domain schema (spec section 27): 8 migrations, 34 tables, on
top of Phase 2's `users`/`refresh_tokens`. Verified against a real
Postgres 16 + PostGIS 3.4 instance — not just "migrations that look
right," but actually applied, rolled back, reapplied, and queried.

```
002_create_vehicle_and_driver_domain  → vehicle_types, vehicles, drivers, riders,
                                          vehicle_locations, vehicle_driver_assignments
003_create_rides_domain               → rides, ride_fares, ratings
004_create_payments                   → payments (polymorphic)
005_create_garages_and_repairs        → garages, mechanics, garage_services,
                                          service_bookings, repair_orders, maintenance_records
006_create_marketplace                → vehicle_listings, vehicle_images,
                                          vehicle_inspections, vehicle_offers, favorites
007_create_rentals                    → rental_listings, rental_bookings
008_create_earnings                   → owner_earnings, driver_earnings, platform_commissions
009_create_notifications_support_audit → notifications, messages, support_tickets, audit_logs
```

Plus `src/db/seeds/001_vehicle_types.js` — idempotent seed for the 7
vehicle types (Bike/Auto/Mini/Sedan/SUV/Premium/XL) every other module
depends on as a foreign key.

## 2. Why `geography(Point, 4326)`, not `geometry`

Every location column (`vehicles` via `vehicle_locations`, `rides`
pickup/dropoff, `garages`, `vehicle_listings`, `rental_listings`) uses
PostGIS's `geography` type over `geometry`. The difference matters:

- `geometry` treats coordinates as flat Cartesian numbers — distance
  between two points is computed as if the Earth were flat, which is
  wrong (and increasingly wrong the further apart the points are) unless
  you manually reproject into a local planar coordinate system.
- `geography` does distance/area calculations on the sphere and returns
  answers **in meters**, which is exactly what "find garages within
  5km" or "distance to nearest driver" needs, with zero extra
  reprojection code.

Every `geography` column has a **GIST index**. This isn't cosmetic —
verified live via `EXPLAIN`:

```
Index Scan using garages_location_index on garages
  Index Cond: (location && _st_expand(...))
  Order By: (location <-> ...)
```

Without the index, `ST_DWithin` + `<->` nearest-neighbor ordering (the
exact query pattern the Garage/Matching services will use in Phases
9/14) degrades to a full table scan re-computing distance for every row.

## 3. Concurrency-sensitive constraints enforced BY THE DATABASE, not just application code

Two places where "the service will check for this" isn't good enough
on its own, so the schema makes the bad state structurally impossible:

**a) A vehicle can't have two active driver assignments** (spec section
24/25) — a partial unique index:
```sql
CREATE UNIQUE INDEX vehicle_driver_assignments_one_active_per_vehicle
ON vehicle_driver_assignments (vehicle_id) WHERE status = 'ACTIVE';
```

**b) A rental listing can't have two overlapping active bookings**
(spec section 25: "Vehicle RENTED cannot simultaneously be available
for another rental") — a range-overlap EXCLUSION CONSTRAINT using
`btree_gist`:
```sql
ALTER TABLE rental_bookings ADD CONSTRAINT rental_bookings_no_overlap
EXCLUDE USING gist (
  rental_listing_id WITH =,
  tstzrange(start_at, end_at, '[)') WITH &&
) WHERE (status IN ('CONFIRMED', 'ACTIVE'));
```

**Why this matters more than an application-level check:** an
application-level "check for overlap, then insert" has a race condition
— two concurrent requests can both pass the check before either commits
(the exact TOCTOU bug the whole project brief's Section 12 concurrency
section is about, just in a different module). A DB constraint is
checked atomically as part of the write itself; there's no window for
two concurrent transactions to both succeed. This was proven live, not
just asserted:

```
INSERT ... start_at=Sep11 end_at=Sep13 (overlaps existing Sep10-Sep12, CONFIRMED)
→ ERROR: conflicting key value violates exclusion constraint "rental_bookings_no_overlap"

INSERT ... start_at=Sep12 end_at=Sep14 (starts exactly when the first ends)
→ INSERT 0 1   (correctly allowed - adjacent, not overlapping)

INSERT ... same overlapping range, but existing booking is CANCELLED
→ INSERT 0 1   (correctly allowed - cancelled bookings don't hold the vehicle)
```

Ride-acceptance concurrency (spec section 12, "three drivers accept the
same ride") uses a different mechanism — `SELECT ... FOR UPDATE` inside
a transaction — because that scenario isn't a static range-overlap
check, it's "exactly one of N concurrent writers should win," which
`rides.status` + row-level locking handles in the service layer
(Phase 6/9), not a constraint. Different concurrency problems, different
correct tools.

## 4. Why `payments` and `platform_commissions` are polymorphic

`payments.payable_type` + `payable_id` (not four separate
`ride_payments`/`rental_payments`/... tables) because the payment state
machine, provider abstraction, and idempotency requirement (spec
sections 13 & 16) are identical regardless of what's being paid for.
`payable_id` is intentionally **not** a foreign key — it can't be, since
it points at different tables depending on `payable_type` — so that
referential integrity is the PaymentService's job (Phase 12), a standard
and accepted trade-off for polymorphic associations. Same pattern reused
for `audit_logs.entity_type/entity_id`.

## 5. Why earnings tables are an append-only ledger, not a mutable balance

`owner_earnings` / `driver_earnings` / `platform_commissions` insert one
row per earning event; a dashboard SUMs over a date range rather than
reading/writing a running balance column. This is auditable (every
earning traces back to a `source_id`), trivially reconcilable against
payment records, and immune to the classic bug where a mutable balance
silently drifts from reality after one missed update — a real concern
for a system that's supposed to correctly split ride revenue between
driver, vehicle owner, and platform (spec section 24).

## 6. Bug found via live testing: `down()` migration left an orphaned enum type

While proving migrations are actually reversible (not just "have a
`down()` function that looks plausible"), rolling all 8 migrations down
and back up **failed**:
```
ERROR: type "assignment_status" already exists
```
`002_create_vehicle_and_driver_domain`'s `down()` dropped the
`vehicle_driver_assignments` table but never dropped its
`assignment_status` enum type — so a full down→up cycle left a
duplicate-type conflict. Fixed by adding the missing `pgm.dropType()`
call, then verified with a genuinely clean round-trip: 8 migrations
down → table count back to the exact Phase 2 baseline (4 tables, 1 enum
type: `user_role`) → 8 migrations up → back to 36 tables. This is
exactly the kind of bug that only surfaces by actually running the
rollback, not by reading the migration file and assuming it's the
mirror image of `up()`.

## 7. What's intentionally NOT built yet

- No repository/service/controller code touches these tables yet —
  that arrives module-by-module (vehicles: Phase 5, rides: Phase 6,
  garages: Phase 14, marketplace: Phase 15, rentals: Phase 16, earnings:
  Phase 17)
- Ride state machine transition validation (REQUESTED → ... →
  PAYMENT_COMPLETED, rejecting invalid jumps) is enforced by the
  `ride_status` enum only insofar as "must be one of these values" — the
  actual transition graph is Phase 6's `RideStateMachine` service, per
  the Phase 1 layering rule that business rules live in services, not
  the database
- Redis GEO for live driver location (Phase 7/11) — `vehicle_locations`
  in Postgres is explicitly the periodic snapshot, not the hot path

## 8. Test cases delivered this phase

8 new integration tests (`tests/integration/schema.test.ts`), run
against the live database:
- PostGIS extension is installed and reports a version
- Nearby-garage query returns only garages within the radius, correctly
  ordered nearest-first
- That query is confirmed (via `EXPLAIN`) to use the GIST index, not a
  sequential scan
- Overlapping `CONFIRMED` rental bookings on the same listing are
  rejected
- Back-to-back bookings (end of one = start of next) are allowed
- Overlapping a `CANCELLED` booking is allowed
- Invalid ranges (`end_at <= start_at`) are rejected
- Invalid `vehicle_status` enum values are rejected

Combined with Phase 1/2's tests: **41/41 passing.**

Run them:
```
cd backend && npm run migrate:up && npm run seed && npm test
```

## 9. Interview questions this phase should prepare you to answer

1. **Why `geography` over `geometry` for location columns?**
   `geography` computes real-world meters on a sphere automatically;
   `geometry` treats lat/lng as flat Cartesian coordinates, giving
   distances that are wrong (increasingly so at range) unless you
   manually reproject. For "how far is this garage" queries, `geography`
   is correct by default.
2. **Why enforce the rental no-double-booking rule with a database
   exclusion constraint instead of an application-level check?**
   Application checks ("query for overlaps, then insert if none found")
   have a race window: two concurrent requests can both pass the check
   before either commits. An exclusion constraint is evaluated
   atomically as part of the write, so there's no window for two
   overlapping bookings to both succeed — verified live by attempting
   exactly that.
3. **Why is `payments.payable_id` not a foreign key?** Because it
   polymorphically references different tables (`rides`,
   `rental_bookings`, `vehicle_listings`, `service_bookings`) depending
   on `payable_type`, and Postgres foreign keys can only point at one
   table. Referential integrity for it becomes the PaymentService's
   responsibility instead of the database's — a standard trade-off, not
   an oversight.
4. **Why did the migration rollback bug only show up when actually
   testing the rollback, not from reading the code?** `down()` looked
   plausible on inspection — it dropped the table that used the enum.
   But nothing about `up()`/`down()` symmetry is checked by the tool
   itself; a forgotten `dropType()` call is silent until you actually
   run `down()` then `up()` again and hit the duplicate-type error. This
   is the general argument for testing migrations in CI, not just
   trusting them because they compile/apply once.
5. **Why ledger tables (`driver_earnings`) instead of a mutable
   `balance` column on `users`?** A ledger is append-only and auditable
   — every entry traces to a `source_id` (a specific ride or rental) and
   the current balance is always a SUM, computed fresh, so it can never
   silently drift from the sum of its actual sources the way a
   manually-maintained running total can after a missed update.
6. **How would `vehicle_locations` change once Phase 11 (Redis) lands?**
   It already only stores periodic snapshots, not live GPS — the design
   anticipated Redis GEO owning the hot path from the start, so no
   schema change is needed here, only a new write path in the Location
   service that samples from Redis into this table on an interval.
