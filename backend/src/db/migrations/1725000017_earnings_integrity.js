/**
 * Migration: 017_earnings_integrity (Phase 17: owner -> driver earnings)
 *
 * The Phase 3 ledgers were plain tables. Money needs the database to refuse
 * mistakes, so this adds:
 *   - one-settlement-per-source UNIQUE indexes (a retried/duplicated settlement
 *     can never pay anyone twice - the same "constraint is the real guard" idea
 *     used for bookings and payments)
 *   - non-negative CHECKs on every ledger amount
 *   - a `payouts` table: money leaving the platform (withdrawals + deposit refunds)
 *   - the vehicle on the owner ledger row, so per-vehicle dashboards are one GROUP BY
 */

exports.up = (pgm) => {
  // ---------- ledger integrity ----------
  pgm.addColumn("owner_earnings", {
    vehicle_id: { type: "uuid", references: "vehicles", onDelete: "set null" },
    driver_id: { type: "uuid", references: "users", onDelete: "set null" },
  });
  pgm.createIndex("owner_earnings", ["vehicle_id", "created_at"]);
  pgm.addConstraint("owner_earnings", "owner_earnings_amount_nonneg", "CHECK (amount >= 0)");
  pgm.createIndex("owner_earnings", ["source_type", "source_id"], { unique: true, name: "owner_earnings_one_per_source" });

  pgm.addConstraint("platform_commissions", "platform_commissions_amount_nonneg", "CHECK (amount >= 0)");
  pgm.addConstraint("platform_commissions", "platform_commissions_rate_range", "CHECK (rate_percent >= 0 AND rate_percent <= 100)");
  pgm.createIndex("platform_commissions", ["source_type", "source_id"], { unique: true, name: "platform_commissions_one_per_source" });

  // Adjustments may be negative (a clawback); fares and bonuses may not.
  pgm.addConstraint("driver_earnings", "driver_earnings_amount_sign", "CHECK (type = 'ADJUSTMENT' OR amount >= 0)");
  pgm.sql(`CREATE UNIQUE INDEX driver_earnings_one_fare_per_ride ON driver_earnings (ride_id) WHERE type = 'RIDE_FARE'`);

  // ---------- payouts: money leaving the platform ----------
  pgm.createType("payout_kind", ["EARNINGS_WITHDRAWAL", "DEPOSIT_REFUND"]);
  pgm.createType("payout_status", ["PENDING", "PAID", "FAILED"]);

  pgm.createTable("payouts", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    user_id: { type: "uuid", notNull: true, references: "users", onDelete: "restrict" },
    kind: { type: "payout_kind", notNull: true },
    amount: { type: "numeric(10,2)", notNull: true },
    currency: { type: "text", notNull: true, default: "INR" },
    status: { type: "payout_status", notNull: true, default: "PENDING" },
    // DEPOSIT_REFUND rows point at the rental booking; withdrawals have no source.
    source_type: { type: "payable_type" },
    source_id: { type: "uuid" },
    idempotency_key: { type: "text", notNull: true, unique: true },
    provider_reference: { type: "text" },
    failure_reason: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    paid_at: { type: "timestamptz" },
  });
  pgm.addConstraint("payouts", "payouts_amount_positive", "CHECK (amount > 0)");
  pgm.addConstraint(
    "payouts",
    "payouts_source_matches_kind",
    "CHECK ((kind = 'DEPOSIT_REFUND' AND source_type = 'RENTAL' AND source_id IS NOT NULL) OR (kind = 'EARNINGS_WITHDRAWAL' AND source_id IS NULL))"
  );
  // One deposit refund per booking, ever.
  pgm.sql(`CREATE UNIQUE INDEX payouts_one_deposit_refund_per_booking ON payouts (source_id) WHERE kind = 'DEPOSIT_REFUND'`);
  pgm.createIndex("payouts", ["user_id", "created_at"]);
  pgm.sql(`CREATE INDEX payouts_user_live ON payouts (user_id) WHERE kind = 'EARNINGS_WITHDRAWAL' AND status IN ('PENDING','PAID')`);
};

exports.down = (pgm) => {
  pgm.dropTable("payouts");
  pgm.dropType("payout_status");
  pgm.dropType("payout_kind");

  pgm.sql(`DROP INDEX IF EXISTS driver_earnings_one_fare_per_ride`);
  pgm.dropConstraint("driver_earnings", "driver_earnings_amount_sign");

  pgm.dropIndex("platform_commissions", [], { name: "platform_commissions_one_per_source" });
  pgm.dropConstraint("platform_commissions", "platform_commissions_rate_range");
  pgm.dropConstraint("platform_commissions", "platform_commissions_amount_nonneg");

  pgm.dropIndex("owner_earnings", [], { name: "owner_earnings_one_per_source" });
  pgm.dropConstraint("owner_earnings", "owner_earnings_amount_nonneg");
  pgm.dropIndex("owner_earnings", ["vehicle_id", "created_at"]);
  pgm.dropColumn("owner_earnings", ["vehicle_id", "driver_id"]);
};
