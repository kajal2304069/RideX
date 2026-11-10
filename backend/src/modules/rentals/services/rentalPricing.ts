/**
 * Pure pricing for rentals. All arithmetic is in integer PAISE (1/100 of a rupee), converted at the edges, so
 * 0.1 + 0.2 style float drift can never leak into what a renter is charged.
 *
 * Billing rule: time is billed in whole hours, rounded UP (a 90-minute rental is 2 hours).
 *   - hourly price only : hours x hourly
 *   - daily price only  : ceil(hours / 24) x daily
 *   - both              : full days x daily + min(remaining hours x hourly, one more day)
 *                         (the renter never pays more for 23 hours than for a full day)
 */
export const MS_PER_HOUR = 3_600_000;
export const MIN_RENTAL_HOURS = 1;
export const MAX_RENTAL_DAYS = 30;
/** A return this much past end_at is not charged a late fee. */
export const LATE_GRACE_MS = 15 * 60 * 1000;
/** Late hours are charged at the normal hourly rate x this multiplier, to discourage keeping the vehicle. */
export const LATE_FEE_MULTIPLIER = 1.5;

export const toPaise = (rupees: number | string): number => Math.round(Number(rupees) * 100);
export const fromPaise = (paise: number): number => paise / 100;

export interface RentalRates {
  hourlyPrice: number | null;
  dailyPrice: number | null;
}

export interface RentalQuote {
  billedHours: number;
  days: number;
  remainingHours: number;
  rent: number;
  /** The per-hour rate used to price late returns, snapshotted on the booking. */
  effectiveHourlyRate: number;
}

export function billedHoursBetween(start: Date, end: Date): number {
  return Math.ceil((end.getTime() - start.getTime()) / MS_PER_HOUR);
}

/** hourly if set, otherwise the daily price spread over 24 hours (rounded up to a whole paisa). */
export function effectiveHourlyPaise(rates: RentalRates): number {
  if (rates.hourlyPrice !== null) return toPaise(rates.hourlyPrice);
  return Math.ceil(toPaise(rates.dailyPrice!) / 24);
}

export function calculateRentalPrice(start: Date, end: Date, rates: RentalRates): RentalQuote {
  if (rates.hourlyPrice === null && rates.dailyPrice === null) throw new Error("A listing needs at least one price");
  const hours = billedHoursBetween(start, end);
  if (hours < MIN_RENTAL_HOURS) throw new Error("Rental is shorter than the minimum");

  const hourly = rates.hourlyPrice === null ? null : toPaise(rates.hourlyPrice);
  const daily = rates.dailyPrice === null ? null : toPaise(rates.dailyPrice);

  let days = 0;
  let remainingHours = hours;
  let rentPaise: number;
  if (hourly !== null && daily === null) {
    rentPaise = hours * hourly;
  } else if (hourly === null && daily !== null) {
    days = Math.ceil(hours / 24);
    remainingHours = 0;
    rentPaise = days * daily;
  } else {
    days = Math.floor(hours / 24);
    remainingHours = hours % 24;
    rentPaise = days * daily! + Math.min(remainingHours * hourly!, daily!);
  }
  return { billedHours: hours, days, remainingHours, rent: fromPaise(rentPaise), effectiveHourlyRate: fromPaise(effectiveHourlyPaise(rates)) };
}

/** Late fee for a return after `end`. Zero inside the grace period; otherwise whole late hours x rate x multiplier. */
export function calculateLateFee(end: Date, returnedAt: Date, hourlyRate: number): number {
  const lateMs = returnedAt.getTime() - end.getTime();
  if (lateMs <= LATE_GRACE_MS) return 0;
  const lateHours = Math.ceil(lateMs / MS_PER_HOUR);
  return fromPaise(Math.round(lateHours * toPaise(hourlyRate) * LATE_FEE_MULTIPLIER));
}

/**
 * Splits the deposit at the end of a rental. Deductions (late fee + owner's damage claim) can never exceed the
 * deposit: the renter is never billed beyond what they put down.
 */
export function settleDeposit(deposit: number, lateFee: number, damageDeduction: number): { deducted: number; refundDue: number } {
  const dep = toPaise(deposit);
  const deducted = Math.min(dep, toPaise(lateFee) + toPaise(damageDeduction));
  return { deducted: fromPaise(deducted), refundDue: fromPaise(dep - deducted) };
}
