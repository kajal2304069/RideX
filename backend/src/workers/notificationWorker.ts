import { Worker } from "bullmq";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { getBullMQConnection } from "../config/bullmqConnection";
import { NOTIFICATION_QUEUE } from "../queues/notificationQueue";
import { notificationsService } from "../modules/notifications/services/notifications.service";
import { NotificationJob } from "../modules/notifications/types/notifications.types";

export function startNotificationWorker(concurrency = env.NOTIFICATION_WORKER_CONCURRENCY): Worker<NotificationJob> {
  const worker = new Worker<NotificationJob>(NOTIFICATION_QUEUE, (job) => notificationsService.process(job.data), {
    connection: getBullMQConnection(),
    concurrency,
  });

  worker.on("failed", (job, err) => {
    const exhausted = job ? job.attemptsMade >= (job.opts.attempts ?? 1) : true;
    const fields = { jobId: job?.id, type: job?.data.type, attempt: job?.attemptsMade, err: err.message };
    if (exhausted) logger.error(fields, "Notification job failed permanently (kept in failed set / DLQ)");
    else logger.warn(fields, "Notification job failed, will retry");
  });
  worker.on("error", (err) => logger.error({ err }, "Notification worker error"));

  logger.info({ concurrency }, "Notification worker started");
  return worker;
}
