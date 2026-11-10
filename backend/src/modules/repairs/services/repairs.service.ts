import { ApiError } from "../../../common/ApiError";
import { withLock } from "../../../common/redisLock";
import { logger } from "../../../config/logger";
import { garagesRepository } from "../../garages/repositories/garages.repository";
import { notificationsService } from "../../notifications/services/notifications.service";
import { vehiclesRepository } from "../../vehicles/repositories/vehicles.repository";
import { repairsRepository } from "../repositories/repairs.repository";
import {
  BookingRecord, BookingStatus, PartUsed, toPublicBooking, toPublicMaintenance, toPublicRepairOrder,
} from "../types/repairs.types";
import { assertValidBookingTransition, BookingTransitionError, CANCELLABLE_BOOKING_STATUSES } from "./bookingStateMachine";
import { computeRepairCosts, NEXT_DUE_DAYS } from "./repairCosts";

/** Used when the garage has no radius-specific rule: how far we look for an emergency garage. */
const EMERGENCY_SEARCH_RADIUS_METERS = 20000;
const CURRENCY = "INR";

function isUniqueViolation(err: unknown): err is { code: "23505" } {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

export interface CreateBookingInput {
  garageId: string;
  garageServiceId?: string;
  vehicleId?: string;
  scheduledAt?: Date;
  description?: string;
  idempotencyKey: string;
}

export interface EmergencyInput {
  lat: number;
  lng: number;
  vehicleId?: string;
  description?: string;
  idempotencyKey: string;
}

/** Loads a booking the caller may act on as the GARAGE side. 404 for anyone else so existence is not leaked. */
async function loadForGarageOwner(bookingId: string, userId: string): Promise<BookingRecord> {
  const booking = await repairsRepository.findById(bookingId);
  if (!booking || booking.garage_owner_id !== userId) throw ApiError.notFound("Booking not found");
  return booking;
}

/**
 * Validates the transition against the pure state machine, then applies it
 * with a guarded UPDATE. If the guarded UPDATE matches nothing, someone else
 * moved the booking between our read and our write (customer cancelled,
 * double click): 409 rather than silently overwriting.
 */
async function advance(booking: BookingRecord, to: BookingStatus, extra: { mechanicId?: string } = {}): Promise<BookingRecord> {
  try {
    assertValidBookingTransition(booking.status, to);
  } catch (err) {
    if (err instanceof BookingTransitionError) throw ApiError.badRequest(err.message);
    throw err;
  }
  const updated = await repairsRepository.transition(booking.id, booking.status, to, extra);
  if (!updated) throw ApiError.conflict("Booking was changed by someone else; reload and retry");
  logger.info({ bookingId: booking.id, from: booking.status, to }, "Booking status changed");
  return updated;
}

export const repairsService = {
  async create(customerId: string, input: CreateBookingInput, extra: { isEmergency?: boolean; breakdown?: { lat: number; lng: number } } = {}) {
    if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 100) {
      throw ApiError.badRequest("idempotencyKey must be 8-100 characters");
    }
    // Namespaced per customer: one user's key can never collide with another's.
    const storedKey = `${customerId}:${input.idempotencyKey}`;

    return withLock(`lock:booking:create:${storedKey}`, async () => {
      const existing = await repairsRepository.findByIdempotencyKey(storedKey);
      if (existing) return toPublicBooking(existing);

      const garage = await garagesRepository.findById(input.garageId);
      if (!garage || !garage.is_active) throw ApiError.notFound("Garage not found");

      if (input.garageServiceId) {
        const service = await garagesRepository.findService(input.garageServiceId);
        if (!service || service.garage_id !== garage.id) throw ApiError.badRequest("That service is not offered by this garage");
      }
      if (input.vehicleId) {
        const vehicle = await vehiclesRepository.findById(input.vehicleId);
        // 404, not 403: don't reveal that someone else's vehicle exists.
        if (!vehicle || vehicle.owner_id !== customerId) throw ApiError.notFound("Vehicle not found");
      }
      if (input.scheduledAt && input.scheduledAt.getTime() < Date.now()) {
        throw ApiError.badRequest("scheduledAt must be in the future");
      }

      let booking: BookingRecord;
      try {
        booking = await repairsRepository.create({
          garageId: garage.id, customerId, vehicleId: input.vehicleId, garageServiceId: input.garageServiceId,
          isEmergency: extra.isEmergency ?? false, scheduledAt: input.scheduledAt, idempotencyKey: storedKey,
          description: input.description, breakdown: extra.breakdown,
        });
      } catch (err) {
        // Lock expired / Redis blip: the unique index on idempotency_key caught the duplicate.
        if (isUniqueViolation(err)) {
          const winner = await repairsRepository.findByIdempotencyKey(storedKey);
          if (winner) return toPublicBooking(winner);
        }
        throw err;
      }

      void notificationsService.notify(garage.owner_id, "BOOKING_REQUESTED", booking.id, { isEmergency: booking.is_emergency });
      return toPublicBooking(booking);
    });
  },

  /**
   * Spec section 19: an emergency breakdown is auto-dispatched to the NEAREST
   * active garage that lists EMERGENCY_REPAIR, instead of making a stranded
   * driver browse. Uses the same GIST-backed KNN query as the nearby search.
   */
  async createEmergency(customerId: string, input: EmergencyInput) {
    const [garage] = await garagesRepository.findNearby({
      lat: input.lat, lng: input.lng, radiusMeters: EMERGENCY_SEARCH_RADIUS_METERS, serviceType: "EMERGENCY_REPAIR", limit: 1,
    });
    if (!garage) throw ApiError.notFound("No garage offering emergency repair is available near you");

    const service = await garagesRepository.findServiceByType(garage.id, "EMERGENCY_REPAIR");
    return this.create(
      customerId,
      { garageId: garage.id, garageServiceId: service?.id, vehicleId: input.vehicleId, description: input.description, idempotencyKey: input.idempotencyKey },
      { isEmergency: true, breakdown: { lat: input.lat, lng: input.lng } }
    );
  },

  // ---- garage-side lifecycle -------------------------------------------------

  async accept(bookingId: string, ownerId: string) {
    const booking = await loadForGarageOwner(bookingId, ownerId);
    const updated = await advance(booking, "ACCEPTED");
    void notificationsService.notify(booking.customer_id, "BOOKING_ACCEPTED", booking.id);
    return toPublicBooking(updated);
  },

  async assignMechanic(bookingId: string, ownerId: string, mechanicId: string) {
    const booking = await loadForGarageOwner(bookingId, ownerId);
    const mechanic = await garagesRepository.findMechanic(mechanicId);
    if (!mechanic || mechanic.garage_id !== booking.garage_id) throw ApiError.badRequest("Mechanic does not belong to this garage");
    if (!mechanic.is_active) throw ApiError.badRequest("Mechanic is not active");

    try {
      const updated = await advance(booking, "MECHANIC_ASSIGNED", { mechanicId });
      void notificationsService.notify(booking.customer_id, "MECHANIC_ASSIGNED", booking.id);
      return toPublicBooking(updated);
    } catch (err) {
      // The partial unique index (one active job per mechanic) is the real guarantee.
      if (isUniqueViolation(err)) throw ApiError.conflict("This mechanic already has an active job");
      throw err;
    }
  },

  /**
   * The vehicle physically arrives. If it is a registered RideX vehicle it is
   * taken out of service (AVAILABLE -> UNDER_MAINTENANCE) so it cannot be
   * matched to a ride or rented while it is on a lift. The vehicle is claimed
   * FIRST; if the booking transition then loses a race, the claim is undone.
   */
  async markVehicleReceived(bookingId: string, ownerId: string) {
    const booking = await loadForGarageOwner(bookingId, ownerId);
    try {
      assertValidBookingTransition(booking.status, "VEHICLE_RECEIVED");
    } catch (err) {
      if (err instanceof BookingTransitionError) throw ApiError.badRequest(err.message);
      throw err;
    }

    let claimed = false;
    if (booking.vehicle_id) {
      claimed = (await vehiclesRepository.updateStatusIfCurrentlyIs(booking.vehicle_id, "AVAILABLE", "UNDER_MAINTENANCE")) !== null;
      if (!claimed) throw ApiError.conflict("The vehicle is currently in use (ride, rental or already out of service)");
    }

    try {
      const updated = await advance(booking, "VEHICLE_RECEIVED");
      void notificationsService.notify(booking.customer_id, "VEHICLE_RECEIVED", booking.id);
      return toPublicBooking(updated);
    } catch (err) {
      if (claimed && booking.vehicle_id) {
        await vehiclesRepository.updateStatusIfCurrentlyIs(booking.vehicle_id, "UNDER_MAINTENANCE", "AVAILABLE");
      }
      throw err;
    }
  },

  async startRepair(bookingId: string, ownerId: string) {
    const booking = await loadForGarageOwner(bookingId, ownerId);
    const updated = await advance(booking, "REPAIR_IN_PROGRESS");
    await repairsRepository.ensureRepairOrder(booking.id);
    return toPublicBooking(updated);
  },

  async updateRepairOrder(
    bookingId: string,
    ownerId: string,
    input: { diagnosis?: string; workPerformed?: string; partsUsed?: PartUsed[]; laborCost: number }
  ) {
    const booking = await loadForGarageOwner(bookingId, ownerId);
    if (booking.status !== "REPAIR_IN_PROGRESS") {
      throw ApiError.conflict(`Repair order can only be edited while REPAIR_IN_PROGRESS (current: ${booking.status})`);
    }
    const parts = input.partsUsed ?? [];
    const costs = computeRepairCosts(input.laborCost, parts);

    const order = await repairsRepository.updateRepairOrderIfInProgress(bookingId, {
      diagnosis: input.diagnosis, workPerformed: input.workPerformed, partsUsed: parts, ...costs,
    });
    // Lost the race with "mark ready" between our check and the write.
    if (!order) throw ApiError.conflict("Booking is no longer in progress; the repair order is frozen");
    return toPublicRepairOrder(order);
  },

  async markReady(bookingId: string, ownerId: string) {
    const booking = await loadForGarageOwner(bookingId, ownerId);
    const order = await repairsRepository.findRepairOrder(bookingId);
    if (booking.status === "REPAIR_IN_PROGRESS" && (!order || Number(order.total_cost) <= 0)) {
      throw ApiError.badRequest("Record the repair costs before marking the vehicle ready");
    }
    const updated = await advance(booking, "READY");
    // Re-read: the order cannot change after READY, so this is the final amount.
    const finalOrder = await repairsRepository.findRepairOrder(bookingId);
    void notificationsService.notify(booking.customer_id, "BOOKING_READY", booking.id, {
      totalCost: Number(finalOrder?.total_cost ?? 0), currency: CURRENCY,
    });
    return toPublicBooking(updated);
  },

  // ---- shared ---------------------------------------------------------------

  /** Customer or garage owner. Cancellation is only possible before the vehicle is received. */
  async cancel(bookingId: string, requesterId: string) {
    const booking = await repairsRepository.findById(bookingId);
    const isCustomer = booking?.customer_id === requesterId;
    const isGarage = booking?.garage_owner_id === requesterId;
    if (!booking || (!isCustomer && !isGarage)) throw ApiError.notFound("Booking not found");

    if (!CANCELLABLE_BOOKING_STATUSES.includes(booking.status)) {
      throw ApiError.badRequest(`A booking in status ${booking.status} cannot be cancelled`);
    }
    // The mechanic is freed automatically: CANCELLED is outside the one-active-job index.
    const updated = await advance(booking, "CANCELLED");
    const other = isCustomer ? booking.garage_owner_id : booking.customer_id;
    void notificationsService.notify(other, "BOOKING_CANCELLED", booking.id, { cancelledBy: isCustomer ? "CUSTOMER" : "GARAGE" });
    return toPublicBooking(updated);
  },

  /**
   * Called by the GARAGE_SERVICE payment resolver after money has moved.
   * Idempotent: the completion transaction only applies from READY, so a
   * replayed payment event does nothing the second time.
   */
  async completeAfterPayment(bookingId: string): Promise<void> {
    const booking = await repairsRepository.findById(bookingId);
    if (!booking) throw ApiError.notFound("Booking not found");
    if (booking.status === "COMPLETED") return;

    const serviceType = booking.garage_service_id ? (await garagesRepository.findService(booking.garage_service_id))?.service_type : undefined;
    const done = await repairsRepository.completeBooking(bookingId, serviceType ? NEXT_DUE_DAYS[serviceType] ?? null : null);
    if (!done) return; // another delivery completed it first

    if (booking.vehicle_id) {
      const freed = (await vehiclesRepository.updateStatusIfCurrentlyIs(booking.vehicle_id, "UNDER_MAINTENANCE", "AVAILABLE")) !== null;
      if (!freed) logger.warn({ bookingId, vehicleId: booking.vehicle_id }, "Vehicle was not UNDER_MAINTENANCE at completion - left untouched");
    }
    void notificationsService.notify(booking.garage_owner_id, "BOOKING_PAID", booking.id);
    logger.info({ bookingId }, "Booking completed after payment");
  },

  async getOne(bookingId: string, requesterId: string, isAdmin: boolean) {
    const booking = await repairsRepository.findById(bookingId);
    if (!booking || (booking.customer_id !== requesterId && booking.garage_owner_id !== requesterId && !isAdmin)) {
      throw ApiError.notFound("Booking not found");
    }
    const order = await repairsRepository.findRepairOrder(bookingId);
    return { booking: toPublicBooking(booking), repairOrder: order ? toPublicRepairOrder(order) : null };
  },

  async listMine(customerId: string) {
    return (await repairsRepository.listByCustomer(customerId)).map(toPublicBooking);
  },

  async listForGarage(garageId: string, ownerId: string, status?: BookingStatus) {
    const garage = await garagesRepository.findById(garageId);
    if (!garage || garage.owner_id !== ownerId) throw ApiError.notFound("Garage not found");
    return (await repairsRepository.listByGarage(garageId, status)).map(toPublicBooking);
  },

  async maintenanceHistory(vehicleId: string, requesterId: string, isAdmin: boolean) {
    const vehicle = await vehiclesRepository.findById(vehicleId);
    if (!vehicle || (vehicle.owner_id !== requesterId && !isAdmin)) throw ApiError.notFound("Vehicle not found");
    return (await repairsRepository.listMaintenance(vehicleId)).map(toPublicMaintenance);
  },
};
