/**
 * Migration: 021_listing_condition_new
 *
 * Adds "NEW" to listing_condition so dealers and owners can list a brand-new vehicle next to second-hand ones.
 * Additive only: no existing row or query changes. Postgres cannot remove an enum value, so `down` is a no-op.
 */
exports.shorthands = undefined;
exports.up = (pgm) => {
  pgm.sql(`ALTER TYPE listing_condition ADD VALUE IF NOT EXISTS 'NEW' BEFORE 'EXCELLENT'`);
};
exports.down = () => {};
