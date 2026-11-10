import { pool } from "../../../db/pool";
import { ImageRecord, ListingCondition, ListingRecord, ListingStatus, FuelType, TransmissionType } from "../types/marketplace.types";

/** lat/lng via ST_Y/ST_X so no PostGIS type ever leaves this file. */
const LISTING_SELECT = `
  SELECT l.id, l.seller_id, u.full_name AS seller_name, l.vehicle_type_id, l.brand, l.model, l.year, l.mileage_km,
         l.fuel_type, l.transmission, l.condition, l.owner_count, l.price,
         ST_Y(l.location::geometry) AS lat, ST_X(l.location::geometry) AS lng,
         l.address, l.description, to_char(l.insurance_valid_until, 'YYYY-MM-DD') AS insurance_valid_until,
         l.status, l.created_at, l.updated_at,
         EXISTS (SELECT 1 FROM vehicle_offers o WHERE o.listing_id = l.id AND o.status = 'ACCEPTED') AS is_reserved
  FROM vehicle_listings l JOIN users u ON u.id = l.seller_id`;

export type SortKey = "newest" | "price_asc" | "price_desc" | "distance";

export interface SearchFilters {
  q?: string;
  brand?: string;
  vehicleTypeId?: string;
  minPrice?: number;
  maxPrice?: number;
  minYear?: number;
  maxYear?: number;
  maxMileage?: number;
  conditions?: ListingCondition[];
  fuelType?: FuelType;
  transmission?: TransmissionType;
  near?: { lat: number; lng: number; radiusMeters: number };
}

/** Escapes LIKE wildcards so a user searching for "50%" does not get a pattern. */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export const listingsRepository = {
  async create(input: {
    sellerId: string; vehicleTypeId: string; brand: string; model: string; year: number; mileageKm: number;
    fuelType: FuelType; transmission: TransmissionType; condition: ListingCondition; ownerCount: number; price: number;
    lat: number; lng: number; address?: string; description?: string; insuranceValidUntil?: string;
  }): Promise<ListingRecord> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO vehicle_listings
         (seller_id, vehicle_type_id, brand, model, year, mileage_km, fuel_type, transmission, condition, owner_count, price,
          location, address, description, insurance_valid_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, ST_SetSRID(ST_MakePoint($13, $12), 4326)::geography, $14,$15,$16)
       RETURNING id`,
      [input.sellerId, input.vehicleTypeId, input.brand, input.model, input.year, input.mileageKm, input.fuelType,
       input.transmission, input.condition, input.ownerCount, input.price, input.lat, input.lng,
       input.address ?? null, input.description ?? null, input.insuranceValidUntil ?? null]
    );
    return (await this.findById(rows[0].id))!;
  },

  async findById(id: string): Promise<ListingRecord | null> {
    const { rows } = await pool.query<ListingRecord>(`${LISTING_SELECT} WHERE l.id = $1`, [id]);
    return rows[0] ?? null;
  },

  async findBySeller(sellerId: string): Promise<ListingRecord[]> {
    const { rows } = await pool.query<ListingRecord>(`${LISTING_SELECT} WHERE l.seller_id = $1 ORDER BY l.created_at DESC`, [sellerId]);
    return rows;
  },

  async update(id: string, patch: Partial<{
    price: number; mileageKm: number; condition: ListingCondition; description: string | null; address: string | null;
    insuranceValidUntil: string | null; ownerCount: number; lat: number; lng: number;
  }>): Promise<ListingRecord | null> {
    const sets: string[] = ["updated_at = now()"];
    const values: unknown[] = [id];
    const add = (col: string, v: unknown) => { values.push(v); sets.push(`${col} = $${values.length}`); };
    if (patch.price !== undefined) add("price", patch.price);
    if (patch.mileageKm !== undefined) add("mileage_km", patch.mileageKm);
    if (patch.condition !== undefined) add("condition", patch.condition);
    if (patch.description !== undefined) add("description", patch.description);
    if (patch.address !== undefined) add("address", patch.address);
    if (patch.insuranceValidUntil !== undefined) add("insurance_valid_until", patch.insuranceValidUntil);
    if (patch.ownerCount !== undefined) add("owner_count", patch.ownerCount);
    if (patch.lat !== undefined && patch.lng !== undefined) {
      values.push(patch.lng, patch.lat);
      sets.push(`location = ST_SetSRID(ST_MakePoint($${values.length - 1}, $${values.length}), 4326)::geography`);
    }
    await pool.query(`UPDATE vehicle_listings SET ${sets.join(", ")} WHERE id = $1`, values);
    return this.findById(id);
  },

  /** True when moderation took the listing down; the seller may not relist it (an admin must restore it). */
  async isRemovedByAdmin(id: string): Promise<boolean> {
    const { rows } = await pool.query<{ removed: boolean }>(`SELECT removed_by_admin_at IS NOT NULL AS removed FROM vehicle_listings WHERE id = $1`, [id]);
    return rows[0]?.removed ?? false;
  },

  /** Guarded status change: applies only if the listing is still in `from`. */
  async setStatusIfCurrently(id: string, from: ListingStatus, to: ListingStatus): Promise<boolean> {
    const { rowCount } = await pool.query(`UPDATE vehicle_listings SET status = $3::listing_status, updated_at = now() WHERE id = $1 AND status = $2::listing_status`, [id, from, to]);
    return (rowCount ?? 0) > 0;
  },

  /**
   * Keyset-paginated search over ACTIVE listings.
   *
   * Why keyset (a "seek" cursor) and not OFFSET: OFFSET n makes Postgres produce and throw away n rows, so page 500 is
   * slow, and rows shift between pages when listings are added. The cursor is the last row's (sort value, id); the next
   * page is `WHERE (sort, id) < (last_sort, last_id)`, which a (sort, id) index serves directly. `id` is the tiebreaker
   * that keeps the ordering total, so no row is skipped or repeated.
   *
   * The sort value is selected AS TEXT and cast back, because a JS Date has millisecond precision while created_at has
   * microseconds, and that mismatch would skip rows that share a millisecond.
   */
  async search(input: { filters: SearchFilters; sort: SortKey; cursor?: { v: string; id: string }; limit: number }): Promise<ListingRecord[]> {
    const { filters: f } = input;
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const where: string[] = [`l.status = 'ACTIVE'`];

    if (f.q) where.push(`(l.brand || ' ' || l.model) ILIKE ${p(`%${escapeLike(f.q)}%`)}`);
    if (f.brand) where.push(`lower(l.brand) = lower(${p(f.brand)})`);
    if (f.vehicleTypeId) where.push(`l.vehicle_type_id = ${p(f.vehicleTypeId)}`);
    if (f.minPrice !== undefined) where.push(`l.price >= ${p(f.minPrice)}`);
    if (f.maxPrice !== undefined) where.push(`l.price <= ${p(f.maxPrice)}`);
    if (f.minYear !== undefined) where.push(`l.year >= ${p(f.minYear)}`);
    if (f.maxYear !== undefined) where.push(`l.year <= ${p(f.maxYear)}`);
    if (f.maxMileage !== undefined) where.push(`l.mileage_km <= ${p(f.maxMileage)}`);
    if (f.conditions?.length) where.push(`l.condition = ANY(${p(f.conditions)}::listing_condition[])`);
    if (f.fuelType) where.push(`l.fuel_type = ${p(f.fuelType)}::fuel_type`);
    if (f.transmission) where.push(`l.transmission = ${p(f.transmission)}::transmission_type`);

    let distanceExpr = "NULL::float8";
    if (f.near) {
      const pt = `ST_SetSRID(ST_MakePoint(${p(f.near.lng)}, ${p(f.near.lat)}), 4326)::geography`;
      distanceExpr = `ST_Distance(l.location, ${pt})`;
      where.push(`ST_DWithin(l.location, ${pt}, ${p(f.near.radiusMeters)})`);
    }

    const sorts: Record<SortKey, { expr: string; dir: "ASC" | "DESC"; cast: string }> = {
      newest: { expr: "l.created_at", dir: "DESC", cast: "timestamptz" },
      price_asc: { expr: "l.price", dir: "ASC", cast: "numeric" },
      price_desc: { expr: "l.price", dir: "DESC", cast: "numeric" },
      distance: { expr: distanceExpr, dir: "ASC", cast: "float8" },
    };
    const s = sorts[input.sort];

    if (input.cursor) {
      const op = s.dir === "ASC" ? ">" : "<";
      where.push(`(${s.expr}, l.id) ${op} (${p(input.cursor.v)}::${s.cast}, ${p(input.cursor.id)}::uuid)`);
    }

    const { rows } = await pool.query<ListingRecord>(
      `SELECT x.* FROM (
         SELECT l.id, l.seller_id, u.full_name AS seller_name, l.vehicle_type_id, l.brand, l.model, l.year, l.mileage_km,
                l.fuel_type, l.transmission, l.condition, l.owner_count, l.price,
                ST_Y(l.location::geometry) AS lat, ST_X(l.location::geometry) AS lng,
                l.address, l.description, to_char(l.insurance_valid_until, 'YYYY-MM-DD') AS insurance_valid_until,
                l.status, l.created_at, l.updated_at,
                EXISTS (SELECT 1 FROM vehicle_offers o WHERE o.listing_id = l.id AND o.status = 'ACCEPTED') AS is_reserved,
                ${distanceExpr} AS distance_meters,
                (SELECT i.url FROM vehicle_images i WHERE i.listing_id = l.id ORDER BY i.position LIMIT 1) AS thumbnail,
                (${s.expr})::text AS sort_value
         FROM vehicle_listings l JOIN users u ON u.id = l.seller_id
         WHERE ${where.join(" AND ")}
         ORDER BY ${s.expr} ${s.dir}, l.id ${s.dir}
         LIMIT ${p(input.limit)}
       ) x`,
      params
    );
    return rows;
  },

  // --- images ---
  async listImages(listingId: string): Promise<ImageRecord[]> {
    const { rows } = await pool.query<ImageRecord>(`SELECT id, listing_id, url, position FROM vehicle_images WHERE listing_id = $1 ORDER BY position`, [listingId]);
    return rows;
  },

  /** Takes the lowest free slot 0-9 unless one is requested. A full gallery or a taken slot surfaces as a pg 23505 / 23514. */
  async addImage(listingId: string, url: string, position?: number): Promise<ImageRecord> {
    const { rows } = await pool.query<ImageRecord>(
      `INSERT INTO vehicle_images (listing_id, url, position)
       VALUES ($1, $2, COALESCE($3::int, (SELECT COALESCE(min(g), 10) FROM generate_series(0, 9) g
                                          WHERE NOT EXISTS (SELECT 1 FROM vehicle_images WHERE listing_id = $1 AND position = g))))
       RETURNING id, listing_id, url, position`,
      [listingId, url, position ?? null]
    );
    return rows[0];
  },

  async deleteImage(listingId: string, imageId: string): Promise<boolean> {
    const { rowCount } = await pool.query(`DELETE FROM vehicle_images WHERE id = $1 AND listing_id = $2`, [imageId, listingId]);
    return (rowCount ?? 0) > 0;
  },

  // --- favorites ---
  async addFavorite(userId: string, listingId: string): Promise<void> {
    await pool.query(`INSERT INTO favorites (user_id, listing_id) VALUES ($1, $2) ON CONFLICT (user_id, listing_id) DO NOTHING`, [userId, listingId]);
  },
  async removeFavorite(userId: string, listingId: string): Promise<void> {
    await pool.query(`DELETE FROM favorites WHERE user_id = $1 AND listing_id = $2`, [userId, listingId]);
  },
  async isFavorite(userId: string, listingId: string): Promise<boolean> {
    const { rows } = await pool.query(`SELECT 1 FROM favorites WHERE user_id = $1 AND listing_id = $2`, [userId, listingId]);
    return rows.length > 0;
  },
  async countFavorites(listingId: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM favorites WHERE listing_id = $1`, [listingId]);
    return rows[0].n;
  },
  async listFavorites(userId: string): Promise<ListingRecord[]> {
    const { rows } = await pool.query<ListingRecord>(
      `${LISTING_SELECT} JOIN favorites f ON f.listing_id = l.id AND f.user_id = $1 WHERE l.status <> 'DELISTED' ORDER BY f.created_at DESC`,
      [userId]
    );
    return rows;
  },

  /** Public trust signal: how many completed inspections, and the latest overall score. */
  async inspectionSummary(listingId: string): Promise<{ completed: number; latestOverallScore: number | null }> {
    const { rows } = await pool.query<{ completed: number; score: string | null }>(
      `SELECT count(*)::int AS completed,
              (SELECT (report->>'overallScore') FROM vehicle_inspections WHERE listing_id = $1 AND status = 'COMPLETED' ORDER BY created_at DESC LIMIT 1) AS score
       FROM vehicle_inspections WHERE listing_id = $1 AND status = 'COMPLETED'`,
      [listingId]
    );
    return { completed: rows[0].completed, latestOverallScore: rows[0].score === null ? null : Number(rows[0].score) };
  },
};
