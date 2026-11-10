/**
 * Migration: 004_create_payments
 *
 * `payments` is deliberately polymorphic (`payable_type` + `payable_id`)
 * rather than four separate tables (ride_payments, rental_payments, ...)
 * because payment STATE MACHINE, PROVIDER, and IDEMPOTENCY logic (spec
 * sections 13 & 16) is identical regardless of what's being paid for -
 * duplicating that logic per domain would be the real "fake system
 * design" anti-pattern the brief warns against. `payable_id` isn't a
 * foreign key (it can't be - it points at different tables depending on
 * `payable_type`), so referential integrity for it is enforced in the
 * PaymentService (Phase 12), not the database. This is a standard,
 * accepted trade-off for polymorphic associations.
 *
 * `idempotency_key` is UNIQUE and NOT NULL - every payment attempt MUST
 * supply one (spec section 13: never charge twice for the same intent).
 */

exports.up = (pgm) => {
  pgm.createType("payable_type", ["RIDE", "RENTAL", "MARKETPLACE", "GARAGE_SERVICE"]);
  pgm.createType("payment_status", ["PENDING", "PROCESSING", "SUCCESS", "FAILED", "REFUNDED"]);
  pgm.createType("payment_provider", ["mock", "stripe"]);

  pgm.createTable("payments", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    payable_type: { type: "payable_type", notNull: true },
    payable_id: { type: "uuid", notNull: true },
    payer_id: { type: "uuid", notNull: true, references: "users", onDelete: "restrict" },
    amount: { type: "numeric(10,2)", notNull: true },
    currency: { type: "text", notNull: true, default: "INR" },
    provider: { type: "payment_provider", notNull: true, default: "mock" },
    // Reference/charge ID from the payment provider (e.g. Stripe PaymentIntent id).
    // Never store raw card data (spec section 16) - only this opaque reference.
    provider_reference: { type: "text" },
    status: { type: "payment_status", notNull: true, default: "PENDING" },
    idempotency_key: { type: "text", notNull: true, unique: true },
    failure_reason: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.createIndex("payments", ["payable_type", "payable_id"]);
  pgm.createIndex("payments", "payer_id");
  pgm.createIndex("payments", "status");
};

exports.down = (pgm) => {
  pgm.dropTable("payments");
  pgm.dropType("payment_provider");
  pgm.dropType("payment_status");
  pgm.dropType("payable_type");
};
