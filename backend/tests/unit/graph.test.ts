import { Graph } from "../../src/modules/routing/dsa/graph";

describe("Graph (adjacency list)", () => {
  it("addEdge implicitly creates both endpoint nodes", () => {
    const g = new Graph();
    g.addEdge("A", "B", 10);
    expect(g.hasNode("A")).toBe(true);
    expect(g.hasNode("B")).toBe(true);
    expect(g.nodeCount).toBe(2);
  });

  it("a bidirectional edge appears in both directions' adjacency lists", () => {
    const g = new Graph();
    g.addEdge("A", "B", 10, true);

    expect(g.getNeighbors("A")).toEqual([{ to: "B", weight: 10 }]);
    expect(g.getNeighbors("B")).toEqual([{ to: "A", weight: 10 }]);
  });

  it("a one-way (directed) edge only appears in the 'from' node's list", () => {
    const g = new Graph();
    g.addEdge("A", "B", 10, false);

    expect(g.getNeighbors("A")).toEqual([{ to: "B", weight: 10 }]);
    expect(g.getNeighbors("B")).toEqual([]);
  });

  it("returns an empty neighbor list for an unknown node rather than throwing", () => {
    const g = new Graph();
    expect(g.getNeighbors("nonexistent")).toEqual([]);
  });

  it("supports multiple edges from the same node", () => {
    const g = new Graph();
    g.addEdge("A", "B", 5);
    g.addEdge("A", "C", 7);
    g.addEdge("A", "D", 3);

    expect(g.getNeighbors("A")).toHaveLength(3);
  });

  it("nodeCount and edgeCount reflect the graph's actual size", () => {
    const g = new Graph();
    g.addEdge("A", "B", 1); // bidirectional -> 2 adjacency entries
    g.addEdge("B", "C", 1); // bidirectional -> 2 adjacency entries

    expect(g.nodeCount).toBe(3);
    expect(g.edgeCount).toBe(4);
  });

  it("addNode alone creates an isolated node with no edges", () => {
    const g = new Graph();
    g.addNode("isolated");
    expect(g.hasNode("isolated")).toBe(true);
    expect(g.getNeighbors("isolated")).toEqual([]);
  });
});
