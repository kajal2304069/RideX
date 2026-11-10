import { randomUUID } from "crypto";
import { redis } from "../config/redis";

/**
 * A distributed lock using Redis's `SET key value NX PX ttl` (spec
 * section 28: "distributed locks"). This is a genuinely different tool
 * from the concurrency mechanisms used elsewhere in the project:
 *
 *   - `SELECT ... FOR UPDATE` (Phase 6, ride acceptance) locks a
 *     specific ROW inside a Postgres transaction - it only protects
 *     concurrent access to data that already lives in Postgres, and
 *     only for the duration of that one transaction.
 *   - This Redis lock protects an arbitrary CRITICAL SECTION of
 *     application code - useful when the thing being coordinated isn't
 *     (only) a database row, or spans multiple operations/services that
 *     don't share a single Postgres transaction.
 *
 * `NX` (only set if the key doesn't already exist) is what makes
 * acquisition atomic: two concurrent callers racing to acquire the same
 * lock key can never both succeed, because Redis processes commands
 * single-threaded - one `SET ... NX` wins, the other gets a `null`
 * reply and knows it lost. `PX` (expiry in milliseconds) is a safety
 * net: if the lock holder crashes before releasing, the lock still
 * expires on its own rather than deadlocking every future acquisition
 * attempt forever.
 *
 * The lock's VALUE is a random token unique to this specific acquisition
 * (not just a boolean/1), and release checks that token matches before
 * deleting - this prevents a subtle bug: if the lock expired on its own
 * (the holder was slow) and a DIFFERENT caller acquired it in the
 * meantime, the original (slow) caller's eventual `release()` call must
 * NOT delete the new caller's lock. Checking the token first makes
 * release safe even after expiry-driven handover. The check-then-delete
 * is itself done as a single Lua script so it's atomic (no window where
 * another process could grab the lock between the GET check and the DEL).
 */
const RELEASE_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  else
    return 0
  end
`;

export interface LockHandle {
  key: string;
  token: string;
  release(): Promise<boolean>;
}

/** Attempts to acquire the lock once, immediately. Returns null if someone else already holds it. */
export async function tryAcquireLock(key: string, ttlMs: number): Promise<LockHandle | null> {
  const token = randomUUID();
  const result = await redis.set(key, token, "PX", ttlMs, "NX");
  if (result !== "OK") return null;

  return {
    key,
    token,
    release: () => releaseLock(key, token),
  };
}

async function releaseLock(key: string, token: string): Promise<boolean> {
  const result = await redis.eval(RELEASE_SCRIPT, 1, key, token);
  return result === 1;
}

/**
 * Runs `fn` while holding the lock, retrying acquisition with a short
 * backoff until `maxWaitMs` elapses. This is the version most callers
 * want - `tryAcquireLock` alone only makes sense when the caller has a
 * specific reason to fail fast instead of waiting.
 */
export async function withLock<T>(
  key: string,
  fn: () => Promise<T>,
  options: { ttlMs?: number; maxWaitMs?: number; retryDelayMs?: number } = {}
): Promise<T> {
  const ttlMs = options.ttlMs ?? 5000;
  const maxWaitMs = options.maxWaitMs ?? 3000;
  const retryDelayMs = options.retryDelayMs ?? 50;

  const deadline = Date.now() + maxWaitMs;
  let handle: LockHandle | null = null;

  while (Date.now() < deadline) {
    handle = await tryAcquireLock(key, ttlMs);
    if (handle) break;
    await sleep(retryDelayMs);
  }

  if (!handle) {
    throw new Error(`Could not acquire lock "${key}" within ${maxWaitMs}ms`);
  }

  try {
    return await fn();
  } finally {
    await handle.release();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
