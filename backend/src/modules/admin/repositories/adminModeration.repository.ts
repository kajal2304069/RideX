import { PoolClient } from "pg";

export const adminModerationRepository = {
  async markListingRemoved(client: PoolClient, listingId: string, reason: string): Promise<void> {
    await client.query(`UPDATE vehicle_listings SET removed_by_admin_at = now(), removed_reason = $2 WHERE id = $1`, [listingId, reason]);
  },

  /** DELISTED + removed-by-admin -> ACTIVE. Returns false if the listing is not in that state. */
  async restoreListing(client: PoolClient, listingId: string): Promise<boolean> {
    const { rowCount } = await client.query(
      `UPDATE vehicle_listings SET status = 'ACTIVE', removed_by_admin_at = NULL, removed_reason = NULL, updated_at = now()
       WHERE id = $1 AND status = 'DELISTED' AND removed_by_admin_at IS NOT NULL`,
      [listingId]
    );
    return (rowCount ?? 0) > 0;
  },

  /** Returns false when the garage does not exist or is already in the requested state. */
  async setGarageActive(client: PoolClient, garageId: string, active: boolean): Promise<boolean> {
    const { rowCount } = await client.query(`UPDATE garages SET is_active = $2, updated_at = now() WHERE id = $1 AND is_active <> $2`, [garageId, active]);
    return (rowCount ?? 0) > 0;
  },

  async garageExists(client: PoolClient, garageId: string): Promise<boolean> {
    const { rowCount } = await client.query(`SELECT 1 FROM garages WHERE id = $1`, [garageId]);
    return (rowCount ?? 0) > 0;
  },
};
