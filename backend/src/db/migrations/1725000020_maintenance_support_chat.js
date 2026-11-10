/**
 * Migration: 020_maintenance_support_chat
 *
 *  - vehicle_documents: insurance / registration / pollution / permit / fitness with an expiry, so reminders can fire
 *  - vehicle_incidents: accident history (spec section 26)
 *  - maintenance_records.source: a record written by a garage on completion vs one an owner entered by hand
 *  - support_ticket_messages + ticket bookkeeping columns (resolved_at, assigned_to)
 *  - messages (chat): length guard and a ride-scoped read index
 */
exports.up = (pgm) => {
  pgm.createType("vehicle_document_type", ["INSURANCE", "REGISTRATION", "POLLUTION", "PERMIT", "FITNESS"]);
  pgm.createTable("vehicle_documents", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    vehicle_id: { type: "uuid", notNull: true, references: "vehicles", onDelete: "cascade" },
    doc_type: { type: "vehicle_document_type", notNull: true },
    document_number: { type: "text" },
    issued_at: { type: "date" },
    expires_at: { type: "date", notNull: true },
    notes: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("vehicle_documents", "vehicle_documents_dates_ordered", "CHECK (issued_at IS NULL OR issued_at <= expires_at)");
  // A renewal is a NEW row (history is kept); the same document cannot be entered twice.
  pgm.createIndex("vehicle_documents", ["vehicle_id", "doc_type", "expires_at"], { unique: true, name: "vehicle_documents_unique_period" });
  pgm.createIndex("vehicle_documents", "expires_at");

  pgm.createType("incident_severity", ["MINOR", "MODERATE", "MAJOR"]);
  pgm.createTable("vehicle_incidents", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    vehicle_id: { type: "uuid", notNull: true, references: "vehicles", onDelete: "cascade" },
    occurred_at: { type: "date", notNull: true },
    severity: { type: "incident_severity", notNull: true },
    description: { type: "text", notNull: true },
    repair_cost: { type: "numeric(10,2)" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("vehicle_incidents", "vehicle_incidents_cost_nonneg", "CHECK (repair_cost IS NULL OR repair_cost >= 0)");
  pgm.createIndex("vehicle_incidents", ["vehicle_id", "occurred_at"]);

  pgm.addColumn("maintenance_records", { source: { type: "text", notNull: true, default: "GARAGE" } });
  pgm.addConstraint("maintenance_records", "maintenance_records_source_valid", "CHECK (source IN ('GARAGE','OWNER'))");
  pgm.addConstraint("maintenance_records", "maintenance_records_cost_nonneg", "CHECK (cost IS NULL OR cost >= 0)");
  pgm.createIndex("maintenance_records", ["vehicle_id", "service_type", "performed_at"]);

  pgm.addColumns("support_tickets", {
    resolved_at: { type: "timestamptz" },
    assigned_to: { type: "uuid", references: "users", onDelete: "set null" },
  });
  pgm.addConstraint("support_tickets", "support_tickets_subject_len", "CHECK (char_length(subject) BETWEEN 3 AND 200)");
  pgm.createIndex("support_tickets", ["status", "priority", "created_at"]);
  pgm.createTable("support_ticket_messages", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    ticket_id: { type: "uuid", notNull: true, references: "support_tickets", onDelete: "cascade" },
    author_id: { type: "uuid", notNull: true, references: "users", onDelete: "cascade" },
    is_staff: { type: "boolean", notNull: true, default: false },
    body: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("support_ticket_messages", "support_ticket_messages_body_len", "CHECK (char_length(body) BETWEEN 1 AND 4000)");
  pgm.createIndex("support_ticket_messages", ["ticket_id", "created_at"]);

  pgm.addConstraint("messages", "messages_body_len", "CHECK (char_length(body) BETWEEN 1 AND 1000)");
  pgm.createIndex("messages", ["ride_id", "created_at", "id"]);
};

exports.down = (pgm) => {
  pgm.dropIndex("messages", ["ride_id", "created_at", "id"]);
  pgm.dropConstraint("messages", "messages_body_len");
  pgm.dropTable("support_ticket_messages");
  pgm.dropIndex("support_tickets", ["status", "priority", "created_at"]);
  pgm.dropConstraint("support_tickets", "support_tickets_subject_len");
  pgm.dropColumns("support_tickets", ["resolved_at", "assigned_to"]);
  pgm.dropIndex("maintenance_records", ["vehicle_id", "service_type", "performed_at"]);
  pgm.dropConstraint("maintenance_records", "maintenance_records_cost_nonneg");
  pgm.dropConstraint("maintenance_records", "maintenance_records_source_valid");
  pgm.dropColumn("maintenance_records", "source");
  pgm.dropTable("vehicle_incidents");
  pgm.dropType("incident_severity");
  pgm.dropTable("vehicle_documents");
  pgm.dropType("vehicle_document_type");
};
