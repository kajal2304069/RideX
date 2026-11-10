# RideX — Phase 18: Admin dashboard

## 1. What we built

The operator's console: see the whole platform, act on it, and be able to prove afterwards **who did what**. The backend for the
dashboard's Users, Drivers, Vehicles, Rides, Rentals, Marketplace, Garages, Payments, Revenue, Analytics and System Health pages
(the React screens come with the frontend phase; the frontend is still a scaffold).

- **Access:** every `/api/admin/*` and `/api/analytics/*` route sits behind one `router.use(authenticate, authorize("ADMIN"))` — a new route cannot forget the gate.
- **Users:** search/filter/paginate (no secret columns ever returned), detail with activity counts and balance, **deactivate / activate**, **grant / revoke roles**.
- **Operational lists:** drivers, vehicles, rides, rentals, payments — display-ready rows, filters, keyset pagination.
- **Moderation:** remove / restore marketplace listings; deactivate / activate garages (an inactive garage vanishes from public search).
- **Audit log:** append-only, filterable. Existing admin actions (driver verification, payment refund, earnings reconcile) now write to it too.
- **Analytics:** overview, zero-filled time series (`rides`, `completed_rides`, `signups`, `gmv`, `commission` by hour/day/week), revenue (collected vs kept vs owed), leaderboards.
- **System health:** Postgres/Redis latency, pool saturation, per-queue backlog and failures, websocket clients, and **business invariants** (stuck payments, paid rides without an earnings split, overdue rental holds, stuck payouts, unpaid deposit refunds).

## 2. Architecture

```
routes ─ authenticate + authorize(ADMIN) ─▶ controllers ─▶ services ─▶ repositories     (modules/admin, modules/analytics)
adminUsers.service ─ one transaction: lock admins FOR UPDATE → lock target → change → audit row ─▶ commit
                   └ after commit: Redis revocation keys + driver offline + socket disconnect
authenticate / websocket handshake ─▶ common/tokenRevocation (one Redis MGET)
systemHealth.service ─▶ pg, redis, BullMQ queues, analyticsRepository.healthCounters (one query)
```

## 3. Decisions worth defending

**Instant revocation without a DB hit per request.** Access tokens are stateless JWTs (15 min). A deactivated user must be locked out *now*.
Two small Redis keys do it: `auth:deactivated:<id>` (reject all) and `auth:valid-after:<id>` (reject tokens issued before this second — used after a role
change so the client refreshes and gets the new roles). Durable truth stays in Postgres (`is_active`, `roles`); login and refresh read it there.
Both keys expire after an access token's lifetime. **Fail open** if Redis is down: rejecting everyone would turn a cache outage into a total outage, and the exposure is bounded by 15 minutes (documented trade-off). Deactivation also revokes refresh tokens, takes a driver offline and disconnects their sockets.

**The audit row is part of the change.** For admin mutations the audit insert is *inside* the same transaction: if it cannot be written, the change does not happen
(a test proves a failed action leaves no audit row). For actions that already committed in another module (refund, verification) `recordAfter` logs loudly instead of turning a success into an error.

**Audit is append-only in the database.** A trigger refuses `UPDATE`/`DELETE` (SQLSTATE 42501). The one allowed exception is the foreign key's own `ON DELETE SET NULL`,
so deleting a user keeps their audit rows with `actor_id = NULL` instead of being blocked. An audit trail the application can edit is not evidence.

**Never lock the platform out of itself.** Role changes and deactivations take `SELECT … FOR UPDATE` on **all admin rows** (ordered by id, so no deadlocks), then the target.
Rules inside that lock: you cannot deactivate yourself or change your own ADMIN role; the last *active* admin can never be removed or deactivated; a deactivated account cannot be promoted;
a user always keeps ≥ 1 role; the acting admin must *still* be an active admin when the lock is held (they may have been demoted a moment ago).
Without the lock, two admins removing each other at the same instant would each see "the other is still an admin" and leave **zero** admins — the concurrency test fails if the lock is removed.

**Moderation reuses the owning module's transaction.** Removing a listing uses the seller's delist transaction (same row lock), so it cannot race an accepted offer; it is refused while a buyer holds an accepted reservation. A removed listing cannot be relisted by the seller (`removed_by_admin_at`).

**Health distinguishes `down` from `degraded`.** `down` = Postgres or Redis unreachable. `degraded` = reachable but an invariant is violated (e.g. a paid ride with no earnings split — the Phase 17 reconcile did not run).
Each check has a 2 s deadline so a hung dependency shows as "down" instead of hanging the page. Invariants have a 5-minute grace so a payment in flight is not a false alarm.

**Search treats `%` and `_` literally** (escaped `LIKE`), so a search box cannot be used for wildcard scans. Charts are bounded: at most 500 buckets per request, and empty days are zero-filled so the line does not skip.

## 4. Database (`1725000018_admin_audit.js`, reversible)

`audit_logs` gets `ip_address`, two indexes (`actor_id,created_at`, `action,created_at`) and the append-only trigger. `users` gets `deactivated_at/reason` with
`CHECK (is_active OR deactivated_at IS NOT NULL)`. `vehicle_listings` gets `removed_by_admin_at/removed_reason`.

**Bug found while testing reversibility:** after `down` then `up`, the migration failed on any database that already had a deactivated user, because the new CHECK rejected existing rows with no timestamp.
Fixed by backfilling `deactivated_at` from `updated_at` before adding the constraint.

## 5. API

| Area | Endpoints |
|---|---|
| Users | `GET /api/admin/users`, `GET …/users/:id`, `POST …/users/:id/deactivate`, `…/activate`, `…/roles` |
| Lists | `GET /api/admin/drivers`, `/vehicles`, `/rides`, `/rentals`, `/payments` |
| Moderation | `GET /api/admin/listings`, `POST …/listings/:id/remove`, `…/restore`; `GET /api/admin/garages`, `POST …/garages/:id/deactivate`, `…/activate` |
| Accountability | `GET /api/admin/audit-logs`, `GET /api/admin/system/health` |
| Analytics | `GET /api/analytics/overview`, `/timeseries`, `/revenue`, `/leaderboards` |

Every mutation requires a non-empty `reason`, recorded with the actor, IP and before/after state.

## 6. Tests (new: 73; whole suite 680)

`tests/integration/admin.test.ts` (access control, users, deactivation, roles, audit, lists, moderation), `tests/integration/analytics.test.ts` (overview, time series, revenue, leaderboards, health),
`tests/unit/adminRules.test.ts` (admin-survival rule, range/bucket rules, LIKE escaping, cursors).

Mutation checks (each made the right tests fail, then was restored): removing the `FOR UPDATE` on admins, skipping the token-revocation check, dropping the audit trigger.

## 7. Known gaps

- Revocation relies on Redis; with Redis down, a deactivated user's existing access token works for ≤ 15 minutes (fail-open, deliberate).
- No two-person approval for destructive actions, no admin 2FA, no admin IP allow-list.
- Role grants do not validate that the role makes sense (a user can be made GARAGE_OWNER without owning a garage).
- Analytics queries run on the primary; at scale they belong on a read replica or on pre-aggregated daily rollups.
- Health is pull-only: nothing alerts a human yet (Phase 21).
- Chat/support moderation and ticket handling are not built (the `support` module is still empty).

## 8. Interview Q&A

1. **How do you disable a user instantly with stateless JWTs?** A tiny Redis denylist checked on every request (`MGET`, no DB hit), with a TTL equal to the token lifetime. Durable state in Postgres; Redis is an accelerator, and we chose fail-open and wrote down why.
2. **Why `FOR UPDATE` on all admin rows?** To make "at least one admin remains" a serialised decision. Two concurrent demotions otherwise read the same snapshot (write skew), each conclude another admin exists, and both commit.
3. **Why is the audit insert inside the transaction?** Change and evidence must be atomic: no change without a record, no record of a change that rolled back.
4. **Why a trigger for append-only?** Application discipline is not a guarantee; the database enforces it even against a bug or a compromised session. Carve-out for the FK's `SET NULL` keeps user deletion working.
5. **`degraded` vs `down`?** Different operator responses: down = page someone now; degraded = a repair path is lagging, fix soon. Invariants catch failures that no dependency check can see.
6. **What if an admin account is stolen?** Blast radius: every action is audited with IP; the last-admin and self-demotion rules cap damage; next steps are 2FA and two-person approval (listed gaps).
7. **Extracting this as a service?** Admin becomes a read-model/BFF: reads from replicas or event-fed projections; writes become commands sent to the owning services (users, listings, garages), each keeping its own audit.
8. **Bottleneck?** Overview/revenue aggregate over large tables: add daily rollup tables, cache the overview for ~30 s, serve from a replica.
