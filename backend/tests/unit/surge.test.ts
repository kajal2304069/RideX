import { DEFAULT_SURGE_TIERS, MAX_SURGE_MULTIPLIER, MIN_DEMAND_FOR_SURGE, parseTiers, surgeMultiplierFor, validateTiers } from "../../src/modules/pricing/services/surge";

describe("surge pricing rule (pure)", () => {
  it("no surge when demand is below the noise floor, even with zero drivers", () => {
    expect(surgeMultiplierFor(0, 0)).toBe(1);
    expect(surgeMultiplierFor(MIN_DEMAND_FOR_SURGE - 1, 0)).toBe(1);
  });

  it("walks up the tiers as demand per driver grows", () => {
    expect(surgeMultiplierFor(3, 3)).toBe(1); // ratio 1.0
    expect(surgeMultiplierFor(3, 2)).toBe(1.2); // ratio 1.5
    expect(surgeMultiplierFor(5, 2)).toBe(1.5); // ratio 2.5
    expect(surgeMultiplierFor(8, 2)).toBe(2); // ratio 4
  });

  it("zero drivers is treated as one (no division by zero): 3 requests, no drivers -> ratio 3 -> 1.5x", () => {
    expect(surgeMultiplierFor(3, 0)).toBe(1.5);
    expect(surgeMultiplierFor(10, 0)).toBe(2);
  });

  it("is monotonic: more demand never lowers the multiplier; more supply never raises it", () => {
    let prev = 1;
    for (let d = 0; d <= 40; d++) { const m = surgeMultiplierFor(d, 3); expect(m).toBeGreaterThanOrEqual(prev); prev = m; }
    prev = Infinity;
    for (let s = 0; s <= 40; s++) { const m = surgeMultiplierFor(12, s); expect(m).toBeLessThanOrEqual(prev); prev = m; }
  });

  it("never exceeds the hard cap and never goes below 1", () => {
    expect(surgeMultiplierFor(1_000_000, 0)).toBeLessThanOrEqual(MAX_SURGE_MULTIPLIER);
    expect(surgeMultiplierFor(5, 100)).toBe(1);
  });

  it("tier order does not matter, and custom tiers apply", () => {
    const tiers = [{ minRatio: 2, multiplier: 1.8 }, { minRatio: 1, multiplier: 1.1 }];
    expect(surgeMultiplierFor(4, 4, tiers)).toBe(1.1);
    expect(surgeMultiplierFor(8, 4, tiers)).toBe(1.8);
  });

  it("rejects tiers that could quote a price below normal or above the cap", () => {
    expect(() => validateTiers([{ minRatio: 1, multiplier: 0.5 }])).toThrow(RangeError);
    expect(() => validateTiers([{ minRatio: 1, multiplier: 9 }])).toThrow(RangeError);
    expect(() => validateTiers([{ minRatio: 0, multiplier: 1.2 }])).toThrow(RangeError);
  });

  it("rejects negative or non-finite inputs", () => {
    expect(() => surgeMultiplierFor(-1, 0)).toThrow(RangeError);
    expect(() => surgeMultiplierFor(NaN, 1)).toThrow(RangeError);
  });

  it("parseTiers reads the env format, falls back to defaults, and rejects garbage", () => {
    expect(parseTiers(undefined)).toEqual(DEFAULT_SURGE_TIERS);
    expect(parseTiers("  ")).toEqual(DEFAULT_SURGE_TIERS);
    expect(parseTiers("3:2, 1.5:1.2")).toEqual([{ minRatio: 1.5, multiplier: 1.2 }, { minRatio: 3, multiplier: 2 }]);
    expect(() => parseTiers("abc")).toThrow(RangeError);
    expect(() => parseTiers("2:7")).toThrow(RangeError);
  });
});
