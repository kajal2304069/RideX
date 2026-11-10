import { ApiError } from "../../../common/ApiError";
import { logger } from "../../../config/logger";
import { driversRepository } from "../../drivers/repositories/drivers.repository";
import { vehiclesRepository } from "../repositories/vehicles.repository";
import { PublicVehicle, toPublicVehicle, VehicleStatus } from "../types/vehicles.types";
import { assertValidVehicleTransition, VehicleTransitionError } from "./vehicleStateMachine";

/** Raised by `pg` for a Postgres unique_violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): err is { code: "23505"; constraint?: string } {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

function assertOwnership(vehicleOwnerId: string, requesterId: string) {
  if (vehicleOwnerId !== requesterId) {
    // 404, not 403: don't reveal that a vehicle with this ID exists and
    // belongs to someone else - same "don't leak information" principle
    // as the account-enumeration protection in Phase 2's login.
    throw ApiError.notFound("Vehicle not found");
  }
}

export const vehiclesService = {
  /** Exact-email lookup (never a search, so it cannot be used to list drivers). Only verified, currently unassigned drivers match. */
  lookupDriver: (email: string) => vehiclesRepository.findAssignableDriverByEmail(email),

  async listTypes() {
    const rows = await vehiclesRepository.listTypes();
    return rows.map((t) => ({
      id: t.id, code: t.code, name: t.display_name, category: t.category,
      baseFare: Number(t.base_fare), perKmRate: Number(t.per_km_rate), perMinRate: Number(t.per_min_rate),
    }));
  },

  async create(
    ownerId: string,
    input: {
      vehicleTypeId: string;
      registrationNumber: string;
      brand: string;
      model: string;
      year: number;
      color?: string;
      fuelType: string;
      transmission: string;
      mileageKm: number;
    }
  ): Promise<PublicVehicle> {
    const existing = await vehiclesRepository.findByRegistrationNumber(input.registrationNumber);
    if (existing) {
      throw ApiError.conflict("A vehicle with this registration number is already registered");
    }

    const vehicle = await vehiclesRepository.create({ ownerId, ...input });
    logger.info({ vehicleId: vehicle.id, ownerId }, "Vehicle registered");
    return toPublicVehicle(vehicle);
  },

  async listMine(ownerId: string): Promise<PublicVehicle[]> {
    const vehicles = await vehiclesRepository.findByOwner(ownerId);
    return vehicles.map(toPublicVehicle);
  },

  async getOwned(vehicleId: string, requesterId: string): Promise<PublicVehicle> {
    const vehicle = await vehiclesRepository.findById(vehicleId);
    if (!vehicle) throw ApiError.notFound("Vehicle not found");
    assertOwnership(vehicle.owner_id, requesterId);
    return toPublicVehicle(vehicle);
  },

  async update(
    vehicleId: string,
    requesterId: string,
    fields: { color?: string; mileageKm?: number }
  ): Promise<PublicVehicle> {
    const vehicle = await vehiclesRepository.findById(vehicleId);
    if (!vehicle) throw ApiError.notFound("Vehicle not found");
    assertOwnership(vehicle.owner_id, requesterId);

    const updated = await vehiclesRepository.updateFields(vehicleId, fields);
    return toPublicVehicle(updated!);
  },

  /**
   * Enforces the state machine (vehicleStateMachine.ts) AND uses an
   * optimistic-concurrency write (updateStatusIfCurrentlyIs) so two
   * concurrent status-change requests against the same vehicle can't
   * both silently "succeed" against a stale read - the second request's
   * WHERE clause simply won't match, and gets a 409 instead of quietly
   * clobbering the first request's change.
   */
  async updateStatus(vehicleId: string, requesterId: string, next: VehicleStatus): Promise<PublicVehicle> {
    const vehicle = await vehiclesRepository.findById(vehicleId);
    if (!vehicle) throw ApiError.notFound("Vehicle not found");
    assertOwnership(vehicle.owner_id, requesterId);

    try {
      assertValidVehicleTransition(vehicle.status, next);
    } catch (err) {
      if (err instanceof VehicleTransitionError) {
        throw ApiError.badRequest(err.message);
      }
      throw err;
    }

    const updated = await vehiclesRepository.updateStatusIfCurrentlyIs(vehicleId, vehicle.status, next);
    if (!updated) {
      // Someone else changed the status between our read and our write.
      throw ApiError.conflict(
        `Vehicle status changed concurrently - expected ${vehicle.status}, please refresh and retry`
      );
    }
    logger.info({ vehicleId, from: vehicle.status, to: next }, "Vehicle status changed");
    return toPublicVehicle(updated);
  },

  /**
   * Owner assigns a verified driver to operate their vehicle (spec
   * section 24). Three checks before the DB is even touched:
   *   1. requester owns the vehicle
   *   2. vehicle is AVAILABLE (not already mid-ride, rented, or in the shop)
   *   3. driver exists and is VERIFIED (an unverified driver can't be
   *      handed a vehicle any more than they can go online - Phase 4's
   *      same principle, applied here)
   * plus one more that's about the DRIVER side, not the vehicle side:
   * a driver can only actively operate one vehicle at a time.
   */
  async assignDriver(
    vehicleId: string,
    requesterId: string,
    input: { driverId: string; commissionPercent: number; ownerSharePercent: number }
  ) {
    const vehicle = await vehiclesRepository.findById(vehicleId);
    if (!vehicle) throw ApiError.notFound("Vehicle not found");
    assertOwnership(vehicle.owner_id, requesterId);

    if (vehicle.status !== "AVAILABLE") {
      throw ApiError.conflict(`Cannot assign a driver while vehicle status is ${vehicle.status}`);
    }

    const driver = await driversRepository.findByUserId(input.driverId);
    if (!driver) throw ApiError.notFound("Driver not found");
    if (driver.verification_status !== "VERIFIED") {
      throw ApiError.forbidden(`Cannot assign an unverified driver (status: ${driver.verification_status})`);
    }

    const existingVehicleAssignment = await vehiclesRepository.findActiveAssignmentByVehicle(vehicleId);
    if (existingVehicleAssignment) {
      throw ApiError.conflict("This vehicle already has an active driver assignment");
    }
    const existingDriverAssignment = await vehiclesRepository.findActiveAssignmentByDriver(input.driverId);
    if (existingDriverAssignment) {
      throw ApiError.conflict("This driver is already assigned to another vehicle");
    }

    const assignment = await createAssignmentOrConflict({
      vehicleId,
      driverId: input.driverId,
      ownerId: requesterId,
      commissionPercent: input.commissionPercent,
      ownerSharePercent: input.ownerSharePercent,
    });
    logger.info({ vehicleId, driverId: input.driverId }, "Driver assigned to vehicle");
    return assignment;
  },

  async unassignDriver(vehicleId: string, requesterId: string) {
    const vehicle = await vehiclesRepository.findById(vehicleId);
    if (!vehicle) throw ApiError.notFound("Vehicle not found");
    assertOwnership(vehicle.owner_id, requesterId);

    const assignment = await vehiclesRepository.findActiveAssignmentByVehicle(vehicleId);
    if (!assignment) throw ApiError.notFound("No active driver assignment for this vehicle");

    await vehiclesRepository.endAssignment(assignment.id, vehicleId, assignment.driver_id);
    logger.info({ vehicleId, driverId: assignment.driver_id }, "Driver unassigned from vehicle");
  },
};

/**
 * Thin wrapper around the repository's transactional insert. The
 * `findActiveAssignmentByVehicle`/`findActiveAssignmentByDriver` checks
 * above this call are a fast-path (avoid a doomed insert in the common
 * case), NOT the actual guarantee - two requests can both pass those
 * checks before either commits (classic TOCTOU). The DB's partial
 * unique index is what's actually unbypassable, so the correct API
 * response for that race is still a clean 409, not whatever the raw
 * driver error happens to look like. Caught live by
 * tests/concurrency/vehicleAssignment.test.ts, which originally
 * surfaced this exact case as an unhandled 500 before this fix.
 */
async function createAssignmentOrConflict(input: {
  vehicleId: string;
  driverId: string;
  ownerId: string;
  commissionPercent: number;
  ownerSharePercent: number;
}) {
  try {
    return await vehiclesRepository.createAssignment(input);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw ApiError.conflict("This vehicle already has an active driver assignment");
    }
    throw err;
  }
}
