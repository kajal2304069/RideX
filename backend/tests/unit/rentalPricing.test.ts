import {
  LATE_FEE_MULTIPLIER, LATE_GRACE_MS, calculateLateFee, calculateRentalPrice, effectiveHourlyPaise, settleDeposit, toPaise,
} from "../../src/modules/rentals/services/rentalPricing";
import { isValidBookingTransition } from "../../src/modules/rentals/services/rentalStateMachine";
import { BOOKING_STATUSES } from "../../src/modules/rentals/types/rentals.types";
import { assertValidWindow, refundForCancellation } from "../../src/modules/rentals/services/rentalRules";

const T0 = new Date("2030-01-01T10:00:00.000Z");
const plusH = (h: number, from = T0) => new Date(from.getTime() + h * 3_600_000);
const both = { hourlyPrice: 100, dailyPrice: 800 };

describe("calculateRentalPrice", () => {
  it("hourly only: whole hours, rounded up", () => {
    expect(calculateRentalPrice(T0, plusH(5), { hourlyPrice: 100, dailyPrice: null }).rent).toBe(500);
    expect(calculateRentalPrice(T0, new Date(T0.getTime() + 90 * 60_000), { hourlyPrice: 100, dailyPrice: null })).toMatchObject({ billedHours: 2, rent: 200 });
    expect(calculateRentalPrice(T0, new Date(T0.getTime() + 3_600_001), { hourlyPrice: 100, dailyPrice: null }).billedHours).toBe(2);
    expect(calculateRentalPrice(T0, plusH(1), { hourlyPrice: 100, dailyPrice: null }).billedHours).toBe(1);
  });
  it("daily only: every started day is billed", () => {
    const r = { hourlyPrice: null, dailyPrice: 800 };
    expect(calculateRentalPrice(T0, plusH(1), r).rent).toBe(800);
    expect(calculateRentalPrice(T0, plusH(24), r).rent).toBe(800);
    expect(calculateRentalPrice(T0, plusH(25), r)).toMatchObject({ days: 2, rent: 1600 });
  });
  it("both: full days + remaining hours, never more than another full day", () => {
    expect(calculateRentalPrice(T0, plusH(5), both).rent).toBe(500);
    expect(calculateRentalPrice(T0, plusH(8), both).rent).toBe(800); // exactly a day's worth
    expect(calculateRentalPrice(T0, plusH(23), both).rent).toBe(800); // capped
    expect(calculateRentalPrice(T0, plusH(24), both).rent).toBe(800);
    expect(calculateRentalPrice(T0, plusH(30), both)).toMatchObject({ days: 1, remainingHours: 6, rent: 1400 });
    expect(calculateRentalPrice(T0, plusH(24 * 30), both).rent).toBe(24000);
  });
  it("is exact on awkward decimals (integer paise internally)", () => {
    expect(calculateRentalPrice(T0, plusH(3), { hourlyPrice: 33.33, dailyPrice: null }).rent).toBe(99.99);
    expect(calculateRentalPrice(T0, plusH(10), { hourlyPrice: 0.1, dailyPrice: null }).rent).toBe(1);
    expect(toPaise(0.29)).toBe(29);
    expect(toPaise("19.99")).toBe(1999);
  });
  it("rejects a listing with no price", () => {
    expect(() => calculateRentalPrice(T0, plusH(2), { hourlyPrice: null, dailyPrice: null })).toThrow();
  });
  it("effective hourly rate: hourly if set, else daily/24 rounded up to a paisa", () => {
    expect(effectiveHourlyPaise(both)).toBe(10000);
    expect(effectiveHourlyPaise({ hourlyPrice: null, dailyPrice: 800 })).toBe(3334);
  });
});

describe("late fee and deposit settlement", () => {
  const end = T0;
  it("no fee on time, early, or inside the grace period", () => {
    expect(calculateLateFee(end, plusH(-1, end), 100)).toBe(0);
    expect(calculateLateFee(end, end, 100)).toBe(0);
    expect(calculateLateFee(end, new Date(end.getTime() + LATE_GRACE_MS), 100)).toBe(0);
  });
  it("one millisecond past the grace costs a whole hour x rate x multiplier", () => {
    expect(calculateLateFee(end, new Date(end.getTime() + LATE_GRACE_MS + 1), 100)).toBe(100 * LATE_FEE_MULTIPLIER);
    expect(calculateLateFee(end, plusH(2.5, end), 100)).toBe(450);
    expect(calculateLateFee(end, plusH(3, end), 100)).toBe(450);
    expect(calculateLateFee(end, plusH(3.01, end), 100)).toBe(600);
  });
  it("deductions never exceed the deposit and the refund never goes negative", () => {
    expect(settleDeposit(2000, 0, 0)).toEqual({ deducted: 0, refundDue: 2000 });
    expect(settleDeposit(2000, 450, 500)).toEqual({ deducted: 950, refundDue: 1050 });
    expect(settleDeposit(2000, 4500, 0)).toEqual({ deducted: 2000, refundDue: 0 });
    expect(settleDeposit(0, 100, 100)).toEqual({ deducted: 0, refundDue: 0 });
    expect(settleDeposit(1000.1, 0.2, 0)).toEqual({ deducted: 0.2, refundDue: 999.9 });
  });
});

describe("booking state machine", () => {
  const allowed: Record<string, string[]> = {
    PENDING_PAYMENT: ["CONFIRMED", "CANCELLED", "EXPIRED"],
    CONFIRMED: ["ACTIVE", "CANCELLED"],
    ACTIVE: ["COMPLETED"],
    COMPLETED: [], CANCELLED: [], EXPIRED: [],
  };
  it("allows exactly the documented transitions, for every pair", () => {
    for (const from of BOOKING_STATUSES) for (const to of BOOKING_STATUSES) {
      expect(isValidBookingTransition(from, to)).toBe(allowed[from].includes(to));
    }
  });
});

describe("window and refund rules", () => {
  const now = T0;
  it("accepts a normal future window and rejects every kind of bad one", () => {
    expect(() => assertValidWindow(plusH(2), plusH(6), now)).not.toThrow();
    expect(() => assertValidWindow(plusH(-1), plusH(6), now)).toThrow(/future/);
    expect(() => assertValidWindow(now, plusH(6), now)).toThrow(/future/);
    expect(() => assertValidWindow(plusH(6), plusH(2), now)).toThrow(/after/);
    expect(() => assertValidWindow(plusH(2), plusH(2.5), now)).toThrow(/at least/);
    expect(() => assertValidWindow(plusH(2), plusH(3), now)).not.toThrow(); // exactly one hour
    expect(() => assertValidWindow(plusH(2), plusH(2 + 24 * 30), now)).not.toThrow(); // exactly 30 days
    expect(() => assertValidWindow(plusH(2), plusH(2 + 24 * 30 + 1), now)).toThrow(/30 days/);
    expect(() => assertValidWindow(plusH(24 * 181), plusH(24 * 181 + 5), now)).toThrow(/ahead/);
    expect(() => assertValidWindow(new Date("x"), plusH(5), now)).toThrow(/valid/);
  });
  it("refund policy: owner always full; renter full only with 24h+ notice", () => {
    expect(refundForCancellation("OWNER", plusH(1), 2500, now)).toBe(2500);
    expect(refundForCancellation("RENTER", plusH(48), 2500, now)).toBe(2500);
    expect(refundForCancellation("RENTER", plusH(24), 2500, now)).toBe(2500); // exactly 24h counts
    expect(refundForCancellation("RENTER", new Date(plusH(24).getTime() - 1), 2500, now)).toBe(0);
    expect(refundForCancellation("RENTER", plusH(-1), 2500, now)).toBe(0);
  });
});
