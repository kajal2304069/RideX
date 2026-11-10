import { RentalBookingStatus } from "../types/rentals.types";

/**
 *   PENDING_PAYMENT --pay--> CONFIRMED --handover--> ACTIVE --return--> COMPLETED
 *         |  |                  |
 *         |  +--deadline--> EXPIRED
 *         +--cancel--> CANCELLED <--cancel--+
 *
 * COMPLETED, CANCELLED and EXPIRED are terminal. An ACTIVE rental cannot be cancelled: the vehicle is out, so the only
 * way to end it is the return (which settles late fees and the deposit).
 * Pure function, no IO, so it is exhaustively unit-tested.
 */
const TRANSITIONS: Record<RentalBookingStatus, RentalBookingStatus[]> = {
  PENDING_PAYMENT: ["CONFIRMED", "CANCELLED", "EXPIRED"],
  CONFIRMED: ["ACTIVE", "CANCELLED"],
  ACTIVE: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export const isValidBookingTransition = (from: RentalBookingStatus, to: RentalBookingStatus) => TRANSITIONS[from].includes(to);

/** Statuses in which a booking occupies the vehicle (mirrors the exclusion constraint's WHERE clause). */
export const HOLDING_STATUSES: RentalBookingStatus[] = ["PENDING_PAYMENT", "CONFIRMED", "ACTIVE"];
