import { assertValidBookingTransition, BookingTransitionError, CANCELLABLE_BOOKING_STATUSES, isValidBookingTransition } from "../../src/modules/repairs/services/bookingStateMachine";
import { BookingStatus } from "../../src/modules/repairs/types/repairs.types";

const ALL: BookingStatus[] = ["REQUESTED", "ACCEPTED", "MECHANIC_ASSIGNED", "VEHICLE_RECEIVED", "REPAIR_IN_PROGRESS", "READY", "COMPLETED", "CANCELLED"];
const HAPPY_PATH: BookingStatus[] = ["REQUESTED", "ACCEPTED", "MECHANIC_ASSIGNED", "VEHICLE_RECEIVED", "REPAIR_IN_PROGRESS", "READY", "COMPLETED"];

describe("booking state machine", () => {
  it("allows every step of the happy path in order", () => {
    for (let i = 0; i < HAPPY_PATH.length - 1; i++) {
      expect(isValidBookingTransition(HAPPY_PATH[i], HAPPY_PATH[i + 1])).toBe(true);
    }
  });

  it("allows cancellation exactly until the vehicle is received", () => {
    for (const s of ALL) {
      expect(isValidBookingTransition(s, "CANCELLED")).toBe(CANCELLABLE_BOOKING_STATUSES.includes(s));
    }
    expect(CANCELLABLE_BOOKING_STATUSES).toEqual(["REQUESTED", "ACCEPTED", "MECHANIC_ASSIGNED"]);
  });

  it("has no way out of COMPLETED or CANCELLED", () => {
    for (const to of ALL) {
      expect(isValidBookingTransition("COMPLETED", to)).toBe(false);
      expect(isValidBookingTransition("CANCELLED", to)).toBe(false);
    }
  });

  it("rejects skipping states and going backwards", () => {
    expect(isValidBookingTransition("REQUESTED", "MECHANIC_ASSIGNED")).toBe(false);
    expect(isValidBookingTransition("ACCEPTED", "REPAIR_IN_PROGRESS")).toBe(false);
    expect(isValidBookingTransition("READY", "REPAIR_IN_PROGRESS")).toBe(false);
    expect(isValidBookingTransition("VEHICLE_RECEIVED", "ACCEPTED")).toBe(false);
  });

  it("rejects no-op transitions", () => {
    for (const s of ALL) expect(isValidBookingTransition(s, s)).toBe(false);
  });

  it("exactly 8 valid transitions plus 3 cancellations exist (guards against accidental additions)", () => {
    let count = 0;
    for (const a of ALL) for (const b of ALL) if (isValidBookingTransition(a, b)) count++;
    expect(count).toBe(6 + 3);
  });

  it("assert throws a typed error carrying from/to", () => {
    expect(() => assertValidBookingTransition("READY", "ACCEPTED")).toThrow(BookingTransitionError);
    try {
      assertValidBookingTransition("READY", "ACCEPTED");
    } catch (e) {
      expect(e).toMatchObject({ from: "READY", to: "ACCEPTED" });
    }
  });
});
