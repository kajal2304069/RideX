/**
 * Migration: 006_create_marketplace
 *
 * `vehicle_listings.location` + GIST index powers "vehicles near me"
 * (spec section 21). Filter columns (brand, price, year, condition) get
 * a composite btree index since marketplace search is a classic
 * multi-filter query pattern.
 */

exports.up = (pgm) => {
  pgm.createType("listing_condition", ["EXCELLENT", "GOOD", "FAIR", "NEEDS_WORK"]);
  pgm.createType("listing_status", ["ACTIVE", "SOLD", "DELISTED"]);

  pgm.createTable("vehicle_listings", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    seller_id: { type: "uuid", notNull: true, references: "users", onDelete: "cascade" },
    vehicle_type_id: { type: "uuid", notNull: true, references: "vehicle_types" },
    brand: { type: "text", notNull: true },
    model: { type: "text", notNull: true },
    year: { type: "integer", notNull: true },
    mileage_km: { type: "integer", notNull: true, default: 0 },
    fuel_type: { type: "fuel_type", notNull: true },
    transmission: { type: "transmission_type", notNull: true },
    condition: { type: "listing_condition", notNull: true, default: "GOOD" },
    owner_count: { type: "integer", notNull: true, default: 1 },
    price: { type: "numeric(12,2)", notNull: true },
    location: { type: "geography(Point,4326)", notNull: true },
    address: { type: "text" },
    description: { type: "text" },
    insurance_valid_until: { type: "date" },
    status: { type: "listing_status", notNull: true, default: "ACTIVE" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("vehicle_listings", "location", { method: "gist" });
  pgm.createIndex("vehicle_listings", ["brand", "price", "year", "condition"]);
  pgm.createIndex("vehicle_listings", "seller_id");
  pgm.createIndex("vehicle_listings", "status");

  pgm.createTable("vehicle_images", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    listing_id: { type: "uuid", notNull: true, references: "vehicle_listings", onDelete: "cascade" },
    url: { type: "text", notNull: true },
    position: { type: "integer", notNull: true, default: 0 },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("vehicle_images", "listing_id");

  pgm.createType("inspection_status", ["SCHEDULED", "COMPLETED", "CANCELLED"]);

  pgm.createTable("vehicle_inspections", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    listing_id: { type: "uuid", notNull: true, references: "vehicle_listings", onDelete: "cascade" },
    buyer_id: { type: "uuid", notNull: true, references: "users", onDelete: "cascade" },
    scheduled_at: { type: "timestamptz", notNull: true },
    status: { type: "inspection_status", notNull: true, default: "SCHEDULED" },
    // Structured report: engine, brakes, tyres, battery, body, electrical,
    // documents, accident_history - see spec section 22.
    report: { type: "jsonb" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("vehicle_inspections", "listing_id");

  pgm.createType("offer_status", ["PENDING", "ACCEPTED", "REJECTED", "WITHDRAWN"]);

  pgm.createTable("vehicle_offers", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    listing_id: { type: "uuid", notNull: true, references: "vehicle_listings", onDelete: "cascade" },
    buyer_id: { type: "uuid", notNull: true, references: "users", onDelete: "cascade" },
    offer_amount: { type: "numeric(12,2)", notNull: true },
    status: { type: "offer_status", notNull: true, default: "PENDING" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("vehicle_offers", "listing_id");
  pgm.createIndex("vehicle_offers", "buyer_id");

  pgm.createTable("favorites", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    user_id: { type: "uuid", notNull: true, references: "users", onDelete: "cascade" },
    listing_id: { type: "uuid", notNull: true, references: "vehicle_listings", onDelete: "cascade" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("favorites", "favorites_unique_user_listing", "UNIQUE (user_id, listing_id)");
};

exports.down = (pgm) => {
  pgm.dropTable("favorites");
  pgm.dropTable("vehicle_offers");
  pgm.dropType("offer_status");
  pgm.dropTable("vehicle_inspections");
  pgm.dropType("inspection_status");
  pgm.dropTable("vehicle_images");
  pgm.dropTable("vehicle_listings");
  pgm.dropType("listing_status");
  pgm.dropType("listing_condition");
};
