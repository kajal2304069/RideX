import { redis } from "../../src/config/redis";
import { tryAcquireLock, withLock } from "../../src/common/redisLock";

async function cleanupKey(key: string) {
  await redis.del(key);
}

describe("Redis distributed lock (live Redis)", () => {
  afterAll(() => {
    redis.disconnect();
  });

  describe("tryAcquireLock", () => {
    it("acquires an unheld lock", async () => {
      const key = "lock:test:acquire-1";
      const handle = await tryAcquireLock(key, 5000);
      expect(handle).not.toBeNull();
      await handle!.release();
    });

    it("fails to acquire an already-held lock", async () => {
      const key = "lock:test:acquire-2";
      const first = await tryAcquireLock(key, 5000);
      const second = await tryAcquireLock(key, 5000);

      expect(first).not.toBeNull();
      expect(second).toBeNull(); // someone already holds it

      await first!.release();
      await cleanupKey(key);
    });

    it("can be acquired again after being released", async () => {
      const key = "lock:test:acquire-3";
      const first = await tryAcquireLock(key, 5000);
      await first!.release();

      const second = await tryAcquireLock(key, 5000);
      expect(second).not.toBeNull();
      await second!.release();
    });

    it("expires on its own after the TTL even if never released (crash safety)", async () => {
      const key = "lock:test:ttl-expiry";
      await tryAcquireLock(key, 200); // very short TTL, deliberately never released

      await new Promise((resolve) => setTimeout(resolve, 350));

      const afterExpiry = await tryAcquireLock(key, 5000);
      expect(afterExpiry).not.toBeNull(); // the expired lock no longer blocks acquisition
      await afterExpiry!.release();
    });

    it("release() does not delete a DIFFERENT holder's lock acquired after this one expired", async () => {
      const key = "lock:test:token-safety";
      const original = await tryAcquireLock(key, 150);
      await new Promise((resolve) => setTimeout(resolve, 250)); // let it expire

      const newHolder = await tryAcquireLock(key, 5000);
      expect(newHolder).not.toBeNull();

      // The original handle's release() call arrives "late" - it must be a
      // no-op, NOT delete newHolder's still-valid lock (the token check
      // inside releaseLock's Lua script is exactly what prevents this).
      const releasedSomething = await original!.release();
      expect(releasedSomething).toBe(false);

      const stillHeld = await redis.get(key);
      expect(stillHeld).toBe(newHolder!.token); // newHolder's lock survived

      await newHolder!.release();
    });
  });

  describe("withLock - real concurrency test", () => {
    it("serializes concurrent callers: only one runs the critical section at a time", async () => {
      const key = "lock:test:mutual-exclusion";
      let concurrentCount = 0;
      let maxConcurrentObserved = 0;
      const executionOrder: number[] = [];

      const criticalSection = async (id: number) => {
        concurrentCount++;
        maxConcurrentObserved = Math.max(maxConcurrentObserved, concurrentCount);
        await new Promise((resolve) => setTimeout(resolve, 30)); // simulate work
        executionOrder.push(id);
        concurrentCount--;
      };

      // Fire 5 concurrent attempts to run the SAME critical section.
      await Promise.all(
        [1, 2, 3, 4, 5].map((id) => withLock(key, () => criticalSection(id), { maxWaitMs: 2000 }))
      );

      // The whole point of the lock: never more than one execution overlapping.
      expect(maxConcurrentObserved).toBe(1);
      expect(executionOrder).toHaveLength(5);
      expect(new Set(executionOrder).size).toBe(5); // all 5 actually ran, none skipped
    });

    it("releases the lock even if the wrapped function throws", async () => {
      const key = "lock:test:release-on-throw";

      await expect(
        withLock(key, async () => {
          throw new Error("intentional failure");
        })
      ).rejects.toThrow("intentional failure");

      // If the lock weren't released, this second acquisition would time out.
      const canAcquireAgain = await tryAcquireLock(key, 1000);
      expect(canAcquireAgain).not.toBeNull();
      await canAcquireAgain!.release();
    });

    it("throws if the lock cannot be acquired within maxWaitMs", async () => {
      const key = "lock:test:timeout";
      const blocker = await tryAcquireLock(key, 5000); // held for a while, never released in time

      await expect(
        withLock(key, async () => "should never run", { maxWaitMs: 200, retryDelayMs: 20 })
      ).rejects.toThrow(/could not acquire lock/i);

      await blocker!.release();
    });

    it("returns the wrapped function's return value", async () => {
      const result = await withLock("lock:test:return-value", async () => 42);
      expect(result).toBe(42);
    });
  });
});
