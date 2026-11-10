import Redis from "ioredis";
import { env } from "./env";
import { logger } from "./logger";

/**
 * Redis is used for everything that is high-frequency, ephemeral, or
 * needs sub-millisecond access - NOT as a system of record:
 *
 *   - Live driver GPS (Redis GEO)            -> location module
 *   - Nearby-driver / nearby-garage search    -> matching, garages
 *   - Distributed locks (ride assignment)     -> rides / matching
 *   - Rate limiting counters                  -> middleware
 *   - Short-lived caches (fare config, etc.)  -> pricing
 *   - BullMQ queues (separate connection)     -> queues/*
 *
 * A second, dedicated connection is created for BullMQ because BullMQ
 * issues blocking commands that shouldn't share a connection with
 * regular request-path Redis calls.
 */
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  // Cap reconnect backoff and give up after a bounded number of attempts
  // instead of retrying forever - a dead Redis should surface via /ready
  // failing (see checkRedisHealth), not silently retry in the background.
  retryStrategy(times) {
    if (times > 10) return null; // stop retrying
    return Math.min(times * 200, 2000);
  },
});

redis.on("error", (err) => {
  logger.error({ err }, "Redis connection error");
});

redis.on("connect", () => {
  logger.info("Redis connected");
});

export async function checkRedisHealth(): Promise<boolean> {
  try {
    const pong = await redis.ping();
    return pong === "PONG";
  } catch {
    return false;
  }
}
