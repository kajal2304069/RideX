import { ApiError } from "../../../common/ApiError";
import { analyticsRepository, Bucket, MetricName, Range } from "../repositories/analytics.repository";

const DAY = 86_400_000;

/** Default window: the last 30 days. */
export function resolveRange(from?: Date, to?: Date, now = new Date()): Range {
  const end = to ?? now;
  const start = from ?? new Date(end.getTime() - 30 * DAY);
  if (start >= end) throw ApiError.badRequest("`from` must be before `to`");
  return { from: start, to: end };
}

/** Keeps a chart request bounded: at most 500 buckets. */
const BUCKET_MS: Record<Bucket, number> = { hour: 3_600_000, day: DAY, week: 7 * DAY };
export function assertBucketCount(bucket: Bucket, r: Range) {
  const buckets = Math.ceil((r.to.getTime() - r.from.getTime()) / BUCKET_MS[bucket]) + 1;
  if (buckets > 500) throw ApiError.badRequest(`That range would produce ${buckets} ${bucket} buckets (max 500); use a larger bucket or a shorter range`);
}

export const analyticsService = {
  async overview(from?: Date, to?: Date) {
    const r = resolveRange(from, to);
    const [users, drivers, vehicles, rides, payments, rentals, marketplace, garages] = await Promise.all([
      analyticsRepository.users(r), analyticsRepository.drivers(), analyticsRepository.vehicles(), analyticsRepository.rides(r),
      analyticsRepository.payments(r), analyticsRepository.rentals(r), analyticsRepository.marketplace(), analyticsRepository.garages(r),
    ]);
    return { range: r, users, drivers, vehicles, rides, payments, rentals, marketplace, garages };
  },

  async timeseries(metric: MetricName, bucket: Bucket, from?: Date, to?: Date) {
    const r = resolveRange(from, to);
    assertBucketCount(bucket, r);
    return { metric, bucket, range: r, points: await analyticsRepository.timeseries(metric, bucket, r) };
  },

  async revenue(from?: Date, to?: Date) {
    const r = resolveRange(from, to);
    return { range: r, ...(await analyticsRepository.revenue(r)) };
  },

  async leaderboards(from?: Date, to?: Date, limit = 10) {
    const r = resolveRange(from, to);
    const [drivers, owners] = await Promise.all([analyticsRepository.topDrivers(r, limit), analyticsRepository.topOwners(r, limit)]);
    return { range: r, topDrivers: drivers, topOwners: owners };
  },
};
