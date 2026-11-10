# Phase 19 — Testing strategy and gaps closed

## Layers
| Layer | Where | What it proves |
|---|---|---|
| Unit (pure) | `backend/tests/unit` | Fare maths, earnings splits (sum to the paisa), admin rules, matching ranking, Dijkstra |
| Integration | `backend/tests/integration` | Real Express app + real Postgres/PostGIS + real Redis: auth, rides, payments, earnings, admin… |
| Concurrency | `tests/integration/*Concurrency*`, `redisLock`, plus race cases inside module tests | Fire N requests at once; assert exactly one winner and a consistent DB |
| Frontend | `frontend/src/test` (Vitest + React Testing Library + jsdom) | Formatting, API client refresh/envelope/errors, auth store, UI primitives, ride line, how-to guide |
| Browser smoke (manual script) | `e2e/` | Every page for every role loads with no console/API errors; offer, garage booking, rental quote, ride request→driver sees it |

## Added this phase
`tests/integration/phase19.test.ts` (15 tests) for the endpoints the web app needs: `GET /vehicles/types` (public, not shadowed by `/:vehicleId`),
`GET /vehicles/drivers/lookup` (exact email only; verified + unassigned only; owner-only), ride `fare` field (null → filled), ride rating
(once only, range 1–5, participants only, completed only, **4 concurrent submits → exactly one row**).
Frontend: 27 tests incl. the single-flight token refresh and the how-to guide completeness check (every step has a picture, English and Hindi).

## Mutation checks (prove the tests can fail)
Removed `FOR UPDATE` on withdraw · removed the settlement gate · charged commission on damage · removed `FOR UPDATE` on admins · skipped the token-revocation check · dropped the audit trigger · replaced single-flight refresh `??=` with `=` — **each one made at least one test fail**, then was restored.

## Bug caught by the full run
Prometheus default metrics were exposed as `ridex_process_process_*` (double prefix). Fixed to `ridex_*`; the observability test guards the names.

## Known gaps
No load test in CI; no visual-regression tests; the browser smoke script is not wired into CI; payment/payout providers are mocks, so provider-specific failure modes are simulated only.

## Interview questions
1. Why test against a real Postgres rather than mocks? (Constraints, locks and isolation *are* the behaviour.)
2. How do you test a race? (Fire it concurrently, assert the invariant, then break the guard and confirm the test fails.)
3. What is a mutation check and why do it by hand? 
4. Why does the token-refresh test mock both `api` and bare `axios`? (Refresh deliberately bypasses the interceptor to avoid recursion.)
