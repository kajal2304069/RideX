/**
 * Migration: 002_create_vehicle_and_driver_domain
 *
 * Design notes:
 *
 *  - Location columns use PostGIS `geography(Point, 4326)` (not plain
 *    `geometry`) because `geography` does distance/area math in real
 *    METERS on the sphere automatically, whereas `geometry` treats
 *    coordinates as flat Cartesian units - wrong for lat/lng unless you
 *    manually reproject. For a mobility app where "how many meters away
 *    is this garage" is a first-class query, `geography` is the right
 *    default. Every geography column gets a GIST index, which is what
 *    makes `ST_DWithin` / `<->` nearest-neighbor queries fast instead of
 *    a full table scan.
 *
 *  - `vehicle_locations` is a PERIODIC SNAPSHOT table, not the live GPS
 *    feed. Per spec section 8 ("do not write every GPS update directly
 *    to PostgreSQL"), live position lives in Redis GEO (Phase 7/11) and
 *    only gets persisted here on a sampled interval - useful for trip
 *    replay/analytics, not for "where is this driver right now."
 *
 *  - `vehicles.status` is a single source of truth for the state
 *    machine in spec section 25 (AVAILABLE / RENTED / IN_RIDE_SERVICE /
 *    UNDER_MAINTENANCE / UNAVAILABLE). Enforcing "can't be RENTED and
 *    IN_RIDE_SERVICE at once" is a single-column enum, not two booleans
 *    that could disagree.
 *
 *  - `updated_at` columns are maintained by the application layer
 *    (repository UPDATE statements set it explicitly), not DB triggers -
 *    keeps the "only repositories touch SQL, only services own business
 *    rules" layering from Phase 1 clean, at the cost of repositories
 *    needing to remember to set it (documented here so it isn't missed).
 */

exports.up = (pgm) => {
  pgm.createExtension("postgis", { ifNotExists: true });

  // --- Vehicle types (spec section 6: Bike/Auto/Mini/Sedan/SUV/Premium/XL) ---
  pgm.createTable("vehicle_types", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    code: { type: "text", notNull: true, unique: true }, // BIKE, AUTO, MINI, SEDAN, SUV, PREMIUM, XL
    display_name: { type: "text", notNull: true },
    category: { type: "text", notNull: true, default: "RIDE" }, // RIDE | RENTAL | BOTH
    capacity: { type: "integer", notNull: true, default: 4 },
    base_fare: { type: "numeric(10,2)", notNull: true, default: 0 },
    per_km_rate: { type: "numeric(10,2)", notNull: true, default: 0 },
    per_min_rate: { type: "numeric(10,2)", notNull: true, default: 0 },
    is_active: { type: "boolean", notNull: true, default: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.createType("vehicle_status", [
    "AVAILABLE",
    "RENTED",
    "IN_RIDE_SERVICE",
    "UNDER_MAINTENANCE",
    "UNAVAILABLE",
  ]);
  pgm.createType("fuel_type", ["PETROL", "DIESEL", "ELECTRIC", "HYBRID", "CNG"]);
  pgm.createType("transmission_type", ["MANUAL", "AUTOMATIC"]);

  pgm.createTable("vehicles", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    owner_id: { type: "uuid", notNull: true, references: "users", onDelete: "cascade" },
    vehicle_type_id: { type: "uuid", notNull: true, references: "vehicle_types" },
    registration_number: { type: "text", notNull: true, unique: true },
    brand: { type: "text", notNull: true },
    model: { type: "text", notNull: true },
    year: { type: "integer", notNull: true },
    color: { type: "text" },
    fuel_type: { type: "fuel_type", notNull: true, default: "PETROL" },
    transmission: { type: "transmission_type", notNull: true, default: "MANUAL" },
    mileage_km: { type: "integer", notNull: true, default: 0 },
    status: { type: "vehicle_status", notNull: true, default: "AVAILABLE" },
    current_driver_id: { type: "uuid", references: "users", onDelete: "set null" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("vehicles", "owner_id");
  pgm.createIndex("vehicles", "status");
  pgm.createIndex("vehicles", "current_driver_id");

  // --- Driver / rider profiles (1:1 extension of users, per role) ---
  pgm.createType("verification_status", ["PENDING", "VERIFIED", "REJECTED"]);

  pgm.createTable("drivers", {
    user_id: { type: "uuid", primaryKey: true, references: "users", onDelete: "cascade" },
    license_number: { type: "text", notNull: true, unique: true },
    license_expiry: { type: "date", notNull: true },
    verification_status: { type: "verification_status", notNull: true, default: "PENDING" },
    is_online: { type: "boolean", notNull: true, default: false },
    current_vehicle_id: { type: "uuid", references: "vehicles", onDelete: "set null" },
    rating_avg: { type: "numeric(3,2)", notNull: true, default: 5.0 },
    total_rides: { type: "integer", notNull: true, default: 0 },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("drivers", "is_online");

  pgm.createTable("riders", {
    user_id: { type: "uuid", primaryKey: true, references: "users", onDelete: "cascade" },
    rating_avg: { type: "numeric(3,2)", notNull: true, default: 5.0 },
    total_rides: { type: "integer", notNull: true, default: 0 },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  // --- Periodic vehicle/driver location snapshots (NOT the live GPS feed - see note above) ---
  pgm.createTable("vehicle_locations", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    vehicle_id: { type: "uuid", notNull: true, references: "vehicles", onDelete: "cascade" },
    driver_id: { type: "uuid", references: "users", onDelete: "set null" },
    location: { type: "geography(Point,4326)", notNull: true },
    heading: { type: "real" },
    speed_kmh: { type: "real" },
    recorded_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("vehicle_locations", "location", { method: "gist" });
  pgm.createIndex("vehicle_locations", ["vehicle_id", "recorded_at"]);

  // --- Owner -> Driver vehicle assignment + earning split (spec section 24) ---
  pgm.createType("assignment_status", ["ACTIVE", "ENDED"]);

  pgm.createTable("vehicle_driver_assignments", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    vehicle_id: { type: "uuid", notNull: true, references: "vehicles", onDelete: "cascade" },
    driver_id: { type: "uuid", notNull: true, references: "users", onDelete: "cascade" },
    owner_id: { type: "uuid", notNull: true, references: "users", onDelete: "cascade" },
    commission_percent: { type: "numeric(5,2)", notNull: true }, // platform's cut is separate - see platform_commissions
    owner_share_percent: { type: "numeric(5,2)", notNull: true },
    status: { type: "assignment_status", notNull: true, default: "ACTIVE" },
    started_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    ended_at: { type: "timestamptz" },
  });
  pgm.createIndex("vehicle_driver_assignments", "vehicle_id");
  pgm.createIndex("vehicle_driver_assignments", "driver_id");
  // A vehicle can only have ONE active assignment at a time - enforced with a
  // partial unique index rather than application logic alone, so even a
  // concurrency bug in the service layer can't create two.
  pgm.sql(`
    CREATE UNIQUE INDEX vehicle_driver_assignments_one_active_per_vehicle
    ON vehicle_driver_assignments (vehicle_id)
    WHERE status = 'ACTIVE'
  `);
};

exports.down = (pgm) => {
  pgm.dropTable("vehicle_driver_assignments");
  pgm.dropType("assignment_status");
  pgm.dropTable("vehicle_locations");
  pgm.dropTable("riders");
  pgm.dropTable("drivers");
  pgm.dropType("verification_status");
  pgm.dropTable("vehicles");
  pgm.dropType("transmission_type");
  pgm.dropType("fuel_type");
  pgm.dropType("vehicle_status");
  pgm.dropTable("vehicle_types");
};
