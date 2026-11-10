/**
 * Phase 14: emergency breakdown requests (spec section 19) need to know WHERE
 * the vehicle is, and any booking benefits from a free-text problem description.
 */
exports.up = (pgm) => {
  pgm.addColumns("service_bookings", {
    breakdown_location: { type: "geography(Point,4326)" },
    description: { type: "text" },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns("service_bookings", ["breakdown_location", "description"]);
};
