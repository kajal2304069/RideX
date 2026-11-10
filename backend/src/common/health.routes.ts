import { Router } from "express";
import { checkDbHealth } from "../db/pool";
import { checkRedisHealth } from "../config/redis";
import { asyncHandler } from "./asyncHandler";
import { isDraining } from "../observability/lifecycle";

export const healthRouter = Router();

/** Liveness: is the process up at all? Used by orchestrators to decide whether to restart the container. */
healthRouter.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", uptimeSeconds: process.uptime() });
});

/** Readiness: can this instance actually serve traffic (DB + Redis reachable)? Used to gate load-balancer routing. */
healthRouter.get(
  "/ready",
  asyncHandler(async (_req, res) => {
    // Draining (SIGTERM received): tell the load balancer to stop sending traffic BEFORE we stop accepting it.
    if (isDraining()) return void res.status(503).json({ status: "draining" });
    const [dbUp, redisUp] = await Promise.all([checkDbHealth(), checkRedisHealth()]);
    const ready = dbUp && redisUp;
    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not_ready",
      dependencies: { postgres: dbUp ? "up" : "down", redis: redisUp ? "up" : "down" },
    });
  })
);
