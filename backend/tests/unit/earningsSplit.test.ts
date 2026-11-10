import { splitRental, splitRideFare, toBasisPoints, toPaise } from "../../src/modules/earnings/services/earningsSplit";

describe("earningsSplit (pure money rules)", () => {
  describe("splitRideFare", () => {
    it("20% platform, then 80% of the remainder to the owner, the rest to the driver", () => {
      // fare 500.00 -> platform 100.00 -> net 400.00 -> owner 320.00 -> driver 80.00
      expect(splitRideFare(50_000, 20, 80)).toEqual({ platform: 10_000, owner: 32_000, driver: 8_000 });
    });

    it("with no owner to pay the driver keeps everything after the platform's cut", () => {
      expect(splitRideFare(50_000, 20, null)).toEqual({ platform: 10_000, owner: 0, driver: 40_000 });
    });

    it("0% commission and 100% owner share are legal extremes", () => {
      expect(splitRideFare(12_345, 0, 100)).toEqual({ platform: 0, owner: 12_345, driver: 0 });
      expect(splitRideFare(12_345, 100, 50)).toEqual({ platform: 12_345, owner: 0, driver: 0 });
    });

    it("zero fare splits into zeros", () => {
      expect(splitRideFare(0, 20, 80)).toEqual({ platform: 0, owner: 0, driver: 0 });
    });

    it("fractional percentages are exact (12.5% of 1.00 = 0.13, rounded half-up on the platform side)", () => {
      const s = splitRideFare(100, 12.5, 33.33);
      expect(s.platform).toBe(13);
      expect(s.platform + s.owner + s.driver).toBe(100);
    });

    it("INVARIANT: platform + owner + driver always equals the fare, for 20,000 random inputs", () => {
      let seed = 42;
      const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
      for (let i = 0; i < 20_000; i++) {
        const fare = Math.floor(rnd() * 5_000_000);
        const platformPct = Math.round(rnd() * 10_000) / 100;
        const ownerPct = rnd() < 0.2 ? null : Math.round(rnd() * 10_000) / 100;
        const s = splitRideFare(fare, platformPct, ownerPct);
        expect(s.platform + s.owner + s.driver).toBe(fare);
        expect(s.platform).toBeGreaterThanOrEqual(0);
        expect(s.owner).toBeGreaterThanOrEqual(0);
        expect(s.driver).toBeGreaterThanOrEqual(0);
      }
    });

    it("rejects negative or fractional paise and out-of-range percentages", () => {
      expect(() => splitRideFare(-1, 20, 80)).toThrow(RangeError);
      expect(() => splitRideFare(10.5, 20, 80)).toThrow(RangeError);
      expect(() => splitRideFare(100, 101, 80)).toThrow(RangeError);
      expect(() => splitRideFare(100, 20, -1)).toThrow(RangeError);
      expect(() => splitRideFare(100, NaN, 50)).toThrow(RangeError);
    });
  });

  describe("splitRental", () => {
    it("platform earns on rent + late fee; the owner gets the rest", () => {
      expect(splitRental(50_000, 0, 0, 10)).toEqual({ platform: 5_000, owner: 45_000 });
      expect(splitRental(50_000, 45_000, 0, 10)).toEqual({ platform: 9_500, owner: 85_500 });
    });

    it("damage compensation goes to the owner untouched by the commission", () => {
      expect(splitRental(50_000, 0, 50_000, 10)).toEqual({ platform: 5_000, owner: 95_000 });
    });

    it("INVARIANT: platform + owner always equals rent + late fee + damage", () => {
      let seed = 7;
      const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
      for (let i = 0; i < 10_000; i++) {
        const rent = Math.floor(rnd() * 3_000_000), late = Math.floor(rnd() * 500_000), dmg = Math.floor(rnd() * 500_000);
        const s = splitRental(rent, late, dmg, Math.round(rnd() * 10_000) / 100);
        expect(s.platform + s.owner).toBe(rent + late + dmg);
      }
    });

    it("rejects bad input", () => {
      expect(() => splitRental(-1, 0, 0, 10)).toThrow(RangeError);
      expect(() => splitRental(100, 0, 0, 120)).toThrow(RangeError);
    });
  });

  it("toPaise / toBasisPoints round decimal strings from numeric columns exactly", () => {
    expect(toPaise("123.45")).toBe(12_345);
    expect(toPaise(0.29)).toBe(29); // 0.29 * 100 = 28.999999999999996 in floating point
    expect(toBasisPoints("12.50")).toBe(1250);
  });
});
