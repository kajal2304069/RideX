/**
 * Phase 16: database-level rules for vehicle rental.
 *
 *  1. A PENDING_PAYMENT booking now HOLDS the vehicle (for a short, payment_due_at-bounded window). Before, only
 *     CONFIRMED/ACTIVE bookings were in the exclusion constraint, so two renters could both reach the payment screen
 *     for the same dates and the loser would be charged for a vehicle that was already gone. Holding at booking time
 *     moves the conflict to the cheap step (creating the booking), not the expensive one (taking money).
 *  2. rental_bookings gets the lifecycle columns: payment deadline, confirmed/started/cancelled timestamps, who
 *     cancelled, late fee, damage deduction, deposit settlement, refund amount.
 *  3. CHECKs: duration between 1 hour and 30 days, positive amounts, at least one price on a listing.
 *  4. A listing can only be created by the vehicle's OWNER, enforced by a composite foreign key
 *     (vehicle_id, owner_id) -> vehicles (id, owner_id). Application code checks first for a friendly error.
 *  5. rental_booking_status gains EXPIRED (a hold whose payment deadline passed).
 */
exports.up = (pgm) => {
  pgm.sql(`ALTER TYPE rental_booking_status ADD VALUE IF NOT EXISTS 'EXPIRED'`);

  pgm.addColumns("rental_bookings", {
    payment_due_at: { type: "timestamptz" },
    confirmed_at: { type: "timestamptz" },
    started_at: { type: "timestamptz" },
    cancelled_at: { type: "timestamptz" },
    cancelled_by: { type: "text" },
    hourly_rate_at_booking: { type: "numeric(10,2)", notNull: true, default: 0 },
    late_fee: { type: "numeric(10,2)", notNull: true, default: 0 },
    damage_deduction: { type: "numeric(10,2)", notNull: true, default: 0 },
    deposit_refund_due: { type: "numeric(10,2)" },
    refund_amount: { type: "numeric(10,2)", notNull: true, default: 0 },
    return_notes: { type: "text" },
  });
  pgm.addConstraint("rental_bookings", "rental_bookings_cancelled_by_valid", "CHECK (cancelled_by IS NULL OR cancelled_by IN ('RENTER', 'OWNER', 'SYSTEM'))");
  pgm.addConstraint("rental_bookings", "rental_bookings_duration_range", // An inverted/empty range is rejected by the existing rental_bookings_valid_range; this one only judges the length of valid ranges.
    "CHECK (end_at <= start_at OR (end_at - start_at >= interval '1 hour' AND end_at - start_at <= interval '30 days'))");
  pgm.addConstraint("rental_bookings", "rental_bookings_amounts_valid",
    "CHECK (total_amount > 0 AND deposit_amount >= 0 AND late_fee >= 0 AND damage_deduction >= 0 AND refund_amount >= 0)");
  pgm.addConstraint("rental_bookings", "rental_bookings_deductions_within_deposit",
    "CHECK (deposit_refund_due IS NULL OR (deposit_refund_due >= 0 AND deposit_refund_due <= deposit_amount))");

  // The hold now includes PENDING_PAYMENT.
  pgm.sql(`ALTER TABLE rental_bookings DROP CONSTRAINT rental_bookings_no_overlap`);
  pgm.sql(`
    ALTER TABLE rental_bookings
    ADD CONSTRAINT rental_bookings_no_overlap
    EXCLUDE USING gist (
      rental_listing_id WITH =,
      tstzrange(start_at, end_at, '[)') WITH &&
    )
    WHERE (status IN ('PENDING_PAYMENT', 'CONFIRMED', 'ACTIVE'))
  `);
  pgm.sql(`CREATE INDEX rental_bookings_pending_due ON rental_bookings (payment_due_at) WHERE status = 'PENDING_PAYMENT'`);

  pgm.addConstraint("rental_listings", "rental_listings_has_price", "CHECK (hourly_price IS NOT NULL OR daily_price IS NOT NULL)");
  pgm.addConstraint("rental_listings", "rental_listings_prices_positive",
    "CHECK ((hourly_price IS NULL OR hourly_price > 0) AND (daily_price IS NULL OR daily_price > 0) AND security_deposit >= 0)");

  pgm.sql(`ALTER TABLE vehicles ADD CONSTRAINT vehicles_id_owner_unique UNIQUE (id, owner_id)`);
  pgm.sql(`
    ALTER TABLE rental_listings
    ADD CONSTRAINT rental_listings_vehicle_owner_fk
    FOREIGN KEY (vehicle_id, owner_id) REFERENCES vehicles (id, owner_id) ON DELETE CASCADE
  `);

  pgm.sql(`CREATE INDEX rental_listings_active_created ON rental_listings (created_at DESC, id DESC) WHERE is_active`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS rental_listings_active_created`);
  pgm.sql(`ALTER TABLE rental_listings DROP CONSTRAINT rental_listings_vehicle_owner_fk`);
  pgm.sql(`ALTER TABLE vehicles DROP CONSTRAINT vehicles_id_owner_unique`);
  pgm.dropConstraint("rental_listings", "rental_listings_prices_positive");
  pgm.dropConstraint("rental_listings", "rental_listings_has_price");
  pgm.sql(`DROP INDEX IF EXISTS rental_bookings_pending_due`);
  pgm.sql(`ALTER TABLE rental_bookings DROP CONSTRAINT rental_bookings_no_overlap`);
  pgm.sql(`
    ALTER TABLE rental_bookings
    ADD CONSTRAINT rental_bookings_no_overlap
    EXCLUDE USING gist (rental_listing_id WITH =, tstzrange(start_at, end_at, '[)') WITH &&)
    WHERE (status IN ('CONFIRMED', 'ACTIVE'))
  `);
  pgm.dropConstraint("rental_bookings", "rental_bookings_deductions_within_deposit");
  pgm.dropConstraint("rental_bookings", "rental_bookings_amounts_valid");
  pgm.dropConstraint("rental_bookings", "rental_bookings_duration_range");
  pgm.dropConstraint("rental_bookings", "rental_bookings_cancelled_by_valid");
  pgm.dropColumns("rental_bookings", [
    "payment_due_at", "confirmed_at", "started_at", "cancelled_at", "cancelled_by", "hourly_rate_at_booking",
    "late_fee", "damage_deduction", "deposit_refund_due", "refund_amount", "return_notes",
  ]);
  // The EXPIRED enum value cannot be removed in PostgreSQL; it is harmless to leave.
};
