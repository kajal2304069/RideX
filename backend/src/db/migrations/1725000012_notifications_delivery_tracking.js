/**
 * Phase 13: make notification delivery idempotent.
 *
 * dedupe_key   - identifies "this event for this user" (e.g.
 *                RIDE_ASSIGNED__<rideId>). The unique index means a job that
 *                is retried, or enqueued twice, can never create a second
 *                in-app notification. BullMQ's jobId dedupes in Redis; this
 *                is the durable backstop once Redis has forgotten the job.
 * email_sent_at - set only after the email channel accepted the message, so a
 *                retry after a crash knows whether the email still needs sending.
 */
exports.up = (pgm) => {
  pgm.addColumns("notifications", {
    dedupe_key: { type: "text" },
    email_sent_at: { type: "timestamptz" },
  });
  // NULL dedupe_keys are distinct, so ad-hoc notifications without a key are unaffected.
  pgm.createIndex("notifications", ["user_id", "dedupe_key"], { unique: true, name: "notifications_user_dedupe_unique" });
  pgm.createIndex("notifications", ["user_id", "created_at"], { name: "notifications_user_created_idx" });
};

exports.down = (pgm) => {
  pgm.dropIndex("notifications", ["user_id", "created_at"], { name: "notifications_user_created_idx" });
  pgm.dropIndex("notifications", ["user_id", "dedupe_key"], { name: "notifications_user_dedupe_unique" });
  pgm.dropColumns("notifications", ["dedupe_key", "email_sent_at"]);
};
