import { Queue } from "bullmq";
import { getBullMQConnection } from "../config/bullmqConnection";

export const MAINTENANCE_QUEUE = "maintenance";

let queue: Queue | null = null;
export function getMaintenanceQueue(): Queue {
  if (!queue) {
    queue = new Queue(MAINTENANCE_QUEUE, {
      connection: getBullMQConnection(),
      defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: { count: 30 }, removeOnFail: { count: 100 } },
    });
  }
  return queue;
}

/**
 * Registers the daily scan. A job SCHEDULER (not a plain delayed job) is stored in Redis under a fixed id, so calling
 * this on every worker start is idempotent: ten workers booting still produce exactly one schedule, and the schedule
 * survives restarts. 06:00 UTC = 11:30 IST.
 */
export const MAINTENANCE_SCHEDULER_ID = "maintenance-daily-scan";
export async function scheduleMaintenanceScan(pattern = "0 6 * * *"): Promise<void> {
  await getMaintenanceQueue().upsertJobScheduler(MAINTENANCE_SCHEDULER_ID, { pattern }, { name: "scan", data: {} });
}

export async function closeMaintenanceQueue(): Promise<void> {
  if (!queue) return;
  const q = queue;
  queue = null;
  await q.close();
}
