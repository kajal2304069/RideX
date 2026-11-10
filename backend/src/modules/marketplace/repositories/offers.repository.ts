import { PoolClient } from "pg";
import { pool, withTransaction } from "../../../db/pool";
import { OfferRecord, OfferStatus } from "../types/marketplace.types";

const OFFER_SELECT = `
  SELECT o.id, o.listing_id, o.buyer_id, o.offer_amount, o.status, o.accepted_at, o.created_at, o.updated_at,
         l.seller_id, l.price AS listing_price, l.status AS listing_status,
         (l.year || ' ' || l.brand || ' ' || l.model) AS listing_title
  FROM vehicle_offers o JOIN vehicle_listings l ON l.id = o.listing_id`;

export const offersRepository = {
  async findById(id: string): Promise<OfferRecord | null> {
    const { rows } = await pool.query<OfferRecord>(`${OFFER_SELECT} WHERE o.id = $1`, [id]);
    return rows[0] ?? null;
  },

  /** Throws pg 23505 if this buyer already has a PENDING offer on the listing (partial unique index). */
  async create(listingId: string, buyerId: string, amount: number): Promise<OfferRecord> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO vehicle_offers (listing_id, buyer_id, offer_amount) VALUES ($1, $2, $3) RETURNING id`,
      [listingId, buyerId, amount]
    );
    return (await this.findById(rows[0].id))!;
  },

  async listForListing(listingId: string, status?: OfferStatus): Promise<OfferRecord[]> {
    const { rows } = await pool.query<OfferRecord>(
      `${OFFER_SELECT} WHERE o.listing_id = $1 AND ($2::offer_status IS NULL OR o.status = $2::offer_status) ORDER BY o.offer_amount DESC, o.created_at ASC`,
      [listingId, status ?? null]
    );
    return rows;
  },

  async listForBuyer(buyerId: string): Promise<OfferRecord[]> {
    const { rows } = await pool.query<OfferRecord>(`${OFFER_SELECT} WHERE o.buyer_id = $1 ORDER BY o.created_at DESC`, [buyerId]);
    return rows;
  },

  async findPendingForBuyer(listingId: string, buyerId: string): Promise<OfferRecord | null> {
    const { rows } = await pool.query<OfferRecord>(`${OFFER_SELECT} WHERE o.listing_id = $1 AND o.buyer_id = $2 AND o.status IN ('PENDING','ACCEPTED') ORDER BY o.created_at DESC LIMIT 1`, [listingId, buyerId]);
    return rows[0] ?? null;
  },

  async findAcceptedForListing(listingId: string): Promise<OfferRecord | null> {
    const { rows } = await pool.query<OfferRecord>(`${OFFER_SELECT} WHERE o.listing_id = $1 AND o.status = 'ACCEPTED'`, [listingId]);
    return rows[0] ?? null;
  },

  /** Guarded transition used for reject / withdraw. */
  async transition(id: string, from: OfferStatus, to: OfferStatus): Promise<boolean> {
    const { rowCount } = await pool.query(
      `UPDATE vehicle_offers SET status = $3::offer_status, updated_at = now() WHERE id = $1 AND status = $2::offer_status`,
      [id, from, to]
    );
    return (rowCount ?? 0) > 0;
  },

  /**
   * Accepting an offer reserves the listing for one buyer. In ONE transaction:
   *   1. lock the listing row (FOR UPDATE) so concurrent accepts on the same listing queue up behind each other
   *   2. require the listing to still be ACTIVE
   *   3. flip THIS offer PENDING -> ACCEPTED (guarded)
   *   4. reject every other PENDING offer on the listing
   * The partial unique index "one ACCEPTED per listing" is the backstop if anything ever bypasses the lock.
   *
   * Returns `outcome` so the service can pick the right HTTP error without string matching.
   */
  async acceptOffer(offerId: string): Promise<
    | { outcome: "accepted"; offer: OfferRecord; rejectedBuyerIds: string[] }
    | { outcome: "not_found" | "listing_not_active" | "offer_not_pending" | "already_reserved" }
  > {
    return withTransaction(async (client) => {
      const o = await client.query<{ listing_id: string }>(`SELECT listing_id FROM vehicle_offers WHERE id = $1`, [offerId]);
      if (!o.rows[0]) return { outcome: "not_found" as const };
      const listingId = o.rows[0].listing_id;

      const l = await client.query<{ status: string }>(`SELECT status FROM vehicle_listings WHERE id = $1 FOR UPDATE`, [listingId]);
      if (l.rows[0]?.status !== "ACTIVE") return { outcome: "listing_not_active" as const };

      const existing = await client.query(`SELECT 1 FROM vehicle_offers WHERE listing_id = $1 AND status = 'ACCEPTED'`, [listingId]);
      if (existing.rowCount) return { outcome: "already_reserved" as const };

      const upd = await client.query(
        `UPDATE vehicle_offers SET status = 'ACCEPTED', accepted_at = now(), updated_at = now() WHERE id = $1 AND status = 'PENDING'`,
        [offerId]
      );
      if (!upd.rowCount) return { outcome: "offer_not_pending" as const };

      const rejected = await client.query<{ buyer_id: string }>(
        `UPDATE vehicle_offers SET status = 'REJECTED', updated_at = now() WHERE listing_id = $1 AND status = 'PENDING' RETURNING buyer_id`,
        [listingId]
      );
      const offer = (await client.query<OfferRecord>(`${OFFER_SELECT} WHERE o.id = $1`, [offerId])).rows[0];
      return { outcome: "accepted" as const, offer, rejectedBuyerIds: rejected.rows.map((r) => r.buyer_id) };
    });
  },

  /**
   * ACCEPTED -> EXPIRED when the buyer did not pay in time. `graceMs` lets the delayed job (which may fire a few
   * milliseconds before the database's idea of the deadline) still succeed; the payment path passes 0.
   * Returns the expired offer, or null if it was not ACCEPTED or not yet due (idempotent).
   */
  async expireAcceptedIfDue(offerId: string, ttlMs: number, graceMs = 0): Promise<OfferRecord | null> {
    const { rowCount } = await pool.query(
      `UPDATE vehicle_offers SET status = 'EXPIRED', updated_at = now()
       WHERE id = $1 AND status = 'ACCEPTED' AND accepted_at <= now() - make_interval(secs => $2::float8)`,
      [offerId, Math.max(0, ttlMs - graceMs) / 1000]
    );
    return rowCount ? this.findById(offerId) : null;
  },

  /**
   * ACTIVE -> DELISTED, refused while an offer is ACCEPTED (the buyer has a reservation), and all PENDING offers are
   * rejected in the same transaction. Takes the same listing row lock as acceptOffer, so a delist and an accept racing
   * each other are serialized: whichever runs second sees the other's result. (Without the lock, a delist could slip in
   * after an accept and leave a paid-for reservation on a delisted listing.)
   */
  async delistIfUnreserved(listingId: string, inTx?: (client: PoolClient) => Promise<void>): Promise<{ outcome: "delisted"; rejectedBuyerIds: string[] } | { outcome: "not_active" | "reserved" }> {
    return withTransaction(async (client) => {
      const l = await client.query<{ status: string }>(`SELECT status FROM vehicle_listings WHERE id = $1 FOR UPDATE`, [listingId]);
      if (l.rows[0]?.status !== "ACTIVE") return { outcome: "not_active" as const };
      const reserved = await client.query(`SELECT 1 FROM vehicle_offers WHERE listing_id = $1 AND status = 'ACCEPTED'`, [listingId]);
      if (reserved.rowCount) return { outcome: "reserved" as const };

      await client.query(`UPDATE vehicle_listings SET status = 'DELISTED', updated_at = now() WHERE id = $1`, [listingId]);
      const rejected = await client.query<{ buyer_id: string }>(
        `UPDATE vehicle_offers SET status = 'REJECTED', updated_at = now() WHERE listing_id = $1 AND status = 'PENDING' RETURNING buyer_id`,
        [listingId]
      );
      if (inTx) await inTx(client); // e.g. the admin audit row, so it commits or rolls back with the takedown
      return { outcome: "delisted" as const, rejectedBuyerIds: rejected.rows.map((r) => r.buyer_id) };
    });
  },

  /** Marks the listing SOLD for an accepted offer. Idempotent: false means it was already SOLD (or not ACTIVE). */
  async markListingSold(listingId: string): Promise<boolean> {
    const { rowCount } = await pool.query(`UPDATE vehicle_listings SET status = 'SOLD', updated_at = now() WHERE id = $1 AND status = 'ACTIVE'`, [listingId]);
    return (rowCount ?? 0) > 0;
  },
};
