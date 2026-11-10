import { PoolClient } from "pg";
import { pool } from "../../../db/pool";
import { Page, Where, keysetPage, likePattern } from "./pagination";

export interface AdminUserRow {
  id: string;
  email: string;
  phone: string | null;
  fullName: string;
  roles: string[];
  isActive: boolean;
  deactivatedAt: Date | null;
  deactivatedReason: string | null;
  createdAt: Date;
}

// NOTE: password_hash and every token column are deliberately never selected.
const toRow = (r: any): AdminUserRow => ({
  id: r.id, email: r.email, phone: r.phone, fullName: r.full_name, roles: r.roles, isActive: r.is_active,
  deactivatedAt: r.deactivated_at, deactivatedReason: r.deactivated_reason, createdAt: r.created_at,
});
const COLS = `a.id, a.email, a.phone, a.full_name, a.roles::text[] AS roles, a.is_active, a.deactivated_at, a.deactivated_reason, a.created_at`;

export interface LockedUser { id: string; is_active: boolean; roles: string[] }

export const adminUsersRepository = {
  async list(f: { q?: string; role?: string; active?: boolean; limit: number; cursor?: string }): Promise<Page<AdminUserRow>> {
    const w = new Where();
    if (f.q) w.add((p) => { const v = p(likePattern(f.q!)); return `(a.email ILIKE ${v} OR a.full_name ILIKE ${v} OR a.phone ILIKE ${v})`; });
    if (f.role) w.add((p) => `${p(f.role)}::user_role = ANY(a.roles)`);
    if (f.active !== undefined) w.add((p) => `a.is_active = ${p(f.active)}`);
    return keysetPage(COLS, `FROM users a`, w, f.limit, f.cursor, toRow);
  },

  async findById(id: string): Promise<AdminUserRow | null> {
    const { rows } = await pool.query(`SELECT ${COLS} FROM users a WHERE a.id = $1`, [id]);
    return rows[0] ? toRow(rows[0]) : null;
  },

  /** Counts that make a support/ops view useful without N+1 calls from the client. */
  async activity(id: string) {
    const { rows } = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM rides WHERE rider_id = $1) AS rides_as_rider,
         (SELECT COUNT(*) FROM rides WHERE driver_id = $1) AS rides_as_driver,
         (SELECT COUNT(*) FROM vehicles WHERE owner_id = $1) AS vehicles,
         (SELECT COUNT(*) FROM payments WHERE payer_id = $1) AS payments,
         (SELECT COUNT(*) FROM rental_bookings WHERE renter_id = $1) AS rentals_as_renter,
         (SELECT COUNT(*) FROM vehicle_listings WHERE seller_id = $1) AS marketplace_listings,
         (SELECT verification_status FROM drivers WHERE user_id = $1) AS driver_verification`,
      [id]
    );
    const r = rows[0];
    return {
      ridesAsRider: Number(r.rides_as_rider), ridesAsDriver: Number(r.rides_as_driver), vehicles: Number(r.vehicles),
      payments: Number(r.payments), rentalsAsRenter: Number(r.rentals_as_renter), marketplaceListings: Number(r.marketplace_listings),
      driverVerification: r.driver_verification as string | null,
    };
  },

  // ---- inside a transaction ----

  /**
   * Locks every ADMIN row in a fixed order (by id). Two admins changing each other at the same moment therefore queue
   * up instead of both seeing "the other admin is still there" and together removing the last one.
   */
  async lockAdmins(client: PoolClient): Promise<LockedUser[]> {
    const { rows } = await client.query(`SELECT id, is_active, roles::text[] AS roles FROM users WHERE 'ADMIN' = ANY(roles) ORDER BY id FOR UPDATE`);
    return rows;
  },

  async lockUser(client: PoolClient, id: string): Promise<LockedUser | null> {
    const { rows } = await client.query(`SELECT id, is_active, roles::text[] AS roles FROM users WHERE id = $1 FOR UPDATE`, [id]);
    return rows[0] ?? null;
  },

  async deactivate(client: PoolClient, id: string, reason: string): Promise<void> {
    await client.query(`UPDATE users SET is_active = false, deactivated_at = now(), deactivated_reason = $2, updated_at = now() WHERE id = $1`, [id, reason]);
    // End every session, and take a driver off the road.
    await client.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
    await client.query(`UPDATE drivers SET is_online = false, updated_at = now() WHERE user_id = $1 AND is_online`, [id]);
  },

  async activate(client: PoolClient, id: string): Promise<void> {
    await client.query(`UPDATE users SET is_active = true, deactivated_at = NULL, deactivated_reason = NULL, updated_at = now() WHERE id = $1`, [id]);
  },

  async setRoles(client: PoolClient, id: string, roles: string[]): Promise<void> {
    await client.query(`UPDATE users SET roles = $2::user_role[], updated_at = now() WHERE id = $1`, [id, roles]);
  },
};
