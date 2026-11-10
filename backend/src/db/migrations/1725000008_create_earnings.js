/**
 * Migration: 008_create_earnings
 *
 * These are append-only ledger tables (spec section 24's owner/driver
 * earnings dashboards, section 34's revenue reporting), not mutable
 * balances - a row is inserted per earning event and dashboards SUM
 * over date ranges. This is the standard "ledger, not account balance
 * column" pattern: it's auditable (every earning has a traceable
 * source_id), replayable, and immune to the classic bug where a mutable
 * running balance drifts from reality after a missed update.
 */

exports.up = (pgm) => {
  pgm.createType("earning_source_type", ["RIDE_SHARE", "RENTAL"]);

  pgm.createTable("owner_earnings", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    owner_id: { type: "uuid", notNull: true, references: "users", onDelete: "cascade" },
    source_type: { type: "earning_source_type", notNull: true },
    source_id: { type: "uuid", notNull: true }, // ride_id or rental_booking_id, depending on source_type
    amount: { type: "numeric(10,2)", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("owner_earnings", ["owner_id", "created_at"]);

  pgm.createType("driver_earning_type", ["RIDE_FARE", "BONUS", "ADJUSTMENT"]);

  pgm.createTable("driver_earnings", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    driver_id: { type: "uuid", notNull: true, references: "users", onDelete: "cascade" },
    ride_id: { type: "uuid", references: "rides", onDelete: "set null" },
    type: { type: "driver_earning_type", notNull: true, default: "RIDE_FARE" },
    amount: { type: "numeric(10,2)", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("driver_earnings", ["driver_id", "created_at"]);

  pgm.createTable("platform_commissions", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    source_type: { type: "payable_type", notNull: true }, // reuse RIDE/RENTAL/MARKETPLACE/GARAGE_SERVICE from payments
    source_id: { type: "uuid", notNull: true },
    amount: { type: "numeric(10,2)", notNull: true },
    rate_percent: { type: "numeric(5,2)", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("platform_commissions", ["source_type", "created_at"]);
};

exports.down = (pgm) => {
  pgm.dropTable("platform_commissions");
  pgm.dropTable("driver_earnings");
  pgm.dropType("driver_earning_type");
  pgm.dropTable("owner_earnings");
  pgm.dropType("earning_source_type");
};
