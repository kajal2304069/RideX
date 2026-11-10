/**
 * Migration: 018_admin_audit (Phase 18: admin dashboard)
 *
 *  - audit_logs becomes APPEND-ONLY at the database level. An audit trail that the application (or a bug, or a
 *    compromised admin session) can edit is not evidence. A trigger refuses UPDATE and DELETE. The one exception is the
 *    foreign key's own `ON DELETE SET NULL` (a deleted user's rows keep existing with actor_id = NULL).
 *  - indexes for the admin "who did what" queries
 *  - vehicle_listings.removed_by_admin_at/removed_reason: a listing taken down by moderation cannot be relisted by its seller
 *  - users.deactivated_at / deactivated_reason: when and why an account was disabled
 */

exports.up = (pgm) => {
  pgm.addColumn("audit_logs", { ip_address: { type: "text" } });
  pgm.createIndex("audit_logs", ["actor_id", "created_at"]);
  pgm.createIndex("audit_logs", ["action", "created_at"]);

  pgm.sql(`
    CREATE FUNCTION audit_logs_append_only() RETURNS trigger AS $$
    BEGIN
      -- allow ONLY the FK cascade that nulls actor_id when a user row is deleted
      IF TG_OP = 'UPDATE' AND NEW.actor_id IS NULL AND (to_jsonb(NEW) - 'actor_id') = (to_jsonb(OLD) - 'actor_id') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = '42501';
    END;
    $$ LANGUAGE plpgsql;
  `);
  pgm.sql(`
    CREATE TRIGGER audit_logs_no_edit BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();
  `);

  pgm.addColumns("users", {
    deactivated_at: { type: "timestamptz" },
    deactivated_reason: { type: "text" },
  });
  // Accounts that were already inactive before this migration have no timestamp: backfill, or the CHECK below would
  // reject the existing rows and the migration would fail on any database that already has a deactivated user.
  pgm.sql(`UPDATE users SET deactivated_at = updated_at WHERE NOT is_active AND deactivated_at IS NULL`);
  pgm.addConstraint("users", "users_deactivation_consistent", "CHECK (is_active OR deactivated_at IS NOT NULL)");

  pgm.addColumns("vehicle_listings", {
    removed_by_admin_at: { type: "timestamptz" },
    removed_reason: { type: "text" },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns("vehicle_listings", ["removed_by_admin_at", "removed_reason"]);
  pgm.dropConstraint("users", "users_deactivation_consistent");
  pgm.dropColumns("users", ["deactivated_at", "deactivated_reason"]);
  pgm.sql(`DROP TRIGGER IF EXISTS audit_logs_no_edit ON audit_logs`);
  pgm.sql(`DROP FUNCTION IF EXISTS audit_logs_append_only()`);
  pgm.dropIndex("audit_logs", ["action", "created_at"]);
  pgm.dropIndex("audit_logs", ["actor_id", "created_at"]);
  pgm.dropColumn("audit_logs", "ip_address");
};
