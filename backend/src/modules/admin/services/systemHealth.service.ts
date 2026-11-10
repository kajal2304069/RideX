import { Queue } from "bullmq";
import { pool } from "../../../db/pool";
import { redis } from "../../../config/redis";
import { getIO } from "../../../websocket/io";
import { getNotificationQueue } from "../../../queues/notificationQueue";
import { getMarketplaceQueue } from "../../../queues/marketplaceQueue";
import { getRentalQueue } from "../../../queues/rentalQueue";
import { analyticsRepository } from "../../analytics/repositories/analytics.repository";

const CHECK_TIMEOUT_MS = 2000;

interface Check { status: "up" | "down"; latencyMs: number | null; error?: string }

/** Runs `fn` with a deadline, so a hung dependency makes the health page say "down" instead of hanging the page. */
async function timed<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T; ms: number } | { ok: false; error: string; ms: number }> {
  const t0 = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      fn(),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${CHECK_TIMEOUT_MS}ms`)), CHECK_TIMEOUT_MS); }),
    ]);
    return { ok: true, value, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: (err as Error).message, ms: Date.now() - t0 };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const toCheck = (r: Awaited<ReturnType<typeof timed>>): Check =>
  r.ok ? { status: "up", latencyMs: r.ms } : { status: "down", latencyMs: null, error: r.error };

async function queueCounts(name: string, get: () => Queue<any>) {
  const r = await timed(() => get().getJobCounts("waiting", "active", "delayed", "failed"));
  if (!r.ok) return { name, status: "down" as const, failed: 0, error: r.error };
  return { name, status: "up" as const, failed: 0, ...r.value };
}

export const systemHealthService = {
  /**
   * One call that answers "is the platform healthy right now?":
   *   dependencies  - Postgres and Redis reachable, with latency (down => the platform is down)
   *   pool/process  - saturation signals
   *   queues        - backlog and failed jobs per BullMQ queue
   *   realtime      - connected websocket clients
   *   invariants    - business conditions that should always be ~0 (a stuck payment, a paid ride with no earnings...).
   *                   A non-zero value means a background repair path did not run: degraded, not down.
   */
  async report() {
    const [db, rd] = await Promise.all([timed(() => pool.query("SELECT 1")), timed(() => redis.ping())]);
    const dependencies = { postgres: toCheck(db), redis: toCheck(rd) };

    const invariants = db.ok ? await timed(() => analyticsRepository.healthCounters()) : null;
    const queues = rd.ok
      ? await Promise.all([queueCounts("notifications", getNotificationQueue), queueCounts("marketplace", getMarketplaceQueue), queueCounts("rentals", getRentalQueue)])
      : [];

    const alerts: string[] = [];
    if (invariants?.ok) {
      const c = invariants.value;
      if (c.stuckPayments) alerts.push(`${c.stuckPayments} payment(s) stuck in PROCESSING for over 5 minutes`);
      if (c.unsettledRides) alerts.push(`${c.unsettledRides} paid ride(s) with no earnings split (run reconcile)`);
      if (c.overdueRentalHolds) alerts.push(`${c.overdueRentalHolds} rental hold(s) past their deadline and not expired`);
      if (c.stuckPayouts) alerts.push(`${c.stuckPayouts} payout(s) PENDING for over 5 minutes`);
      if (c.openDepositRefunds) alerts.push(`${c.openDepositRefunds} deposit refund(s) not yet paid (run reconcile)`);
    }
    for (const q of queues) {
      if (q.status === "down") alerts.push(`queue ${q.name} unreachable`);
      else if (q.failed > 0) alerts.push(`queue ${q.name} has ${q.failed} failed job(s)`);
    }

    const status = !db.ok || !rd.ok ? "down" : alerts.length ? "degraded" : "ok";
    const mem = process.memoryUsage();
    return {
      status,
      checkedAt: new Date(),
      dependencies,
      database: { poolTotal: pool.totalCount, poolIdle: pool.idleCount, poolWaiting: pool.waitingCount },
      queues,
      realtime: { websocketClients: getIO()?.engine.clientsCount ?? null },
      invariants: invariants?.ok ? invariants.value : null,
      alerts,
      process: { uptimeSeconds: Math.round(process.uptime()), rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576), node: process.version },
    };
  },
};
