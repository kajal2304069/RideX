# RideX — Phase 4: Rider + Driver

## 1. What we built

Repository/service/controller/route layers on top of Phase 3's
`riders`/`drivers` tables — profile access, driver onboarding, the
driver verification workflow, and the online/offline toggle.

```
GET   /api/riders/me                      → rider's own profile

POST  /api/drivers/onboard                → submit license info, starts PENDING
GET   /api/drivers/me                     → driver's own profile
POST  /api/drivers/online                 → go online (requires VERIFIED)
POST  /api/drivers/offline                → go offline (always allowed)
GET   /api/drivers/pending                → [ADMIN] list drivers awaiting verification
PATCH /api/drivers/:driverId/verification → [ADMIN] approve/reject a driver
```

## 2. Why riders are auto-provisioned but drivers require an onboarding step

A `riders` row needs no information beyond the user's existence — there's
nothing to collect. A `drivers` row needs a license number and expiry
date that the registration form never asks for. So:

- **Riders:** `auth.repository.createUser` now runs registration in a
  single transaction that inserts the `users` row **and**, if `RIDER` is
  among the signup roles, the `riders` row — atomically. A rider never
  exists in a half-provisioned state (verified live: register → `GET
  /api/riders/me` succeeds immediately, no separate step).
- **Drivers:** deliberately a separate `POST /api/drivers/onboard` call.
  Baking license collection into the generic registration endpoint would
  couple the auth module to driver-specific business data — instead,
  a `DRIVER`-role user registers like anyone else, then completes
  onboarding when they're ready to actually drive. This also gives a
  natural place to reject bad license data without complicating the
  registration flow every other role goes through.

## 3. The verification-gates-online business rule lives in the service layer

`driversService.goOnline` — not the database, not the controller — is
what rejects a `PENDING` or `REJECTED` driver trying to go online. Per
the Phase 1 layering rules, this is exactly where a business rule like
this belongs: it's testable in complete isolation from a real database
(see `tests/unit/driversService.test.ts` — 9 tests against a mocked
repository, covering PENDING/REJECTED/VERIFIED/no-profile-at-all), and
it's also verified against the live system end-to-end:

```
POST /api/drivers/online  (PENDING driver)
→ 403 "Cannot go online: driver verification status is PENDING"

PATCH /api/drivers/:id/verification {"status":"VERIFIED"}  (as admin)
→ 200, verificationStatus: "VERIFIED"

POST /api/drivers/online  (same driver, now VERIFIED)
→ 200, isOnline: true
```

Going offline, by contrast, has **no** verification gate — a driver
should always be able to take themselves off dispatch regardless of
their status; there's no safety reason to block that, only reasons to
block the opposite direction.

## 4. Testing an admin-gated workflow without an admin-creation endpoint

`ADMIN` is deliberately excluded from public self-registration (Phase
2). So how do the verification-workflow tests get an admin account to
test with? `promoteToAdmin()` in the integration test file updates the
`roles` column directly via SQL — simulating "an admin account already
exists" (which in a real deployment would come from a seeded bootstrap
admin or a promotion by an existing admin, both out of scope for this
phase). One easy-to-miss detail this surfaced: **roles are baked into
the access token at issuance** (`common/jwt.ts`), so promoting a user's
DB row to `ADMIN` doesn't retroactively upgrade a token they already
hold — the test has to log in again *after* the promotion to get a
token carrying the new role. This is a direct, useful illustration of
the access-token statelessness trade-off discussed in Phase 2 (a
demoted/promoted user's permissions only take effect once their current
access token expires or they re-authenticate).

## 5. What's intentionally NOT built yet

- No `PATCH /api/riders/me` or `/api/drivers/me` update endpoints —
  there's nothing user-editable on these profiles yet (rating/total
  rides are system-managed and will be written by the ride-completion
  flow in Phase 6, not by the user)
- No linkage between a driver and a vehicle yet (`current_vehicle_id`
  exists on the schema but nothing sets it) — that's Phase 5 (Vehicle
  management)
- No admin bootstrap/promotion endpoint — promoting the first admin is
  an ops/seed concern, addressed properly in Phase 18 (Admin Dashboard)

## 6. Test cases delivered this phase

19 new tests, all passing:
- **Unit (9, mocked repository, no DB):** onboarding rejects a
  duplicate profile / past expiry / taken license number, accepts valid
  input; `goOnline` rejects PENDING/REJECTED/no-profile, allows
  VERIFIED; `goOffline` always succeeds regardless of status
- **Integration (10, live DB):** rider auto-provisioning at
  registration, RBAC rejection for non-RIDER on `/riders/me`; driver
  onboarding success/wrong-role/duplicate/license-conflict/validation;
  the full online-blocked → admin-verifies → online-allowed →
  offline lifecycle; RBAC rejection of the verification endpoint for a
  non-admin; the pending-drivers admin list

Combined with Phases 1–3: **60/60 passing.**

Also manually walked the entire live flow with `curl` against the real
server + Postgres (register rider → confirm DB row exists directly via
`psql` → register driver → onboard → blocked from going online →
promote an admin via SQL → verify the driver → go online → go offline),
matching every assertion the automated tests make.

Run them:
```
cd backend && npm test
```

## 7. Interview questions this phase should prepare you to answer

1. **Why is the rider profile auto-created but the driver profile
   isn't?** Because they need different amounts of information. Riders
   need none beyond "a user exists"; drivers need license data the
   generic registration form doesn't collect. Auto-provisioning riders
   removes a redundant round-trip the client would otherwise have to
   remember to make; forcing driver onboarding as its own step keeps
   registration generic across all roles.
2. **Why not put the "must be VERIFIED to go online" check in the
   database (e.g. a trigger or check constraint)?** It's business logic
   with room to evolve (a future rule might allow SUSPENDED drivers with
   pending appeals to view but not accept rides, or require an
   additional vehicle-assigned check before going online) — that kind of
   conditional, evolving logic belongs in a service method that's easy
   to read, modify, and unit-test, not encoded as a database trigger
   that's harder to test in isolation and awkward to extend.
3. **Why does promoting a user to ADMIN via direct SQL not immediately
   grant them admin access through their existing session?** Access
   tokens are stateless and self-contained (Phase 2) — the roles baked
   into a JWT at signing time don't get revisited until that token
   expires or the user re-authenticates. This is the same trade-off
   that makes access tokens fast (no DB check per request); the cost is
   a role change has a delay bounded by the access-token TTL (15 min) or
   an explicit fresh login.
4. **How would you extend this to support driver re-verification
   (license renewal, periodic re-checks)?** The `verification_status`
   enum already supports moving a `VERIFIED` driver back to `PENDING` —
   `setVerification` doesn't currently restrict which transitions are
   allowed, so an admin (or an automated license-expiry job in Phase 13)
   could set a driver back to PENDING, which `goOnline`'s existing check
   would immediately start enforcing with no additional code.
5. **What would break if a driver went offline while mid-ride, and how
   does the current design prevent it?** Nothing in the drivers module
   itself models rides yet — that coupling is intentionally deferred to
   Phase 6, where the ride state machine (not the driver's online
   status) will be the source of truth for whether a driver is
   currently engaged. `is_online` and "has an active ride" are separate
   concerns that will be reconciled in the Matching/Ride services, not
   conflated into one flag here.
