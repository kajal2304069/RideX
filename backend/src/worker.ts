import { startNotificationWorker } from "./workers/notificationWorker";
import { startMarketplaceWorker } from "./workers/marketplaceWorker";
import { closeMarketplaceQueue } from "./queues/marketplaceQueue";
import { startMaintenanceWorker } from "./workers/maintenanceWorker";
import { closeMaintenanceQueue } from "./queues/maintenanceQueue";
import { startRentalWorker } from "./workers/rentalWorker";
import { closeRentalQueue } from "./queues/rentalQueue";
import { logger } from "./config/logger";
import { pool } from "./db/pool";
import { redis } from "./config/redis";
import { closeBullMQConnection } from "./config/bullmqConnection";
import { closeNotificationQueue } from "./queues/notificationQueue";

/**
 * Standalone worker process: `npm run worker`. Scales independently of the
 * API (more workers = more throughput) and a stuck provider here can never
 * slow request handling.
 */
const workers = [startNotificationWorker(), startMarketplaceWorker(), startRentalWorker(), startMaintenanceWorker()];

async function shutdown(signal: string) {
  logger.info(`${signal} received - draining worker`);
  await Promise.all(workers.map((w) => w.close())); // waits for in-flight jobs
  await closeNotificationQueue();
  await closeMarketplaceQueue();
  await closeRentalQueue();
  await closeMaintenanceQueue();
  await closeBullMQConnection();
  await pool.end();
  redis.disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
