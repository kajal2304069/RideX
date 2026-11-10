/**
 * Migration: 001_create_users_and_auth
 *
 * Phase 2 needs somewhere to persist accounts, so this migration creates
 * the minimum durable schema auth depends on. The full domain schema
 * (vehicles, rides, garages, marketplace, etc.) is built out in Phase 3.
 *
 * Design notes:
 *  - `roles` is a Postgres array of a `user_role` enum, not a join table,
 *    because a user's role set changes rarely and is always read together
 *    with the user row (see spec section 5: "a user may have multiple
 *    capabilities" - Rider + Vehicle Owner + Seller simultaneously).
 *  - Passwords are never stored in plaintext or reversibly encrypted -
 *    only an Argon2id hash (`password_hash`).
 *  - `refresh_tokens` is its own table (not a JWT-only refresh scheme) so
 *    tokens can be individually revoked (logout, password change,
 *    compromise) without invalidating every session server-wide, and so
 *    we can enforce rotation (old token is marked `revoked_at` the moment
 *    it's exchanged for a new one - reuse of a revoked token is a signal
 *    of token theft).
 */

exports.up = (pgm) => {
  pgm.createExtension("pgcrypto", { ifNotExists: true }); // for gen_random_uuid()
  pgm.createExtension("citext", { ifNotExists: true }); // for case-insensitive email column

  pgm.createType("user_role", [
    "RIDER",
    "DRIVER",
    "VEHICLE_OWNER",
    "GARAGE_OWNER",
    "MECHANIC",
    "SELLER",
    "BUYER",
    "ADMIN",
  ]);

  pgm.createTable("users", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    email: { type: "citext", notNull: true, unique: true },
    phone: { type: "text", unique: true },
    password_hash: { type: "text", notNull: true },
    full_name: { type: "text", notNull: true },
    roles: { type: "user_role[]", notNull: true, default: pgm.func("ARRAY['RIDER']::user_role[]") },
    is_active: { type: "boolean", notNull: true, default: true },
    email_verified_at: { type: "timestamptz" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.createIndex("users", "roles", { method: "gin" });

  pgm.createTable("refresh_tokens", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    user_id: {
      type: "uuid",
      notNull: true,
      references: "users",
      onDelete: "cascade",
    },
    // We store a hash of the token, never the raw token, so a DB leak
    // alone can't be used to impersonate sessions.
    token_hash: { type: "text", notNull: true, unique: true },
    // Rotation chain: when a refresh token is used, we set replaced_by
    // to the new token's id and revoked_at to now(). A later request
    // presenting an already-revoked token indicates token reuse/theft.
    replaced_by: { type: "uuid" },
    revoked_at: { type: "timestamptz" },
    expires_at: { type: "timestamptz", notNull: true },
    user_agent: { type: "text" },
    ip_address: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.createIndex("refresh_tokens", "user_id");
  pgm.createIndex("refresh_tokens", "expires_at");
};

exports.down = (pgm) => {
  pgm.dropTable("refresh_tokens");
  pgm.dropTable("users");
  pgm.dropType("user_role");
};
