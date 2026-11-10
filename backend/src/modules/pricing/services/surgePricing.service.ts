import { env } from "../../../config/env";
import { logger } from "../../../config/logger";
import { locationService } from "../../location/services/location.service";
import { ridesRepository } from "../../rides/repositories/rides.repository";
import { parseTiers, surgeMultiplierFor } from "./surge";

export interface SurgeQuote {
  multiplier: number;
  demand: number;
  supply: number;
  radiusMeters: number;
}

const tiers = parseTiers(env.SURGE_TIERS);

export const surgePricingService = {
  /**
   * Current surge at a pickup point for a vehicle type. NEVER throws: pricing is not allowed to take ride booking down,
   * so if Redis or Postgres cannot answer we log and quote 1.0x (graceful degradation: the rider pays the normal fare
   * instead of getting an error).
   */
  async quote(pickup: { lat: number; lng: number }, vehicleTypeId: string): Promise<SurgeQuote> {
    const radiusMeters = env.SURGE_RADIUS_METERS;
    if (env.SURGE_ENABLED !== "true") return { multiplier: 1.0, demand: 0, supply: 0, radiusMeters };
    try {
      const [open, drivers] = await Promise.all([
        ridesRepository.countSearchingNear(pickup, vehicleTypeId, radiusMeters),
        locationService.getNearbyDrivers(pickup.lat, pickup.lng, radiusMeters, vehicleTypeId),
      ]);
      const demand = open + 1; // the request being priced counts too
      const supply = drivers.length;
      return { multiplier: surgeMultiplierFor(demand, supply, tiers), demand, supply, radiusMeters };
    } catch (err) {
      logger.warn({ err }, "Surge lookup failed; quoting 1.0x");
      return { multiplier: 1.0, demand: 0, supply: 0, radiusMeters };
    }
  },
};
