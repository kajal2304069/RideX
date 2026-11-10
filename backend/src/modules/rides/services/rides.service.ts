import { pool } from "../../../db/pool";
import { ApiError } from "../../../common/ApiError";
import { logger } from "../../../config/logger";
import { driversRepository } from "../../drivers/repositories/drivers.repository";
import { vehiclesRepository } from "../../vehicles/repositories/vehicles.repository";
import { ridesRepository } from "../repositories/rides.repository";
import { computeFare, estimateDurationSeconds, haversineDistanceMeters } from "./fare.service";
import { assertValidRideTransition, RideTransitionError } from "./rideStateMachine";
import { GeoPoint, PublicRide, RideRecord, RideStatus, toPublicRide } from "../types/rides.types";
import { emitToRoom, rideRoom, userRoom } from "../../../websocket/io";
import { withLock } from "../../../common/redisLock";
import { notificationsService } from "../../notifications/services/notifications.service";
import { getOrSetCache } from "../../../common/cache";
import { surgePricingService } from "../../pricing/services/surgePricing.service";
import { earningsService } from "../../earnings/services/earnings.service";

/** Raised by `pg` for a Postgres unique_violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): err is { code: "23505" } {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

/**
 * Broadcasts a ride event to every interested party: the ride's own
 * room (for clients that called `ride:join`, Phase 10) AND each
 * party's personal room (so a client gets the update even if it hasn't
 * subscribed to the ride room yet - e.g. the instant after a rider
 * creates a ride, before their client has had a chance to `ride:join`
 * the room that ride only just started existing in). `emitToRoom` is a
 * safe no-op when no socket server is running (most tests exercise the
 * REST layer alone via `createApp()`, never booting a real HTTP+socket
 * server) - see websocket/io.ts.
 */
function broadcastRideEvent(ride: { id: string; rider_id: string; driver_id: string | null }, event: string, payload: PublicRide) {
  emitToRoom(rideRoom(ride.id), event, payload);
  emitToRoom(userRoom(ride.rider_id), event, payload);
  if (ride.driver_id) emitToRoom(userRoom(ride.driver_id), event, payload);
}

/**
 * Vehicle type rates are read on nearly every ride-related request
 * (every fare estimate, every ride creation) but the underlying rows
 * change essentially never after seeding - a textbook read-through
 * cache candidate (Phase 11). 5-minute TTL: short enough that a rare
 * admin-updated rate (a future feature; no such endpoint exists yet)
 * would propagate reasonably quickly, long enough that this removes
 * the repeated Postgres round-trip from the hot path almost entirely.
 */
async function getVehicleTypeRates(vehicleTypeId: string) {
  const cacheKey = `cache:vehicle-type-rates:${vehicleTypeId}`;

  const cached = await getOrSetCache(cacheKey, 300, async () => {
    const { rows } = await pool.query(
      `SELECT id, base_fare, per_km_rate, per_min_rate FROM vehicle_types WHERE id = $1 AND is_active = true`,
      [vehicleTypeId]
    );
    // Cache a null sentinel rather than throwing here - throwing inside
    // `compute()` would also skip caching, so every request for an
    // invalid ID would re-hit Postgres. Caching "this ID doesn't exist"
    // is itself useful (protects against a client retry-looping on a
    // typo'd ID), and the ApiError is still thrown below either way.
    if (!rows[0]) return null;
    return {
      baseFare: Number(rows[0].base_fare),
      perKmRate: Number(rows[0].per_km_rate),
      perMinRate: Number(rows[0].per_min_rate),
    };
  });

  if (!cached) throw ApiError.badRequest("Unknown or inactive vehicle type");
  return cached;
}

function assertParty(ride: { rider_id: string; driver_id: string | null }, requesterId: string) {
  if (ride.rider_id !== requesterId && ride.driver_id !== requesterId) {
    throw ApiError.notFound("Ride not found");
  }
}

const LIVE_STATUSES: RideStatus[] = ["DRIVER_ASSIGNED", "DRIVER_ARRIVING", "DRIVER_ARRIVED", "TRIP_STARTED"];

/**
 * Adds what screens need beyond the raw ride: the saved fare (set when the trip completes) and the other person's card.
 * A phone number is only included while the ride is live, and only to the other party: once the trip is over, or for
 * anyone else, it is null.
 */
async function withFare(ride: RideRecord, viewer: "rider" | "driver" = "rider") {
  const fare = await ridesRepository.findFareByRideId(ride.id);
  const live = LIVE_STATUSES.includes(ride.status);
  let driver: null | { id: string; fullName: string; phone: string | null; ratingAvg: number; totalRides: number; vehicle: null | { brand: string | null; model: string | null; color: string | null; registrationNumber: string | null; typeName: string | null; typeCode: string | null } } = null;
  let rider: null | { id: string; fullName: string; phone: string | null } = null;
  if (viewer === "rider" && ride.driver_id) {
    const c = await ridesRepository.findDriverCard(ride.driver_id, ride.vehicle_id);
    if (c) driver = { id: ride.driver_id, fullName: c.full_name, phone: live ? c.phone : null, ratingAvg: Number(c.rating_avg), totalRides: c.total_rides,
      vehicle: c.registration_number ? { brand: c.brand, model: c.model, color: c.color, registrationNumber: c.registration_number, typeName: c.type_name, typeCode: c.type_code } : null };
  }
  if (viewer === "driver") {
    const c = await ridesRepository.findRiderCard(ride.rider_id);
    if (c) rider = { id: ride.rider_id, fullName: c.full_name, phone: live ? c.phone : null };
  }
  return { ...toPublicRide(ride), fare: fare ? { totalFare: Number(fare.total_fare), currency: fare.currency } : null, driver, rider };
}

export const ridesService = {
  /** Upfront fare quote, shown before the rider commits to requesting. Uses Haversine, not Dijkstra (Phase 8) - see fare.service.ts. */
  async estimate(pickup: GeoPoint, dropoff: GeoPoint, vehicleTypeId: string) {
    const rates = await getVehicleTypeRates(vehicleTypeId);
    const distanceMeters = Math.round(haversineDistanceMeters(pickup, dropoff));
    const durationSeconds = estimateDurationSeconds(distanceMeters);
    const surge = await surgePricingService.quote(pickup, vehicleTypeId);
    const fare = computeFare(distanceMeters, durationSeconds, rates, { surgeMultiplier: surge.multiplier });
    return { distanceMeters, durationSeconds, fare, surge: { multiplier: surge.multiplier, demand: surge.demand, supply: surge.supply } };
  },

  /**
   * Creates a ride and puts it straight into SEARCHING_DRIVER.
   * REQUESTED (spec section 7's first state) is treated as instantaneous
   * rather than a persisted, separate row state - there's no async step
   * between "rider hits request" and "we start looking for a driver" at
   * this phase (no fraud/pre-auth check yet), so persisting a
   * REQUESTED row that transitions to SEARCHING_DRIVER microseconds
   * later would just be two DB writes to model one event. If a
   * pre-search validation step is added later, this is exactly where a
   * real REQUESTED-then-SEARCHING_DRIVER two-step would be introduced.
   *
   * Idempotency (spec section 13): if `idempotencyKey` matches an
   * existing ride, that ride is returned as-is instead of creating a
   * duplicate - protects against double-tap/retry-on-timeout double
   * booking.
   */
  async request(
    riderId: string,
    input: {
      pickup: GeoPoint & { address: string };
      dropoff: GeoPoint & { address: string };
      vehicleTypeId: string;
      idempotencyKey: string;
    }
  ): Promise<PublicRide> {
    // Distributed lock (Phase 11) closes the TOCTOU race between
    // "check for an existing ride with this idempotency key" and
    // "create one" - without it, two requests submitted at nearly the
    // same instant with the SAME key (the exact scenario an
    // idempotency key exists to protect against: a client retrying a
    // slow/timed-out request) could both pass the existence check
    // before either commits, and both attempt to insert. Lock scope is
    // per (rider, key) - unrelated requests never contend with each
    // other.
    return withLock(`lock:ride:request:${riderId}:${input.idempotencyKey}`, async () => {
      const existing = await ridesRepository.findByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        if (existing.rider_id !== riderId) {
          // Someone else's idempotency key - never silently return another
          // rider's ride data.
          throw ApiError.conflict("Idempotency key already used");
        }
        return toPublicRide(existing);
      }

      const active = await ridesRepository.findActiveByRider(riderId);
      if (active) {
        throw ApiError.conflict("You already have an active ride in progress");
      }

      const rates = await getVehicleTypeRates(input.vehicleTypeId);
      const distanceMeters = Math.round(haversineDistanceMeters(input.pickup, input.dropoff));
      const durationSeconds = estimateDurationSeconds(distanceMeters);
      void rates; // rates aren't needed at request time - fare is computed and saved at trip completion (see completeTrip)
      // Surge is decided ONCE, here, and stored on the ride: the fare at completion uses what the rider was quoted.
      const surge = await surgePricingService.quote(input.pickup, input.vehicleTypeId);

      let ride;
      try {
        ride = await ridesRepository.create({
          riderId,
          vehicleTypeId: input.vehicleTypeId,
          pickup: input.pickup,
          dropoff: input.dropoff,
          idempotencyKey: input.idempotencyKey,
          distanceMeters,
          durationSeconds,
          surgeMultiplier: surge.multiplier,
        });
      } catch (err) {
        // Defense in depth (same lesson as Phase 5's vehicle-assignment
        // bug): even with the lock above, a genuine 23505 here would mean
        // the lock's TTL expired before this transaction committed under
        // extreme slowness - rather than leak a raw 500, treat it exactly
        // like finding the row on the initial check.
        if (isUniqueViolation(err)) {
          const raceWinner = await ridesRepository.findByIdempotencyKey(input.idempotencyKey);
          if (raceWinner) return toPublicRide(raceWinner);
        }
        throw err;
      }

      logger.info({ rideId: ride.id, riderId }, "Ride requested");
      const publicRide = toPublicRide(ride);
      broadcastRideEvent(ride, "ride:requested", publicRide);
      return publicRide;
    });
  },

  async getOne(rideId: string, requesterId: string) {
    const ride = await ridesRepository.findById(rideId);
    if (!ride) throw ApiError.notFound("Ride not found");
    assertParty(ride, requesterId);
    return withFare(ride, requesterId === ride.driver_id ? "driver" : "rider");
  },

  async getCurrentForRider(riderId: string) {
    const ride = await ridesRepository.findActiveByRider(riderId);
    return ride ? withFare(ride) : null;
  },

  async getCurrentForDriver(driverId: string) {
    const ride = await ridesRepository.findActiveByDriver(driverId);
    return ride ? withFare(ride, "driver") : null;
  },

  async getHistory(riderId: string) {
    const rides = await ridesRepository.findHistoryByRider(riderId);
    return Promise.all(rides.map((r) => withFare(r, "rider")));
  },

  /**
   * Either party rates the other once the trip has finished. One rating per person per ride (a UNIQUE constraint, so a
   * double-tap or two devices cannot rate twice). The ratee's average is recomputed from the ratings table inside the
   * same transaction, so it can never drift from the rows it summarises.
   */
  async rate(rideId: string, raterId: string, input: { rating: number; comment?: string }) {
    const ride = await ridesRepository.findById(rideId);
    if (!ride) throw ApiError.notFound("Ride not found");
    assertParty(ride, raterId);
    if (ride.status !== "TRIP_COMPLETED" && ride.status !== "PAYMENT_COMPLETED") {
      throw ApiError.conflict("A ride can only be rated after the trip is completed");
    }
    const rateeId = raterId === ride.rider_id ? ride.driver_id : ride.rider_id;
    if (!rateeId) throw ApiError.conflict("This ride has no one to rate");
    const rateeIsDriver = rateeId === ride.driver_id;

    const created = await ridesRepository.addRating({ rideId, raterId, rateeId, rating: input.rating, comment: input.comment, rateeIsDriver });
    if (!created) throw ApiError.conflict("You have already rated this ride");
    return { rideId, rating: input.rating };
  },

  async myRating(rideId: string, raterId: string) {
    const ride = await ridesRepository.findById(rideId);
    if (!ride) throw ApiError.notFound("Ride not found");
    assertParty(ride, raterId);
    return { rating: await ridesRepository.findRatingBy(rideId, raterId) };
  },

  /** The crude matching pool until Phase 9's MatchingService exists - every SEARCHING_DRIVER ride, unranked. */
  async listAvailableForDrivers(vehicleTypeId?: string): Promise<PublicRide[]> {
    const rides = await ridesRepository.findSearchingRides(vehicleTypeId);
    return rides.map(toPublicRide);
  },

  /**
   * Driver acceptance - see rides.repository.ts::acceptRideIfSearching
   * for the actual concurrency mechanism (SELECT ... FOR UPDATE). This
   * method's job is everything AROUND that: validating the driver is
   * eligible at all before even attempting the lock, and coordinating
   * the vehicle's state machine (Phase 5) once acceptance succeeds.
   */
  async accept(rideId: string, driverId: string): Promise<PublicRide> {
    const driver = await driversRepository.findByUserId(driverId);
    if (!driver) throw ApiError.notFound("Driver profile not found");
    if (driver.verification_status !== "VERIFIED") {
      throw ApiError.forbidden("Only verified drivers can accept rides");
    }
    if (!driver.current_vehicle_id) {
      throw ApiError.badRequest("You need a vehicle assigned before accepting rides");
    }
    if (!driver.is_online) {
      throw ApiError.forbidden("You must be online to accept rides");
    }

    const alreadyActive = await ridesRepository.findActiveByDriver(driverId);
    if (alreadyActive) {
      throw ApiError.conflict("You already have an active ride");
    }

    const vehicle = await vehiclesRepository.findById(driver.current_vehicle_id);
    if (!vehicle) throw ApiError.notFound("Assigned vehicle not found");
    if (vehicle.status !== "AVAILABLE") {
      throw ApiError.conflict(`Your assigned vehicle is currently ${vehicle.status}`);
    }

    const rideBeforeAccept = await ridesRepository.findById(rideId);
    if (!rideBeforeAccept) throw ApiError.notFound("Ride not found");
    if (rideBeforeAccept.vehicle_type_id !== vehicle.vehicle_type_id) {
      throw ApiError.badRequest("Your vehicle type doesn't match this ride's requested vehicle type");
    }

    // The actual race-safe operation - see repository for the FOR UPDATE lock.
    const { ride, conflict } = await ridesRepository.acceptRideIfSearching(rideId, driverId, vehicle.id);
    if (conflict) {
      throw ApiError.conflict("This ride has already been accepted by another driver");
    }
    if (!ride) throw ApiError.notFound("Ride not found");

    const vehicleUpdated = await vehiclesRepository.updateStatusIfCurrentlyIs(vehicle.id, "AVAILABLE", "IN_RIDE_SERVICE");
    if (!vehicleUpdated) {
      // Extremely unlikely (we just confirmed AVAILABLE above, and vehicle
      // status changes are owner-only elsewhere) but if it happens, the
      // ride acceptance itself already succeeded and must not be rolled
      // back silently - log loudly for operational visibility instead.
      logger.error({ rideId, vehicleId: vehicle.id }, "Ride accepted but vehicle status update lost a race - needs manual reconciliation");
    }

    logger.info({ rideId, driverId, vehicleId: vehicle.id }, "Ride accepted");
    const publicRide = toPublicRide(ride);
    broadcastRideEvent(ride, "ride:accepted", publicRide);
    void notificationsService.notify(ride.rider_id, "RIDE_ASSIGNED", ride.id);
    return publicRide;
  },

  async transition(
    rideId: string,
    requesterId: string,
    to: RideStatus,
    timestampColumn?: "arrived_at" | "started_at" | "completed_at"
  ): Promise<PublicRide> {
    const ride = await ridesRepository.findById(rideId);
    if (!ride) throw ApiError.notFound("Ride not found");
    if (ride.driver_id !== requesterId) {
      throw ApiError.forbidden("Only the assigned driver can update this ride's status");
    }

    try {
      assertValidRideTransition(ride.status, to);
    } catch (err) {
      if (err instanceof RideTransitionError) throw ApiError.badRequest(err.message);
      throw err;
    }

    const updated = await ridesRepository.updateStatus(rideId, to, timestampColumn);
    logger.info({ rideId, from: ride.status, to }, "Ride status changed");
    const publicRide = toPublicRide(updated!);

    // DRIVER_ARRIVING/DRIVER_ARRIVED aren't in spec section 11's named
    // event list (only requested/accepted/started/completed/cancelled
    // are), but a rider's live map still needs SOME signal that the
    // driver's status moved - `ride:status_changed` covers every
    // transition uniformly, while `ride:started` additionally fires for
    // the one further transition the spec names explicitly.
    broadcastRideEvent(ride, "ride:status_changed", publicRide);
    if (to === "TRIP_STARTED") broadcastRideEvent(ride, "ride:started", publicRide);

    const transitionNotice: Partial<Record<RideStatus, "DRIVER_ARRIVING" | "DRIVER_ARRIVED" | "TRIP_STARTED">> = {
      DRIVER_ARRIVING: "DRIVER_ARRIVING",
      DRIVER_ARRIVED: "DRIVER_ARRIVED",
      TRIP_STARTED: "TRIP_STARTED",
    };
    const notice = transitionNotice[to];
    if (notice) void notificationsService.notify(ride.rider_id, notice, ride.id);

    return publicRide;
  },

  /**
   * Completing a trip: validate the transition, persist the final fare
   * (spec section 14), free the vehicle back to AVAILABLE, and bump
   * both parties' ride counts. All the side effects of "a ride finished"
   * live here, in one place, rather than scattered across whatever
   * caller happens to trigger completion.
   */
  async complete(rideId: string, driverId: string): Promise<PublicRide> {
    const ride = await ridesRepository.findById(rideId);
    if (!ride) throw ApiError.notFound("Ride not found");
    if (ride.driver_id !== driverId) {
      throw ApiError.forbidden("Only the assigned driver can complete this ride");
    }

    try {
      assertValidRideTransition(ride.status, "TRIP_COMPLETED");
    } catch (err) {
      if (err instanceof RideTransitionError) throw ApiError.badRequest(err.message);
      throw err;
    }

    const rates = await getVehicleTypeRates(ride.vehicle_type_id);
    const fare = computeFare(ride.distance_meters ?? 0, ride.duration_seconds ?? 0, rates, { surgeMultiplier: Number(ride.surge_multiplier) });
    await ridesRepository.saveFare(rideId, fare);

    const updated = await ridesRepository.updateStatus(rideId, "TRIP_COMPLETED", "completed_at");

    if (ride.vehicle_id) {
      const vehicleFreed = await vehiclesRepository.updateStatusIfCurrentlyIs(ride.vehicle_id, "IN_RIDE_SERVICE", "AVAILABLE");
      if (!vehicleFreed) {
        logger.error({ rideId, vehicleId: ride.vehicle_id }, "Vehicle status did not free cleanly after trip completion - needs manual reconciliation");
      }
    }

    await pool.query(`UPDATE drivers SET total_rides = total_rides + 1, updated_at = now() WHERE user_id = $1`, [
      driverId,
    ]);
    await pool.query(`UPDATE riders SET total_rides = total_rides + 1, updated_at = now() WHERE user_id = $1`, [
      ride.rider_id,
    ]);

    logger.info({ rideId, totalFare: fare.totalFare }, "Trip completed");
    const publicRide = toPublicRide(updated!);
    broadcastRideEvent(ride, "ride:completed", publicRide);
    void notificationsService.notify(ride.rider_id, "RIDE_COMPLETED", ride.id, { totalFare: fare.totalFare, currency: fare.currency });
    return publicRide;
  },

  /**
   * Called by PaymentService after a RIDE payment succeeds (spec section
   * 7: TRIP_COMPLETED -> PAYMENT_COMPLETED). Lives in the rides module so
   * the ride lifecycle stays owned by one service; payments -> rides is the
   * only dependency direction. Idempotent: if the ride is already
   * PAYMENT_COMPLETED (a retried finalization) it returns it unchanged.
   */
  async markPaymentCompleted(rideId: string): Promise<PublicRide> {
    const ride = await ridesRepository.findById(rideId);
    if (!ride) throw ApiError.notFound("Ride not found");
    if (ride.status === "PAYMENT_COMPLETED") {
      // A replayed finalization also re-runs the (idempotent) earnings split, healing a settlement that failed last time.
      await earningsService.settleRideSafely(rideId);
      return toPublicRide(ride);
    }

    try {
      assertValidRideTransition(ride.status, "PAYMENT_COMPLETED");
    } catch (err) {
      if (err instanceof RideTransitionError) throw ApiError.conflict(err.message);
      throw err;
    }

    const updated = await ridesRepository.updateStatusIfCurrently(rideId, ride.status, "PAYMENT_COMPLETED");
    if (!updated) {
      // Lost a race with another finalizer; whatever state it is in now is authoritative.
      return toPublicRide((await ridesRepository.findById(rideId))!);
    }

    logger.info({ rideId }, "Ride payment completed");
    await earningsService.settleRideSafely(rideId);
    const publicRide = toPublicRide(updated);
    broadcastRideEvent(ride, "ride:status_changed", publicRide);
    broadcastRideEvent(ride, "ride:payment_completed", publicRide);
    if (ride.driver_id) void notificationsService.notify(ride.driver_id, "PAYMENT_RECEIVED", ride.id);
    return publicRide;
  },

  /**
   * Either party can cancel pre-trip-start (state machine enforces
   * exactly which "from" states allow it). If a vehicle had already
   * been committed to this ride (post-acceptance), it's freed back to
   * AVAILABLE as part of cancellation - otherwise a cancelled ride
   * would leave the vehicle stuck IN_RIDE_SERVICE forever.
   */
  async cancel(rideId: string, requesterId: string, reason?: string): Promise<PublicRide> {
    const ride = await ridesRepository.findById(rideId);
    if (!ride) throw ApiError.notFound("Ride not found");
    assertParty(ride, requesterId);

    const cancelStatus: RideStatus = requesterId === ride.rider_id ? "CANCELLED_BY_RIDER" : "CANCELLED_BY_DRIVER";

    try {
      assertValidRideTransition(ride.status, cancelStatus);
    } catch (err) {
      if (err instanceof RideTransitionError) throw ApiError.badRequest(err.message);
      throw err;
    }

    const updated = await ridesRepository.updateStatus(rideId, cancelStatus, "cancelled_at", { cancellationReason: reason });

    if (ride.vehicle_id) {
      const vehicleFreed = await vehiclesRepository.updateStatusIfCurrentlyIs(ride.vehicle_id, "IN_RIDE_SERVICE", "AVAILABLE");
      if (!vehicleFreed) {
        logger.warn({ rideId, vehicleId: ride.vehicle_id }, "Vehicle was not IN_RIDE_SERVICE at cancellation time - leaving status untouched");
      }
    }

    logger.info({ rideId, cancelStatus, reason }, "Ride cancelled");
    const publicRide = toPublicRide(updated!);
    broadcastRideEvent(ride, "ride:cancelled", publicRide);
    // Tell the OTHER party; the canceller already knows.
    const other = requesterId === ride.rider_id ? ride.driver_id : ride.rider_id;
    if (other) {
      void notificationsService.notify(other, "RIDE_CANCELLED", ride.id, {
        cancelledBy: requesterId === ride.rider_id ? "RIDER" : "DRIVER",
      });
    }
    return publicRide;
  },
};
