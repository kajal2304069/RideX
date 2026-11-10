import { Queue } from "bullmq";
import { env } from "../config/env";
import { getBullMQConnection } from "../config/bullmqConnection";
import { NotificationJob } from "../modules/notifications/types/notifications.types";

export const NOTIFICATION_QUEUE = "notifications";

let queue: Queue<NotificationJob> | null = null;

/**
 * Retry policy: 5 attempts with exponential backoff (1s, 2s, 4s, 8s by
 * default). A job that still fails stays in BullMQ's `failed` set - that
 * set is our dead-letter queue; it is inspectable and retryable, and the
 * admin stats endpoint reports its size.
 *
 * removeOnComplete is bounded (count + age) so Redis memory cannot grow
 * without limit. Consequence: after removal BullMQ forgets the jobId, so
 * the DB unique index on (user_id, dedupe_key) is what makes a late
 * duplicate harmless.
 */
export function getNotificationQueue(): Queue<NotificationJob> {
  if (!queue) {
    queue = new Queue<NotificationJob>(NOTIFICATION_QUEUE, {
      connection: getBullMQConnection(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: env.NOTIFICATION_BACKOFF_MS },
        removeOnComplete: { count: 1000, age: 3600 },
        removeOnFail: { count: 5000 },
      },
    });
  }
  return queue;
}

export async function closeNotificationQueue(): Promise<void> {
  if (!queue) return;
  const q = queue;
  queue = null;
  await q.close();
}
