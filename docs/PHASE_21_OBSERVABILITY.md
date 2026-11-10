# Phase 21 — Observability

## Endpoints
| Path | Purpose | Notes |
|---|---|---|
| `GET /health` | liveness (process is up) | never touches dependencies |
| `GET /ready` | readiness: Postgres + Redis reachable | 503 while draining or when a dependency is down; the load balancer uses this |
| `GET /metrics` | Prometheus | Bearer `METRICS_TOKEN`; open in dev; **disabled in production if unset** |
| `GET /api/admin/system/health` | human/ops view | latencies, pool, queues, sockets, business invariants (admin only) |

## Metrics
HTTP: `ridex_http_requests_total{method,route,status}`, `ridex_http_request_duration_seconds` (route is the **pattern** `/api/rides/:rideId`, never the raw URL — bounded cardinality).
Business: `ridex_payments_total{status}`, `ridex_matching_duration_seconds`, `ridex_active_rides`, `ridex_online_drivers`, `ridex_websocket_connections`,
`ridex_invariant_violations{name}` (stuck payments, unsettled rides, overdue rental holds, stuck payouts, open deposit refunds — **should always be 0**).
Infra: `ridex_db_pool_connections{state}`, `ridex_queue_jobs{queue,state}`, Node process metrics (`ridex_process_*`/`ridex_nodejs_*` defaults).

## Logs
Structured JSON (pino), one line per request with `requestId`, the same id returned in every error body and in the `x-request-id` header, so a user's screenshot of an error leads straight to the log line. Secrets and tokens are redacted; a test greps logs to prove it.

## Alerts to create
5xx > 1% for 5 min · p95 > 1 s for 10 min · any `ridex_invariant_violations` > 0 for 10 min · `ridex_queue_jobs{state="failed"}` rising · DB pool waiting > 0 for 2 min · `/ready` failing.

## Why business invariants as metrics
Infrastructure can be green while money is stuck. Counting "paid rides without an earnings split" turns a silent correctness bug into a page.

## Interview questions
Liveness vs readiness? · Why label by route pattern? · What do you alert on first and why? · How do you correlate a user report with a log line?
