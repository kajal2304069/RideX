/**
 * Phase 14: database-level guarantees for the garage domain.
 *
 * 1. A mechanic can have at most ONE active job. "Active" = the booking is in
 *    MECHANIC_ASSIGNED / VEHICLE_RECEIVED / REPAIR_IN_PROGRESS. Once a booking
 *    is READY, COMPLETED or CANCELLED it leaves the index, so the mechanic is
 *    free again with no cleanup code. Same idea as Phase 5's one-active-
 *    assignment-per-vehicle index.
 *
 * 2. A garage lists each service type once (a duplicate row would make
 *    "which price applies?" ambiguous).
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE UNIQUE INDEX service_bookings_one_active_job_per_mechanic
    ON service_bookings (mechanic_id)
    WHERE mechanic_id IS NOT NULL
      AND status IN ('MECHANIC_ASSIGNED', 'VEHICLE_RECEIVED', 'REPAIR_IN_PROGRESS')
  `);
  pgm.createIndex("garage_services", ["garage_id", "service_type"], { unique: true, name: "garage_services_unique_type" });
};

exports.down = (pgm) => {
  pgm.dropIndex("garage_services", ["garage_id", "service_type"], { name: "garage_services_unique_type" });
  pgm.sql(`DROP INDEX IF EXISTS service_bookings_one_active_job_per_mechanic`);
};
