# RideX — Phase 2: Authentication

## 1. What we built

Full JWT-based auth with refresh-token rotation, Argon2id password
hashing, and RBAC middleware usable by every future module.

```
POST /api/auth/register   → create account, issue token pair
POST /api/auth/login      → verify credentials, issue token pair
POST /api/auth/refresh    → rotate refresh token, issue new access token
POST /api/auth/logout     → revoke refresh token
GET  /api/auth/me         → return current user (requires access token)
```

New/changed files:
- `db/migrations/1725000001_create_users_and_auth.js` — `users` +
  `refresh_tokens` tables (first real schema; full domain schema is
  Phase 3)
- `scripts/migrate.js` — programmatic node-pg-migrate runner
- `common/jwt.ts`, `common/password.ts` — token and hashing utilities
- `middleware/auth.ts` — `authenticate` + `authorize(...roles)`, shared
  by every module going forward
- `middleware/validate.ts` — generic Zod request validator
- `modules/auth/*` — types, validators, repository, service, controller, routes
- `utils/pgArray.ts` — Postgres custom-enum-array parsing fix (see §4)

## 2. Why refresh-token rotation with a DB-backed table (not JWT-only)

A pure "long-lived JWT refresh token, never touch the DB" scheme is
simpler but has one fatal weakness: **you can't revoke a single stolen
token**. If a refresh token leaks, your only remedy is rotating the
signing secret - which logs out *every* user, not just the compromised
one.

Instead:
- Every refresh token has a row in `refresh_tokens`, keyed by its JWT's
  `jti` claim.
- Using a refresh token **rotates** it: the old row is marked
  `revoked_at` + `replaced_by`, a new row is inserted, in one
  transaction (`authRepository.rotateRefreshToken`).
- If a token is presented that's already `revoked_at` (i.e. someone is
  replaying a token that was already exchanged once), that's a strong
  signal the token was stolen and used by two parties. We can't tell
  which of the two holders is legitimate, so **every** refresh token
  for that user is revoked, forcing a fresh login everywhere. This is
  verified by `auth.test.ts`'s reuse-detection test and was manually
  reproduced end-to-end against the live server (see §5).
- Only a **hash** of the refresh token is stored (`token_hash`), so a
  database leak alone can't be replayed as a live session - same
  principle as password storage.

## 3. Why access + refresh use separate JWT secrets, and different storage

| | Access token | Refresh token |
|---|---|---|
| Lifetime | 15 min | 7 days |
| Checked against DB? | No (stateless) | Yes, every time |
| Where the client keeps it | JS memory / Authorization header | httpOnly cookie, scoped to `/api/auth` |
| Secret | `JWT_ACCESS_SECRET` | `JWT_REFRESH_SECRET` |

Splitting the secrets means a leak of one token type's signing key
doesn't let an attacker forge the other type. The access token is
intentionally **not** checked against the DB on every request - that's
the entire performance point of having a short-lived token in the first
place (see §6, "what if a user is deactivated mid-session").

The refresh token lives in an `httpOnly`, `SameSite=Lax` cookie scoped
to `/api/auth` (not readable by JS, not sent to unrelated endpoints) -
this is what stops a garden-variety XSS payload from stealing it.

## 4. Bug found via live testing: Postgres custom enum arrays

While testing against the real local Postgres instance (not a mock),
`GET /api/auth/me` returned `"roles": "{RIDER}"` — a raw Postgres array
*literal string* — instead of a JSON array. `pg`'s driver auto-parses
arrays of **built-in** types (`text[]`, `int4[]`) but not arrays of
**custom** types like our `user_role` enum. Fixed with
`utils/pgArray.ts::parsePgEnumArray`, applied in the repository layer
so every consumer of `UserRecord.roles` always sees a real array. This
is exactly the kind of bug that only surfaces by running against a real
database instead of asserting against a mock — worth calling out
explicitly since the project brief asked for this to be a real,
verified system rather than a "fake system design disconnected from
the code."

## 5. What was verified live (not just unit-tested)

Ran a real Postgres 16 + PostGIS 3.4 and Redis instance, booted the
actual server, and drove the full flow with `curl`:

1. Register with multiple roles (`RIDER` + `VEHICLE_OWNER`) → roles
   returned correctly as an array (post-fix)
2. Duplicate email → `409`, generic message
3. Weak password → `400` with field-level Zod errors
4. Login with wrong password vs. unknown email → **identical** `401`
   response (no account enumeration)
5. `GET /me` with valid / missing / malformed token → `200` / `401` / `401`
6. Refresh → new access token + rotated refresh cookie (old ≠ new)
7. **Replaying the old, already-rotated refresh token** → `401
   "Session invalidated"`, and the server log shows
   `"Refresh token reuse detected - revoking all sessions"`
8. The **legitimate** rotated token was also killed by that sweep (DB
   query confirmed all 4 tokens issued in the session ended up
   `revoked_at IS NOT NULL`)
9. Logout → refresh token revoked, subsequent refresh attempt `401`
10. Attempting to self-register as `ADMIN` → rejected by the Zod schema
    (`ADMIN` is deliberately excluded from the public-facing enum)

All of this is now also codified as automated Jest integration tests
(`tests/integration/auth.test.ts`) that run against the same live DB.

## 6. Interview questions this phase should prepare you to answer

1. **Why not just use one long-lived JWT and skip the whole
   refresh-token table?** You lose the ability to revoke a single
   session. A DB-backed refresh token with rotation gives you
   short-lived, low-cost access tokens for performance AND
   individually-revocable sessions for security - the standard
   trade-off resolution used by most production auth systems (this is
   effectively OAuth's refresh-token-rotation pattern).
2. **What happens if a user is deactivated while they still hold a
   valid access token?** They stay "logged in" for up to 15 minutes
   (access tokens aren't checked against the DB). This is an accepted
   trade-off - checking the DB on every request would defeat the
   purpose of having a stateless access token. If you need instant
   revocation, you'd shorten the access token TTL or add a
   cache-backed denylist (a Redis SET of revoked user IDs, checked in
   the `authenticate` middleware - a natural Phase 11 extension).
3. **How does refresh-token reuse detection actually catch theft?**
   Normal usage rotates a token exactly once before it's superseded. If
   an already-revoked token is presented again, either (a) the
   legitimate client retried a request after already rotating (a
   client bug), or (b) an attacker has a copy of an old token and is
   using it after the real user already moved on. We can't distinguish
   these cases, so we conservatively treat it as theft and kill every
   session - a false positive costs the user one re-login; a false
   negative leaves a thief with access.
4. **Why hash the refresh token before storing it, but not the access
   token?** The access token is never stored server-side at all
   (that's the point of a stateless JWT) - there's nothing to hash. The
   refresh token IS stored (so it can be looked up/revoked), so it gets
   hashed the same way a password would, because it's a bearer
   credential with real value if leaked from the DB.
5. **Why did self-registration exclude the ADMIN role at the schema
   level instead of in application logic?** Making it structurally
   impossible (the Zod enum used for the public registration endpoint
   simply doesn't include `ADMIN`) removes an entire class of bug where
   a future code change accidentally allows it - "secure by
   construction" beats "secure because someone remembered to check."
6. **How would you scale the rate limiter beyond one instance?** The
   current `express-rate-limit` store is in-memory per-process, so once
   the backend runs behind a load balancer across multiple instances,
   each instance would allow its own quota. It needs to move to a
   shared Redis-backed store (`rate-limit-redis`) - explicitly flagged
   in the code as a Phase 11 follow-up rather than silently deferred.

## 7. Test cases delivered this phase

33 tests total, all passing against a live Postgres + Redis:
- **Unit** (17): `ApiError` factories, JWT sign/verify round-trips and
  cross-type rejection, Argon2 hashing/verification/salting, RBAC
  `authorize()` union-role logic
- **Integration** (16, live DB): register/duplicate/weak-password/no-self-admin,
  login success/generic-failure-message, `/me` with valid/missing/malformed
  token, refresh rotation, refresh **reuse detection with full session
  revocation**, refresh with no token, logout revocation

Run them:
```
cd backend && npm test
```
(Requires `DATABASE_URL`/`REDIS_URL` pointing at a reachable Postgres/Redis -
`docker compose up -d postgres redis` is enough.)
