/**
 * Migration: 003_create_rides_domain
 *
 * `ride_status` encodes the full state machine from spec section 7.
 * Postgres enums enforce "this column can only ever hold one of these
 * values", but the ALLOWED TRANSITIONS (e.g. COMPLETED -> REQUESTED must
 * never happen) are a business rule, not a column constraint - that
 * validation lives in the RideStateMachine service (Phase 6), which is
 * the correct layer for it per the Phase 1 layering rules. The DB's job
 * here is just to guarantee the column never holds a garbage value.
 *
 * pickup/dropoff are geography points (see migration 002's note on why
 * geography over geometry) with GIST indexes, since "find rides near
 * this point" and driver-matching distance queries hit these columns.
 */

exports.up = (pgm) => {
  pgm.createType("ride_status", [
    "REQUESTED",
    "SEARCHING_DRIVER",
    "DRIVER_ASSIGNED",
    "DRIVER_ARRIVING",
    "DRIVER_ARRIVED",
    "TRIP_STARTED",
    "TRIP_COMPLETED",
    "PAYMENT_COMPLETED",
    "CANCELLED_BY_RIDER",
    "CANCELLED_BY_DRIVER",
    "CANCELLED_BY_SYSTEM",
  ]);

  pgm.createTable("rides", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    rider_id: { type: "uuid", notNull: true, references: "users", onDelete: "restrict" },
    driver_id: { type: "uuid", references: "users", onDelete: "set null" },
    vehicle_id: { type: "uuid", references: "vehicles", onDelete: "set null" },
    vehicle_type_id: { type: "uuid", notNull: true, references: "vehicle_types" },
    status: { type: "ride_status", notNull: true, default: "REQUESTED" },

    pickup_location: { type: "geography(Point,4326)", notNull: true },
    pickup_address: { type: "text", notNull: true },
    dropoff_location: { type: "geography(Point,4326)", notNull: true },
    dropoff_address: { type: "text", notNull: true },

    // Idempotency (spec section 13): a client-supplied key so retried
    // "create ride" requests (flaky mobile network, double-tap) can't
    // create two rides for the same intent.
    idempotency_key: { type: "text", unique: true },

    distance_meters: { type: "integer" },
    duration_seconds: { type: "integer" },

    requested_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    accepted_at: { type: "timestamptz" },
    arrived_at: { type: "timestamptz" },
    started_at: { type: "timestamptz" },
    completed_at: { type: "timestamptz" },
    cancelled_at: { type: "timestamptz" },
    cancellation_reason: { type: "text" },

    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.createIndex("rides", "rider_id");
  pgm.createIndex("rides", "driver_id");
  pgm.createIndex("rides", "status");
  pgm.createIndex("rides", "pickup_location", { method: "gist" });
  pgm.createIndex("rides", "dropoff_location", { method: "gist" });
  // Composite index for "this driver's currently-active ride" lookups,
  // which the concurrency-critical accept-ride flow (Phase 9) hits often.
  pgm.createIndex("rides", ["driver_id", "status"]);

  // --- Fare breakdown (spec section 14) - one row per ride ---
  pgm.createTable("ride_fares", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    ride_id: { type: "uuid", notNull: true, unique: true, references: "rides", onDelete: "cascade" },
    base_fare: { type: "numeric(10,2)", notNull: true, default: 0 },
    distance_charge: { type: "numeric(10,2)", notNull: true, default: 0 },
    time_charge: { type: "numeric(10,2)", notNull: true, default: 0 },
    booking_fee: { type: "numeric(10,2)", notNull: true, default: 0 },
    surge_multiplier: { type: "numeric(4,2)", notNull: true, default: 1.0 },
    discount: { type: "numeric(10,2)", notNull: true, default: 0 },
    tax: { type: "numeric(10,2)", notNull: true, default: 0 },
    total_fare: { type: "numeric(10,2)", notNull: true },
    currency: { type: "text", notNull: true, default: "INR" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  // --- Ratings (rider<->driver, both directions, one per ride per rater) ---
  pgm.createTable("ratings", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    ride_id: { type: "uuid", notNull: true, references: "rides", onDelete: "cascade" },
    rater_id: { type: "uuid", notNull: true, references: "users", onDelete: "cascade" },
    ratee_id: { type: "uuid", notNull: true, references: "users", onDelete: "cascade" },
    rating: { type: "smallint", notNull: true },
    comment: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("ratings", "ratings_rating_range", "CHECK (rating BETWEEN 1 AND 5)");
  pgm.addConstraint("ratings", "ratings_one_per_rater_per_ride", "UNIQUE (ride_id, rater_id)");
  pgm.createIndex("ratings", "ratee_id");
};

exports.down = (pgm) => {
  pgm.dropTable("ratings");
  pgm.dropTable("ride_fares");
  pgm.dropTable("rides");
  pgm.dropType("ride_status");
};
