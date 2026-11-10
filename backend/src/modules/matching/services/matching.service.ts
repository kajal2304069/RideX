import { ApiError } from "../../../common/ApiError";
import { logger } from "../../../config/logger";
import { locationService } from "../../location/services/location.service";
import { driversRepository } from "../../drivers/repositories/drivers.repository";
import { ridesRepository } from "../../rides/repositories/rides.repository";
import { estimateDurationSeconds } from "../../rides/services/fare.service";
import { matchingDuration } from "../../../observability/metrics";
import { scoreCandidate } from "./scoring";
import { CandidateDriver, MatchResult } from "../types/matching.types";

/**
 * Progressive search radius expansion, spec section 9's exact values:
 * "1km -> 2km -> 5km -> 10km if necessary." Stops at the FIRST radius
 * that yields at least one qualified candidate - there's no reason to
 * keep expanding (and pulling in worse-ranked, farther candidates) once
 * a close-enough pool exists. Only escalates when a smaller radius
 * comes back empty.
 */
const SEARCH_RADII_METERS = [1000, 2000, 5000, 10000];

/**
 * MatchingService - spec section 9. Given a ride, finds and RANKS
 * nearby drivers rather than dispatching to whichever driver happens to
 * respond first. Three responsibilities, kept distinct:
 *   1. Progressive radius search (this file) - "where do we even look"
 *   2. Gate-filtering (this file) - "who's actually eligible"
 *   3. Scoring (scoring.ts, pure function) - "who's the best fit"
 */
export const matchingService = {
  async findCandidates(rideId: string): Promise<MatchResult> {
    const stop = matchingDuration.startTimer();
    try {
      const result = await this.findCandidatesUntimed(rideId);
      stop({ outcome: result.candidatesFound > 0 ? "found" : "none" });
      return result;
    } catch (err) {
      stop({ outcome: "error" });
      throw err;
    }
  },

  async findCandidatesUntimed(rideId: string): Promise<MatchResult> {
    const ride = await ridesRepository.findById(rideId);
    if (!ride) throw ApiError.notFound("Ride not found");
    if (ride.status !== "SEARCHING_DRIVER") {
      throw ApiError.conflict(`Ride is not searching for a driver (status: ${ride.status})`);
    }

    for (const radiusMeters of SEARCH_RADII_METERS) {
      const nearby = await locationService.getNearbyDrivers(
        ride.pickup_lat,
        ride.pickup_lng,
        radiusMeters,
        ride.vehicle_type_id
      );

      const candidates = await filterAndScore(nearby, radiusMeters);

      if (candidates.length > 0) {
        logger.info(
          { rideId, radiusMeters, candidateCount: candidates.length },
          "Matching candidates found"
        );
        return {
          rideId,
          searchRadiusMeters: radiusMeters,
          candidatesFound: candidates.length,
          candidates: candidates.sort((a, b) => b.score - a.score),
        };
      }
    }

    logger.info({ rideId, maxRadiusMeters: SEARCH_RADII_METERS.at(-1) }, "No matching candidates found at any radius");
    return {
      rideId,
      searchRadiusMeters: SEARCH_RADII_METERS.at(-1)!,
      candidatesFound: 0,
      candidates: [],
    };
  },
};

/**
 * Applies the two hard gates spec section 9 lists alongside the scored
 * dimensions - vehicle compatibility (already applied by
 * `getNearbyDrivers`'s `vehicleTypeId` filter, upstream of this
 * function) and driver AVAILABILITY, which needs a check this function
 * performs directly: a driver can be "online" and broadcasting location
 * (Phase 7) while already mid-ride (Phase 6's accept flow deliberately
 * doesn't touch `is_online` when a ride starts - see Phase 6 docs) -
 * so online-but-busy drivers must be excluded here, not just trusted
 * from presence in the location index alone.
 */
async function filterAndScore(
  nearby: Awaited<ReturnType<typeof locationService.getNearbyDrivers>>,
  radiusMeters: number
): Promise<CandidateDriver[]> {
  const candidates: CandidateDriver[] = [];

  for (const hit of nearby) {
    const [driver, activeRide] = await Promise.all([
      driversRepository.findByUserId(hit.driverId),
      ridesRepository.findActiveByDriver(hit.driverId),
    ]);

    if (!driver) continue; // stale/orphaned Redis entry - shouldn't happen, but never trust it blindly
    if (driver.verification_status !== "VERIFIED") continue;
    if (activeRide) continue; // busy - the availability gate

    const etaSeconds = estimateDurationSeconds(hit.distanceMeters);
    const ratingAvg = Number(driver.rating_avg);

    const breakdown = scoreCandidate({
      distanceMeters: hit.distanceMeters,
      etaSeconds,
      ratingAvg,
      searchRadiusMeters: radiusMeters,
    });

    candidates.push({
      driverId: hit.driverId,
      vehicleId: hit.vehicleId,
      distanceMeters: Math.round(hit.distanceMeters),
      etaSeconds,
      ratingAvg,
      score: breakdown.total,
      scoreBreakdown: {
        distanceScore: breakdown.distanceScore,
        etaScore: breakdown.etaScore,
        ratingScore: breakdown.ratingScore,
      },
    });
  }

  return candidates;
}
