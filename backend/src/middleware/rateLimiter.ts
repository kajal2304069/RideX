import rateLimit from "express-rate-limit";
import { RedisStore, RedisReply } from "rate-limit-redis";
import { redis } from "../config/redis";
import { env } from "../config/env";

const skipInTests = () => env.NODE_ENV === "test";

/**
 * Backed by Redis (not the in-memory default store) - this is the
 * Phase 2/5 follow-up explicitly flagged at the time: an in-memory
 * counter is scoped to a single Node process, so once the backend runs
 * as more than one instance behind a load balancer, each instance
 * would independently allow its own full quota - a client hammering
 * the API could get N times the intended limit just by having requests
 * spread across N instances. A RedisStore makes the counter shared
 * state every instance reads/writes, so the limit is enforced against
 * the fleet as a whole, not per-process.
 *
 * `RedisStore`'s `sendCommand` is a thin adapter to ioredis's `.call()`
 * (rate-limit-redis is client-library-agnostic; this is the one line
 * that couples it to the specific ioredis instance this project uses -
 * see config/redis.ts).
 */
function redisStore(prefix: string) {
  return new RedisStore({
    sendCommand: (...args: string[]) =>
      (redis.call as (...a: string[]) => Promise<RedisReply>)(...args),
    prefix,
  });
}

/**
 * Global, coarse rate limit applied to all routes. Auth routes (login,
 * register) get a stricter, dedicated limiter (see auth.routes.ts)
 * sharing the same Redis-backed approach.
 */
export const globalRateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  store: redisStore("rl:global:"),
  message: {
    success: false,
    error: { code: "RATE_LIMITED", message: "Too many requests, please slow down." },
  },
});

export { redisStore };
