import { redis } from "../../src/config/redis";
import { getOrSetCache, invalidateCache, invalidateCachePattern } from "../../src/common/cache";

describe("getOrSetCache (live Redis)", () => {
  afterEach(async () => {
    await redis.del("cache:test:key");
    await redis.del("cache:test:pattern:a", "cache:test:pattern:b");
  });
  afterAll(() => redis.disconnect());

  it("calls compute() on a cache miss and returns its value", async () => {
    const compute = jest.fn().mockResolvedValue({ value: 42 });
    const result = await getOrSetCache("cache:test:key", 60, compute);

    expect(result).toEqual({ value: 42 });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("serves from cache on a hit, without calling compute() again", async () => {
    const compute = jest.fn().mockResolvedValue({ value: 42 });
    await getOrSetCache("cache:test:key", 60, compute); // populates the cache

    const secondCompute = jest.fn().mockResolvedValue({ value: 999 });
    const result = await getOrSetCache("cache:test:key", 60, secondCompute);

    expect(result).toEqual({ value: 42 }); // the ORIGINAL cached value, not secondCompute's
    expect(secondCompute).not.toHaveBeenCalled();
  });

  it("actually persists the value in Redis as JSON", async () => {
    await getOrSetCache("cache:test:key", 60, async () => ({ a: 1, b: "two" }));

    const raw = await redis.get("cache:test:key");
    expect(JSON.parse(raw!)).toEqual({ a: 1, b: "two" });
  });

  it("sets a TTL on the cached key", async () => {
    await getOrSetCache("cache:test:key", 120, async () => "value");

    const ttl = await redis.ttl("cache:test:key");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it("caches falsy-but-defined values correctly (0, empty string) - not treated as a miss", async () => {
    await getOrSetCache("cache:test:key", 60, async () => 0);
    const compute = jest.fn().mockResolvedValue(999);
    const result = await getOrSetCache("cache:test:key", 60, compute);

    expect(result).toBe(0);
    expect(compute).not.toHaveBeenCalled();
  });

  it("invalidateCache removes a specific key, forcing the next call to recompute", async () => {
    await getOrSetCache("cache:test:key", 60, async () => "original");
    await invalidateCache("cache:test:key");

    const compute = jest.fn().mockResolvedValue("recomputed");
    const result = await getOrSetCache("cache:test:key", 60, compute);

    expect(result).toBe("recomputed");
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("invalidateCachePattern removes every matching key", async () => {
    await getOrSetCache("cache:test:pattern:a", 60, async () => "a");
    await getOrSetCache("cache:test:pattern:b", 60, async () => "b");

    await invalidateCachePattern("cache:test:pattern:*");

    expect(await redis.get("cache:test:pattern:a")).toBeNull();
    expect(await redis.get("cache:test:pattern:b")).toBeNull();
  });
});
