import { redis } from "../../../config/redis";
import { pool } from "../../../db/pool";
import { logger } from "../../../config/logger";
import { ApiError } from "../../../common/ApiError";
import { driversRepository } from "../../drivers/repositories/drivers.repository";
import { vehiclesRepository } from "../../vehicles/repositories/vehicles.repository";
import { DriverLocationUpdate, NearbyDriver } from "../types/location.types";

/**
 * Redis key layout:
 *   geo:drivers                 - a single GEO sorted set, member = driverId
 *   loc:driver:<driverId>       - hash: lat, lng, heading, speedKmh, vehicleId,
 *                                  vehicleTypeId, updatedAt (unix ms)
 *   loc:persisted:<driverId>    - plain string, last unix ms this driver's
 *                                  position was written to Postgres (throttle marker)
 *
 * Why a GEO set PLUS a separate hash, instead of just the GEO set: Redis
 * GEO commands only store a member's coordinates - there's no room in a
 * sorted-set entry for heading, speed, vehicle type, or a last-updated
 * timestamp. The hash carries everything else, keyed by the same
 * driverId, so a nearby-search result can be enriched with a second
 * lookup (see getNearbyDrivers).
 */
const GEO_KEY = "geo:drivers";
const locationHashKey = (driverId: string) => `loc:driver:${driverId}`;
const persistedMarkerKey = (driverId: string) => `loc:persisted:${driverId}`;

/**
 * A driver's GEO-set entry has no way to expire on its own (Redis sorted
 * sets don't support per-member TTL - only whole-key TTL). So staleness
 * is tracked via the hash's `updatedAt` field instead: if a driver's
 * last update is older than this threshold, they're treated as
 * effectively offline for matching purposes (spec section 36's "driver
 * disconnect" failure handling, applied at the geolocation layer) even
 * though their coordinates are technically still sitting in the GEO
 * set. `getNearbyDrivers` filters these out AND lazily removes them
 * from the GEO set as a cleanup side effect, so the set doesn't grow
 * unboundedly with abandoned entries.
 */
const STALE_THRESHOLD_MS = 30_000;

/** Don't write every single GPS ping to Postgres (spec section 8) - only persist a sample every N seconds per driver. */
const PERSIST_INTERVAL_MS = 30_000;

export const locationService = {
  /**
   * The entrypoint controllers actually call. Deliberately re-derives
   * `vehicleId`/`vehicleTypeId` from the driver's own DB row rather than
   * trusting client-supplied values for them - a driver can only ever
   * broadcast a position tagged with the vehicle they're actually
   * assigned to (Phase 5's assignment), not an arbitrary one, which
   * matters once Phase 9's matching starts trusting `vehicleTypeId` from
   * this data to route ride requests.
   */
  async recordDriverPing(driverId: string, update: DriverLocationUpdate): Promise<void> {
    const driver = await driversRepository.findByUserId(driverId);
    if (!driver) throw ApiError.notFound("Driver profile not found");
    if (!driver.is_online) throw ApiError.forbidden("Go online before broadcasting location");
    if (!driver.current_vehicle_id) throw ApiError.badRequest("No vehicle assigned");

    const vehicle = await vehiclesRepository.findById(driver.current_vehicle_id);
    if (!vehicle) throw ApiError.notFound("Assigned vehicle not found");

    await this.updateDriverLocation(driverId, vehicle.id, vehicle.vehicle_type_id, update);
  },

  async updateDriverLocation(
    driverId: string,
    vehicleId: string,
    vehicleTypeId: string,
    update: DriverLocationUpdate
  ): Promise<void> {
    const now = Date.now();

    await redis.geoadd(GEO_KEY, update.lng, update.lat, driverId);
    await redis.hset(locationHashKey(driverId), {
      lat: update.lat,
      lng: update.lng,
      heading: update.heading ?? "",
      speedKmh: update.speedKmh ?? "",
      vehicleId,
      vehicleTypeId,
      updatedAt: now,
    });
    // Belt-and-suspenders TTL on the metadata hash itself: even if a
    // driver's app crashes without ever calling goOffline/removeDriver,
    // the hash self-cleans after a few missed update cycles. The GEO
    // set entry doesn't get this for free (no per-member TTL exists in
    // Redis), which is exactly why getNearbyDrivers cross-checks against
    // the hash rather than trusting GEO set membership alone.
    await redis.expire(locationHashKey(driverId), 120);

    await maybePersistToPostgres(driverId, vehicleId, update, now);
  },

  /**
   * Nearby-driver search (spec section 8's core query, and what Phase 9's
   * MatchingService will build on top of). GEOSEARCH does the actual
   * radius filtering and distance sort in Redis; this method's job is
   * enriching each hit with metadata from the hash and filtering out
   * anyone stale.
   */
  async getNearbyDrivers(
    lat: number,
    lng: number,
    radiusMeters: number,
    vehicleTypeId?: string
  ): Promise<NearbyDriver[]> {
    const hits = (await redis.geosearch(
      GEO_KEY,
      "FROMLONLAT",
      lng,
      lat,
      "BYRADIUS",
      radiusMeters,
      "m",
      "ASC",
      "WITHCOORD",
      "WITHDIST"
    )) as unknown as [string, string, [string, string]][];

    if (hits.length === 0) return [];

    const pipeline = redis.pipeline();
    for (const [driverId] of hits) {
      pipeline.hgetall(locationHashKey(driverId));
    }
    const results = await pipeline.exec();

    const now = Date.now();
    const nearby: NearbyDriver[] = [];
    const staleDriverIds: string[] = [];

    hits.forEach(([driverId, distance, [hitLng, hitLat]], i) => {
      const [, hash] = results![i];
      const meta = hash as Record<string, string> | null;

      if (!meta || !meta.updatedAt) {
        staleDriverIds.push(driverId);
        return;
      }
      const updatedAt = Number(meta.updatedAt);
      if (now - updatedAt > STALE_THRESHOLD_MS) {
        staleDriverIds.push(driverId);
        return;
      }
      if (vehicleTypeId && meta.vehicleTypeId !== vehicleTypeId) {
        return;
      }

      nearby.push({
        driverId,
        vehicleId: meta.vehicleId,
        vehicleTypeId: meta.vehicleTypeId,
        lat: Number(hitLat),
        lng: Number(hitLng),
        distanceMeters: Number(distance),
        heading: meta.heading ? Number(meta.heading) : null,
        speedKmh: meta.speedKmh ? Number(meta.speedKmh) : null,
        updatedAt,
      });
    });

    if (staleDriverIds.length > 0) {
      await redis.zrem(GEO_KEY, ...staleDriverIds);
      logger.debug({ count: staleDriverIds.length }, "Removed stale driver locations from GEO set");
    }

    return nearby;
  },

  async removeDriverLocation(driverId: string): Promise<void> {
    await redis.zrem(GEO_KEY, driverId);
    await redis.del(locationHashKey(driverId));
  },

  async getDriverLocation(driverId: string): Promise<NearbyDriver | null> {
    const meta = await redis.hgetall(locationHashKey(driverId));
    if (!meta || !meta.updatedAt) return null;
    return {
      driverId,
      vehicleId: meta.vehicleId,
      vehicleTypeId: meta.vehicleTypeId,
      lat: Number(meta.lat),
      lng: Number(meta.lng),
      distanceMeters: 0,
      heading: meta.heading ? Number(meta.heading) : null,
      speedKmh: meta.speedKmh ? Number(meta.speedKmh) : null,
      updatedAt: Number(meta.updatedAt),
    };
  },
};

async function maybePersistToPostgres(
  driverId: string,
  vehicleId: string,
  update: DriverLocationUpdate,
  now: number
): Promise<void> {
  const lastPersisted = await redis.get(persistedMarkerKey(driverId));
  if (lastPersisted && now - Number(lastPersisted) < PERSIST_INTERVAL_MS) {
    return; // sampled recently enough - skip this write
  }

  await pool.query(
    `INSERT INTO vehicle_locations (vehicle_id, driver_id, location, heading, speed_kmh)
     VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6)`,
    [vehicleId, driverId, update.lng, update.lat, update.heading ?? null, update.speedKmh ?? null]
  );
  await redis.set(persistedMarkerKey(driverId), now);
}
