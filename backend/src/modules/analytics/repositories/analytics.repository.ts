import { pool } from "../../../db/pool";

export interface Range { from: Date; to: Date }

const n = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;
const count = (rows: any[], key: string, field = "c"): Record<string, number> => Object.fromEntries(rows.map((r) => [r[key], Number(r[field])]));

export const TERMINAL_RIDE = ["PAYMENT_COMPLETED", "CANCELLED_BY_RIDER", "CANCELLED_BY_DRIVER", "CANCELLED_BY_SYSTEM"];

/**
 * Metrics for the time-series chart. SQL is composed ONLY from this whitelist (never from request input), which is what
 * makes interpolating `table`/`ts`/`value` safe.
 */
export const METRICS = {
  rides: { table: "rides", ts: "created_at", value: "COUNT(*)", where: "true" },
  completed_rides: { table: "rides", ts: "completed_at", value: "COUNT(*)", where: "status IN ('TRIP_COMPLETED','PAYMENT_COMPLETED') AND completed_at IS NOT NULL" },
  signups: { table: "users", ts: "created_at", value: "COUNT(*)", where: "true" },
  gmv: { table: "payments", ts: "created_at", value: "COALESCE(SUM(amount), 0)", where: "status = 'SUCCESS'" },
  commission: { table: "platform_commissions", ts: "created_at", value: "COALESCE(SUM(amount), 0)", where: "true" },
} as const;
export type MetricName = keyof typeof METRICS;
export type Bucket = "hour" | "day" | "week";

export const analyticsRepository = {
  async users(r: Range) {
    const [totals, byRole] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_active) AS active, COUNT(*) FILTER (WHERE created_at >= $1 AND created_at < $2) AS new_in_range FROM users`, [r.from, r.to]),
      pool.query(`SELECT role::text AS role, COUNT(*) AS c FROM users, unnest(roles) AS role GROUP BY role`),
    ]);
    const t = totals.rows[0];
    return { total: Number(t.total), active: Number(t.active), newInRange: Number(t.new_in_range), byRole: count(byRole.rows, "role") };
  },

  async drivers() {
    const [v, o] = await Promise.all([
      pool.query(`SELECT verification_status::text AS s, COUNT(*) AS c FROM drivers GROUP BY 1`),
      pool.query(`SELECT COUNT(*) FILTER (WHERE is_online) AS online, COUNT(*) AS total FROM drivers`),
    ]);
    return { total: Number(o.rows[0].total), online: Number(o.rows[0].online), byVerification: count(v.rows, "s") };
  },

  async vehicles() {
    const { rows } = await pool.query(`SELECT status::text AS s, COUNT(*) AS c FROM vehicles GROUP BY 1`);
    return { total: rows.reduce((a, r) => a + Number(r.c), 0), byStatus: count(rows, "s") };
  },

  async rides(r: Range) {
    const [by, live, timing] = await Promise.all([
      pool.query(`SELECT status::text AS s, COUNT(*) AS c FROM rides WHERE created_at >= $1 AND created_at < $2 GROUP BY 1`, [r.from, r.to]),
      pool.query(`SELECT COUNT(*) AS c FROM rides WHERE status NOT IN (${TERMINAL_RIDE.map((s) => `'${s}'`).join(",")}, 'TRIP_COMPLETED')`),
      pool.query(
        `SELECT AVG(EXTRACT(EPOCH FROM (a.accepted_at - a.requested_at))) AS pickup_s,
                AVG(EXTRACT(EPOCH FROM (a.completed_at - a.started_at))) FILTER (WHERE a.completed_at IS NOT NULL AND a.started_at IS NOT NULL) AS trip_s,
                AVG(f.total_fare) FILTER (WHERE a.status IN ('TRIP_COMPLETED','PAYMENT_COMPLETED')) AS avg_fare
         FROM rides a LEFT JOIN ride_fares f ON f.ride_id = a.id
         WHERE a.created_at >= $1 AND a.created_at < $2 AND a.accepted_at IS NOT NULL`, [r.from, r.to]
      ),
    ]);
    const byStatus = count(by.rows, "s");
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const cancelled = (byStatus.CANCELLED_BY_RIDER ?? 0) + (byStatus.CANCELLED_BY_DRIVER ?? 0) + (byStatus.CANCELLED_BY_SYSTEM ?? 0);
    const completed = (byStatus.TRIP_COMPLETED ?? 0) + (byStatus.PAYMENT_COMPLETED ?? 0);
    const t = timing.rows[0];
    return {
      total, byStatus, completed, cancelled,
      completionRate: total ? Math.round((completed / total) * 1000) / 1000 : 0,
      cancellationRate: total ? Math.round((cancelled / total) * 1000) / 1000 : 0,
      activeNow: Number(live.rows[0].c),
      avgSecondsToAccept: t.pickup_s === null ? null : Math.round(Number(t.pickup_s)),
      avgTripSeconds: t.trip_s === null ? null : Math.round(Number(t.trip_s)),
      avgFare: t.avg_fare === null ? null : n(t.avg_fare),
    };
  },

  async payments(r: Range) {
    const { rows } = await pool.query(
      `SELECT payable_type::text AS type, status::text AS status, COUNT(*) AS c, COALESCE(SUM(amount), 0) AS amount
       FROM payments WHERE created_at >= $1 AND created_at < $2 GROUP BY 1, 2`, [r.from, r.to]
    );
    const byStatus: Record<string, { count: number; amount: number }> = {};
    for (const x of rows) {
      const s = (byStatus[x.status] ??= { count: 0, amount: 0 });
      s.count += Number(x.c); s.amount = n(s.amount + Number(x.amount));
    }
    return { byStatus, byType: rows.filter((x) => x.status === "SUCCESS").map((x) => ({ type: x.type, count: Number(x.c), amount: n(x.amount) })) };
  },

  async rentals(r: Range) {
    const { rows } = await pool.query(`SELECT status::text AS s, COUNT(*) AS c FROM rental_bookings WHERE created_at >= $1 AND created_at < $2 GROUP BY 1`, [r.from, r.to]);
    return { byStatus: count(rows, "s") };
  },

  async marketplace() {
    const { rows } = await pool.query(`SELECT status::text AS s, COUNT(*) AS c FROM vehicle_listings GROUP BY 1`);
    return { listingsByStatus: count(rows, "s") };
  },

  async garages(r: Range) {
    const { rows } = await pool.query(`SELECT status::text AS s, COUNT(*) AS c FROM service_bookings WHERE created_at >= $1 AND created_at < $2 GROUP BY 1`, [r.from, r.to]);
    return { bookingsByStatus: count(rows, "s") };
  },

  /** Zero-filled series: generate_series gives every bucket, the aggregate is LEFT JOINed so empty buckets read 0. */
  async timeseries(metric: MetricName, bucket: Bucket, r: Range) {
    const m = METRICS[metric];
    const { rows } = await pool.query(
      `SELECT b.bucket, COALESCE(x.v, 0) AS v
       FROM generate_series(date_trunc('${bucket}', $1::timestamptz), date_trunc('${bucket}', $2::timestamptz - interval '1 millisecond'), interval '1 ${bucket}') AS b(bucket)
       LEFT JOIN (
         SELECT date_trunc('${bucket}', ${m.ts}) AS bucket, ${m.value} AS v
         FROM ${m.table} WHERE ${m.where} AND ${m.ts} >= $1 AND ${m.ts} < $2 GROUP BY 1
       ) x ON x.bucket = b.bucket
       ORDER BY b.bucket`,
      [r.from, r.to]
    );
    return rows.map((x) => ({ bucket: x.bucket as Date, value: n(x.v) }));
  },

  async revenue(r: Range) {
    const [pay, comm, outs, owed] = await Promise.all([
      pool.query(
        `SELECT payable_type::text AS type,
                COALESCE(SUM(amount) FILTER (WHERE status = 'SUCCESS'), 0) AS gross,
                COALESCE(SUM(amount) FILTER (WHERE status = 'REFUNDED'), 0) AS refunded
         FROM payments WHERE created_at >= $1 AND created_at < $2 GROUP BY 1 ORDER BY 1`, [r.from, r.to]
      ),
      pool.query(`SELECT source_type::text AS type, COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS c FROM platform_commissions WHERE created_at >= $1 AND created_at < $2 GROUP BY 1 ORDER BY 1`, [r.from, r.to]),
      pool.query(`SELECT kind::text AS kind, status::text AS status, COALESCE(SUM(amount), 0) AS amount FROM payouts WHERE created_at >= $1 AND created_at < $2 GROUP BY 1, 2`, [r.from, r.to]),
      // All-time snapshot: what the platform still owes users (earned and not yet withdrawn).
      pool.query(
        `SELECT (SELECT COALESCE(SUM(amount), 0) FROM owner_earnings) + (SELECT COALESCE(SUM(amount), 0) FROM driver_earnings) AS earned,
                (SELECT COALESCE(SUM(amount), 0) FROM payouts WHERE kind = 'EARNINGS_WITHDRAWAL' AND status IN ('PENDING','PAID')) AS withdrawn`
      ),
    ]);
    const byType = pay.rows.map((x) => ({ type: x.type, gross: n(x.gross), refunded: n(x.refunded), net: n(Number(x.gross)) }));
    return {
      collected: {
        gross: n(byType.reduce((a, x) => a + x.gross, 0)),
        refunded: n(byType.reduce((a, x) => a + x.refunded, 0)),
        byType,
      },
      commission: { total: n(comm.rows.reduce((a, x) => a + Number(x.amount), 0)), bySource: comm.rows.map((x) => ({ source: x.type, amount: n(x.amount), count: Number(x.c) })) },
      payouts: outs.rows.map((x) => ({ kind: x.kind, status: x.status, amount: n(x.amount) })),
      owedToUsers: n(Number(owed.rows[0].earned) - Number(owed.rows[0].withdrawn)),
    };
  },

  async topDrivers(r: Range, limit: number) {
    const { rows } = await pool.query(
      `SELECT e.driver_id, u.email, u.full_name, COALESCE(SUM(e.amount), 0) AS total, COUNT(*) FILTER (WHERE e.type = 'RIDE_FARE') AS rides
       FROM driver_earnings e JOIN users u ON u.id = e.driver_id
       WHERE e.created_at >= $1 AND e.created_at < $2 GROUP BY e.driver_id, u.email, u.full_name ORDER BY total DESC, e.driver_id LIMIT $3`,
      [r.from, r.to, limit]
    );
    return rows.map((x) => ({ driverId: x.driver_id, email: x.email, fullName: x.full_name, earnings: n(x.total), rides: Number(x.rides) }));
  },

  async topOwners(r: Range, limit: number) {
    const { rows } = await pool.query(
      `SELECT e.owner_id, u.email, u.full_name, COALESCE(SUM(e.amount), 0) AS total
       FROM owner_earnings e JOIN users u ON u.id = e.owner_id
       WHERE e.created_at >= $1 AND e.created_at < $2 GROUP BY e.owner_id, u.email, u.full_name ORDER BY total DESC, e.owner_id LIMIT $3`,
      [r.from, r.to, limit]
    );
    return rows.map((x) => ({ ownerId: x.owner_id, email: x.email, fullName: x.full_name, earnings: n(x.total) }));
  },

  // ---- system health: business invariants that should be ~0 ----
  async healthCounters() {
    const { rows } = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM payments WHERE status = 'PROCESSING' AND updated_at < now() - interval '5 minutes') AS stuck_payments,
         (SELECT COUNT(*) FROM rides r WHERE r.status = 'PAYMENT_COMPLETED' AND r.driver_id IS NOT NULL AND r.updated_at < now() - interval '5 minutes'
            AND NOT EXISTS (SELECT 1 FROM platform_commissions c WHERE c.source_type = 'RIDE' AND c.source_id = r.id)) AS unsettled_rides,
         (SELECT COUNT(*) FROM rental_bookings WHERE status = 'PENDING_PAYMENT' AND payment_due_at < now() - interval '2 minutes') AS overdue_rental_holds,
         (SELECT COUNT(*) FROM payouts WHERE status = 'PENDING' AND created_at < now() - interval '5 minutes') AS stuck_payouts,
         (SELECT COUNT(*) FROM rental_bookings b LEFT JOIN payouts p ON p.kind = 'DEPOSIT_REFUND' AND p.source_id = b.id
            WHERE b.status = 'COMPLETED' AND b.deposit_refund_due > 0 AND (p.id IS NULL OR p.status <> 'PAID') AND b.updated_at < now() - interval '5 minutes') AS open_deposit_refunds`
    );
    const r = rows[0];
    return {
      stuckPayments: Number(r.stuck_payments), unsettledRides: Number(r.unsettled_rides), overdueRentalHolds: Number(r.overdue_rental_holds),
      stuckPayouts: Number(r.stuck_payouts), openDepositRefunds: Number(r.open_deposit_refunds),
    };
  },
};
