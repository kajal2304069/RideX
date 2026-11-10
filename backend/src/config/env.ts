import "dotenv/config";
import { z } from "zod";

/**
 * All environment variables are parsed and validated ONCE, at boot.
 * If a required var is missing/invalid, the process fails fast here
 * instead of crashing later mid-request with a confusing error.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  CLIENT_URL: z.string().default("http://localhost:5173"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PG_POOL_MAX: z.coerce.number().default(20),
  PG_POOL_IDLE_TIMEOUT_MS: z.coerce.number().default(30000),

  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  JWT_ACCESS_SECRET: z.string().min(10, "JWT_ACCESS_SECRET too short"),
  JWT_REFRESH_SECRET: z.string().min(10, "JWT_REFRESH_SECRET too short"),
  JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),

  PAYMENT_PROVIDER: z.enum(["mock", "stripe"]).default("mock"),
  STRIPE_SECRET_KEY: z.string().optional(),

  // Phase 13: notification queue
  NOTIFICATION_BACKOFF_MS: z.coerce.number().default(1000),
  NOTIFICATION_WORKER_CONCURRENCY: z.coerce.number().default(5),
  // Phase 15: how long a buyer has to pay after the seller accepts their offer (default 48h)
  OFFER_ACCEPTANCE_TTL_MS: z.coerce.number().default(48 * 60 * 60 * 1000),
  /** How long a PENDING_PAYMENT rental booking holds the vehicle before it expires (Phase 16). */
  RENTAL_PAYMENT_HOLD_MS: z.coerce.number().default(15 * 60 * 1000),
  /** Phase 17: the platform's cut of a ride fare when the driver has no owner agreement, and of rental revenue. */
  PLATFORM_COMMISSION_PERCENT: z.coerce.number().min(0).max(100).default(20),
  RENTAL_COMMISSION_PERCENT: z.coerce.number().min(0).max(100).default(10),
  /** Smallest withdrawal a user may request, in rupees. */
  MIN_PAYOUT_AMOUNT: z.coerce.number().min(0).default(100),
  /** Phase 18+: surge pricing. SURGE_TIERS is "minRatio:multiplier,..." e.g. "1.5:1.2,2.5:1.5,4:2"; empty = defaults. */
  SURGE_ENABLED: z.enum(["true", "false"]).default("true"),
  SURGE_RADIUS_METERS: z.coerce.number().min(100).max(50000).default(5000),
  SURGE_TIERS: z.string().optional(),
  /** Phase 21: bearer token required for GET /metrics. Unset: open in dev/test, disabled in production. */
  // Docker passes an unset variable as "" - treat that as "not configured", not as a too-short token.
  METRICS_TOKEN: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(16).optional()),
  /** Phase 21: how long to keep answering /ready with 503 before closing the server on SIGTERM, so the load balancer drains us. */
  SHUTDOWN_DRAIN_MS: z.coerce.number().min(0).default(0),
  START_WORKER: z.enum(["true", "false"]).default("false"),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  /** Login/register attempts per IP per 15 minutes. Keep low in production; raise for demos and shared office IPs. */
  // Voice assistant. Without ANTHROPIC_API_KEY it answers from the built-in guide (English + Hindi).
  ANTHROPIC_API_KEY: z.string().optional().transform((v) => (v ? v : undefined)),
  ASSISTANT_MODEL: z.string().default("claude-sonnet-5-5"),
  ASSISTANT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),
  ASSISTANT_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_MAX: z.coerce.number().default(120),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("❌ Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
