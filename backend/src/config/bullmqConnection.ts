import Redis from "ioredis";
import { env } from "./env";
import { logger } from "./logger";

/**
 * BullMQ gets its own Redis connection, separate from `config/redis.ts`
 * (Phase 11 explains why: blocking commands, and `maxRetriesPerRequest`
 * must be null for BullMQ but is wrong for the request path).
 *
 * Phase 13 makes it LAZY. The connection used to open the moment the
 * module was imported; now that rides/payments import the notification
 * producer, that would open a second Redis socket in every process and
 * every test that merely loads the app. Creating it on first use means
 * only code that really enqueues or consumes jobs pays for it.
 */
let connection: Redis | null = null;

export function getBullMQConnection(): Redis {
  if (!connection) {
    connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    connection.on("error", (err) => {
      logger.error({ err }, "BullMQ Redis connection error");
    });
  }
  return connection;
}

export async function closeBullMQConnection(): Promise<void> {
  if (!connection) return;
  const c = connection;
  connection = null;
  c.disconnect();
}
