import pino from "pino";
import { env } from "./env";

/** Credentials must never reach the logs (the request logger was writing Authorization headers in full). */
export const redactConfig = {
    paths: [
      'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]',
      'res.headers["set-cookie"]', '*.password', '*.passwordHash', '*.password_hash', '*.refreshToken', '*.accessToken', '*.token', '*.paymentMethodToken',
    ],
    censor: "[REDACTED]",
  }

/**
 * Structured (JSON) logging so logs are queryable in any log aggregator
 * (CloudWatch, Datadog, ELK, etc). Pretty-printed only in development.
 */
export const logger = pino({
  level: env.NODE_ENV === "production" ? "info" : "debug",
  transport:
    env.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
      : undefined,
  base: { service: "ridex-backend" },
  // Credentials must never reach the logs (they were being written in full by the request logger).
  redact: redactConfig,
});
