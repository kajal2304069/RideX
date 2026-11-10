# RideX — Phase 12: Payments

## 1. What we built

A payment system whose one job is: **a payable is charged exactly once, no matter how many times, or how
concurrently, the client asks.**

- `POST /api/payments` with an `Idempotency-Key` header
- A `PaymentProvider` interface with a `MockPaymentProvider` (working) and a `StripePaymentProvider` (stub)
- `PaymentService` driving the state machine `PENDING → PROCESSING → SUCCESS | FAILED`, then `SUCCESS → REFUNDED`
- Wiring into the ride lifecycle: a successful RIDE payment moves the ride `TRIP_COMPLETED → PAYMENT_COMPLETED`
  and emits `ride:payment_completed`
- A new migration: a **partial unique index** so the database itself refuses a second live payment per payable
- Read endpoints (own payments, one payment) and an admin-only refund

## 2. Architecture

```
POST /api/payments  (Idempotency-Key: <key>)
        │
   PaymentsController           thin: reads header + body
        │
   PaymentsService.pay()
        │  withLock("lock:payment:<type>:<id>")          ← layer 2
        ├─ 1. findByIdempotencyKey("<payerId>:<key>")      ← layer 1 (replay → return original)
        ├─ 2. PayableResolver.resolve()                    amount + owner, computed server-side
        ├─ 3. findLiveByPayable()                          fast-path duplicate check
        ├─ 4. INSERT payments (PENDING)                    ← layer 3 (partial unique index → 23505 → 409)
        ├─ 5. PENDING → PROCESSING
        ├─ 6. PaymentProvider.charge(…, idempotencyKey)    provider dedupes too
        └─ 7. PROCESSING → SUCCESS | FAILED
                │ on SUCCESS
        PayableResolver.onSuccess()  →  ridesService.markPaymentCompleted()
```

Dependency direction is one-way: `payments → rides`. The ride module knows nothing about payments, so the
RENTAL, MARKETPLACE and GARAGE_SERVICE payables (Phases 14–16) only need to register a resolver.

### Why a resolver per payable type

The `payments` table is polymorphic (`payable_type` + `payable_id`). A `PayableResolver` answers two
questions for its type: *what is owed, by whom?* (`resolve`) and *what changes once it is paid?*
(`onSuccess`). `PaymentService` stays free of ride/rental/marketplace logic. Unregistered types return 501.

## 3. Database changes

Migration `1725000011_payments_one_live_per_payable.js`:

```sql
CREATE UNIQUE INDEX payments_one_live_per_payable
ON payments (payable_type, payable_id)
WHERE status IN ('PENDING', 'PROCESSING', 'SUCCESS');
```

- At most one *live* payment per payable. This is the guarantee; everything else is a fast path.
- `FAILED` and `REFUNDED` rows are outside the index, so a declined card can be retried and a refunded
  payable can be paid again, while history accumulates.
- The existing `idempotency_key UNIQUE` column is reused. Keys are stored as `<payerId>:<key>`, so two users
  can send the same raw key without colliding and no one can probe another user's keys.

## 4. API

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/payments` | any user | Header `Idempotency-Key` (8–100 chars) required. Body: `payableType`, `payableId`, `paymentMethodToken`. **No `amount` field** (strict schema rejects it). |
| GET | `/api/payments` | any user | Own payment history |
| GET | `/api/payments/:id` | payer or ADMIN | 404 for anyone else |
| POST | `/api/payments/:id/refund` | ADMIN | `SUCCESS → REFUNDED`, once |

Status codes: `201` success, `402` card declined (payment row returned with `FAILED`), `400` bad input or ride
not completed, `404` not found / not yours, `409` already paid or key misuse, `501` payable type not built yet,
`502` provider unreachable.

Mock tokens: `tok_mock_success` (default), `tok_mock_decline`, `tok_mock_funds`, `tok_mock_error` (throws).

## 5. How the guarantees work

### Three layers against double payment

| Layer | Stops | Fails when |
|---|---|---|
| Idempotency key | Client retries of the *same* request | Client sends a *new* key for the same ride |
| Redis lock per payable | Concurrent requests, even with different keys | Lock expires mid-flight, or Redis is down |
| Partial unique index | Everything, at commit time | Never (it is the database) |

Each layer is tested alone. The concurrency suite fires 10 simultaneous requests at a 100 ms-latency provider:

- same key → 10 × `201`, one payment id, **one provider charge**
- different keys → exactly one `201`, nine `409`, one charge
- lock bypassed (straight to the repository) → one insert wins, nine fail with `23505`

I also dropped the index and confirmed the DB-guarantee tests fail, then restored it.

### The unknown-outcome problem

If `charge()` throws (timeout, connection reset), we do not know whether the money moved. Marking the payment
`FAILED` would invite a retry under a new key and a possible double charge. So we:

1. leave the payment `PROCESSING` and return `502`,
2. keep it in the unique index, so a new key gets `409`,
3. let a retry with the **same** key re-drive it: `settle()` calls the provider again with the same idempotency
   key, which a real gateway deduplicates.

A *decline* is different: the provider told us definitively, so it is `FAILED` and retryable.

### Server-side amount

The client never supplies the amount. For a RIDE it is `ride_fares.total_fare`, saved when the driver completed
the trip. A tampered request cannot underpay.

### Optimistic transitions

Every payment status change is `UPDATE … WHERE id = $1 AND status = ANY($from)`. A stale writer cannot turn a
`SUCCESS` into a `FAILED`. The ride's `TRIP_COMPLETED → PAYMENT_COMPLETED` uses the same pattern
(`updateStatusIfCurrently`) and is idempotent, so replaying a paid request re-runs the follow-up safely if it
failed the first time.

### Card data

RideX never receives a card number. The client tokenizes with the gateway's SDK and sends only
`paymentMethodToken`; we store only the provider's opaque `provider_reference`.

## 6. Known gaps (deliberate, for later phases)

- **No webhooks.** Real gateways confirm asynchronously (3-D Secure, bank transfers). A `PROCESSING` payment
  would be finalized by a signed webhook, and a reconciliation job would sweep stale `PROCESSING` rows. The
  job needs a provider "look up charge" call, so it lands with the real Stripe integration (BullMQ itself arrived in Phase 13).
- **Refunds don't revert the ride.** `PAYMENT_COMPLETED` is terminal in the state machine; a refund only
  changes the payment. Partial refunds are not modelled.
- **Stripe is a stub.** The interface and the failure mapping rules are documented in the file.
- **No payout to drivers/owners yet.** Split of the fare is Phase 17.
- **Provider call happens while holding the lock.** TTL is 15 s. A very slow provider could outlast it, which
  is exactly the case the unique index covers.

## 7. Test cases

Unit (`paymentsService.test.ts`, 20): provider determinism and decline/error paths; amount from the resolver;
short-key rejection; replayed key; key reused for another payable; non-payer gets 404; live payment under another
key; 23505 mapped to the winner and to 409; decline does not trigger `onSuccess`; provider error leaves
`PROCESSING` and writes no terminal state; re-drive on retry; SUCCESS replay re-runs follow-up; refund happy path,
non-SUCCESS, and lost race; read access rules.

Integration (`payments.test.ts`, 20): full ride → pay → `PAYMENT_COMPLETED`; amount equals saved fare; client
`amount` rejected; missing header; unauthenticated; unfinished ride; someone else's ride; unknown ride; 501 for
RENTAL; replay; second key on paid ride; key reuse across rides; per-payer key namespace; decline then retry;
provider error then same-key retry; stuck `PROCESSING` blocks a new key; read rules; refund once and non-admin;
index rejects a second live row but allows `FAILED`.

Concurrency (`paymentIdempotency.test.ts`, 3): described above.

Full suite: **262 passing** (219 before this phase).

## 8. Interview questions

**What does idempotency mean here, and why is it not enough alone?**
Repeating a request has the same effect as sending it once. The key handles retries of one request. It cannot
help when a user taps "Pay" on two devices with two different keys, which is why the per-payable lock and the
unique index exist.

**Why a partial unique index rather than a plain one?**
A plain unique on `(payable_type, payable_id)` would forbid a second row after a decline, so no retry and no
history. Partial restricts the rule to live states.

**Why keep the payment `PROCESSING` when the provider call throws?**
The outcome is unknown. `FAILED` is a claim that no money moved; we cannot make it. Leaving it live blocks
other keys and lets the same key finish it.

**What if the lock expires while the provider is still charging?**
A second request could acquire the lock, but its INSERT hits the unique index (live row exists) and becomes a
409, or returns the winner's payment if the key matches. No second charge.

**What if Redis is down?**
`withLock` throws and the request fails closed (5xx). Payments are the wrong place to fail open. The index
would still protect us if we chose to proceed without the lock.

**What if the process crashes between the provider charging and writing `SUCCESS`?**
The row is `PROCESSING`. The client retries with the same key; the provider dedupes on the idempotency key
and returns the original charge; we write `SUCCESS`. A reconciliation job should also sweep old `PROCESSING`
rows (a BullMQ repeatable job, once the real provider exists).

**What if the process crashes after `SUCCESS` but before the ride is updated?**
Payment is `SUCCESS`, ride is `TRIP_COMPLETED`. Replaying the request re-runs `onSuccess`, which is idempotent.
A sweeper could repair it without any client.

**Why not wrap payment + ride update in one DB transaction?**
We cannot: the provider call is outside the database, and holding a transaction open across a network call is
a bad idea. We use a saga-like sequence of idempotent steps instead.

**Why compute the amount on the server?**
Never trust the client with money. The strict schema rejects an `amount` field outright.

**Why return 404 instead of 403 for another user's ride?**
403 confirms the resource exists. 404 reveals nothing.

**Why is the provider behind an interface?**
Swapping gateways is a one-file change, and tests can inject a slow or failing provider.

**Alternatives?**
Database-only: `SELECT … FOR UPDATE` on the ride row instead of a Redis lock, which removes the Redis
dependency but holds a DB connection longer. Outbox pattern: write "charge requested" in the same transaction
as the payment row and let a worker call the provider, which gives at-least-once with no request-time provider
call. Event sourcing for payments is overkill here.

**Bottleneck and scale?**
The lock is per payable, so unrelated payments never contend. The provider's latency dominates. At scale move
the charge to a queue worker (outbox), accept asynchronously (`202`), and finalize via webhook.

**Microservice extraction?**
`payments` already depends on rides only through the resolver interface and `ridesService.markPaymentCompleted`.
Extraction means replacing that call with an event (`payment.succeeded`) consumed by rides, and the resolver's
`resolve()` with a synchronous API call or a replicated read model. The payments table and unique index move
with the service.

**How would you test the race?**
Slow the provider so many requests are in flight at once, fire them with `Promise.all`, and assert on the
provider's call count and the row count, not just on HTTP status codes. Then remove each protection in turn
and make sure some test fails.
