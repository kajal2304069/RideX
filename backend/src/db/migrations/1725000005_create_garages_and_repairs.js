/**
 * Migration: 005_create_garages_and_repairs
 *
 * `garages.location` gets a GIST index for the same reason vehicles/rides
 * do - "nearby garages" (spec section 17) is a `ST_DWithin` / `<->`
 * query, and without the index that's a full table scan per request.
 *
 * `service_bookings.status` encodes the state machine from spec section 18.
 */

exports.up = (pgm) => {
  pgm.createTable("garages", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    owner_id: { type: "uuid", notNull: true, references: "users", onDelete: "cascade" },
    name: { type: "text", notNull: true },
    location: { type: "geography(Point,4326)", notNull: true },
    address: { type: "text", notNull: true },
    phone: { type: "text" },
    opening_hours: { type: "jsonb" }, // e.g. {"mon": "09:00-18:00", ...}
    price_range: { type: "text" }, // e.g. "$$", "500-2000"
    rating_avg: { type: "numeric(3,2)", notNull: true, default: 5.0 },
    is_active: { type: "boolean", notNull: true, default: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("garages", "location", { method: "gist" });
  pgm.createIndex("garages", "owner_id");

  pgm.createTable("mechanics", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    garage_id: { type: "uuid", notNull: true, references: "garages", onDelete: "cascade" },
    user_id: { type: "uuid", references: "users", onDelete: "set null" },
    name: { type: "text", notNull: true },
    specialization: { type: "text" },
    is_active: { type: "boolean", notNull: true, default: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("mechanics", "garage_id");

  pgm.createType("garage_service_type", [
    "OIL_CHANGE",
    "BRAKE_REPAIR",
    "ENGINE_REPAIR",
    "TYRE_REPLACEMENT",
    "BATTERY_REPLACEMENT",
    "GENERAL_SERVICE",
    "ELECTRICAL_REPAIR",
    "AC_REPAIR",
    "BODY_WORK",
    "EMERGENCY_REPAIR",
  ]);

  pgm.createTable("garage_services", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    garage_id: { type: "uuid", notNull: true, references: "garages", onDelete: "cascade" },
    service_type: { type: "garage_service_type", notNull: true },
    price_from: { type: "numeric(10,2)" },
    price_to: { type: "numeric(10,2)" },
    estimated_duration_minutes: { type: "integer" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("garage_services", ["garage_id", "service_type"]);

  pgm.createType("service_booking_status", [
    "REQUESTED",
    "ACCEPTED",
    "MECHANIC_ASSIGNED",
    "VEHICLE_RECEIVED",
    "REPAIR_IN_PROGRESS",
    "READY",
    "COMPLETED",
    "CANCELLED",
  ]);

  pgm.createTable("service_bookings", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    garage_id: { type: "uuid", notNull: true, references: "garages", onDelete: "restrict" },
    customer_id: { type: "uuid", notNull: true, references: "users", onDelete: "cascade" },
    vehicle_id: { type: "uuid", references: "vehicles", onDelete: "set null" },
    garage_service_id: { type: "uuid", references: "garage_services", onDelete: "set null" },
    mechanic_id: { type: "uuid", references: "mechanics", onDelete: "set null" },
    status: { type: "service_booking_status", notNull: true, default: "REQUESTED" },
    is_emergency: { type: "boolean", notNull: true, default: false }, // spec section 19: emergency breakdown
    scheduled_at: { type: "timestamptz" },
    idempotency_key: { type: "text", unique: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("service_bookings", "garage_id");
  pgm.createIndex("service_bookings", "customer_id");
  pgm.createIndex("service_bookings", "status");

  pgm.createTable("repair_orders", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    service_booking_id: { type: "uuid", notNull: true, unique: true, references: "service_bookings", onDelete: "cascade" },
    diagnosis: { type: "text" },
    work_performed: { type: "text" },
    parts_used: { type: "jsonb" },
    labor_cost: { type: "numeric(10,2)", notNull: true, default: 0 },
    parts_cost: { type: "numeric(10,2)", notNull: true, default: 0 },
    total_cost: { type: "numeric(10,2)", notNull: true, default: 0 },
    started_at: { type: "timestamptz" },
    completed_at: { type: "timestamptz" },
  });

  pgm.createTable("maintenance_records", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    vehicle_id: { type: "uuid", notNull: true, references: "vehicles", onDelete: "cascade" },
    service_type: { type: "garage_service_type" },
    cost: { type: "numeric(10,2)" },
    odometer_km: { type: "integer" },
    performed_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    next_due_at: { type: "timestamptz" }, // drives the BullMQ maintenance-reminder job (Phase 26/13)
    notes: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("maintenance_records", "vehicle_id");
  pgm.createIndex("maintenance_records", "next_due_at");
};

exports.down = (pgm) => {
  pgm.dropTable("maintenance_records");
  pgm.dropTable("repair_orders");
  pgm.dropTable("service_bookings");
  pgm.dropType("service_booking_status");
  pgm.dropTable("garage_services");
  pgm.dropType("garage_service_type");
  pgm.dropTable("mechanics");
  pgm.dropTable("garages");
};
