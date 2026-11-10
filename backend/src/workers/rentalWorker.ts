import { Worker } from "bullmq";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { getBullMQConnection } from "../config/bullmqConnection";
import { ExpireBookingJob, RENTAL_QUEUE } from "../queues/rentalQueue";
import { rentalBookingsService } from "../modules/rentals/services/rentalBookings.service";

export function startRentalWorker(concurrency = env.NOTIFICATION_WORKER_CONCURRENCY): Worker<ExpireBookingJob> {
  const worker = new Worker<ExpireBookingJob>(RENTAL_QUEUE, (job) => rentalBookingsService.expireIfDue(job.data.bookingId), {
    connection: getBullMQConnection(),
    concurrency,
  });
  worker.on("failed", (job, err) => logger.warn({ jobId: job?.id, attempt: job?.attemptsMade, err: err.message }, "Rental job failed"));
  worker.on("error", (err) => logger.error({ err }, "Rental worker error"));
  logger.info({ concurrency }, "Rental worker started");
  return worker;
}
