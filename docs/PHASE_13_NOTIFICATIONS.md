# RideX — Phase 13: Notifications + BullMQ

## 1. What we built

Events in the ride and payment flows (driver assigned, trip completed, payment received...) now produce
notifications that are delivered **asynchronously, at-least-once, with no duplicates in the app**.

- A BullMQ queue (`notifications`) with retries, exponential backoff and a dead-letter set
- A **producer** (`notificationsService.notify`) called from rides and payments; it only enqueues
- A **worker** that stores the in-app notification, pushes it live over Socket.IO, and sends email where the type warrants it
- REST API to list, count unread, mark read, mark all read; admin queue stats
- A standalone worker process (`npm run worker`), or in-process in dev (`START_WORKER=true`)
- Migration: `dedupe_key` + `email_sent_at` on `notifications`, with a unique index on `(user_id, dedupe_key)`

## 2. Architecture

```
 request path (API process)                     background (worker process)
 ───────────────────────────                    ──────────────────────────────────────────
 rides.accept() ──► notify() ──► BullMQ queue ──► Worker ─► process(job)
 payments.settle()   (enqueue only,   (Redis)               1. INSERT notification ON CONFLICT DO NOTHING
                      never throws)                         2. PUBLISH redis "ridex:notifications:new"
                                                            3. email (if type wants it) → stamp email_sent_at
                                                                        │
 API process ◄── SUBSCRIBE ◄──────────────────────────────── Redis pub/sub
   └─ emitToRoom("user:<id>", "notification:new")  → client socket
```

Why a queue at all: the request path should do the minimum. A slow or down email provider must not slow
"accept ride", and a Redis blip while enqueuing must not fail a ride that already succeeded (`notify` swallows
and logs the error).

Why the pub/sub bridge: the worker may be a different process from the one holding the sockets, so it cannot call
`emitToRoom`. It publishes; every API instance subscribes and emits to its own sockets. This also works when the
worker runs inside the API.

## 3. Notification types

| Type | Recipient | Email |
|---|---|---|
| RIDE_ASSIGNED, DRIVER_ARRIVING, DRIVER_ARRIVED, TRIP_STARTED | rider | no |
| RIDE_COMPLETED (with fare) | rider | yes |
| RIDE_CANCELLED | the *other* party | no |
| PAYMENT_SUCCESS | payer | yes |
| PAYMENT_RECEIVED | driver | no |
| PAYMENT_REFUNDED | payer | yes |

Jobs carry facts (ids, amounts). Text is rendered by the worker from `templates.ts`, so wording can change and
already-queued jobs pick up the new copy.

## 4. API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/notifications?limit&unreadOnly&before` | newest first; `before` is a timestamp cursor |
| GET | `/api/notifications/unread-count` | |
| PATCH | `/api/notifications/:id/read` | 404 if not yours |
| POST | `/api/notifications/read-all` | |
| GET | `/api/notifications/admin/queue-stats` | ADMIN; waiting/active/delayed/completed/failed |

Socket event: `notification:new` to room `user:<id>`.

## 5. Delivery guarantees, step by step

BullMQ retries a failed job from the top, so every step of `process()` is safe to repeat:

| Step | Made repeat-safe by |
|---|---|
| Insert in-app row | `ON CONFLICT (user_id, dedupe_key) DO NOTHING` |
| Live push | only when the row was newly inserted |
| Email | only while `email_sent_at IS NULL`; stamped after the provider accepts |

Result: **in-app is exactly-once; email is at-least-once.** If the process dies after the provider accepts the
mail but before we stamp it, a retry resends. Closing that gap needs a provider-side idempotency key.

### Two-layer duplicate protection (same pattern as Phase 12)

1. `jobId = <type>__<entity>__<user>`: enqueuing the same event twice is a no-op while BullMQ remembers the job.
   (BullMQ forbids `:` in custom ids, hence `__`.)
2. Unique index in Postgres: `removeOnComplete` is bounded, so BullMQ eventually forgets the id. A late duplicate then
   gets through the queue but not the database.

### Retries and the dead-letter set

5 attempts, exponential backoff (1s, 2s, 4s, 8s). After the last attempt the job stays in BullMQ's `failed` set,
which is our DLQ: inspectable, retryable, and counted by the stats endpoint. The in-app notification still exists
even if the email never went out, because step 1 already committed.

`UnrecoverableError` (e.g. the user no longer exists) skips remaining attempts: retrying cannot fix it.

### Graceful shutdown

`SIGTERM` calls `worker.close()`, which waits for in-flight jobs, then closes Redis and Postgres. Verified against
a real separate worker process.

## 6. Other changes

- `config/bullmqConnection.ts` is now **lazy**. It used to open a Redis socket on import; now that rides and
  payments import the producer, that would have opened one in every process and test.
- Jest: a setup file shortens backoff to 50 ms; an after-all hook closes the queue and connection so Jest exits.

## 7. Known gaps

- **Email, SMS and push are mocks.** `EmailChannel` is the seam; SMS and push would be sibling interfaces. There are
  no per-user channel preferences or quiet hours.
- **Pub/sub is fire-and-forget.** If no API process is subscribed at that instant the live push is lost; the stored
  notification is not.
- **A crash between the insert and the publish** loses only the live push, never the notification.
- **No stuck-payment sweeper yet.** Phase 12's `PROCESSING` reconciliation needs a provider "look up charge" call that
  the stub does not have; it belongs with the real Stripe integration and a BullMQ repeatable job.
- **No Bull Board UI.** Stats are numbers only.
- **Notification rows grow forever.** A retention job (delete read notifications older than N days) is a natural
  repeatable job.

## 8. Test cases

Unit (`notificationsService.test.ts`, 14): templates and email flags; dedupe key has no `:`; producer uses the
deterministic jobId and never throws; consumer stores/publishes/emails; skips email for in-app types; duplicate does
not republish or re-email; retry after email failure emails without republishing; email failure propagates and does
not stamp; failed publish does not fail the job; unknown user is `UnrecoverableError`; mark-read 404.

Integration (`notifications.test.ts`, 15, real Postgres + Redis + worker): enqueue to row to live push; email once;
job holds facts not text; triple enqueue gives one row; direct double `process()` gives one row and one email;
email fails twice then succeeds on attempt 3 with one live push; five failures land in the failed set with the row
intact; unknown user fails after one attempt; list/unread/read/read-all; pagination; isolation between users;
validation and auth; admin-only stats; full ride lifecycle plus payment produces the right notifications for rider
and driver (including the two emails); cancel notifies only the other party.

Also verified by hand: a separate `npm run worker` process consuming a job from another process, with the realtime
message arriving, and a clean SIGTERM drain.

Full suite: **291 passing** (262 before this phase).

## 9. Interview questions

**Why a queue instead of sending inline?**
Latency and failure isolation. The request returns after an enqueue (~1 ms) rather than after an SMTP round trip, and
a provider outage becomes retries in the background instead of 500s.

**Why BullMQ / Redis rather than a database table as the queue?**
BullMQ gives delayed jobs, backoff, concurrency, rate limiting and stalled-job recovery out of the box. A Postgres
queue (`SELECT … FOR UPDATE SKIP LOCKED`) is a good choice when you want the job and the business write in one
transaction. Kafka/SQS fit higher volume or multiple independent consumers.

**What delivery semantics do you provide?**
At-least-once from the queue, made effectively-once for the in-app notification by idempotent writes. Email stays
at-least-once.

**A job is processed twice. What happens?**
The insert conflicts and is skipped, no second live push, and the email is skipped if `email_sent_at` is set.

**What if the worker crashes mid-job?**
BullMQ marks the job stalled after its lock expires and re-queues it. Because the steps are idempotent, rerunning is safe.

**What if Redis is down when you enqueue?**
`notify` logs and returns; the ride still succeeds, and the notification is lost. If notifications were
business-critical you would use the **transactional outbox**: write the event to a Postgres table in the same
transaction as the state change and have a relay enqueue it.

**Why can enqueue lose a notification, and is that acceptable here?**
Ride state is the source of truth; notifications are derived and the client also reads state. Acceptable for
"driver arrived", not for, say, a legal receipt. Hence the outbox as the upgrade path.

**How do you prevent duplicates?**
jobId for the common case, the unique index for the guarantee.

**Why `removeOnComplete` with limits?**
Without it, completed jobs accumulate in Redis forever. The price is that jobId dedupe has a time window, which the
DB index covers.

**Why a separate worker process?**
Independent scaling and failure isolation: CPU or provider trouble in the worker cannot starve the API. The cost is
the cross-process realtime bridge.

**Why not just call `io.emit` from the worker?**
It has no sockets. With multiple API instances the user's socket may be on any of them, so publish and let each one
emit locally. The Socket.IO Redis adapter is the general form of this.

**Ordering?**
Not guaranteed: with concurrency > 1, "driver arriving" can be processed after "driver arrived". Notifications are
independent and timestamped; if order mattered you would group by user (BullMQ Pro groups) or use concurrency 1 per key.

**How would you add SMS and push?**
New channel implementations behind the same interface, user preferences, and one job per channel so a failing SMS
provider retries independently of email.

**How would you monitor it?**
Queue depth, oldest waiting job age, failed-set size, retry rate, processing latency (Phase 21).

**Extracting this as a microservice?**
Already close: producers only call `notify(userId, type, entityId, data)`. Replace it with an event on a broker,
move the queue, worker, templates and `notifications` table with it, and keep the pub/sub bridge for realtime.
