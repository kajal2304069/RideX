# RideX — Phase 9: Driver Matching

## 1. What we built

The real `MatchingService` spec section 9 asks for: progressive radius
search, hard eligibility gates, and a genuine weighted scoring
algorithm — replacing Phase 6's "list every searching ride, driver
picks manually" placeholder with actual ranked candidate discovery.

```
GET /api/matching/rides/:rideId/candidates
```

New: `modules/matching/services/scoring.ts` (pure ranking function) and
`modules/matching/services/matching.service.ts` (progressive search +
eligibility filtering, built on Phase 7's `locationService.getNearbyDrivers`).

## 2. Three responsibilities, kept in three places

Spec section 9 lists five ranking criteria: distance, ETA, vehicle
compatibility, driver availability, driver rating. This implementation
splits them into two different kinds of check, on purpose:

- **Hard gates** (a candidate either qualifies or is excluded
  entirely): vehicle compatibility, applied upstream by
  `getNearbyDrivers`'s `vehicleTypeId` filter (Phase 7); and driver
  availability, applied in `matching.service.ts` by excluding any
  driver who already has an active ride.
- **Scored dimensions** (vary in *degree* among already-qualified
  candidates): distance, ETA, and rating — computed by the pure
  `scoreCandidate()` function in `scoring.ts`.

This split matters because "is this driver even eligible" and "how
good a match is this driver" are genuinely different questions with
different failure modes — a wrong answer to the first means dispatching
an unavailable driver (a correctness bug); a wrong answer to the second
just means a worse-than-optimal but still valid match (a quality
issue). Keeping them as separate code paths makes each easier to reason
about and test independently.

## 3. The scoring formula, and why these specific weights

```
score = 0.5 x distanceScore + 0.3 x etaScore + 0.2 x ratingScore
```

- **distanceScore** = `1 - (distanceMeters / searchRadiusMeters)`,
  clamped to [0,1] — 1.0 at the pickup point, 0.0 at the edge of
  whichever radius tier the candidate was found in.
- **etaScore** = `1 - (etaSeconds / 20min)`, clamped — a driver who'd
  arrive immediately scores 1.0; a driver 20+ minutes out scores 0.0.
- **ratingScore** = `ratingAvg / 5`.

**Distance is weighted highest (0.5)** because it's the spec's
first-listed criterion and the dominant real-world factor: a
much-closer, lower-rated driver genuinely should win over a farther,
perfect-rated one for pickup promptness. This is directly verified: a
test constructs exactly that scenario (100m/3-star vs. 1900m/5-star) and
confirms the closer driver's total score wins. ETA is weighted second
(0.3) since it's correlated with but not identical to raw distance
(accounts for the actual duration estimate). Rating is weighted lowest
(0.2) as a meaningful but secondary tie-breaker among otherwise similar
options — not enough to overcome a large distance gap, but enough to
separate two similarly-located drivers.

**Live-verified, not just unit-tested:** a close (111m), 3-star driver
and a farther (823m), 5-star driver were both set up as real online
drivers; the API returned the close driver first with score `0.8604`
vs. the far driver's `0.5587` — the algorithm doing exactly what the
weighting was designed to do, against real HTTP responses.

## 4. Progressive radius expansion — spec's exact tiers, and why it stops early

`SEARCH_RADII_METERS = [1000, 2000, 5000, 10000]` — spec section 9's
literal values. The search tries 1km first and **stops at the first
tier that yields at least one qualified candidate**, rather than always
checking all four tiers and merging results. This is a deliberate
reading of "if necessary": expanding the search past a tier that
already found candidates would only ever pull in worse (farther)
options to rank alongside better ones already found — there's no
scenario where continuing to expand improves the outcome once a
qualified pool exists. Verified live and in tests: a driver placed at
~1.5km (outside the 1km tier, inside the 2km tier) is correctly found,
with the response reporting `searchRadiusMeters: 2000` — proving the
expansion actually happened, not just that a driver was eventually
returned.

## 5. A real gap this phase closes: "online" doesn't mean "available"

Phase 7's location index only tracks whether a driver is broadcasting a
position — it has no concept of whether they're mid-ride. Phase 6's
`accept` flow deliberately doesn't touch `is_online` when a ride starts
(a driver stays "online" throughout their trip, correctly — going
offline mid-ride would be wrong). This means a driver with an active
ride is *still present* in Redis GEO and would appear in a naive nearby
search. `matching.service.ts` explicitly cross-checks each candidate
against `ridesRepository.findActiveByDriver` and excludes anyone with
one — verified with a test that puts a driver at the same coordinates
for two different rides and confirms they only appear as a candidate
for the one they're *not* already driving.

## 6. What's intentionally NOT built yet

- **No automatic dispatch/push.** This phase computes and exposes
  rankings; it does not automatically assign the top candidate or push
  a real-time offer to them. Actual assignment still goes through
  Phase 6's driver-initiated `/accept` endpoint (with its
  `SELECT...FOR UPDATE` concurrency safety). Turning "here's the ranked
  list" into "automatically notify the #1 candidate, with a fallback to
  #2 if they don't respond in N seconds" is a natural Phase 10
  (WebSockets) + Phase 13 (notifications/BullMQ) capability — it needs
  a push channel and a timeout/retry mechanism that don't exist yet.
- **ETA still uses the simple speed-based estimate** (Phase 6's
  `estimateDurationSeconds`), not Phase 8's Dijkstra routing engine —
  consistent with Phase 8's own documented boundary: that engine covers
  one small demo neighborhood, not real coverage for arbitrary
  pickup points.
- **No dynamic weight tuning** — the 0.5/0.3/0.2 split is a fixed
  constant, not something that adapts to city, time of day, or surge
  conditions (a natural extension once real usage data exists to tune
  against).

## 7. Test cases delivered this phase

18 new tests, all passing:
- **Unit (10, pure function, no DB):** closer-wins/sooner-ETA-wins/
  higher-rating-wins in isolation; distance dominating rating in a
  combined scenario; boundary behavior at the radius edge and at
  distance-zero; ETA ceiling clamping; total score bounds [0,1];
  exact perfect-candidate and worst-candidate score values
- **Integration (8, live Redis + Postgres):** ranking order within a
  single search tier, radius expansion when the first tier is empty,
  zero-candidates-is-not-an-error, busy-driver exclusion, rejecting a
  candidates lookup for an already-accepted ride, ownership hiding for
  non-parties, admin override access, full score-breakdown presence in
  the response

Combined with Phases 1–8: **191/191 passing.**

Also manually walked the live flow: two real drivers set up with
different distances and ratings, a real ride requested, and the actual
HTTP response confirmed the closer/lower-rated driver correctly
outranking the farther/perfect-rated one by the exact scores the
formula predicts.

Run them:
```
cd backend && npm test
```

## 8. Interview questions this phase should prepare you to answer

1. **Why are vehicle compatibility and availability treated as gates
   rather than scored dimensions, when the spec lists all five criteria
   together?** Because they're fundamentally different kinds of
   question. "Is this a compatible/available driver" has a correct
   binary answer — getting it wrong means dispatching someone who
   literally cannot take the ride, a correctness bug. "How close/fast/
   well-rated is this driver" is a genuine matter of degree where
   several answers could all be "good enough" — that's what a weighted
   score is for. Conflating them (e.g., giving an incompatible driver a
   low-but-nonzero score instead of excluding them outright) would risk
   ranking an invalid candidate above a valid one under some score
   combination.
2. **Why does the radius search stop at the first tier with candidates
   instead of always checking all four and merging?** Once a qualified
   pool exists at a smaller radius, every candidate the next tier could
   add is necessarily farther away (radius search is monotonic) — so
   expanding further can only add worse-ranked options, never a better
   one. Stopping early is both faster (fewer Redis/Postgres round-trips)
   and never sacrifices ranking quality.
3. **How do you know the "online" driver you found is actually free to
   take this ride?** You can't get that from the location index alone —
   Phase 7's Redis GEO only tracks broadcast position, and a driver
   correctly stays "online" throughout an active trip. The matching
   service has to separately check ride state (`findActiveByDriver`)
   for every geo-index hit before treating it as a real candidate — an
   easy gap to miss if you only ever look at the location system in
   isolation.
4. **Why weight distance highest instead of, say, weighting all three
   scored dimensions equally?** Because the criteria aren't equally
   informative for the actual goal (minimizing rider wait time and
   maximizing match quality) — a driver 2km away is a meaningfully
   worse pickup experience than a driver 200m away almost regardless of
   their rating, while the rating difference between a 4.5 and a 4.8
   star driver is comparatively minor. Weighting reflects that distance
   is the dominant real-world factor, with ETA and rating as
   secondary and tertiary refinements — verified directly by
   constructing a scenario where a closer-but-lower-rated driver wins.
5. **What would you need to add to turn this into a real dispatch
   system?** A push channel to actually notify the top-ranked driver in
   real time (Phase 10's WebSockets), an acceptance timeout with
   fallback to the next-ranked candidate if the first doesn't respond
   (naturally implemented as a BullMQ delayed job, Phase 13), and
   probably surge-aware or time-of-day-aware weight adjustments once
   there's real usage data to tune against. This phase deliberately
   stops at "compute the correct ranking," which is the reusable core
   those later capabilities would build on top of.
