/**
 * A generic binary min-heap, implemented from scratch (array-backed,
 * 0-indexed: parent of i is (i-1)/2, children of i are 2i+1 and 2i+2).
 *
 * This is what gives Dijkstra its O((V+E) log V) time complexity: a
 * naive "scan all unvisited nodes for the minimum" implementation is
 * O(V^2) overall, since every one of V extract-min operations costs
 * O(V). A binary heap makes both insert and extract-min O(log N),
 * bringing the total to O((V+E) log V) - E edge relaxations, each
 * potentially pushing a new heap entry, plus V extractions.
 *
 * Deliberately does NOT implement decrease-key (which a theoretically
 * "purer" Dijkstra would use to update an existing heap entry in
 * place). Instead, `dijkstra.ts` uses "lazy deletion": when a shorter
 * path to a node is found, a NEW entry is pushed rather than mutating
 * an old one, and stale/superseded entries are simply skipped when
 * popped (by checking a `visited` set). This is a well-known,
 * standard simplification - it costs at most a constant factor in
 * extra heap entries (each edge relaxation adds at most one), so it
 * doesn't change the overall O((V+E) log V) bound, and it avoids the
 * real complexity of implementing an indexed/addressable heap.
 */
export class MinPriorityQueue<T> {
  private heap: { priority: number; value: T }[] = [];

  get size(): number {
    return this.heap.length;
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  insert(value: T, priority: number): void {
    this.heap.push({ priority, value });
    this.siftUp(this.heap.length - 1);
  }

  /** Removes and returns the lowest-priority (minimum) element, or undefined if empty. O(log N). */
  extractMin(): T | undefined {
    if (this.heap.length === 0) return undefined;

    const min = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return min.value;
  }

  peekPriority(): number | undefined {
    return this.heap[0]?.priority;
  }

  private siftUp(index: number): void {
    let i = index;
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (this.heap[parent].priority <= this.heap[i].priority) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  private siftDown(index: number): void {
    let i = index;
    const n = this.heap.length;
    for (;;) {
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      let smallest = i;

      if (left < n && this.heap[left].priority < this.heap[smallest].priority) smallest = left;
      if (right < n && this.heap[right].priority < this.heap[smallest].priority) smallest = right;
      if (smallest === i) break;

      this.swap(i, smallest);
      i = smallest;
    }
  }

  private swap(i: number, j: number): void {
    [this.heap[i], this.heap[j]] = [this.heap[j], this.heap[i]];
  }
}
