# RideX — Phase 16: Vehicle rental

## 1. What we built

Owners rent their vehicles out by the hour or day. The point of the phase: **a vehicle can never be double-booked,
a renter is never charged for dates that are already gone, and money and vehicle state never disagree** —
under concurrent requests, retries, timers and crashes.

- **Listings** (VEHICLE_OWNER): list a vehicle you own with hourly and/or daily price, deposit, pickup point, rules; edit, hide/show.
- **Search** (public): text, vehicle type, fuel, transmission, daily-price range, radius (PostGIS), **availability window**; sort newest / price / distance; keyset pagination.
- **Quote + calendar** (public): exact price and availability for a window; blocked ranges with no renter details.
- **Bookings** (RIDER): create a booking that **holds** the vehicle for 15 minutes while the renter pays.
- **Payment**: through the Phase 12 system (`RENTAL` payable) — rent + security deposit, server-priced.
- **Lifecycle**: `PENDING_PAYMENT → CONFIRMED → ACTIVE → COMPLETED`, plus `CANCELLED` and `EXPIRED`.
- **Handover / return** (owner): handover flips the **vehicle** to `RENTED`; return computes late fee, applies damage claim, records the deposit refund due, frees the vehicle.
- **Cancellation with refund policy**, delayed-job expiry of unpaid holds, notifications (RENTAL_BOOKED / CONFIRMED / STARTED / COMPLETED / CANCELLED / EXPIRED).

## 2. Architecture

```
routes → controllers → services → repositories                       (modules/rentals)
  rentalListings.service   rentalBookings.service
  rentalPricing (pure)  rentalRules (pure)  rentalStateMachine (pure)

payments ──RENTAL resolver──▶ rentalBookings.confirmAfterPayment()   payments → rentals (one-way)
rentalBookings ──▶ rentalQueue (delayed expire-booking job) ──▶ rentalWorker ──▶ expireIfDue()
rentalBookings ──(lazy import)──▶ paymentsService.refund()           (lazy: avoids an import cycle)
handover/return ──one DB transaction──▶ vehicles.status (AVAILABLE ⇄ RENTED)
```

Booking state machine:

```
PENDING_PAYMENT --pay--> CONFIRMED --handover--> ACTIVE --return--> COMPLETED
      |  \                    |
      |   +--deadline--> EXPIRED
      +--cancel--> CANCELLED <--cancel--+
```
`COMPLETED`, `CANCELLED`, `EXPIRED` are terminal. An `ACTIVE` rental cannot be cancelled: the vehicle is out, so it ends with the return.

## 3. Database changes (migration `1725000016_rental_integrity`)

| Change | Guarantee |
|---|---|
| Exclusion constraint now covers `PENDING_PAYMENT`, `CONFIRMED`, `ACTIVE` (`tstzrange(start,end,'[)')` on the same listing) | no two bookings can hold the vehicle at the same time, whatever the app does |
| `rental_booking_status` += `EXPIRED` | an unpaid hold that lapsed |
| Booking columns: `payment_due_at`, `confirmed_at`, `started_at`, `cancelled_at/by`, `hourly_rate_at_booking`, `late_fee`, `damage_deduction`, `deposit_refund_due`, `refund_amount`, `return_notes` | audit + settlement |
| CHECKs: duration 1 h–30 days (for valid ranges), amounts ≥ 0, deductions ≤ deposit, `cancelled_by` ∈ RENTER/OWNER/SYSTEM | bad data cannot be stored |
| Listing CHECKs: at least one price, prices > 0, deposit ≥ 0 | |
| `UNIQUE (vehicles.id, owner_id)` + composite FK `rental_listings (vehicle_id, owner_id)` | **only the owner can list a vehicle**, enforced by the database |
| Partial indexes: pending holds by deadline; active listings by `created_at` | expiry sweeps and browse stay cheap |

The migration is reversible (the enum value is the one thing Postgres cannot drop).

## 4. API (`/api/rentals`)

| Method | Path | Who |
|---|---|---|
| GET | `/listings` | public (search) |
| POST | `/listings` | VEHICLE_OWNER |
| GET | `/listings/mine` | owner |
| GET | `/listings/:id` | public if active; owner/admin otherwise (404 for others) |
| PATCH | `/listings/:id` | owner |
| POST | `/listings/:id/activate` · `/deactivate` | owner |
| GET | `/listings/:id/quote?startAt&endAt` | public |
| GET | `/listings/:id/availability?from&to` | public (blocked ranges only) |
| POST | `/listings/:id/bookings` | RIDER — body `{startAt, endAt, idempotencyKey}` (no price fields) |
| GET | `/listings/:id/bookings` · `/bookings/incoming?listingId=` | owner |
| GET | `/bookings/mine` | RIDER |
| GET | `/bookings/:id` | renter, owner, admin (404 for others) |
| POST | `/bookings/:id/cancel` | renter or owner |
| POST | `/bookings/:id/start` · `/complete` | owner |
| POST | `/api/payments` | `payableType: RENTAL`, `payableId: <bookingId>` |

Codes: `201` created, `200` idempotent replay, `400` validation / rule, `402` card declined, `404` missing **or not yours**, `409` conflict or lost race, `502` provider unreachable.

## 5. How the guarantees work

**Pricing (pure, integer paise).** Time is billed in whole hours, rounded up. Hourly only: `hours × hourly`. Daily only: `ceil(hours/24) × daily`. Both: `days × daily + min(remaining × hourly, daily)` — 23 hours never costs more than a day. Late hours cost `hourly × 1.5` after a 15-minute grace. Money is converted to paise at the edges so `0.1 + 0.2` can never reach a charge. The price is **frozen on the booking** when it is created; later price edits do not change it.

**No double booking.** The booking `INSERT` is the only step that takes the vehicle, and the exclusion constraint rejects an overlap (`23P01`) atomically. There is no check-then-insert window. The app's own check is only for a friendly message. Ranges are half-open, so back-to-back bookings (one ends exactly when the next starts) are legal.

**Why a hold at booking time, not at payment time.** If only paid bookings held the vehicle, two renters could both reach the payment screen and the slower one would be charged for a vehicle that is gone (then needing a refund). Holding moves the conflict to the cheap step (creating the booking) instead of the expensive one (taking money). The cost: unpaid holds must expire.

**Hold expiry (three safeguards).** (1) A delayed BullMQ job `expire-booking__<id>`; (2) the payment resolver refuses a lapsed hold and expires it inline, so a lost job cannot make a stale hold payable; (3) a new booking first expires stale holds on that listing, so a lost job cannot block other renters. Correctness never depends on the timer — it only makes expiry timely.

**Payment vs expiry vs cancel.** All three take `lock:payment:RENTAL:<id>` (the same key `PaymentService` uses). Expiry and cancel re-check under the lock and **refuse while a live payment exists**, so a renter who is mid-payment can never lose the vehicle to the timer. The resolver runs inside that lock, so it expires inline instead of calling the locking path (a self-deadlock otherwise). Tested invariants: never `SUCCESS` payment + `EXPIRED` booking; after a pay/cancel race, either confirmed + paid, or cancelled with the payment refunded.

**Refund policy (CONFIRMED booking).** Owner cancels: full refund. Renter cancels ≥ 24 h before start: full refund. Later: nothing. The booking is marked `CANCELLED` (with `refund_amount`) **first**, then the payment is refunded; if the refund call fails, calling cancel again finishes it (idempotent: nothing is refunded twice). A payment that somehow lands on a dead booking is refunded automatically.

**Vehicle state ties rental to ride-hailing.** Handover moves booking `CONFIRMED → ACTIVE` **and** vehicle `AVAILABLE → RENTED` in one transaction (both are guarded `UPDATE … WHERE status = …`). A vehicle that is in ride service, in maintenance or already rented cannot be handed over, and a rented vehicle cannot be picked up by a ride, because ride acceptance only moves a vehicle that is `AVAILABLE` (Phase 6/9 guard). Return moves both back in one transaction.

**Deposit.** Rent + deposit are charged together. At return: `late fee` (server-computed from the real return time and the rate the renter booked at) + the owner's damage claim are deducted, **capped at the deposit** (a claim above the deposit is rejected). The remainder is recorded as `deposit_refund_due`.

**Search availability filter.** Uses the same predicate as the constraint, except a `PENDING_PAYMENT` hold only counts while its deadline has not passed.

## 6. Known gaps

- **Deposit refund and owner payout:** recorded here, paid in Phase 17 (`docs/PHASE_17_EARNINGS.md`): the deposit comes back as a partial refund and the owner's share is written to the earnings ledger.
- **A late fee larger than the deposit** is recorded in full but only the deposit is recoverable; collecting the rest is out of scope.
- **No-shows:** a CONFIRMED booking that is never handed over simply stays CONFIRMED after its window; nothing auto-cancels it.
- **Cancelling inside 24 h forfeits the payment** to the platform/owner; a graduated policy would need partial refunds.
- **No driver/licence verification, mileage or fuel tracking, photos at handover, or insurance.**
- A rental-specific test of "a rented vehicle cannot be taken by a ride" relies on the existing ride guard; there is no end-to-end test through the ride flow.

## 7. Test cases (rental: 20 + 47 + 9 + 12 = 88; full suite 563)

- **Listings/search (20):** create + validation + role + ownership (incl. DB composite FK and CHECKs); edit, one price removable but not both; hide/show visibility matrix; filters (price incl. hourly-only, text, LIKE-escaping), near + distance sort, availability window incl. lapsed holds, keyset pagination under concurrent inserts and mismatched cursors; exact quotes; availability calendar leaks no renter data.
- **Bookings (47):** priced hold + deadline + delayed job; every window rule; price frozen after edits; overlaps (identical, partial, inside, surrounding), adjacency allowed, other listing allowed, cancelled/expired free dates, lapsed hold cleared lazily, live hold not cleared; DB exclusion + CHECKs with the app bypassed; idempotency (replay 200, same key different dates, per-renter namespace, replay after payment); payment (amount, stranger 404, double pay, decline-then-retry, cancelled, lapsed hold with nothing charged); expiry (not due, idempotent, grace, in-flight payment protected, confirmed untouched, **real worker**); cancel (unpaid, ≥24 h refund, <24 h forfeit, owner full refund, no double refund, failed-refund completion, strangers, in-flight payment, payment on a dead booking refunded); handover (early limit, ended, status, busy vehicle leaves booking CONFIRMED, roles, active cannot cancel); return (on time, grace, late fee, snapshot rate, damage claim, zero floor, caps and rejections, roles); read access and lists.
- **Concurrency (9):** 8 renters same dates → 1×201; 8 identical requests → 1 booking; 10 staggered overlapping windows → no overlapping holds; 10 simultaneous payments; payment vs expiry; payment vs cancel; handover vs cancel; duplicate handovers/returns; back-to-back vehicle exclusivity.
- **Unit (12):** pricing (all three modes, rounding, awkward decimals, paise), late fee boundaries, deposit settlement, state machine over every status pair, window rules, refund policy boundaries.
- **Mutation checks:** dropping the exclusion constraint fails the overlap and race tests; removing the in-flight-payment guard from expiry fails its test. Both restored. The old Phase 3 test for an inverted range exposed that my duration CHECK shadowed `rental_bookings_valid_range`; the CHECK now only judges well-formed ranges.

## 8. Interview questions

**How do you prevent double booking?** An exclusion constraint on `(listing, tstzrange)` — a unique index generalised to "no overlap". The insert is atomic, so there is no check-then-act race. Application checks are only for good error messages.

**Why not `SELECT … FOR UPDATE` on the listing, or a Redis lock?** A lock only protects code that takes it. The constraint protects the data from every writer, including future code, scripts and admin SQL. Locks are still used where the critical section spans a provider call (payment).

**Why half-open ranges `[start, end)`?** Back-to-back rentals are legitimate; with closed ranges a rental ending at 10:00 would block one starting at 10:00.

**Why hold the vehicle during payment, and what does it cost?** It avoids charging someone for dates that were just taken (a refund-and-apology flow). The cost is holds that must expire; handled with a delayed job, an inline check at payment, and lazy cleanup on the next booking.

**What if the delayed job is lost?** Nothing breaks: the payment path refuses a lapsed hold and the next booking attempt clears it. The job only improves timeliness.

**Why does expiry skip a booking that has a payment in flight?** A `PROCESSING` charge (provider timeout) has an unknown outcome. Expiring the booking could free the vehicle for someone else while the first renter is charged.

**Why mark the booking CANCELLED before refunding?** Refunding first and then losing the guarded update (the booking started in between) would refund a rental that is happening. Cancelling first is safe, and a failed refund is retried by calling cancel again.

**Why tie handover to the vehicle's own state machine?** The vehicle is a shared resource between ride-hailing and rental. One transaction moves booking and vehicle together, and the existing guarded transitions mean a rented vehicle can't take rides and a vehicle on a ride can't be handed over.

**Why snapshot the hourly rate on the booking?** The late-fee rate must be the one the renter agreed to, not whatever the owner set later.

**Why floats are dangerous for money here, and what do you do?** `0.1 + 0.2 ≠ 0.3`. Money is converted to integer paise before any arithmetic and back at the edge; DB columns are `numeric(10,2)`.

**Bottleneck / scale?** A hot listing serialises on its constraint index; fine, since bookings per vehicle are rare. Search is the load: GIST for location, partial indexes for browse, then a search engine for availability+geo ranking. Read replicas for browse and calendars.

**Microservice extraction?** `payments` reaches rentals only via the resolver interface; replace `confirmAfterPayment` with a `payment.succeeded` event and the resolver's `resolve()` with an API call. The refund call (lazy import today) becomes a command to the payments service. The vehicle-state transaction is the hard part: it would become a saga with compensation.

**Failure modes?** Crash after payment before CONFIRMED: replaying the payment re-runs the idempotent confirm. Crash after CANCELLED before refund: cancel again. Redis down: payment/cancel/expiry fail closed; the exclusion constraint still protects bookings.

**Duplicates and retries?** Booking: idempotency key (namespaced per renter) + the constraint (23P01/23505 → look up and replay). Payments: Phase 12 layers. Jobs: deterministic `jobId`. Handover/return: guarded `UPDATE … WHERE status`.
