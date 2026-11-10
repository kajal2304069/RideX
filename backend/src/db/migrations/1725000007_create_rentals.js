/**
 * Migration: 007_create_rentals
 *
 * Double-booking prevention (spec section 25: "Vehicle RENTED cannot
 * simultaneously be available for another rental") is enforced with a
 * PostgreSQL EXCLUSION CONSTRAINT using the `btree_gist` extension -
 * this makes it IMPOSSIBLE at the database level for two CONFIRMED/ACTIVE
 * bookings on the same rental listing to have overlapping [start_at,
 * end_at) ranges, even under concurrent writes (this is the same class
 * of guarantee `SELECT ... FOR UPDATE` gives for ride acceptance in
 * Phase 9/12, just expressed as a constraint instead of an application
 * lock - the DB is a stronger, non-bypassable enforcement point than
 * the same check written into service code alone).
 */

exports.up = (pgm) => {
  pgm.createExtension("btree_gist", { ifNotExists: true });

  pgm.createTable("rental_listings", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    owner_id: { type: "uuid", notNull: true, references: "users", onDelete: "cascade" },
    vehicle_id: { type: "uuid", notNull: true, unique: true, references: "vehicles", onDelete: "cascade" },
    hourly_price: { type: "numeric(10,2)" },
    daily_price: { type: "numeric(10,2)" },
    security_deposit: { type: "numeric(10,2)", notNull: true, default: 0 },
    pickup_location: { type: "geography(Point,4326)", notNull: true },
    pickup_address: { type: "text" },
    rules: { type: "text" },
    is_active: { type: "boolean", notNull: true, default: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("rental_listings", "pickup_location", { method: "gist" });
  pgm.createIndex("rental_listings", "owner_id");

  pgm.createType("rental_booking_status", [
    "PENDING_PAYMENT",
    "CONFIRMED",
    "ACTIVE",
    "COMPLETED",
    "CANCELLED",
  ]);

  pgm.createTable("rental_bookings", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    rental_listing_id: { type: "uuid", notNull: true, references: "rental_listings", onDelete: "restrict" },
    renter_id: { type: "uuid", notNull: true, references: "users", onDelete: "cascade" },
    status: { type: "rental_booking_status", notNull: true, default: "PENDING_PAYMENT" },
    start_at: { type: "timestamptz", notNull: true },
    end_at: { type: "timestamptz", notNull: true },
    actual_return_at: { type: "timestamptz" },
    total_amount: { type: "numeric(10,2)", notNull: true },
    deposit_amount: { type: "numeric(10,2)", notNull: true, default: 0 },
    idempotency_key: { type: "text", unique: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("rental_bookings", "rental_bookings_valid_range", 'CHECK (end_at > start_at)');
  pgm.createIndex("rental_bookings", "rental_listing_id");
  pgm.createIndex("rental_bookings", "renter_id");

  // The actual double-booking guard: no two bookings on the same listing
  // may have overlapping time ranges WHILE both are in a "holds the
  // vehicle" state (CONFIRMED or ACTIVE). Cancelled/completed bookings
  // are excluded from the check via the WHERE clause, so returning a
  // vehicle correctly frees up that slot for a new booking.
  pgm.sql(`
    ALTER TABLE rental_bookings
    ADD CONSTRAINT rental_bookings_no_overlap
    EXCLUDE USING gist (
      rental_listing_id WITH =,
      tstzrange(start_at, end_at, '[)') WITH &&
    )
    WHERE (status IN ('CONFIRMED', 'ACTIVE'))
  `);
};

exports.down = (pgm) => {
  pgm.dropTable("rental_bookings");
  pgm.dropType("rental_booking_status");
  pgm.dropTable("rental_listings");
};
