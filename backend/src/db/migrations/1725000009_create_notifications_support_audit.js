/**
 * Migration: 009_create_notifications_support_audit
 *
 * `notifications.read_at` (nullable timestamp) instead of a boolean
 * `is_read` - a timestamp is strictly more useful (tells you WHEN it was
 * read, supports "unread in the last N days" queries) at zero extra cost.
 *
 * `audit_logs` is intentionally schema-loose (`metadata jsonb`) because
 * it needs to record heterogeneous events across every module (spec
 * section 38) without a migration per new event type. `entity_type` +
 * `entity_id` give it a queryable polymorphic reference, same pattern as
 * `payments.payable_type/id`.
 */

exports.up = (pgm) => {
  pgm.createTable("notifications", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    user_id: { type: "uuid", notNull: true, references: "users", onDelete: "cascade" },
    // e.g. RIDE_ASSIGNED, DRIVER_ARRIVED, PAYMENT_SUCCESS, RENTAL_CONFIRMED (spec section 30)
    type: { type: "text", notNull: true },
    title: { type: "text", notNull: true },
    body: { type: "text" },
    data: { type: "jsonb" }, // arbitrary payload (rideId, deep link, etc.)
    read_at: { type: "timestamptz" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("notifications", ["user_id", "read_at"]);

  pgm.createTable("messages", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    conversation_id: { type: "uuid", notNull: true }, // groups a rider<->driver thread, typically = ride_id
    ride_id: { type: "uuid", references: "rides", onDelete: "set null" },
    sender_id: { type: "uuid", notNull: true, references: "users", onDelete: "cascade" },
    body: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("messages", ["conversation_id", "created_at"]);

  pgm.createType("support_ticket_status", ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]);
  pgm.createType("support_ticket_priority", ["LOW", "MEDIUM", "HIGH", "URGENT"]);

  pgm.createTable("support_tickets", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    user_id: { type: "uuid", notNull: true, references: "users", onDelete: "cascade" },
    subject: { type: "text", notNull: true },
    description: { type: "text" },
    status: { type: "support_ticket_status", notNull: true, default: "OPEN" },
    priority: { type: "support_ticket_priority", notNull: true, default: "MEDIUM" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("support_tickets", ["user_id", "status"]);

  pgm.createTable("audit_logs", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    actor_id: { type: "uuid", references: "users", onDelete: "set null" }, // null = system-initiated action
    action: { type: "text", notNull: true }, // e.g. "ride.cancelled", "user.role_granted"
    entity_type: { type: "text" },
    entity_id: { type: "uuid" },
    metadata: { type: "jsonb" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("audit_logs", ["entity_type", "entity_id"]);
  pgm.createIndex("audit_logs", "created_at");
};

exports.down = (pgm) => {
  pgm.dropTable("audit_logs");
  pgm.dropTable("support_tickets");
  pgm.dropType("support_ticket_priority");
  pgm.dropType("support_ticket_status");
  pgm.dropTable("messages");
  pgm.dropTable("notifications");
};
