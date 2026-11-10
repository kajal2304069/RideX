import { Queue } from "bullmq";
import { env } from "../config/env";
import { getBullMQConnection } from "../config/bullmqConnection";

export const RENTAL_QUEUE = "rentals";

export interface ExpireBookingJob {
  bookingId: string;
}

let queue: Queue<ExpireBookingJob> | null = null;

export function getRentalQueue(): Queue<ExpireBookingJob> {
  if (!queue) {
    queue = new Queue<ExpireBookingJob>(RENTAL_QUEUE, {
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
 * Schedules "the renter did not pay in time" for a PENDING_PAYMENT hold. Same idea as the marketplace offer timer:
 * a delayed job with a deterministic id (no ':' allowed by BullMQ, hence '__'). It is only the happy-path timer: the
 * payment path refuses a lapsed hold itself, and a new booking lazily clears stale holds on the listing.
 */
export async function scheduleBookingExpiry(bookingId: string, delayMs: number): Promise<void> {
  await getRentalQueue().add("expire-booking", { bookingId }, { jobId: `expire-booking__${bookingId}`, delay: delayMs });
}

export async function closeRentalQueue(): Promise<void> {
  if (!queue) return;
  const q = queue;
  queue = null;
  await q.close();
}
