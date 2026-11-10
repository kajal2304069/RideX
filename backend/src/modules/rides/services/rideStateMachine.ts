import { RideStatus } from "../types/rides.types";

/**
 * Encodes spec section 7's ride lifecycle exactly:
 *
 *   REQUESTED -> SEARCHING_DRIVER -> DRIVER_ASSIGNED -> DRIVER_ARRIVING
 *   -> DRIVER_ARRIVED -> TRIP_STARTED -> TRIP_COMPLETED -> PAYMENT_COMPLETED
 *
 * plus cancellation from any pre-trip-start state. The spec's explicit
 * example of an invalid transition - COMPLETED -> REQUESTED must never
 * be allowed - is exactly what this table structurally prevents: there
 * is no entry in TRIP_COMPLETED's or PAYMENT_COMPLETED's transition
 * list pointing backwards at all.
 *
 * Same pure-function pattern as vehicleStateMachine.ts (Phase 5) -
 * deliberately independent of the database so the entire transition
 * graph is unit-testable without touching Postgres.
 */
const VALID_TRANSITIONS: Record<RideStatus, RideStatus[]> = {
  REQUESTED: ["SEARCHING_DRIVER", "CANCELLED_BY_RIDER", "CANCELLED_BY_SYSTEM"],
  SEARCHING_DRIVER: ["DRIVER_ASSIGNED", "CANCELLED_BY_RIDER", "CANCELLED_BY_SYSTEM"],
  DRIVER_ASSIGNED: ["DRIVER_ARRIVING", "CANCELLED_BY_RIDER", "CANCELLED_BY_DRIVER", "CANCELLED_BY_SYSTEM"],
  DRIVER_ARRIVING: ["DRIVER_ARRIVED", "CANCELLED_BY_RIDER", "CANCELLED_BY_DRIVER", "CANCELLED_BY_SYSTEM"],
  DRIVER_ARRIVED: ["TRIP_STARTED", "CANCELLED_BY_RIDER", "CANCELLED_BY_DRIVER", "CANCELLED_BY_SYSTEM"],
  // Once the trip has actually started, only completion is reachable -
  // no more cancellation. A trip in progress isn't "cancelled," it's
  // ended early, which is a different (unmodeled-for-now) concept.
  TRIP_STARTED: ["TRIP_COMPLETED"],
  TRIP_COMPLETED: ["PAYMENT_COMPLETED"],
  PAYMENT_COMPLETED: [], // terminal
  CANCELLED_BY_RIDER: [], // terminal
  CANCELLED_BY_DRIVER: [], // terminal
  CANCELLED_BY_SYSTEM: [], // terminal
};

export function isValidRideTransition(from: RideStatus, to: RideStatus): boolean {
  if (from === to) return false;
  return VALID_TRANSITIONS[from].includes(to);
}

export class RideTransitionError extends Error {
  constructor(public readonly from: RideStatus, public readonly to: RideStatus) {
    super(`Invalid ride status transition: ${from} -> ${to}`);
  }
}

export function assertValidRideTransition(from: RideStatus, to: RideStatus): void {
  if (!isValidRideTransition(from, to)) {
    throw new RideTransitionError(from, to);
  }
}

export const TERMINAL_RIDE_STATUSES: RideStatus[] = [
  "PAYMENT_COMPLETED",
  "CANCELLED_BY_RIDER",
  "CANCELLED_BY_DRIVER",
  "CANCELLED_BY_SYSTEM",
];

export function isTerminalRideStatus(status: RideStatus): boolean {
  return TERMINAL_RIDE_STATUSES.includes(status);
}
