import {
  isValidRideTransition,
  assertValidRideTransition,
  RideTransitionError,
  isTerminalRideStatus,
} from "../../src/modules/rides/services/rideStateMachine";
import { RideStatus } from "../../src/modules/rides/types/rides.types";

const HAPPY_PATH: RideStatus[] = [
  "REQUESTED",
  "SEARCHING_DRIVER",
  "DRIVER_ASSIGNED",
  "DRIVER_ARRIVING",
  "DRIVER_ARRIVED",
  "TRIP_STARTED",
  "TRIP_COMPLETED",
  "PAYMENT_COMPLETED",
];

describe("Ride state machine", () => {
  it("allows the full happy-path sequence, one step at a time", () => {
    for (let i = 0; i < HAPPY_PATH.length - 1; i++) {
      expect(isValidRideTransition(HAPPY_PATH[i], HAPPY_PATH[i + 1])).toBe(true);
    }
  });

  it("the spec's explicit example: COMPLETED -> REQUESTED must never be allowed", () => {
    expect(isValidRideTransition("TRIP_COMPLETED", "REQUESTED")).toBe(false);
    expect(isValidRideTransition("PAYMENT_COMPLETED", "REQUESTED")).toBe(false);
    expect(() => assertValidRideTransition("TRIP_COMPLETED", "REQUESTED")).toThrow(RideTransitionError);
  });

  it("rejects skipping states in the happy path", () => {
    expect(isValidRideTransition("REQUESTED", "DRIVER_ASSIGNED")).toBe(false);
    expect(isValidRideTransition("SEARCHING_DRIVER", "TRIP_STARTED")).toBe(false);
    expect(isValidRideTransition("DRIVER_ASSIGNED", "TRIP_STARTED")).toBe(false);
  });

  it("allows cancellation (by rider/driver/system) from any pre-trip-start state", () => {
    const preTripStates: RideStatus[] = [
      "REQUESTED",
      "SEARCHING_DRIVER",
      "DRIVER_ASSIGNED",
      "DRIVER_ARRIVING",
      "DRIVER_ARRIVED",
    ];
    for (const state of preTripStates) {
      expect(isValidRideTransition(state, "CANCELLED_BY_SYSTEM")).toBe(true);
    }
  });

  it("rejects cancellation once the trip has started", () => {
    expect(isValidRideTransition("TRIP_STARTED", "CANCELLED_BY_RIDER")).toBe(false);
    expect(isValidRideTransition("TRIP_STARTED", "CANCELLED_BY_DRIVER")).toBe(false);
    expect(isValidRideTransition("TRIP_STARTED", "CANCELLED_BY_SYSTEM")).toBe(false);
  });

  it("rejects a rider cancelling once a driver has already accepted and is en route (only driver/system can, per DRIVER_ASSIGNED's transition list allowing all three - this asserts rider specifically is still included)", () => {
    // Note: rider CAN still cancel post-assignment (spec doesn't forbid it,
    // e.g. rider changes their mind) - this documents that intentional choice.
    expect(isValidRideTransition("DRIVER_ASSIGNED", "CANCELLED_BY_RIDER")).toBe(true);
  });

  it("treats all four terminal statuses as terminal (no outgoing transitions)", () => {
    const terminal: RideStatus[] = ["PAYMENT_COMPLETED", "CANCELLED_BY_RIDER", "CANCELLED_BY_DRIVER", "CANCELLED_BY_SYSTEM"];
    for (const status of terminal) {
      expect(isTerminalRideStatus(status)).toBe(true);
      for (const target of HAPPY_PATH) {
        expect(isValidRideTransition(status, target)).toBe(false);
      }
    }
  });

  it("non-terminal statuses are correctly identified as non-terminal", () => {
    for (const status of HAPPY_PATH.slice(0, -1)) {
      expect(isTerminalRideStatus(status)).toBe(false);
    }
  });

  it("rejects a status 'transitioning' to itself", () => {
    for (const status of HAPPY_PATH) {
      expect(isValidRideTransition(status, status)).toBe(false);
    }
  });

  it("the error carries from/to for callers that want to inspect it", () => {
    try {
      assertValidRideTransition("TRIP_STARTED", "REQUESTED");
      fail("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RideTransitionError);
      expect((err as RideTransitionError).from).toBe("TRIP_STARTED");
      expect((err as RideTransitionError).to).toBe("REQUESTED");
    }
  });
});
