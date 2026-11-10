# RideX — Phase 10: Real-time Tracking

## 1. What we built

Full Socket.IO wiring (spec section 11): JWT-authenticated WebSocket
connections, room-based subscriptions, live driver location broadcast,
and server-emitted ride lifecycle events — turning the REST-only
mutation flow from Phases 6/7/9 into something that actually pushes
updates to connected clients instead of requiring them to poll.

```
Client -> Server:
  ride:join                { rideId }             subscribe to a ride's live updates
  ride:leave                { rideId }
  driver:location:update    { lat, lng, heading?, speedKmh? }
  driver:online
  driver:offline

Server -> Client:
  ride:joined               { rideId }
  ride:requested / ride:accepted / ride:started / ride:completed / ride:cancelled
  ride:status_changed       (fires on every transition, including arriving/arrived)
  driver:location:update    { rideId, driverId, lat, lng, heading, speedKmh, updatedAt }
  driver:online / driver:offline
  error                     { code, message }
```

New: `websocket/io.ts` (the singleton `getIO()`/`setIO()` accessor),
`websocket/authMiddleware.ts`, `websocket/rideEventHandlers.ts` — plus
emit calls added to the existing `rides.service.ts` and
`drivers.service.ts` from Phases 6 and 4.

## 2. The core design problem: services need to emit events, but have no access to `io`

`rides.service.ts` and `drivers.service.ts` are plain functions with no
knowledge of Express, HTTP, or WebSockets — that's deliberate (Phase
1's layering rules: business logic doesn't know about its transport).
But the whole point of this phase is having those exact functions
trigger real-time pushes after a mutation succeeds. Threading an `io`
parameter through every function signature in every module that might
ever need to emit would leak a transport concern into business logic
everywhere.

**The fix:** `websocket/io.ts` is a tiny singleton — `server.ts` calls
`setIO(io)` once at boot; any service calls `getIO()` (or the
`emitToRoom` convenience wrapper) without importing anything
WebSocket-specific beyond this one small file. Critically, `getIO()`
returns `null` — never throws — when no socket server has been booted,
which is the normal case for almost every existing test in this
project: `createApp()` alone (what `supertest` drives) never calls
`setIO()`. A ride mutation must succeed over REST regardless of whether
a socket server happens to be running — exactly the same principle as
Phase 13's future notification system being best-effort, not a
mutation's success condition.

## 3. Authentication: the same tokens, a different transport

`socketAuthMiddleware` verifies the connecting client's access token —
the identical JWT issued by REST login (Phase 2), via the identical
`verifyAccessToken` function — during the Socket.IO handshake, before a
connection is ever accepted. A client that fails this check never gets
a `socket` at all; `io.on('connection', ...)` never fires for them.
This means every downstream handler can trust `socket.data.userId`/
`socket.data.roles` unconditionally, the same way REST controllers
trust `req.user` once `authenticate` middleware has run.

Verified live (a real Socket.IO client connecting to a real server, not
a mock): no token gives `connect_error` with "Authentication required";
a garbage token gives `connect_error` with "Authentication failed"; a
real token connects successfully.

## 4. Room-based authorization: preventing ride eavesdropping

`ride:join` doesn't blindly subscribe a client to any room they ask
for — it re-runs the exact same party check `rides.service.ts`'s
`getOne`/`assertParty` uses for the REST `GET /api/rides/:id` endpoint:
only the ride's rider or its assigned driver may join `ride:<id>`'s
room. Without this, any authenticated user could subscribe to
`ride:<some-guessed-uuid>` and silently receive another rider's live
location data — a real privacy leak a WebSocket layer can introduce
even when the REST API guards the same resource correctly, if the
socket layer doesn't independently re-check authorization. Verified
live: a stranger's `ride:join` for someone else's ride gets a `NOT_FOUND`
`error` event, not the room join.

## 5. Broadcasting to both a ride room AND each party's personal room

`broadcastRideEvent` in `rides.service.ts` emits to `ride:<id>` (for
clients that called `ride:join`) and to `user:<riderId>` /
`user:<driverId>` (each party's personal room, auto-joined on
connection). This redundancy is intentional: a rider's client can't
`ride:join` a ride's room before that ride exists — there's a real gap
between "the REST call to create the ride returns" and "the client's
socket has had a chance to emit `ride:join` for the ID it just got
back." Emitting to the personal room as well means the `ride:requested`
event still reaches the rider even in that gap, and - verified directly
by a test - a client that never explicitly joins the ride room at all
still receives `ride:completed`, purely via its personal room
membership.

## 6. What "handle disconnected clients" means here — and what it deliberately does NOT mean

Spec section 11 asks to "handle disconnected clients." This phase
interprets that narrowly and explains why: the `disconnect` handler
logs the event for observability and does nothing else — critically, it
does NOT call `driversService.goOffline()`. A dropped WebSocket
connection is not reliable evidence a driver is done for the day; it's
just as likely a momentary network blip, the app backgrounding, or a
phone losing signal in a tunnel. Treating every disconnect as an
explicit sign-off would be both wrong and punishing — a driver
shouldn't lose their spot in nearby-search results and have to manually
go back online because of five seconds of bad signal.

The case that actually matters — a driver who disconnects and never
comes back — is already handled, by Phase 7's staleness mechanism: no
more location pings means their entry ages out of Redis GEO after 30
seconds, independent of whether the underlying socket connection is
technically still open or has been dropped. Phase 10 deliberately
doesn't duplicate that logic in the disconnect handler; it relies on
the mechanism Phase 7 already built for exactly this failure mode.

## 7. Reconnection: an explicit client contract, not silent magic

Socket.IO's client library reconnects automatically on network
recovery (detected via the `pingTimeout`/`pingInterval` heartbeat
configured in `websocket/index.ts`) — but room membership does NOT
survive a reconnect. A reconnection is, from the server's point of
view, a brand-new `socket` object with no rooms joined yet (even though
`socket.data.userId` will be freshly re-authenticated correctly, since
reconnection re-runs the full handshake including
`socketAuthMiddleware`). This is documented explicitly in
`rideEventHandlers.ts` rather than left as a surprise: the client is
responsible for re-emitting `ride:join` for any ride it still cares
about once its `connect` event fires again after a reconnect. This is
the standard Socket.IO pattern — the alternative (server-side
session/room persistence keyed by user ID across reconnects) is real
added complexity that isn't justified at this project's scale, and
would need its own separate design (what happens to stale sessions,
how long to retain them, etc.) if it were ever needed.

## 8. What's intentionally NOT built yet

- No socket-driven ride creation/acceptance. REST remains the mutation
  path for every ride/driver action (Phase 6's `SELECT...FOR UPDATE`
  concurrency safety for ride acceptance lives in the REST-triggered
  service call) - sockets are additive (push notification of
  REST-driven changes), not a second way to mutate state. This avoids
  having two different code paths that both need to independently
  enforce the same business rules and concurrency guarantees.
- No presence/typing-indicator style features - this phase's scope is
  strictly the spec section 11 event list (driver online/offline/
  location, ride lifecycle events).
- No horizontal WebSocket scaling (a Redis adapter for Socket.IO,
  needed once the backend runs as more than one instance so a room
  broadcast reaches sockets connected to a different process) - noted
  as a Phase 23 (scalability) concern, not solved here.

## 9. Test cases delivered this phase

10 new integration tests, all against a genuinely live, listening
HTTP + Socket.IO server with real `socket.io-client` connections (not
mocked) — this is the only test file in the project that boots a real
server rather than driving `createApp()` through `supertest` alone,
because the entire point of this phase is behavior that doesn't exist
without a live connection:
- Authentication: no token rejected, invalid token rejected, valid
  token accepted
- `ride:join` authorization: the ride's rider can join; a stranger is
  rejected with a clean `NOT_FOUND` error event
- Live broadcast: `ride:accepted` reaches a subscribed rider the
  instant a driver accepts via REST; `ride:completed` reaches both
  rider and driver via their personal rooms alone (proving the
  dual-broadcast design in §5)
- Live location: a driver's `driver:location:update` socket emit
  reaches a rider subscribed to that ride's room, with correct
  driver ID and coordinates; a non-driver attempting to broadcast
  location is rejected with `FORBIDDEN`
- `driver:online`/`driver:offline` over the socket transport, mirroring
  the REST endpoints from Phase 4

Combined with Phases 1–9: **201/201 passing.**

Run them:
```
cd backend && npm test
# or just this phase's real-server tests:
npx jest tests/integration/websocket.test.ts
```

## 10. Interview questions this phase should prepare you to answer

1. **How does a service function (with no access to Express's req/res)
   emit a WebSocket event?** Through a small singleton (`websocket/io.ts`)
   that `server.ts` populates once at boot via `setIO()`; any service
   calls `getIO()`/`emitToRoom()` without needing to import anything
   about HTTP servers or sockets. It's designed to return `null`
   harmlessly rather than throw when no socket server is running, so
   business logic never has to special-case "what if nobody's
   listening."
2. **Why re-check ride ownership in the `ride:join` socket handler
   when the REST API already checks it on `GET /api/rides/:id`?**
   Because they're separate authorization boundaries protecting the
   same resource through different transports. If the socket layer
   trusted "the client asked for this room, so give it to them," any
   authenticated user could subscribe to any ride's live location by
   guessing IDs, regardless of what the REST API enforces — the REST
   check doesn't automatically protect the socket layer; each transport
   needs its own guard.
3. **Why doesn't a WebSocket disconnect trigger `driversService.
   goOffline()`?** Because a disconnect is ambiguous — it could mean a
   permanent sign-off, or five seconds of bad signal in an elevator.
   Treating every disconnect as "the driver is done" would incorrectly
   punish temporary network blips. The system already has a mechanism
   for the case that actually needs handling (a driver who never
   reconnects): Phase 7's Redis staleness timeout, which doesn't care
   whether the underlying socket is technically open or not — it only
   cares whether location pings have stopped arriving.
4. **What's the client's responsibility after a reconnect, and why
   isn't that handled server-side instead?** The client must re-emit
   `ride:join` for any ride room it cares about, because Socket.IO
   gives you a fresh `socket` object (with no room memberships) on
   every new underlying connection, reconnects included. Handling this
   server-side would mean tracking room memberships per authenticated
   user across disconnects, deciding how long to retain that state,
   and reconciling it if the user's active rides changed while they
   were disconnected — real complexity with no payoff at this
   project's scale, versus a client just re-subscribing on `connect`,
   which is the standard, well-understood Socket.IO pattern.
5. **Why broadcast to both the ride's room and each party's personal
   room, rather than just the ride room?** Because there's a real
   timing gap between "a ride is created" and "a client has had the
   chance to call `ride:join` for the ID it just received" — the ride
   room might have zero subscribers in that window. The personal room
   (auto-joined at connection time, before any ride even exists)
   guarantees delivery regardless of that race. It also means a client
   that never bothers to explicitly join a specific ride room still
   gets updates for its own rides, which is a reasonable simpler
   integration path for a client that only cares about "my current
   ride," not multiple rides at once.
