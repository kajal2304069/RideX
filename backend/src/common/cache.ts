import { redis } from "../config/redis";
import { logger } from "../config/logger";

/**
 * A generic read-through cache (spec section 28: "Caching"). `getOrSet`
 * is the whole API: given a key and a function that computes the real
 * value, it serves from Redis on a cache hit, or calls `compute()` and
 * populates Redis on a miss - callers never need to think about cache
 * bookkeeping themselves.
 *
 * Best suited for read-heavy, infrequently-changing data - vehicle
 * type rates (used on every fare estimate and ride request) are the
 * canonical example in this project: the underlying Postgres rows
 * change essentially never after seeding, but are read on nearly every
 * ride-related request. Caching them removes a repeated, low-value
 * database round-trip from a hot path.
 *
 * Deliberately NOT used for anything that must always reflect the
 * absolute latest state (ride status, driver location, account
 * balances) - a cache is only safe to introduce where a short window
 * of staleness (bounded by `ttlSeconds`) is an acceptable trade-off,
 * which is a judgment call made per call-site, not something this
 * generic utility can enforce.
 */
export async function getOrSetCache<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>
): Promise<T> {
  try {
    const cached = await redis.get(key);
    if (cached !== null) {
      return JSON.parse(cached) as T;
    }
  } catch (err) {
    // A Redis read failure should degrade to "just compute it," not
    // break the request - caching is a performance optimization, never
    // a correctness dependency.
    logger.warn({ err, key }, "Cache read failed, falling back to source");
  }

  const value = await compute();

  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch (err) {
    logger.warn({ err, key }, "Cache write failed - value still returned, just not cached");
  }

  return value;
}

export async function invalidateCache(key: string): Promise<void> {
  await redis.del(key);
}

export async function invalidateCachePattern(pattern: string): Promise<void> {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}
