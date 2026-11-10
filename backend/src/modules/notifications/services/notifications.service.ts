import { UnrecoverableError } from "bullmq";
import { ApiError } from "../../../common/ApiError";
import { logger } from "../../../config/logger";
import { getNotificationQueue } from "../../../queues/notificationQueue";
import { notificationsRepository } from "../repositories/notifications.repository";
import { NotificationJob, NotificationType, PublicNotification, toPublicNotification } from "../types/notifications.types";
import { getEmailChannel } from "./channels/EmailChannel";
import { publishNotification } from "./realtimeBridge";
import { renderNotification } from "./templates";

/** BullMQ forbids ':' in custom job ids, so the key uses '__'. */
export function buildDedupeKey(type: NotificationType, entityId: string): string {
  return `${type}__${entityId}`;
}

export const notificationsService = {
  /**
   * PRODUCER. Called from request paths (ride accepted, payment succeeded...).
   *
   * - Enqueues and returns; no email, no extra DB write, no socket on the
   *   request path, so a slow provider cannot slow a ride request.
   * - Never throws. A ride that was accepted must not turn into a 500 because
   *   Redis hiccuped while enqueuing a courtesy message. Failures are logged.
   * - jobId = type + entity + user, so enqueuing the same event twice is a
   *   no-op while the job is still known to BullMQ.
   */
  async notify(userId: string, type: NotificationType, entityId: string, data: Record<string, unknown> = {}): Promise<void> {
    try {
      const job: NotificationJob = { userId, type, entityId, data };
      await getNotificationQueue().add(type, job, { jobId: `${buildDedupeKey(type, entityId)}__${userId}` });
    } catch (err) {
      logger.error({ err, userId, type, entityId }, "Failed to enqueue notification");
    }
  },

  /**
   * CONSUMER. Run by the worker for each job. Every step is safe to repeat,
   * because BullMQ retries a job from the top after any failure:
   *
   *   1. insert the in-app row      - ON CONFLICT DO NOTHING (idempotent)
   *   2. publish to realtime        - only when the row was newly inserted
   *   3. send email (if the type wants one) and stamp email_sent_at
   *      - only while email_sent_at IS NULL
   *
   * Delivery guarantee: in-app is exactly-once (unique index). Email is
   * at-least-once: a crash between the provider accepting the mail and our
   * stamp could resend it. Real providers accept an idempotency key to
   * close that last gap.
   */
  async process(job: NotificationJob): Promise<void> {
    const contact = await notificationsRepository.findUserContact(job.userId);
    if (!contact) {
      // Retrying cannot make a missing user appear. Fail permanently, skip remaining attempts.
      throw new UnrecoverableError(`User ${job.userId} not found`);
    }

    const rendered = renderNotification(job.type, job.data);
    const { row, inserted } = await notificationsRepository.insertIfAbsent({
      userId: job.userId,
      type: job.type,
      title: rendered.title,
      body: rendered.body,
      data: { ...job.data, entityId: job.entityId },
      dedupeKey: buildDedupeKey(job.type, job.entityId),
    });

    if (inserted) {
      try {
        await publishNotification({ userId: job.userId, notification: toPublicNotification(row) });
      } catch (err) {
        // Live push is best-effort; the row is stored. Do not fail (and re-run) the whole job for it.
        logger.warn({ err, notificationId: row.id }, "Realtime publish failed");
      }
    }

    if (rendered.email && !row.email_sent_at) {
      await getEmailChannel().send({ to: contact.email, subject: rendered.title, text: rendered.body });
      await notificationsRepository.markEmailSent(row.id);
    }
  },

  async list(userId: string, opts: { limit: number; unreadOnly: boolean; before?: Date }): Promise<PublicNotification[]> {
    return (await notificationsRepository.list(userId, opts)).map(toPublicNotification);
  },

  async unreadCount(userId: string): Promise<number> {
    return notificationsRepository.countUnread(userId);
  },

  async markRead(id: string, userId: string): Promise<PublicNotification> {
    const row = await notificationsRepository.markRead(id, userId);
    if (!row) throw ApiError.notFound("Notification not found");
    return toPublicNotification(row);
  },

  async markAllRead(userId: string): Promise<number> {
    return notificationsRepository.markAllRead(userId);
  },

  async queueStats() {
    const counts = await getNotificationQueue().getJobCounts("waiting", "active", "delayed", "completed", "failed");
    return counts;
  },
};
