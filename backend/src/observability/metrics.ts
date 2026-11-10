import { NextFunction, Request, Response } from "express";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { logger } from "../config/logger";
import { redis } from "../config/redis";
import { pool } from "../db/pool";
import { getIO } from "../websocket/io";

/**
 * Prometheus metrics (spec section 37). One registry for the process.
 *
 * Cardinality rules (what keeps a metrics system alive):
 *   - HTTP metrics are labelled by the ROUTE PATTERN ("/api/rides/:id"), never the raw URL; an unmatched path is
 *     "unmatched". Raw URLs would create one time series per id.
 *   - No user ids, emails or request ids in labels, ever.
 *
 * Gauges that need I/O (online drivers, queue depth...) are computed at scrape time, cached for a few seconds, and a
 * failing source is skipped: a broken Redis must not turn /metrics itself into an error, because that is exactly when
 * you need the other numbers.
 */
export const registry = new Registry();
registry.setDefaultLabels({ service: "ridex-backend" });
collectDefaultMetrics({ register: registry, prefix: "ridex_" });

export const httpRequests = new Counter({
  name: "ridex_http_requests_total", help: "HTTP requests handled", labelNames: ["method", "route", "status"], registers: [registry],
});
export const httpDuration = new Histogram({
  name: "ridex_http_request_duration_seconds", help: "HTTP request latency", labelNames: ["method", "route", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: [registry],
});
export const paymentsTotal = new Counter({
  name: "ridex_payments_total", help: "Payments that reached a terminal outcome", labelNames: ["status"], registers: [registry],
});
export const matchingDuration = new Histogram({
  name: "ridex_matching_duration_seconds", help: "Time to find and rank driver candidates", labelNames: ["outcome"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1], registers: [registry],
});

/** Route pattern for a finished request; bounded cardinality. */
/**
 * The route *pattern* (never the raw URL). Express restores `req.baseUrl` to the parent's value once a request is handed to
 * the error handler, so a request that ended in an error would lose its mount prefix ("/rides/:rideId" instead of
 * "/api/chat/rides/:rideId"). When baseUrl is empty we recover the prefix from the URL itself by matching the pattern at its end.
 */
export function routeLabel(req: Request): string {
  const route = (req as Request & { route?: { path?: string } }).route?.path;
  if (!route) return "unmatched";
  const tail = route === "/" ? "" : route;
  if (req.baseUrl) return `${req.baseUrl}${tail}`;
  const path = (req.originalUrl ?? "").split("?")[0].replace(/\/+$/, "");
  const rx = new RegExp("^(.*?)" + tail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z0-9_]+/g, "[^/]+") + "$");
  const m = rx.exec(path);
  return `${m ? m[1] : ""}${tail}`;
}

export function httpMetrics(req: Request, res: Response, next: NextFunction) {
  const end = httpDuration.startTimer();
  res.on("finish", () => {
    const labels = { method: req.method, route: routeLabel(req), status: String(res.statusCode) };
    httpRequests.inc(labels);
    end(labels);
  });
  next();
}

// ---------- scrape-time gauges ----------

function cached<T>(ttlMs: number, fn: () => Promise<T>): () => Promise<T | undefined> {
  let value: T | undefined;
  let at = 0;
  return async () => {
    if (Date.now() - at < ttlMs && at !== 0) return value;
    try { value = await fn(); at = Date.now(); } catch (err) { logger.warn({ err }, "Metrics source unavailable"); }
    return value;
  };
}

const activeRides = cached(5000, async () =>
  Number((await pool.query(`SELECT COUNT(*) AS n FROM rides WHERE status NOT IN ('PAYMENT_COMPLETED','CANCELLED_BY_RIDER','CANCELLED_BY_DRIVER','CANCELLED_BY_SYSTEM')`)).rows[0].n));
const onlineDrivers = cached(5000, async () => redis.zcard("geo:drivers"));
const invariants = cached(15000, async () => (await import("../modules/analytics/repositories/analytics.repository")).analyticsRepository.healthCounters());
const queueCounts = cached(5000, async () => {
  const [{ getNotificationQueue }, { getMarketplaceQueue }, { getRentalQueue }, { getMaintenanceQueue }] = await Promise.all([
    import("../queues/notificationQueue"), import("../queues/marketplaceQueue"), import("../queues/rentalQueue"), import("../queues/maintenanceQueue"),
  ]);
  const queues = { notifications: getNotificationQueue(), marketplace: getMarketplaceQueue(), rentals: getRentalQueue(), maintenance: getMaintenanceQueue() };
  const out: Record<string, Record<string, number>> = {};
  for (const [name, q] of Object.entries(queues)) out[name] = await q.getJobCounts("waiting", "active", "delayed", "failed");
  return out;
});

new Gauge({ name: "ridex_active_rides", help: "Rides not yet finished", registers: [registry], async collect() { const v = await activeRides(); if (v !== undefined) this.set(v); } });
new Gauge({ name: "ridex_online_drivers", help: "Drivers currently in the geo index", registers: [registry], async collect() { const v = await onlineDrivers(); if (v !== undefined) this.set(v); } });
new Gauge({ name: "ridex_websocket_connections", help: "Connected websocket clients on this instance", registers: [registry], collect() { this.set(getIO()?.engine.clientsCount ?? 0); } });
new Gauge({
  name: "ridex_db_pool_connections", help: "pg pool connections by state", labelNames: ["state"], registers: [registry],
  collect() { this.set({ state: "total" }, pool.totalCount); this.set({ state: "idle" }, pool.idleCount); this.set({ state: "waiting" }, pool.waitingCount); },
});
new Gauge({
  name: "ridex_queue_jobs", help: "BullMQ jobs by queue and state", labelNames: ["queue", "state"], registers: [registry],
  async collect() { const q = await queueCounts(); if (!q) return; for (const [name, states] of Object.entries(q)) for (const [state, n] of Object.entries(states)) this.set({ queue: name, state }, n); },
});
new Gauge({
  name: "ridex_invariant_violations", help: "Business invariants that should be 0 (stuck payments, unsettled rides...)", labelNames: ["kind"], registers: [registry],
  async collect() { const c = await invariants(); if (!c) return; for (const [kind, n] of Object.entries(c)) this.set({ kind }, n as number); },
});
