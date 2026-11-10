/**
 * Adjacency-list graph representation (spec section 10's explicit
 * requirement). Chosen over an adjacency MATRIX because a road network
 * is sparse - most intersections connect to only a handful of others,
 * not to every other intersection in the city. An adjacency list is
 * O(V + E) space; a matrix would be O(V^2), wasting enormous space on
 * the (V^2 - E) non-edges that don't exist.
 */
export interface WeightedEdge {
  to: string;
  weight: number;
}

export class Graph {
  private adjacency = new Map<string, WeightedEdge[]>();

  addNode(id: string): void {
    if (!this.adjacency.has(id)) {
      this.adjacency.set(id, []);
    }
  }

  hasNode(id: string): boolean {
    return this.adjacency.has(id);
  }

  /**
   * Adds an edge with the given weight (spec section 10: "Edge weight:
   * distance or travel cost"). Bidirectional by default (most roads can
   * be driven in either direction) - set `bidirectional: false` to model
   * a one-way street.
   */
  addEdge(from: string, to: string, weight: number, bidirectional = true): void {
    this.addNode(from);
    this.addNode(to);
    this.adjacency.get(from)!.push({ to, weight });
    if (bidirectional) {
      this.adjacency.get(to)!.push({ to: from, weight });
    }
  }

  getNeighbors(id: string): WeightedEdge[] {
    return this.adjacency.get(id) ?? [];
  }

  get nodeCount(): number {
    return this.adjacency.size;
  }

  get edgeCount(): number {
    let count = 0;
    for (const edges of this.adjacency.values()) count += edges.length;
    return count; // counts each direction of a bidirectional edge separately, matching adjacency-list storage
  }

  nodeIds(): string[] {
    return [...this.adjacency.keys()];
  }
}
