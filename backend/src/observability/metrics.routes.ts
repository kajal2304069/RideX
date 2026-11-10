import { Router } from "express";
import { timingSafeEqual } from "crypto";
import { env } from "../config/env";
import { asyncHandler } from "../common/asyncHandler";
import { registry } from "./metrics";

export const metricsRouter = Router();

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * GET /metrics, Prometheus text format.
 *   - METRICS_TOKEN set: requires `Authorization: Bearer <token>` (compared in constant time).
 *   - not set, development/test: open (local convenience).
 *   - not set, production: the endpoint does not exist (404). Metrics reveal traffic shape and internals; they must not be
 *     public by accident.
 */
metricsRouter.get("/metrics", asyncHandler(async (req, res) => {
  if (env.METRICS_TOKEN) {
    const header = req.header("authorization") ?? "";
    if (!header.startsWith("Bearer ") || !safeEqual(header.slice(7), env.METRICS_TOKEN)) return void res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
  } else if (env.NODE_ENV === "production") {
    return void res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Not found" } });
  }
  res.setHeader("Content-Type", registry.contentType);
  res.send(await registry.metrics());
}));
