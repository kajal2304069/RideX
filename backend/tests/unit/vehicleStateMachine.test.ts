import { isValidVehicleTransition, assertValidVehicleTransition, VehicleTransitionError } from "../../src/modules/vehicles/services/vehicleStateMachine";
import { VehicleStatus } from "../../src/modules/vehicles/types/vehicles.types";

const ALL_STATUSES: VehicleStatus[] = ["AVAILABLE", "RENTED", "IN_RIDE_SERVICE", "UNDER_MAINTENANCE", "UNAVAILABLE"];

describe("Vehicle status state machine", () => {
  describe("allowed transitions", () => {
    const allowed: [VehicleStatus, VehicleStatus][] = [
      ["AVAILABLE", "RENTED"],
      ["AVAILABLE", "IN_RIDE_SERVICE"],
      ["AVAILABLE", "UNDER_MAINTENANCE"],
      ["AVAILABLE", "UNAVAILABLE"],
      ["RENTED", "AVAILABLE"],
      ["IN_RIDE_SERVICE", "AVAILABLE"],
      ["UNDER_MAINTENANCE", "AVAILABLE"],
      ["UNDER_MAINTENANCE", "UNAVAILABLE"],
      ["UNAVAILABLE", "AVAILABLE"],
    ];

    it.each(allowed)("allows %s -> %s", (from, to) => {
      expect(isValidVehicleTransition(from, to)).toBe(true);
      expect(() => assertValidVehicleTransition(from, to)).not.toThrow();
    });
  });

  describe("forbidden transitions (the whole point of the state machine)", () => {
    const forbidden: [VehicleStatus, VehicleStatus][] = [
      ["RENTED", "IN_RIDE_SERVICE"], // can't jump between busy states without going through AVAILABLE
      ["IN_RIDE_SERVICE", "RENTED"],
      ["RENTED", "UNDER_MAINTENANCE"],
      ["IN_RIDE_SERVICE", "UNDER_MAINTENANCE"],
      ["UNAVAILABLE", "RENTED"],
      ["UNAVAILABLE", "IN_RIDE_SERVICE"],
      ["UNAVAILABLE", "UNDER_MAINTENANCE"],
    ];

    it.each(forbidden)("rejects %s -> %s", (from, to) => {
      expect(isValidVehicleTransition(from, to)).toBe(false);
      expect(() => assertValidVehicleTransition(from, to)).toThrow(VehicleTransitionError);
    });
  });

  it("rejects a status 'transitioning' to itself (no silent no-ops)", () => {
    for (const status of ALL_STATUSES) {
      expect(isValidVehicleTransition(status, status)).toBe(false);
    }
  });

  it("every status has at least one valid outgoing transition (no dead ends)", () => {
    for (const from of ALL_STATUSES) {
      const hasAnyValidTarget = ALL_STATUSES.some((to) => isValidVehicleTransition(from, to));
      expect(hasAnyValidTarget).toBe(true);
    }
  });

  it("the error carries the from/to states for callers that want to inspect it", () => {
    try {
      assertValidVehicleTransition("RENTED", "IN_RIDE_SERVICE");
      fail("expected assertValidVehicleTransition to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(VehicleTransitionError);
      expect((err as VehicleTransitionError).from).toBe("RENTED");
      expect((err as VehicleTransitionError).to).toBe("IN_RIDE_SERVICE");
    }
  });
});
