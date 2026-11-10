import { Pool, PoolClient } from "pg";
import { env } from "../config/env";
import { logger } from "../config/logger";

/**
 * PostgreSQL is RideX's SOURCE OF TRUTH.
 * Everything that must be durable and consistent lives here:
 * users, rides, payments, vehicles, marketplace listings, etc.
 *
 * High-frequency / ephemeral data (live GPS pings, geo search, caches,
 * distributed locks) intentionally does NOT live here - see redis.ts.
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.PG_POOL_MAX,
  idleTimeoutMillis: env.PG_POOL_IDLE_TIMEOUT_MS,
});

pool.on("error", (err) => {
  // Fired on idle client errors (e.g. connection dropped by DB) - never let
  // this crash the whole process silently, always log it.
  logger.error({ err }, "Unexpected PostgreSQL pool error");
});

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function checkDbHealth(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
