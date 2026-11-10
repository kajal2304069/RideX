import { Queue } from "bullmq";
import { env } from "../config/env";
import { getBullMQConnection } from "../config/bullmqConnection";

export const MARKETPLACE_QUEUE = "marketplace";

export interface ExpireOfferJob {
  offerId: string;
}

let queue: Queue<ExpireOfferJob> | null = null;

export function getMarketplaceQueue(): Queue<ExpireOfferJob> {
  if (!queue) {
    queue = new Queue<ExpireOfferJob>(MARKETPLACE_QUEUE, {
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

/**
 * Schedules the "buyer did not pay in time" check. A BullMQ DELAYED job is the right tool: it survives restarts (it is
 * in Redis), it is fired once by exactly one worker, and nothing polls. The jobId is deterministic, so scheduling the
 * same offer twice is a no-op.
 *
 * This is the happy-path timer, not the only safeguard: the payment path also refuses an offer that is past its
 * deadline, so a lost or late job can never let a stale offer be paid.
 */
export async function scheduleOfferExpiry(offerId: string, delayMs: number): Promise<void> {
  await getMarketplaceQueue().add("expire-offer", { offerId }, { jobId: `expire-offer__${offerId}`, delay: delayMs });
}

export async function closeMarketplaceQueue(): Promise<void> {
  if (!queue) return;
  const q = queue;
  queue = null;
  await q.close();
}
