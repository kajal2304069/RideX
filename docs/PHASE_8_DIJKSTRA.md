# RideX — Phase 8: Dijkstra / DSA

## 1. What we built

A from-scratch, textbook-correct Dijkstra's shortest-path
implementation — adjacency list, binary min-heap priority queue,
distance map, parent map, visited set — running over a small, seeded
"road network" graph, exposed as a routing engine with an explicit,
documented separation from production map-routing infrastructure (spec
section 10's non-negotiable requirement).

```
POST /api/routing/route   → shortest path + distance + algorithm stats
                             between two real-world coordinates
```

New: `modules/routing/dsa/` — three pure, DB-independent files
(`priorityQueue.ts`, `graph.ts`, `dijkstra.ts`) that are the actual DSA
deliverable, plus `modules/routing/services/routing.service.ts` bridging
them to a small Postgres-backed demo graph.

## 2. The three DSA components, and why each exists

**`MinPriorityQueue<T>`** — a binary min-heap built from scratch (array-backed,
parent/child index arithmetic, sift-up/sift-down). This is what gives
Dijkstra its logarithmic extract-min; without it, "find the unvisited
node with the smallest tentative distance" is an O(V) scan repeated V
times, i.e. O(V^2) overall. Deliberately does NOT implement
decrease-key - instead uses the standard "lazy deletion" simplification
(push a new entry when a shorter path is found; skip stale entries when
popped, via the visited set), which costs at most a constant factor in
extra heap entries without changing the asymptotic bound, and avoids
building a genuinely more complex indexed heap.

**`Graph`** — adjacency list (`Map<nodeId, WeightedEdge[]>`), not an
adjacency matrix. A road network is sparse (an intersection connects to
a handful of others, not to every other intersection in the graph), so
adjacency list is O(V+E) space vs. a matrix's wasteful O(V^2).

**`dijkstra()`** — the algorithm itself, built from exactly the pieces
the spec names: adjacency list (the `Graph`), priority queue (the
`MinPriorityQueue`), distance map, parent map, visited set. Returns
both the distance map (for "how far") and the parent map (for
`reconstructPath` to answer "which way").

## 3. Complexity, stated and actually exercised

**Time: O((V + E) log V)** — each of V nodes is extracted from the
queue at most once when finalized (O(log V) each, since heap
operations are logarithmic in the number of entries the heap has ever
held); each of E edges is examined once and can trigger at most one
push (O(log V) each). Total: O(V log V + E log V) = O((V + E) log V).

**Space: O(V + E)** — the graph's adjacency list is O(V+E); the
distance/parent/visited structures are each O(V); the queue holds at
most O(E) entries under lazy deletion. Total: O(V + E).

Both bounds are stated directly in `dijkstra.ts`'s docblock, next to
the code that realizes them — not just asserted in this document
disconnected from the implementation, which the project brief
explicitly warns against.

**Exercised, not just claimed:** the unit test suite runs Dijkstra over
a hand-built textbook graph with known-correct shortest distances (a
standard directed-graph example, verified against by-hand calculation),
a 10x10 grid graph (correctly reproduces Manhattan distance — corner to
corner is 18, not some other number), an unreachable-node case
(distance stays `Infinity`, path reconstruction returns `null`), a
same-source-and-target trivial case, and a "does relaxation actually
pick the shorter of two paths" case (a direct weight-100 edge loses to
a 3-hop path totaling weight 3).

## 4. The educational-vs-production distinction (the spec's explicit, non-negotiable requirement)

`routing.service.ts` opens with a large, direct comment contrasting
this engine against real routing infrastructure (OSRM, Valhalla,
Google/Uber's internal routers) on five axes: graph size (~16 hand-placed
nodes vs. millions of real OSM nodes), algorithm strategy (naive
per-request Dijkstra vs. precomputed acceleration structures like
contraction hierarchies), edge weights (static distance vs. live
traffic-weighted), architecture (one in-process JS graph vs.
distributed C++ routing services), and the core reason those
techniques exist at all (a real road graph is too large for
request-time naive Dijkstra to be workable — this project's engine
only avoids that problem by being intentionally tiny).

**The concrete consequence of taking this seriously:** Phase 6's fare
estimation continues to use direct Haversine distance, *not* this
routing engine, even though it would be tempting to wire them together
for a more "complete-looking" system. That's a deliberate choice,
documented in both phases: this routing engine's job is being a
correct, testable Dijkstra reference implementation, not a
fare-critical production dependency for a graph that only covers one
small hand-picked neighborhood.

## 5. The demo road network: real coordinates, synthetic graph

`src/db/seeds/002_road_network.js` seeds 16 nodes at real intersection
coordinates around MG Road / Koramangala / Indiranagar in Bangalore
(consistent with every other phase's example coordinates), connected by
25 edges forming a mesh with genuine alternate routes between most node
pairs — not a straight line, so Dijkstra actually has choices to make.
Edge weights are real Haversine distances between the hand-placed
node coordinates. This is explicitly NOT an OpenStreetMap import;
it's small enough that the shortest path between any two nodes can be
sanity-checked by a human looking at the coordinates, which is the
whole point of an educational dataset.

Live-verified: a route from MG Road Junction to Sony World Junction
computed the actual path **MG Road Junction -> Richmond Circle -> Forum
Mall Junction -> Sony World Junction** (6.39km), with human-readable
labels at every hop — not just a distance number, but the real
node-by-node route the algorithm chose.

## 6. Why the graph is cached in memory, not re-queried per request

`getGraph()` loads all nodes/edges from Postgres once and caches the
resulting `Graph` object in a module-level variable for the process's
lifetime. Dijkstra needs random access to the adjacency list as it
runs — re-querying Postgres for each node's neighbors mid-algorithm
would mean dozens of round-trips per route request, defeating the
purpose of an in-memory graph algorithm entirely. This is a
deliberately simple cache with no TTL or invalidation, which is
appropriate exactly because nothing currently writes to
`road_nodes`/`road_edges` after seeding — a system with an editable
road graph would need real cache invalidation on writes, which is
explicitly out of scope here (and noted as such in the code).

## 7. Coordinate "snapping" — another named simplification

`computeRoute` finds each real-world coordinate's *nearest graph node*
by straight-line distance, then runs Dijkstra between those two nodes.
This is a simplification worth naming rather than hiding: real map-matching
accounts for which actual road segment a point sits on and its position
along that segment, not just "nearest intersection." For a routing
engine whose graph has 16 hand-placed nodes, nearest-node snapping is
adequate; it would not be for real GPS traces on a real road network.

## 8. What's intentionally NOT built yet

- No wiring into fare calculation (Phase 6 still uses Haversine
  directly, deliberately — see §4)
- No wiring into ETA display for the matching engine yet (Phase 9's
  `MatchingService` is a natural future consumer of `computeRoute` for
  ranking driver candidates by actual routed distance rather than
  straight-line distance)
- No live traffic weighting, no graph editing/versioning, no
  multi-modal routing — all explicitly out of scope for an educational
  DSA demonstration

## 9. Test cases delivered this phase

32 new tests, all passing:
- **Unit (24):** `MinPriorityQueue` (ascending-order extraction,
  duplicate priorities, size tracking, a 500-element randomized
  workload verified against a plain sort, peek-without-removing);
  `Graph` (bidirectional vs. directed edges, multi-edge nodes,
  node/edge counting, isolated nodes); `dijkstra` (textbook graph exact
  distances, path reconstruction, source-to-source trivial case,
  unreachable-node handling, single-node graph, missing-source
  handling, relaxation correctness on competing paths, no-node-visited-twice
  invariant, undirected-graph symmetry, 10x10 grid graph Manhattan
  distance)
- **Integration (8, live DB):** route computation over the real seeded
  graph, algorithm metadata in the response, trivial same-point case,
  distance sanity bounds, the `driverToRider`/`riderToDestination`
  convenience wrappers, HTTP-layer success/auth-rejection/validation

Combined with Phases 1–7: **173/173 passing.**

Also manually verified live: registered a user, computed a real route
via the HTTP endpoint, and confirmed the returned path is a genuine
multi-hop route with correct, human-readable intersection labels at
every step — not just a distance number.

Run them:
```
cd backend && npm run seed:routing && npm test
```

## 10. Interview questions this phase should prepare you to answer

1. **Walk through why Dijkstra with a binary heap is O((V+E) log V).**
   Every node is extracted from the priority queue exactly once when
   it's finalized — V extractions, each O(log V) because the heap has
   at most O(V+E) entries at any point. Every edge is examined exactly
   once (when its source node is finalized) and can trigger at most one
   push — E pushes, each O(log V). Summing: O(V log V) + O(E log V) =
   O((V+E) log V).
2. **Why didn't you implement decrease-key for the priority queue?**
   Decrease-key requires an *indexed* heap (tracking each element's
   current position so it can be found and re-sifted in place), which
   is meaningfully more complex to implement correctly. The standard
   alternative — push a new entry whenever a shorter path is found, and
   skip already-finalized (stale) entries when popped — achieves the
   same asymptotic complexity at the cost of at most one extra heap
   entry per edge relaxation, which doesn't change the O((V+E) log V)
   bound at all.
3. **Why adjacency list over adjacency matrix for this graph?** A road
   network is sparse — each intersection connects to a small, roughly
   constant number of other intersections, not to every intersection in
   the graph. An adjacency list costs O(V+E) space, proportional to
   what's actually there; a matrix costs O(V^2), which for any
   real-sized road network would waste enormous space storing "no edge
   here" for the vast majority of node pairs.
4. **What would you need to change to make this handle a real,
   city-scale road network?** Almost everything about the *strategy*,
   not just scale up the same code: precompute acceleration structures
   (contraction hierarchies are the standard approach — precompute
   shortcuts so a live query only touches a small fraction of the
   graph), import real OSM data instead of hand-placed nodes, likely
   move the graph out of a single process's memory into a dedicated
   routing service, and incorporate live/historical traffic data into
   edge weights instead of static distances. Naively running the exact
   algorithm in this module against a real road network's node count
   would be far too slow for request-time use — which is the whole
   reason those precomputation techniques exist.
5. **Why does fare estimation (Phase 6) not use this routing engine?**
   Because this graph only covers one small, hand-picked neighborhood —
   using it for real fare calculation would silently produce wrong
   answers (or errors) for the overwhelming majority of real pickup/
   dropoff pairs that fall outside its ~16 nodes. Haversine distance,
   while itself an approximation, at least works uniformly everywhere.
   This is a deliberate scope boundary, not an oversight: the routing
   engine's purpose in this phase is being a correct, testable DSA
   reference implementation, not a production fare dependency.
6. **How is Dijkstra's correctness actually verified here, versus just
   asserting the complexity bounds?** Against a textbook directed graph
   with distances computable by hand (and checked against those exact
   values), a 10x10 grid graph where the correct answer is a
   well-known closed form (Manhattan distance), and specific edge cases
   (unreachable nodes, same-node trivial paths, a relaxation scenario
   designed so the "obviously good" answer would be wrong) — not just
   "it returns a number that looks plausible."
