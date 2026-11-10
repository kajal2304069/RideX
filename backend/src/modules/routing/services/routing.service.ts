import { ApiError } from "../../../common/ApiError";
import { logger } from "../../../config/logger";
import { haversineDistanceMeters } from "../../rides/services/fare.service";
import { Graph } from "../dsa/graph";
import { dijkstra, reconstructPath } from "../dsa/dijkstra";
import { routingRepository } from "../repositories/routing.repository";
import { GeoPoint } from "../../rides/types/rides.types";
import { RoadNodeRecord, RouteResult } from "../types/routing.types";

/**
 * ============================================================================
 * EDUCATIONAL ROUTING ENGINE - NOT PRODUCTION MAP-ROUTING INFRASTRUCTURE
 * ============================================================================
 * This is the spec's explicit, non-negotiable requirement (section 10):
 * clearly distinguish an educational Dijkstra implementation from how a
 * real, city/country-scale routing engine actually works. Concretely:
 *
 *   THIS ENGINE                          PRODUCTION ENGINES (OSRM, Valhalla,
 *                                         Google/Apple/Uber's internal routers)
 *   -----------------------------------  -----------------------------------
 *   ~16 hand-placed nodes, one small      Millions of nodes/edges imported
 *   neighborhood                          from real OpenStreetMap data
 *
 *   Naive Dijkstra, computed fresh        Precomputed acceleration structures
 *   on every request                      (contraction hierarchies, ALT,
 *                                          graph partitioning) so a query
 *                                          touches a tiny fraction of the
 *                                          graph, not "run the algorithm"
 *
 *   Static edge weights (straight-line    Live/historical traffic-weighted
 *   distance between hand-placed nodes)   edges, updated continuously
 *
 *   Single in-process JS graph, loaded    Distributed routing services,
 *   into memory once                      often written in C++, serving
 *                                          enormous precomputed graphs
 *
 *   Whole graph fits trivially in one     Real road graphs are far too large
 *   process's memory                      for naive single-machine Dijkstra
 *                                          to be workable at request-time -
 *                                          this is EXACTLY why the
 *                                          precomputation techniques above
 *                                          exist
 *
 * The purpose of this module is to correctly DEMONSTRATE the algorithm
 * (adjacency list, priority queue, distance/parent maps, visited set -
 * see dsa/dijkstra.ts) on data small enough to verify by hand, not to
 * pretend this is how RideX would route real trips at scale. Fare
 * estimation (Phase 6) deliberately continues to use a direct Haversine
 * calculation rather than this engine, for exactly this reason - this
 * routing engine's job is being a correct, testable Dijkstra reference,
 * not a fare-critical production dependency.
 * ============================================================================
 */

let cachedGraph: Graph | null = null;
let cachedNodes: Map<string, RoadNodeRecord> | null = null;

/**
 * The graph is loaded from Postgres once and cached in memory for the
 * process's lifetime (not re-queried on every route request) - Dijkstra
 * needs random access to the full adjacency list as it runs, which
 * would mean dozens of DB round-trips per query if the graph lived in
 * Postgres alone. This is a deliberately simple cache (no TTL, no
 * invalidation) appropriate for data that's essentially static once
 * seeded; a real system with an editable road graph would need cache
 * invalidation on writes, which doesn't exist yet because nothing
 * currently writes to road_nodes/road_edges after seeding.
 */
async function getGraph(): Promise<{ graph: Graph; nodes: Map<string, RoadNodeRecord> }> {
  if (cachedGraph && cachedNodes) {
    return { graph: cachedGraph, nodes: cachedNodes };
  }

  const [nodeRows, edgeRows] = await Promise.all([
    routingRepository.loadAllNodes(),
    routingRepository.loadAllEdges(),
  ]);

  if (nodeRows.length === 0) {
    throw ApiError.internal("Road network graph is empty - run `npm run seed:routing`");
  }

  const graph = new Graph();
  const nodes = new Map<string, RoadNodeRecord>();

  for (const node of nodeRows) {
    graph.addNode(node.id);
    nodes.set(node.id, node);
  }
  for (const edge of edgeRows) {
    graph.addEdge(edge.from_node_id, edge.to_node_id, Number(edge.distance_meters), edge.is_bidirectional);
  }

  cachedGraph = graph;
  cachedNodes = nodes;
  logger.info({ nodes: graph.nodeCount, edges: graph.edgeCount }, "Routing graph loaded into memory");
  return { graph, nodes };
}

/** Exposed for tests that need to force a reload after re-seeding. */
export function clearGraphCache(): void {
  cachedGraph = null;
  cachedNodes = null;
}

function findNearestNode(point: GeoPoint, nodes: Map<string, RoadNodeRecord>): RoadNodeRecord {
  let nearest: RoadNodeRecord | null = null;
  let nearestDistance = Infinity;

  for (const node of nodes.values()) {
    const distance = haversineDistanceMeters(point, { lat: node.lat, lng: node.lng });
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = node;
    }
  }

  return nearest!; // nodes is never empty - getGraph() throws first if it is
}

export const routingService = {
  /**
   * Computes the shortest path between two real-world coordinates by
   * "snapping" each to its nearest graph node, then running Dijkstra
   * between those two nodes. This snapping step is itself a
   * simplification worth naming: production map-matching accounts for
   * which ROAD a point is actually on and its position along that road
   * segment, not just "nearest intersection by straight-line distance."
   */
  async computeRoute(from: GeoPoint, to: GeoPoint): Promise<RouteResult> {
    const { graph, nodes } = await getGraph();

    const fromNode = findNearestNode(from, nodes);
    const toNode = findNearestNode(to, nodes);

    const { distances, parents, visitedOrder } = dijkstra(graph, fromNode.id);
    const pathIds = reconstructPath(parents, fromNode.id, toNode.id);

    if (!pathIds) {
      throw ApiError.notFound("No route exists between these points in the road network graph");
    }

    const path = pathIds.map((id) => {
      const node = nodes.get(id)!;
      return { nodeId: node.id, label: node.label, lat: node.lat, lng: node.lng };
    });

    return {
      path,
      distanceMeters: Math.round(distances.get(toNode.id)! * 100) / 100,
      nodesExplored: visitedOrder.length,
      totalGraphNodes: graph.nodeCount,
      totalGraphEdges: graph.edgeCount,
      algorithm: {
        name: "Dijkstra",
        timeComplexity: "O((V + E) log V)",
        spaceComplexity: "O(V + E)",
      },
    };
  },

  /** Convenience wrapper matching spec section 10's named use case: driver's current position to the rider's pickup point. */
  async driverToRider(driverLocation: GeoPoint, riderPickup: GeoPoint): Promise<RouteResult> {
    return this.computeRoute(driverLocation, riderPickup);
  },

  /** Convenience wrapper for the second named use case: rider's pickup to their destination. */
  async riderToDestination(pickup: GeoPoint, destination: GeoPoint): Promise<RouteResult> {
    return this.computeRoute(pickup, destination);
  },
};
