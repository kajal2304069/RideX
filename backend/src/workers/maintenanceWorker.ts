import { Worker } from "bullmq";
import { logger } from "../config/logger";
import { getBullMQConnection } from "../config/bullmqConnection";
import { MAINTENANCE_QUEUE, scheduleMaintenanceScan } from "../queues/maintenanceQueue";
import { maintenanceService } from "../modules/maintenance/services/maintenance.service";

export function startMaintenanceWorker(): Worker {
  const worker = new Worker(MAINTENANCE_QUEUE, () => maintenanceService.scan(), { connection: getBullMQConnection(), concurrency: 1 });
  worker.on("failed", (job, err) => logger.warn({ jobId: job?.id, err: err.message }, "Maintenance job failed"));
  worker.on("error", (err) => logger.error({ err }, "Maintenance worker error"));
  scheduleMaintenanceScan().catch((err) => logger.error({ err }, "Could not register the maintenance schedule"));
  logger.info("Maintenance worker started");
  return worker;
}
