import { asyncHandler } from "../../../common/asyncHandler";
import { sendSuccess } from "../../../common/ApiResponse";
import { analyticsService } from "../services/analytics.service";

type Q = { from?: Date; to?: Date; metric?: any; bucket?: any; limit?: number };

export const analyticsController = {
  overview: asyncHandler(async (req, res) => { const q = req.query as Q; sendSuccess(res, await analyticsService.overview(q.from, q.to)); }),
  timeseries: asyncHandler(async (req, res) => { const q = req.query as Q; sendSuccess(res, await analyticsService.timeseries(q.metric, q.bucket, q.from, q.to)); }),
  revenue: asyncHandler(async (req, res) => { const q = req.query as Q; sendSuccess(res, await analyticsService.revenue(q.from, q.to)); }),
  leaderboards: asyncHandler(async (req, res) => { const q = req.query as Q; sendSuccess(res, await analyticsService.leaderboards(q.from, q.to, q.limit)); }),
};
