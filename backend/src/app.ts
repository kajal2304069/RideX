import express, { Application } from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import compression from "compression";
import pinoHttp from "pino-http";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { requestId } from "./middleware/requestId";
import { globalRateLimiter } from "./middleware/rateLimiter";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { healthRouter } from "./common/health.routes";
import { authRouter } from "./modules/auth/routes/auth.routes";
import { ridersRouter } from "./modules/riders/routes/riders.routes";
import { driversRouter } from "./modules/drivers/routes/drivers.routes";
import { vehiclesRouter } from "./modules/vehicles/routes/vehicles.routes";
import { ridesRouter } from "./modules/rides/routes/rides.routes";
import { locationRouter } from "./modules/location/routes/location.routes";
import { routingRouter } from "./modules/routing/routes/routing.routes";
import { matchingRouter } from "./modules/matching/routes/matching.routes";
import { paymentsRouter } from "./modules/payments/routes/payments.routes";
import { garagesRouter } from "./modules/garages/routes/garages.routes";
import { marketplaceRouter } from "./modules/marketplace/routes/marketplace.routes";
import { rentalsRouter } from "./modules/rentals/routes/rentals.routes";
import { adminRouter } from "./modules/admin/routes/admin.routes";
import { analyticsRouter } from "./modules/analytics/routes/analytics.routes";
import { assistantRouter } from "./modules/assistant/routes/assistant.routes";
import { chatRouter } from "./modules/chat/routes/chat.routes";
import { supportRouter } from "./modules/support/routes/support.routes";
import { maintenanceRouter } from "./modules/maintenance/routes/maintenance.routes";
import { httpMetrics } from "./observability/metrics";
import { metricsRouter } from "./observability/metrics.routes";
import { earningsRouter } from "./modules/earnings/routes/earnings.routes";
import { repairsRouter } from "./modules/repairs/routes/repairs.routes";
import { notificationsRouter } from "./modules/notifications/routes/notifications.routes";

/**
 * Central place where the HTTP layer is assembled.
 *
 * Layering (per module, e.g. src/modules/rides):
 *   routes/       -> maps URL + HTTP verb to a controller, applies validators
 *   controllers/  -> parse request, call a service, shape the response (THIN - no business logic)
 *   services/     -> business logic, orchestration, transactions live here
 *   repositories/ -> the ONLY layer allowed to write raw SQL / talk to pg
 *   validators/   -> zod schemas for request bodies/params/query
 *   types/        -> module-local TypeScript types/DTOs
 *
 * As modules mature (Phase 4 onward) each module registers its own
 * router here, e.g. `app.use("/api/rides", ridesRouter)`.
 */
export function createApp(): Application {
  const app = express();

  app.disable("x-powered-by");
  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId,
      autoLogging: { ignore: (req) => req.url === "/health" },
    })
  );

  app.use(httpMetrics);
  app.use(helmet());
  app.use(
    cors({
      origin: env.CLIENT_URL,
      credentials: true,
    })
  );
  app.use(compression());
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(globalRateLimiter);

  // --- Health / readiness (no /api prefix - infra probes hit these directly) ---
  app.use("/", healthRouter);
  app.use("/", metricsRouter);

  // --- Module routers get mounted here as they're built, phase by phase ---
  app.use("/api/auth", authRouter);           // Phase 2
  app.use("/api/riders", ridersRouter);       // Phase 4
  app.use("/api/drivers", driversRouter);     // Phase 4
  app.use("/api/vehicles", vehiclesRouter);   // Phase 5
  app.use("/api/rides", ridesRouter);         // Phase 6
  app.use("/api/location", locationRouter);   // Phase 7
  app.use("/api/routing", routingRouter);     // Phase 8
  app.use("/api/matching", matchingRouter);   // Phase 9
  app.use("/api/payments", paymentsRouter);   // Phase 12
  app.use("/api/notifications", notificationsRouter); // Phase 13
  app.use("/api/garages", garagesRouter);     // Phase 14
  app.use("/api/bookings", repairsRouter);    // Phase 14
  app.use("/api/marketplace", marketplaceRouter); // Phase 15
  app.use("/api/rentals", rentalsRouter); // Phase 16
  app.use("/api/earnings", earningsRouter); // Phase 17
  app.use("/api/assistant", assistantRouter);
  app.use("/api/chat", chatRouter);
  app.use("/api/support", supportRouter);
  app.use("/api/maintenance", maintenanceRouter);
  app.use("/api/admin", adminRouter);       // Phase 18
  app.use("/api/analytics", analyticsRouter); // Phase 18

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
