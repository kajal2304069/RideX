import { VehicleStatus } from "../types/vehicles.types";

/**
 * AVAILABLE is the hub state: every other state can only be entered from
 * AVAILABLE, and can only return TO AVAILABLE (except UNDER_MAINTENANCE,
 * which can also go straight to UNAVAILABLE - e.g. a vehicle failing
 * inspection gets pulled from service entirely rather than being put
 * back in the pool). This directly encodes spec section 25's invariants:
 * a vehicle can't jump RENTED -> IN_RIDE_SERVICE (skipping a return/
 * inspection step), and can't be in two "busy" states at once because
 * every busy state necessarily exits back through AVAILABLE first.
 *
 * Deliberately a pure function with no DB/IO - the same pattern
 * `RideStateMachine` (Phase 6) will follow, and exactly why it's easy
 * to unit test exhaustively (see vehicleStateMachine.test.ts).
 */
const VALID_TRANSITIONS: Record<VehicleStatus, VehicleStatus[]> = {
  AVAILABLE: ["RENTED", "IN_RIDE_SERVICE", "UNDER_MAINTENANCE", "UNAVAILABLE"],
  RENTED: ["AVAILABLE"],
  IN_RIDE_SERVICE: ["AVAILABLE"],
  UNDER_MAINTENANCE: ["AVAILABLE", "UNAVAILABLE"],
  UNAVAILABLE: ["AVAILABLE"],
};

export function isValidVehicleTransition(from: VehicleStatus, to: VehicleStatus): boolean {
  if (from === to) return false; // no-op "transitions" are rejected explicitly, not silently allowed
  return VALID_TRANSITIONS[from].includes(to);
}

export function assertValidVehicleTransition(from: VehicleStatus, to: VehicleStatus): void {
  if (!isValidVehicleTransition(from, to)) {
    throw new VehicleTransitionError(from, to);
  }
}

export class VehicleTransitionError extends Error {
  constructor(public readonly from: VehicleStatus, public readonly to: VehicleStatus) {
    super(`Invalid vehicle status transition: ${from} -> ${to}`);
  }
}
