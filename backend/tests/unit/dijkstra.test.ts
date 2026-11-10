import { Graph } from "../../src/modules/routing/dsa/graph";
import { dijkstra, reconstructPath } from "../../src/modules/routing/dsa/dijkstra";

/**
 * Classic textbook graph (CLRS-style) used to verify the algorithm
 * against known-correct shortest-path distances, not just "it runs".
 *
 *        10
 *   A ---------> B
 *   |            | \
 *  5|          1 |  \ 2
 *   |            |   \
 *   v      3     v    v
 *   C ---------> D --> E
 *   ^                  |
 *   |________9_________|
 *
 * (directed graph; classic example, shortest A->E = 9 via A->C->D->E)
 */
function buildTextbookGraph(): Graph {
  const g = new Graph();
  g.addEdge("A", "B", 10, false);
  g.addEdge("A", "C", 5, false);
  g.addEdge("B", "D", 1, false);
  g.addEdge("B", "E", 2, false);
  g.addEdge("C", "D", 3, false);
  g.addEdge("D", "E", 1, false);
  g.addEdge("E", "C", 9, false);
  return g;
}

describe("dijkstra", () => {
  it("computes correct shortest distances on a known textbook graph", () => {
    const g = buildTextbookGraph();
    const { distances } = dijkstra(g, "A");

    expect(distances.get("A")).toBe(0);
    expect(distances.get("C")).toBe(5); // A -> C direct
    expect(distances.get("D")).toBe(8); // A -> C -> D (5+3)
    expect(distances.get("E")).toBe(9); // A -> C -> D -> E (5+3+1), better than A->B->E (10+2=12)
    expect(distances.get("B")).toBe(10); // A -> B direct (only path)
  });

  it("reconstructs the actual shortest path, not just its length", () => {
    const g = buildTextbookGraph();
    const { parents } = dijkstra(g, "A");
    const path = reconstructPath(parents, "A", "E");

    expect(path).toEqual(["A", "C", "D", "E"]);
  });

  it("returns distance 0 and a single-node path for source-to-source", () => {
    const g = buildTextbookGraph();
    const { distances, parents } = dijkstra(g, "A");

    expect(distances.get("A")).toBe(0);
    expect(reconstructPath(parents, "A", "A")).toEqual(["A"]);
  });

  it("returns Infinity distance and null path for an unreachable node", () => {
    const g = new Graph();
    g.addEdge("A", "B", 1);
    g.addNode("isolated"); // no edges to/from it

    const { distances, parents } = dijkstra(g, "A");

    expect(distances.get("isolated")).toBe(Infinity);
    expect(reconstructPath(parents, "A", "isolated")).toBeNull();
  });

  it("handles a graph with a single node and no edges", () => {
    const g = new Graph();
    g.addNode("only");

    const { distances, visitedOrder } = dijkstra(g, "only");

    expect(distances.get("only")).toBe(0);
    expect(visitedOrder).toEqual(["only"]);
  });

  it("returns empty results when the source node doesn't exist in the graph", () => {
    const g = buildTextbookGraph();
    const { distances, visitedOrder } = dijkstra(g, "nonexistent");

    expect(visitedOrder).toEqual([]);
    // every node still gets initialized to Infinity, just none reachable
    expect(distances.get("A")).toBe(Infinity);
  });

  it("picks the shorter of two paths to the same node (correctness of relaxation)", () => {
    const g = new Graph();
    // Two paths A->D: direct A->D (weight 100) vs A->B->C->D (weight 1+1+1=3)
    g.addEdge("A", "D", 100, false);
    g.addEdge("A", "B", 1, false);
    g.addEdge("B", "C", 1, false);
    g.addEdge("C", "D", 1, false);

    const { distances, parents } = dijkstra(g, "A");

    expect(distances.get("D")).toBe(3);
    expect(reconstructPath(parents, "A", "D")).toEqual(["A", "B", "C", "D"]);
  });

  it("visits every reachable node exactly once (finalizes each node exactly once)", () => {
    const g = buildTextbookGraph();
    const { visitedOrder } = dijkstra(g, "A");

    const uniqueVisited = new Set(visitedOrder);
    expect(uniqueVisited.size).toBe(visitedOrder.length); // no duplicates
    expect(visitedOrder).toHaveLength(5); // A, B, C, D, E all reachable
  });

  it("works correctly on an undirected (bidirectional) graph", () => {
    const g = new Graph();
    g.addEdge("A", "B", 4);
    g.addEdge("B", "C", 3);
    g.addEdge("A", "C", 10);

    const { distances, parents } = dijkstra(g, "A");

    expect(distances.get("C")).toBe(7); // A->B->C (4+3) beats direct A->C (10)
    expect(reconstructPath(parents, "A", "C")).toEqual(["A", "B", "C"]);

    // And from the other direction - undirected means C->A should also work
    const fromC = dijkstra(g, "C");
    expect(fromC.distances.get("A")).toBe(7);
  });

  it("handles a larger grid graph efficiently and correctly", () => {
    // Build a 10x10 grid graph, each node connected to its right and down neighbor with weight 1.
    const g = new Graph();
    const size = 10;
    const id = (x: number, y: number) => `${x},${y}`;
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
        if (x + 1 < size) g.addEdge(id(x, y), id(x + 1, y), 1);
        if (y + 1 < size) g.addEdge(id(x, y), id(x, y + 1), 1);
      }
    }

    const { distances } = dijkstra(g, id(0, 0));
    // Shortest path from corner to corner in a grid is Manhattan distance.
    expect(distances.get(id(9, 9))).toBe(18);
    expect(distances.get(id(5, 5))).toBe(10);
  });
});
