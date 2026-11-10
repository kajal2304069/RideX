import { BookingStatus } from "../types/repairs.types";

/**
 * Spec section 18's lifecycle:
 *
 *   REQUESTED -> ACCEPTED -> MECHANIC_ASSIGNED -> VEHICLE_RECEIVED
 *             -> REPAIR_IN_PROGRESS -> READY -> COMPLETED
 *
 * Cancellation is allowed only until the garage physically has the vehicle.
 * Once VEHICLE_RECEIVED, the only way out is forward: a half-repaired car
 * can't be "cancelled", it has to be finished (or handled as a dispute by
 * an admin, which is deliberately not modelled here).
 *
 * COMPLETED is reached only by a successful payment (Phase 12), never by a
 * garage owner's say-so, so a garage can't mark a job done without being paid
 * and a customer can't walk away from a finished job.
 *
 * Pure function, like the vehicle and ride machines: no IO, trivially testable.
 */
const VALID_TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  REQUESTED: ["ACCEPTED", "CANCELLED"],
  ACCEPTED: ["MECHANIC_ASSIGNED", "CANCELLED"],
  MECHANIC_ASSIGNED: ["VEHICLE_RECEIVED", "CANCELLED"],
  VEHICLE_RECEIVED: ["REPAIR_IN_PROGRESS"],
  REPAIR_IN_PROGRESS: ["READY"],
  READY: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
};

export function isValidBookingTransition(from: BookingStatus, to: BookingStatus): boolean {
  if (from === to) return false;
  return VALID_TRANSITIONS[from].includes(to);
}

export class BookingTransitionError extends Error {
  constructor(public readonly from: BookingStatus, public readonly to: BookingStatus) {
    super(`Invalid booking status transition: ${from} -> ${to}`);
  }
}

export function assertValidBookingTransition(from: BookingStatus, to: BookingStatus): void {
  if (!isValidBookingTransition(from, to)) throw new BookingTransitionError(from, to);
}

export const CANCELLABLE_BOOKING_STATUSES: BookingStatus[] = ["REQUESTED", "ACCEPTED", "MECHANIC_ASSIGNED"];
