import { Graph } from "./graph";
import { MinPriorityQueue } from "./priorityQueue";

export interface DijkstraResult {
  /** Shortest known distance from the source to every reachable node. */
  distances: Map<string, number>;
  /** Predecessor of each node on its shortest path from the source - used to reconstruct the actual route. */
  parents: Map<string, string | null>;
  /** Order in which nodes were finalized (popped from the queue and settled) - exposed for complexity/behavior verification in tests, not needed by callers otherwise. */
  visitedOrder: string[];
}

/**
 * Classic Dijkstra's algorithm (spec section 10), built from exactly the
 * components the spec calls for:
 *   - adjacency list      -> Graph (graph.ts)
 *   - priority_queue      -> MinPriorityQueue (priorityQueue.ts)
 *   - distance map        -> `distances` below
 *   - parent map           -> `parents` below
 *   - visited set          -> `visited` below
 *
 * TIME COMPLEXITY: O((V + E) log V)
 *   Every node is extracted from the priority queue at most once when
 *   finalized: V extractions, each O(log V) (heap operations are
 *   logarithmic in heap size, which is bounded by the number of pushes).
 *   Every edge is examined exactly once (from its "from" node's
 *   perspective) and can trigger at most one push: E pushes, each
 *   O(log V). Total: O(V log V + E log V) = O((V + E) log V).
 *
 * SPACE COMPLEXITY: O(V + E)
 *   The graph's adjacency list is O(V + E). `distances`, `parents`, and
 *   `visited` are each O(V). The priority queue holds at most one entry
 *   per edge relaxation in the worst case (lazy deletion - see
 *   priorityQueue.ts's comment on why decrease-key isn't implemented),
 *   so O(E) additional space there. Total: O(V + E).
 *
 * Runs entirely in memory against the small, precomputed Graph object -
 * see routing.service.ts for why this is explicitly NOT how a
 * production, city-scale routing engine works.
 */
export function dijkstra(graph: Graph, sourceId: string): DijkstraResult {
  const distances = new Map<string, number>();
  const parents = new Map<string, string | null>();
  const visited = new Set<string>();
  const visitedOrder: string[] = [];

  for (const id of graph.nodeIds()) {
    distances.set(id, Infinity);
    parents.set(id, null);
  }

  if (!graph.hasNode(sourceId)) {
    return { distances, parents, visitedOrder };
  }

  distances.set(sourceId, 0);
  const queue = new MinPriorityQueue<string>();
  queue.insert(sourceId, 0);

  while (!queue.isEmpty()) {
    const current = queue.extractMin()!;

    // Lazy deletion: this entry may be a stale, superseded push from
    // before we found a shorter path to `current`. If we've already
    // finalized this node, skip - don't relax its edges twice.
    if (visited.has(current)) continue;
    visited.add(current);
    visitedOrder.push(current);

    const currentDistance = distances.get(current)!;

    for (const edge of graph.getNeighbors(current)) {
      if (visited.has(edge.to)) continue;

      const candidateDistance = currentDistance + edge.weight;
      if (candidateDistance < distances.get(edge.to)!) {
        distances.set(edge.to, candidateDistance);
        parents.set(edge.to, current);
        queue.insert(edge.to, candidateDistance);
      }
    }
  }

  return { distances, parents, visitedOrder };
}

/**
 * Walks the parent map backwards from `targetId` to `sourceId` to
 * reconstruct the actual shortest path (not just its length). Returns
 * null if the target is unreachable from the source (never visited, or
 * distance is still Infinity).
 */
export function reconstructPath(
  parents: Map<string, string | null>,
  sourceId: string,
  targetId: string
): string[] | null {
  if (sourceId === targetId) return [sourceId];
  if (!parents.has(targetId)) return null;

  const path: string[] = [];
  let current: string | null = targetId;

  while (current !== null) {
    path.push(current);
    if (current === sourceId) {
      return path.reverse();
    }
    current = parents.get(current) ?? null;
  }

  return null; // walked off the map without reaching sourceId - unreachable
}
