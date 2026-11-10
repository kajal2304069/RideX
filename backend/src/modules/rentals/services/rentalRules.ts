import { ApiError } from "../../../common/ApiError";
import { MAX_RENTAL_DAYS, MIN_RENTAL_HOURS, MS_PER_HOUR } from "./rentalPricing";

/** How far ahead a rental may be booked. */
export const MAX_ADVANCE_DAYS = 180;
/** The owner may hand the vehicle over this long before start_at (early arrival), never earlier. */
export const EARLY_HANDOVER_MS = 30 * 60 * 1000;
/** A renter who cancels a CONFIRMED booking at least this long before start_at gets everything back; later gets nothing. */
export const FREE_CANCELLATION_MS = 24 * MS_PER_HOUR;

/** Validates a requested rental window. Throws a 400 ApiError describing the first problem. */
export function assertValidWindow(start: Date, end: Date, now: Date = new Date()): void {
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw ApiError.badRequest("startAt and endAt must be valid dates");
  if (start.getTime() <= now.getTime()) throw ApiError.badRequest("startAt must be in the future");
  if (end.getTime() <= start.getTime()) throw ApiError.badRequest("endAt must be after startAt");
  const durationMs = end.getTime() - start.getTime();
  if (durationMs < MIN_RENTAL_HOURS * MS_PER_HOUR) throw ApiError.badRequest(`A rental must be at least ${MIN_RENTAL_HOURS} hour`);
  if (durationMs > MAX_RENTAL_DAYS * 24 * MS_PER_HOUR) throw ApiError.badRequest(`A rental cannot exceed ${MAX_RENTAL_DAYS} days`);
  if (start.getTime() > now.getTime() + MAX_ADVANCE_DAYS * 24 * MS_PER_HOUR) throw ApiError.badRequest(`Bookings open at most ${MAX_ADVANCE_DAYS} days ahead`);
}

/**
 * What the renter gets back when a CONFIRMED booking is cancelled (rent + deposit were both charged up front).
 * The owner cancelling is never the renter's fault: full refund. The renter cancelling late forfeits the payment.
 */
export function refundForCancellation(by: "RENTER" | "OWNER", startAt: Date, totalPaid: number, now: Date = new Date()): number {
  if (by === "OWNER") return totalPaid;
  return startAt.getTime() - now.getTime() >= FREE_CANCELLATION_MS ? totalPaid : 0;
}
