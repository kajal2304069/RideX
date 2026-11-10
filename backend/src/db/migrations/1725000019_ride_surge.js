/**
 * Migration: 019_ride_surge (surge pricing, spec section 15)
 *
 * The surge multiplier is decided ONCE, when the ride is requested, and stored on the ride. The fare is computed at trip
 * completion, but it must use the multiplier the rider was quoted: recomputing surge at completion would let the price
 * change under the rider's feet (and two reads of "current demand" would disagree).
 */
exports.up = (pgm) => {
  pgm.addColumn("rides", { surge_multiplier: { type: "numeric(4,2)", notNull: true, default: 1.0 } });
  pgm.addConstraint("rides", "rides_surge_multiplier_range", "CHECK (surge_multiplier >= 1.0 AND surge_multiplier <= 5.0)");
};

exports.down = (pgm) => {
  pgm.dropConstraint("rides", "rides_surge_multiplier_range");
  pgm.dropColumn("rides", "surge_multiplier");
};
