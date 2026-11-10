/**
 * Phase 15: database-level rules for the marketplace.
 *
 *  1. One ACCEPTED offer per listing  - the listing is "reserved" for exactly one buyer.
 *  2. One PENDING offer per (listing, buyer) - no offer spam; change an offer by withdrawing it.
 *  3. One SCHEDULED inspection per (listing, buyer).
 *  4. At most 10 images per listing, enforced by CHECK (position 0-9) + UNIQUE (listing, position).
 *  5. Sanity CHECKs on price / year / mileage so bad data cannot get in by any route.
 *  6. offer_status gains EXPIRED (an accepted offer that was not paid in time).
 *  7. pg_trgm + GIN index so free-text search ("civic") does not scan the table.
 *
 * Application code checks these first for friendly errors; the database is the guarantee.
 */
exports.up = (pgm) => {
  pgm.sql(`ALTER TYPE offer_status ADD VALUE IF NOT EXISTS 'EXPIRED'`);

  pgm.addColumns("vehicle_offers", { accepted_at: { type: "timestamptz" } });
  pgm.sql(`CREATE UNIQUE INDEX vehicle_offers_one_accepted_per_listing ON vehicle_offers (listing_id) WHERE status = 'ACCEPTED'`);
  pgm.sql(`CREATE UNIQUE INDEX vehicle_offers_one_pending_per_buyer ON vehicle_offers (listing_id, buyer_id) WHERE status = 'PENDING'`);
  pgm.addConstraint("vehicle_offers", "vehicle_offers_amount_positive", "CHECK (offer_amount > 0)");

  pgm.addColumns("vehicle_inspections", { inspector_id: { type: "uuid", references: "users", onDelete: "set null" } });
  pgm.sql(`CREATE UNIQUE INDEX vehicle_inspections_one_scheduled_per_buyer ON vehicle_inspections (listing_id, buyer_id) WHERE status = 'SCHEDULED'`);

  pgm.addConstraint("vehicle_images", "vehicle_images_position_range", "CHECK (position BETWEEN 0 AND 9)");
  pgm.addConstraint("vehicle_images", "vehicle_images_unique_position", "UNIQUE (listing_id, position)");

  pgm.addConstraint("vehicle_listings", "vehicle_listings_price_positive", "CHECK (price > 0)");
  pgm.addConstraint("vehicle_listings", "vehicle_listings_year_range", "CHECK (year BETWEEN 1950 AND 2100)");
  pgm.addConstraint("vehicle_listings", "vehicle_listings_mileage_nonneg", "CHECK (mileage_km >= 0)");
  pgm.addConstraint("vehicle_listings", "vehicle_listings_owner_count_positive", "CHECK (owner_count >= 1)");

  pgm.createExtension("pg_trgm", { ifNotExists: true });
  pgm.sql(`CREATE INDEX vehicle_listings_search_trgm ON vehicle_listings USING gin ((brand || ' ' || model) gin_trgm_ops)`);
  // Search is "ACTIVE listings, newest/cheapest first": a partial index keeps it small.
  pgm.sql(`CREATE INDEX vehicle_listings_active_created ON vehicle_listings (created_at DESC, id DESC) WHERE status = 'ACTIVE'`);
  pgm.sql(`CREATE INDEX vehicle_listings_active_price ON vehicle_listings (price, id) WHERE status = 'ACTIVE'`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS vehicle_listings_active_price`);
  pgm.sql(`DROP INDEX IF EXISTS vehicle_listings_active_created`);
  pgm.sql(`DROP INDEX IF EXISTS vehicle_listings_search_trgm`);
  pgm.dropConstraint("vehicle_listings", "vehicle_listings_owner_count_positive");
  pgm.dropConstraint("vehicle_listings", "vehicle_listings_mileage_nonneg");
  pgm.dropConstraint("vehicle_listings", "vehicle_listings_year_range");
  pgm.dropConstraint("vehicle_listings", "vehicle_listings_price_positive");
  pgm.dropConstraint("vehicle_images", "vehicle_images_unique_position");
  pgm.dropConstraint("vehicle_images", "vehicle_images_position_range");
  pgm.sql(`DROP INDEX IF EXISTS vehicle_inspections_one_scheduled_per_buyer`);
  pgm.dropColumns("vehicle_inspections", ["inspector_id"]);
  pgm.dropConstraint("vehicle_offers", "vehicle_offers_amount_positive");
  pgm.sql(`DROP INDEX IF EXISTS vehicle_offers_one_pending_per_buyer`);
  pgm.sql(`DROP INDEX IF EXISTS vehicle_offers_one_accepted_per_listing`);
  pgm.dropColumns("vehicle_offers", ["accepted_at"]);
  // Postgres cannot drop an enum value; EXPIRED stays in offer_status on rollback (harmless).
};
