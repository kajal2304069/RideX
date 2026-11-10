import { PoolClient } from "pg";
import { pool, withTransaction } from "../../../db/pool";
import { DateRange, PayoutRecord, SettleRentalInput, SettleRideInput } from "../types/earnings.types";
import { fromPaise } from "../services/earningsSplit";

const num = (v: string | null | undefined) => Math.round(Number(v ?? 0) * 100) / 100;

export interface AssignmentTerms {
  assignment_id: string;
  owner_id: string;
  commission_percent: string;
  owner_share_percent: string;
}

/** Predicate shared by every date-ranged query: [from, to). */
function rangeSql(col: string, r: DateRange, params: unknown[]): string {
  const parts: string[] = [];
  if (r.from) { params.push(r.from); parts.push(`${col} >= $${params.length}`); }
  if (r.to) { params.push(r.to); parts.push(`${col} < $${params.length}`); }
  return parts.length ? ` AND ${parts.join(" AND ")}` : "";
}

export const earningsRepository = {
  // ---------- settlement inputs ----------

  /** The owner agreement that applied when the ride was accepted (the assignment may have ended since). */
  async findAssignmentTerms(vehicleId: string, driverId: string, at: Date): Promise<AssignmentTerms | null> {
    const { rows } = await pool.query<AssignmentTerms>(
      `SELECT id AS assignment_id, owner_id, commission_percent, owner_share_percent
       FROM vehicle_driver_assignments
       WHERE vehicle_id = $1 AND driver_id = $2 AND started_at <= $3 AND (ended_at IS NULL OR ended_at >= $3)
       ORDER BY started_at DESC LIMIT 1`,
      [vehicleId, driverId, at]
    );
    return rows[0] ?? null;
  },

  async vehicleOwnerId(vehicleId: string): Promise<string | null> {
    const { rows } = await pool.query<{ owner_id: string }>(`SELECT owner_id FROM vehicles WHERE id = $1`, [vehicleId]);
    return rows[0]?.owner_id ?? null;
  },

  // ---------- settlement (idempotent) ----------

  /**
   * Writes the whole split in ONE transaction, gated by the platform_commissions row. That row has a unique index on
   * (source_type, source_id), so of N concurrent or repeated settlements exactly one inserts it; every other one sees
   * ON CONFLICT DO NOTHING return zero rows and writes nothing. All-or-nothing: no half-settled ride.
   */
  async settleRide(s: SettleRideInput): Promise<boolean> {
    return withTransaction(async (client) => {
      const gate = await client.query(
        `INSERT INTO platform_commissions (source_type, source_id, amount, rate_percent)
         VALUES ('RIDE', $1, $2, $3) ON CONFLICT (source_type, source_id) DO NOTHING RETURNING id`,
        [s.rideId, fromPaise(s.platform), s.platformPercent]
      );
      if (!gate.rowCount) return false;
      if (s.owner) {
        await client.query(
          `INSERT INTO owner_earnings (owner_id, source_type, source_id, amount, vehicle_id, driver_id)
           VALUES ($1, 'RIDE_SHARE', $2, $3, $4, $5)`,
          [s.owner.ownerId, s.rideId, fromPaise(s.owner.paise), s.owner.vehicleId, s.driver.driverId]
        );
      }
      await client.query(
        `INSERT INTO driver_earnings (driver_id, ride_id, type, amount) VALUES ($1, $2, 'RIDE_FARE', $3)`,
        [s.driver.driverId, s.rideId, fromPaise(s.driver.paise)]
      );
      return true;
    });
  },

  async settleRental(s: SettleRentalInput): Promise<boolean> {
    return withTransaction(async (client) => {
      const gate = await client.query(
        `INSERT INTO platform_commissions (source_type, source_id, amount, rate_percent)
         VALUES ('RENTAL', $1, $2, $3) ON CONFLICT (source_type, source_id) DO NOTHING RETURNING id`,
        [s.bookingId, fromPaise(s.platform), s.platformPercent]
      );
      if (!gate.rowCount) return false;
      await client.query(
        `INSERT INTO owner_earnings (owner_id, source_type, source_id, amount, vehicle_id, driver_id)
         VALUES ($1, 'RENTAL', $2, $3, $4, NULL)`,
        [s.owner.ownerId, s.bookingId, fromPaise(s.owner.paise), s.owner.vehicleId]
      );
      return true;
    });
  },

  /** Paid rides / returned rentals that have no commission row: a settlement that failed after the money moved. */
  async findUnsettledRideIds(limit: number): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT r.id FROM rides r
       WHERE r.status = 'PAYMENT_COMPLETED' AND r.driver_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM platform_commissions c WHERE c.source_type = 'RIDE' AND c.source_id = r.id)
       ORDER BY r.completed_at NULLS LAST LIMIT $1`,
      [limit]
    );
    return rows.map((r) => r.id);
  },

  async findUnsettledRentalIds(limit: number): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT b.id FROM rental_bookings b
       WHERE b.status = 'COMPLETED'
         AND NOT EXISTS (SELECT 1 FROM platform_commissions c WHERE c.source_type = 'RENTAL' AND c.source_id = b.id)
       ORDER BY b.updated_at LIMIT $1`,
      [limit]
    );
    return rows.map((r) => r.id);
  },

  /** Completed rentals whose deposit refund was never created or never paid. */
  async findOpenDepositRefundIds(limit: number): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT b.id FROM rental_bookings b
       LEFT JOIN payouts p ON p.kind = 'DEPOSIT_REFUND' AND p.source_id = b.id
       WHERE b.status = 'COMPLETED' AND b.deposit_refund_due > 0 AND (p.id IS NULL OR p.status <> 'PAID')
       ORDER BY b.updated_at LIMIT $1`,
      [limit]
    );
    return rows.map((r) => r.id);
  },

  // ---------- dashboards ----------

  async ownerTotals(ownerId: string, range: DateRange) {
    const params: unknown[] = [ownerId];
    const earn = await pool.query<{ source_type: string; total: string; entries: string }>(
      `SELECT source_type, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS entries
       FROM owner_earnings WHERE owner_id = $1${rangeSql("created_at", range, params)} GROUP BY source_type`,
      params
    );
    const mParams: unknown[] = [ownerId];
    const maint = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(m.cost), 0) AS total
       FROM maintenance_records m JOIN vehicles v ON v.id = m.vehicle_id
       WHERE v.owner_id = $1${rangeSql("m.performed_at", range, mParams)}`,
      mParams
    );
    const by = (t: string) => earn.rows.find((r) => r.source_type === t);
    return {
      rideShareEarnings: num(by("RIDE_SHARE")?.total),
      rentalRevenue: num(by("RENTAL")?.total),
      rideCount: Number(by("RIDE_SHARE")?.entries ?? 0),
      rentalCount: Number(by("RENTAL")?.entries ?? 0),
      maintenanceCost: num(maint.rows[0].total),
    };
  },

  async ownerByVehicle(ownerId: string, range: DateRange) {
    const params: unknown[] = [ownerId];
    const e = rangeSql("e.created_at", range, params);
    const mParams: unknown[] = [ownerId];
    const m = rangeSql("performed_at", range, mParams);
    const earn = await pool.query<{ vehicle_id: string; ride_share: string; rental: string }>(
      `SELECT e.vehicle_id,
              COALESCE(SUM(e.amount) FILTER (WHERE e.source_type = 'RIDE_SHARE'), 0) AS ride_share,
              COALESCE(SUM(e.amount) FILTER (WHERE e.source_type = 'RENTAL'), 0) AS rental
       FROM owner_earnings e WHERE e.owner_id = $1 AND e.vehicle_id IS NOT NULL${e} GROUP BY e.vehicle_id`,
      params
    );
    const maint = await pool.query<{ vehicle_id: string; total: string }>(
      `SELECT vehicle_id, COALESCE(SUM(cost), 0) AS total FROM maintenance_records
       WHERE vehicle_id IN (SELECT id FROM vehicles WHERE owner_id = $1)${m} GROUP BY vehicle_id`,
      mParams
    );
    const vehicles = await pool.query<{ id: string; title: string; registration_number: string }>(
      `SELECT id, (year || ' ' || brand || ' ' || model) AS title, registration_number FROM vehicles WHERE owner_id = $1 ORDER BY created_at, id`,
      [ownerId]
    );
    return vehicles.rows.map((v) => {
      const ee = earn.rows.find((r) => r.vehicle_id === v.id);
      const mm = maint.rows.find((r) => r.vehicle_id === v.id);
      const rideShare = num(ee?.ride_share);
      const rental = num(ee?.rental);
      const maintenance = num(mm?.total);
      return {
        vehicleId: v.id, title: v.title, registrationNumber: v.registration_number,
        rideShareEarnings: rideShare, rentalRevenue: rental, maintenanceCost: maintenance,
        netEarnings: Math.round((rideShare + rental - maintenance) * 100) / 100,
      };
    });
  },

  async driverTotals(driverId: string, range: DateRange) {
    const params: unknown[] = [driverId];
    const { rows } = await pool.query<{ type: string; total: string; entries: string }>(
      `SELECT type, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS entries
       FROM driver_earnings WHERE driver_id = $1${rangeSql("created_at", range, params)} GROUP BY type`,
      params
    );
    const by = (t: string) => rows.find((r) => r.type === t);
    return {
      rideFares: num(by("RIDE_FARE")?.total),
      bonuses: num(by("BONUS")?.total),
      adjustments: num(by("ADJUSTMENT")?.total),
      rideCount: Number(by("RIDE_FARE")?.entries ?? 0),
    };
  },

  async platformTotals(range: DateRange) {
    const params: unknown[] = [];
    const { rows } = await pool.query<{ source_type: string; total: string; entries: string }>(
      `SELECT source_type, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS entries
       FROM platform_commissions WHERE true${rangeSql("created_at", range, params)} GROUP BY source_type`,
      params
    );
    return rows.map((r) => ({ sourceType: r.source_type, amount: num(r.total), count: Number(r.entries) }));
  },

  /** Keyset-paginated ledger rows, newest first. */
  async ownerEntries(ownerId: string, limit: number, cursor?: { t: string; id: string }) {
    const params: unknown[] = [ownerId, limit];
    let after = "";
    if (cursor) { params.push(cursor.t, cursor.id); after = ` AND (created_at, id) < ($3::timestamptz, $4::uuid)`; }
    const { rows } = await pool.query(
      `SELECT id, source_type, source_id, amount, vehicle_id, created_at, created_at::text AS created_at_raw
       FROM owner_earnings WHERE owner_id = $1${after} ORDER BY created_at DESC, id DESC LIMIT $2`,
      params
    );
    return rows;
  },

  async driverEntries(driverId: string, limit: number, cursor?: { t: string; id: string }) {
    const params: unknown[] = [driverId, limit];
    let after = "";
    if (cursor) { params.push(cursor.t, cursor.id); after = ` AND (created_at, id) < ($3::timestamptz, $4::uuid)`; }
    const { rows } = await pool.query(
      `SELECT id, type, ride_id, amount, created_at, created_at::text AS created_at_raw
       FROM driver_earnings WHERE driver_id = $1${after} ORDER BY created_at DESC, id DESC LIMIT $2`,
      params
    );
    return rows;
  },

  // ---------- balance and payouts ----------

  /** Earned (owner + driver ledgers) minus withdrawals that are PENDING or PAID. FAILED withdrawals give the money back. */
  async balance(userId: string, client?: PoolClient): Promise<{ earned: number; withdrawn: number; available: number }> {
    const runner = client ?? pool;
    const { rows } = await runner.query<{ earned: string; withdrawn: string }>(
      `SELECT
         (SELECT COALESCE(SUM(amount), 0) FROM owner_earnings WHERE owner_id = $1)
       + (SELECT COALESCE(SUM(amount), 0) FROM driver_earnings WHERE driver_id = $1) AS earned,
         (SELECT COALESCE(SUM(amount), 0) FROM payouts
            WHERE user_id = $1 AND kind = 'EARNINGS_WITHDRAWAL' AND status IN ('PENDING','PAID')) AS withdrawn`,
      [userId]
    );
    const earned = num(rows[0].earned);
    const withdrawn = num(rows[0].withdrawn);
    return { earned, withdrawn, available: Math.round((earned - withdrawn) * 100) / 100 };
  },

  /**
   * Reserves money for a withdrawal. The user's row is locked FOR UPDATE for the duration of the transaction, so two
   * simultaneous withdrawals are serialised: the second one computes its balance AFTER the first one's row exists.
   * (Without the lock both would read the same balance and together overdraw it.)
   * Returns the existing payout when the idempotency key was already used.
   */
  async reserveWithdrawal(input: {
    userId: string; amount: number | null; minAmount: number; idempotencyKey: string; currency: string;
  }): Promise<{ payout: PayoutRecord; created: boolean } | { error: "NO_FUNDS" | "BELOW_MINIMUM" | "INSUFFICIENT"; available: number }> {
    return withTransaction(async (client) => {
      await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [input.userId]);

      const existing = await client.query<PayoutRecord>(`SELECT * FROM payouts WHERE idempotency_key = $1`, [input.idempotencyKey]);
      if (existing.rows[0]) return { payout: existing.rows[0], created: false };

      const bal = await this.balance(input.userId, client);
      const amount = input.amount ?? bal.available;
      if (bal.available <= 0) return { error: "NO_FUNDS", available: bal.available };
      if (amount < input.minAmount) return { error: "BELOW_MINIMUM", available: bal.available };
      if (Math.round(amount * 100) > Math.round(bal.available * 100)) return { error: "INSUFFICIENT", available: bal.available };

      const { rows } = await client.query<PayoutRecord>(
        `INSERT INTO payouts (user_id, kind, amount, currency, idempotency_key) VALUES ($1, 'EARNINGS_WITHDRAWAL', $2, $3, $4) RETURNING *`,
        [input.userId, amount, input.currency, input.idempotencyKey]
      );
      return { payout: rows[0], created: true };
    });
  },

  /** Creates (once per booking) the deposit-refund payout. Returns the existing row on conflict. */
  async upsertDepositRefund(input: { renterId: string; bookingId: string; amount: number; currency: string }): Promise<PayoutRecord> {
    const key = `deposit-refund:${input.bookingId}`;
    const { rows } = await pool.query<PayoutRecord>(
      `INSERT INTO payouts (user_id, kind, amount, currency, source_type, source_id, idempotency_key)
       VALUES ($1, 'DEPOSIT_REFUND', $2, $3, 'RENTAL', $4, $5)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
      [input.renterId, input.amount, input.currency, input.bookingId, key]
    );
    if (rows[0]) return rows[0];
    return (await pool.query<PayoutRecord>(`SELECT * FROM payouts WHERE idempotency_key = $1`, [key])).rows[0];
  },

  async findPayout(id: string): Promise<PayoutRecord | null> {
    const { rows } = await pool.query<PayoutRecord>(`SELECT * FROM payouts WHERE id = $1`, [id]);
    return rows[0] ?? null;
  },

  async listPayouts(userId: string, limit: number): Promise<PayoutRecord[]> {
    const { rows } = await pool.query<PayoutRecord>(`SELECT * FROM payouts WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, [userId, limit]);
    return rows;
  },

  /** Guarded transition: only moves a payout that is still in one of `from`. */
  async transitionPayout(id: string, from: string[], to: "PAID" | "FAILED", extra: { reference?: string; reason?: string } = {}): Promise<PayoutRecord | null> {
    const { rows } = await pool.query<PayoutRecord>(
      `UPDATE payouts SET status = $3::payout_status, provider_reference = COALESCE($4, provider_reference),
              failure_reason = $5, paid_at = CASE WHEN $3 = 'PAID' THEN now() ELSE paid_at END
       WHERE id = $1 AND status = ANY($2::payout_status[]) RETURNING *`,
      [id, from, to, extra.reference ?? null, extra.reason ?? null]
    );
    return rows[0] ?? null;
  },
};
