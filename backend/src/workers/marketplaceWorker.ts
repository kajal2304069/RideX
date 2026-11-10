import { Worker } from "bullmq";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { getBullMQConnection } from "../config/bullmqConnection";
import { ExpireOfferJob, MARKETPLACE_QUEUE } from "../queues/marketplaceQueue";
import { offersService } from "../modules/marketplace/services/offers.service";

export function startMarketplaceWorker(concurrency = env.NOTIFICATION_WORKER_CONCURRENCY): Worker<ExpireOfferJob> {
  const worker = new Worker<ExpireOfferJob>(MARKETPLACE_QUEUE, (job) => offersService.expireIfDue(job.data.offerId), {
    connection: getBullMQConnection(),
    concurrency,
  });
  worker.on("failed", (job, err) => logger.warn({ jobId: job?.id, attempt: job?.attemptsMade, err: err.message }, "Marketplace job failed"));
  worker.on("error", (err) => logger.error({ err }, "Marketplace worker error"));
  logger.info({ concurrency }, "Marketplace worker started");
  return worker;
}
