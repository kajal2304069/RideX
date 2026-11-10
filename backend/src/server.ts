import http from "http";
import { createApp } from "./app";
import { createSocketServer } from "./websocket";
import { setIO } from "./websocket/io";
import { startDraining } from "./observability/lifecycle";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { pool } from "./db/pool";
import { redis } from "./config/redis";
import { startNotificationSubscriber } from "./modules/notifications/services/realtimeBridge";
import { startNotificationWorker } from "./workers/notificationWorker";
import { startMarketplaceWorker } from "./workers/marketplaceWorker";
import { closeMarketplaceQueue } from "./queues/marketplaceQueue";
import { startMaintenanceWorker } from "./workers/maintenanceWorker";
import { closeMaintenanceQueue } from "./queues/maintenanceQueue";
import { startRentalWorker } from "./workers/rentalWorker";
import { closeRentalQueue } from "./queues/rentalQueue";
import { closeNotificationQueue } from "./queues/notificationQueue";
import { closeBullMQConnection } from "./config/bullmqConnection";
import { emitToRoom, userRoom } from "./websocket/io";

const app = createApp();
const httpServer = http.createServer(app);
const io = createSocketServer(httpServer);

// Makes `io` reachable from any service via websocket/io.ts's getIO(),
// without those services importing this file or knowing anything about
// HTTP servers - see io.ts's docblock for the full rationale.
setIO(io);

// Phase 13: the worker (here or in another process) publishes new notifications
// to Redis; this process pushes them to the user's sockets.
let stopSubscriber: (() => Promise<void>) | null = null;
startNotificationSubscriber(({ userId, notification }) => emitToRoom(userRoom(userId), "notification:new", notification))
  .then((stop) => (stopSubscriber = stop))
  .catch((err) => logger.error({ err }, "Could not start notification subscriber"));

// Dev convenience. In production run `npm run worker` as its own process.
const inlineWorkers = env.START_WORKER === "true" ? [startNotificationWorker(), startMarketplaceWorker(), startRentalWorker(), startMaintenanceWorker()] : [];

httpServer.listen(env.PORT, () => {
  logger.info(`🚗 RideX backend listening on port ${env.PORT} [${env.NODE_ENV}]`);
});

/**
 * Graceful shutdown: stop accepting new connections, let in-flight
 * requests finish, then close DB/Redis pools cleanly. Important for
 * zero-downtime deploys and container orchestrators sending SIGTERM.
 */
async function shutdown(signal: string) {
  logger.info(`${signal} received - draining for ${env.SHUTDOWN_DRAIN_MS}ms, then shutting down gracefully`);
  startDraining(); // /ready now answers 503 so the load balancer stops routing to us
  await new Promise((r) => setTimeout(r, env.SHUTDOWN_DRAIN_MS));

  httpServer.close(async () => {
    try {
      await Promise.all(inlineWorkers.map((w) => w.close()));
      await closeMarketplaceQueue();
      await closeRentalQueue();
      await closeMaintenanceQueue();
      await stopSubscriber?.();
      await closeNotificationQueue();
      await closeBullMQConnection();
      await pool.end();
      redis.disconnect();
      logger.info("Shutdown complete");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "Error during shutdown");
      process.exit(1);
    }
  });

  // Failsafe: force-exit if something hangs
  setTimeout(() => {
    logger.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10000 + env.SHUTDOWN_DRAIN_MS).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection");
});

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception - exiting");
  process.exit(1);
});
