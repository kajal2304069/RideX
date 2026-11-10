import { MinPriorityQueue } from "../../src/modules/routing/dsa/priorityQueue";

describe("MinPriorityQueue", () => {
  it("starts empty", () => {
    const pq = new MinPriorityQueue<string>();
    expect(pq.isEmpty()).toBe(true);
    expect(pq.size).toBe(0);
    expect(pq.extractMin()).toBeUndefined();
  });

  it("extracts the single inserted element", () => {
    const pq = new MinPriorityQueue<string>();
    pq.insert("a", 5);
    expect(pq.extractMin()).toBe("a");
    expect(pq.isEmpty()).toBe(true);
  });

  it("always extracts in ascending priority order", () => {
    const pq = new MinPriorityQueue<string>();
    pq.insert("c", 30);
    pq.insert("a", 10);
    pq.insert("b", 20);
    pq.insert("e", 50);
    pq.insert("d", 40);

    const order = [pq.extractMin(), pq.extractMin(), pq.extractMin(), pq.extractMin(), pq.extractMin()];
    expect(order).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("handles duplicate priorities without losing any element", () => {
    const pq = new MinPriorityQueue<string>();
    pq.insert("x", 10);
    pq.insert("y", 10);
    pq.insert("z", 10);

    const extracted = [pq.extractMin(), pq.extractMin(), pq.extractMin()];
    expect(extracted.sort()).toEqual(["x", "y", "z"]);
  });

  it("correctly reports size as elements are inserted and extracted", () => {
    const pq = new MinPriorityQueue<number>();
    expect(pq.size).toBe(0);
    pq.insert(1, 1);
    pq.insert(2, 2);
    expect(pq.size).toBe(2);
    pq.extractMin();
    expect(pq.size).toBe(1);
  });

  it("maintains heap order under a large randomized workload", () => {
    const pq = new MinPriorityQueue<number>();
    const values = Array.from({ length: 500 }, () => Math.floor(Math.random() * 10000));
    for (const v of values) pq.insert(v, v);

    const extracted: number[] = [];
    while (!pq.isEmpty()) extracted.push(pq.extractMin()!);

    const expected = [...values].sort((a, b) => a - b);
    expect(extracted).toEqual(expected);
  });

  it("peekPriority reflects the current minimum without removing it", () => {
    const pq = new MinPriorityQueue<string>();
    pq.insert("a", 15);
    pq.insert("b", 5);
    expect(pq.peekPriority()).toBe(5);
    expect(pq.size).toBe(2); // peek does not remove
  });
});
