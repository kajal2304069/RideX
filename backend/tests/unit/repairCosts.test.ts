import { computeRepairCosts, NEXT_DUE_DAYS } from "../../src/modules/repairs/services/repairCosts";
import { GARAGE_SERVICE_TYPES } from "../../src/modules/garages/types/garages.types";

describe("computeRepairCosts", () => {
  it("sums labor and parts", () => {
    const r = computeRepairCosts(500, [{ name: "Pad", quantity: 2, unitPrice: 250.5 }, { name: "Fluid", quantity: 1, unitPrice: 99.99 }]);
    expect(r).toEqual({ laborCost: 500, partsCost: 600.99, totalCost: 1100.99 });
  });

  it("avoids floating-point drift (0.1 + 0.2 style)", () => {
    const r = computeRepairCosts(0.1, [{ name: "x", quantity: 1, unitPrice: 0.2 }]);
    expect(r.totalCost).toBe(0.3);
    expect(0.1 + 0.2).not.toBe(0.3); // the bug this function exists to avoid
  });

  it("handles many small items exactly", () => {
    const r = computeRepairCosts(0, [{ name: "bolt", quantity: 1000, unitPrice: 0.07 }]);
    expect(r.partsCost).toBe(70);
  });

  it("works with no parts", () => {
    expect(computeRepairCosts(250, [])).toEqual({ laborCost: 250, partsCost: 0, totalCost: 250 });
  });
});

describe("NEXT_DUE_DAYS", () => {
  it("has an entry for every service type so a new type can't be forgotten", () => {
    for (const t of GARAGE_SERVICE_TYPES) expect(NEXT_DUE_DAYS).toHaveProperty(t);
  });
});
