# RideX — Phase 17: Owner → driver earnings

## 1. What we built

The business loop from the brief: an **owner** puts a vehicle to work, a **driver** drives it for RideX rides, the **rider pays**, and
the fare is split **platform / owner / driver**. Rentals pay the owner too. Everyone gets a dashboard and can withdraw.
The point of the phase: **every rupee paid is accounted for exactly once, and no money can be created, lost or double-paid** — under
retries, crashes and concurrent requests.

- **Ride settlement**: when a ride's payment succeeds, the fare is split and written to the ledgers.
- **Rental settlement**: when the owner marks a rental returned, rent + late fee (less commission) + damage compensation goes to the owner.
- **Deposit refund**: the refundable part of the deposit is paid back to the renter as a *partial refund* of the original charge.
- **Dashboards**: owner (ride share, rental revenue, maintenance cost, net, per vehicle), driver (fares, bonuses, balance), platform (commission by source, admin only).
- **Ledger listing**: keyset-paginated, newest first.
- **Withdrawals**: one wallet per user (owner + driver earnings − withdrawals), idempotent, race-safe.
- **Reconcile**: an admin-triggered (and job-ready) sweep that repairs anything left half-done.

## 2. The money rules (`earningsSplit.ts`, pure)

Ride fare `F`, platform rate `p`, owner share `s` (of what is *left after* the platform):

```
platform = round(F × p)          owner = round((F − platform) × s)          driver = F − platform − owner
```

`vehicle_driver_assignments.commission_percent` is **the platform's rate** for that agreement and `owner_share_percent` is **the owner's
share of the post-commission fare** (so 20 / 80 means platform 20 %, owner 80 % of the remaining 80 %, driver the last 20 % of it).
With no owner agreement the platform rate is `PLATFORM_COMMISSION_PERCENT` (20) and the driver keeps the rest. A driver who *is* the
owner has no owner row.

Rental: `platform = round((rent + lateFee) × RENTAL_COMMISSION_PERCENT)`, `owner = rent + lateFee − platform + damage`. Damage is compensation
for the owner's property, so it is commission-free. The refundable deposit never enters the split.

**Invariant (unit-tested on 30,000 random inputs):** `platform + owner + driver == fare` and `platform + owner == rent + lateFee + damage`, to the paisa.
Everything is integer **paise**, percentages are **basis points**, rounding is half-up on one side and the remainder goes to the other — that is
what makes the sum exact (no `0.1 + 0.2` drift).

The agreement used is the one in force **when the ride was accepted**, not when it was paid, so ending an agreement afterwards cannot rewrite a past ride.

## 3. Database (`1725000017_earnings_integrity.js`, reversible)

| Change | Why |
|---|---|
| `UNIQUE (source_type, source_id)` on `owner_earnings` and `platform_commissions` | one settlement per source, enforced by the database |
| partial `UNIQUE (ride_id) WHERE type='RIDE_FARE'` on `driver_earnings` | a ride pays its driver once |
| `CHECK amount >= 0` (driver `ADJUSTMENT` may be negative) | no negative fares |
| `owner_earnings.vehicle_id, driver_id` | per-vehicle dashboard is one `GROUP BY` |
| new `payouts` table (`kind`, `status`, `idempotency_key UNIQUE`) | money leaving the platform |
| partial `UNIQUE (source_id) WHERE kind='DEPOSIT_REFUND'` | one deposit refund per booking, ever |
| `CHECK` tying `kind` to `source_type/source_id` | a withdrawal has no source, a refund must have one |

The ledgers stay **append-only** (Phase 3 decision): the balance is *computed* (`Σ earnings − Σ live withdrawals`), never stored, so it cannot drift.

## 4. Concurrency and failure design

| Threat | Defence |
|---|---|
| Settlement runs twice (payment retry, reconcile, race) | the `platform_commissions` row is a **gate**: `INSERT … ON CONFLICT DO NOTHING RETURNING`. Exactly one caller gets a row back and writes owner + driver rows **in the same transaction**; everyone else writes nothing |
| Half-settled ride (crash between inserts) | all three rows are one transaction: all or nothing |
| Settlement fails after the rider paid | caught and logged; the payment still returns 201 (the money moved). `reconcile()` finds paid rides with no commission row and settles them. A replayed payment also re-runs settlement |
| Two withdrawals overdraw the balance | the reservation runs in a transaction that locks the user row `FOR UPDATE`; the second one computes its balance *after* the first one's row exists |
| Client retries a withdrawal | idempotency key (namespaced `<userId>:<key>`) returns the same payout; same key + different amount → 409 |
| Payout provider times out | payout stays `PENDING` and the money stays **reserved** (outcome unknown); retrying with the same key finishes it. Only an explicit rejection (`FAILED`) releases the money |
| Deposit refund provider outage | the return still succeeds, the owner is still paid; the payout stays `PENDING`; reconcile retries it |
| Refund paid twice | one payout row per booking (unique index) + a lock + a guarded `PENDING/FAILED → PAID` transition |

## 5. API

| Method | Path | Who |
|---|---|---|
| GET | `/api/earnings/owner/summary?from&to` | VEHICLE_OWNER |
| GET | `/api/earnings/owner/entries?limit&cursor` | VEHICLE_OWNER |
| GET | `/api/earnings/driver/summary?from&to` | DRIVER |
| GET | `/api/earnings/driver/entries?limit&cursor` | DRIVER |
| GET | `/api/earnings/platform?from&to` | ADMIN |
| GET | `/api/earnings/balance` | any user |
| POST | `/api/earnings/payouts` (`Idempotency-Key` header, body `{amount?}`) | any user |
| GET | `/api/earnings/payouts` | any user |
| POST | `/api/earnings/reconcile` | ADMIN |

The client never sends a balance, a user id or a split — the schema is `.strict()`.

## 6. Tests (new: 44; whole suite 607)

- `tests/unit/earningsSplit.test.ts` — the split rules, extremes, rounding, the sum invariant on random inputs.
- `tests/integration/earnings.test.ts` — ride split, idempotency, **8 concurrent settlements**, no-agreement and ended-agreement cases,
  settlement failure + reconcile, DB constraints, rental split (on-time, late + damage, deposit fully consumed), refund idempotency and outage,
  dashboards, date ranges, role gates, pagination, withdrawals (default/partial/idempotent/namespaced/validation/declined/unknown outcome),
  **6 concurrent withdrawals**, **6 concurrent identical requests**.

Mutation checks (each made the right tests fail, then was restored): removing the `FOR UPDATE` lock, ignoring the settlement gate, charging commission on damage.

## 7. Known gaps

- The payout provider is a mock; a real one (Razorpay X / Stripe Connect) needs bank-account onboarding (KYC), which is not built.
- The deposit refund uses `PaymentProvider.refund(reference, amount)`, which has no idempotency key; a real gateway call should pass one.
- No tax/TDS handling, no payout schedule or holding period, no clawback when a ride fare is later refunded.
- Marketplace sales and garage payments do not pay out to a seller / garage yet (only the commission table supports them).
- `reconcile` is a manual admin call; a repeatable BullMQ job would run it automatically (planned with Phase 21 observability).
- Maintenance cost is informational (it reduces "net earnings" on the dashboard) and is not deducted from the withdrawable balance.

## 8. Interview Q&A

1. **Why a ledger and not a `balance` column?** Auditable, replayable, and it cannot drift after a missed update. The cost is a `SUM`, which an index on `(owner_id, created_at)` keeps cheap; at scale you add a periodically-materialised balance *derived from* the ledger.
2. **Why integer paise and basis points?** Floating point cannot represent 0.1 exactly. With integers the invariant `parts == total` is provable, not hoped for.
3. **Why does the commission row gate the whole settlement?** A unique index makes "exactly once" a database fact. Application checks (`if not settled`) race; `ON CONFLICT DO NOTHING RETURNING` does not.
4. **A payment succeeds but settlement throws — what now?** The rider's payment is real, so we do not fail it. Settlement is idempotent and repairable: replaying the payment or running reconcile completes it. The invariant "paid ride ⇒ eventually one ledger set" is restored by a sweep, not by hoping nothing fails.
5. **How do two simultaneous withdrawals not overdraw?** The reservation locks the user row, so the second transaction sees the first's reservation when it computes the balance. Without the lock both read the same balance (a classic lost update); a test proves it.
6. **Why leave a timed-out payout PENDING instead of FAILED?** FAILED releases the money. If the transfer actually went through, the user could withdraw it again. Unknown outcome ⇒ keep it reserved and retry with the same idempotency key.
7. **Why use the agreement at accept time?** Terms are a contract for the work done. Using "whatever is active now" lets a later change rewrite history.
8. **Microservice extraction?** Earnings becomes a *consumer* of `RidePaid` / `RentalReturned` events. The commission-row gate becomes the consumer's dedupe key, which is what makes at-least-once delivery safe. Reconcile becomes the outbox/replay mechanism.
9. **Bottleneck at scale?** The user-row lock serialises one user's withdrawals (fine — humans) but not different users. Dashboard `SUM`s grow with history → materialised daily rollups and a read replica.
