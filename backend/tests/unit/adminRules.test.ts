import { adminsRemainAfter } from "../../src/modules/admin/services/adminUsers.service";
import { assertBucketCount, resolveRange } from "../../src/modules/analytics/services/analytics.service";
import { decodeCursor, likePattern } from "../../src/modules/admin/repositories/pagination";

const admin = (id: string, active = true) => ({ id, is_active: active, roles: ["ADMIN"] });

describe("admin safety rules (pure)", () => {
  describe("adminsRemainAfter", () => {
    it("is false when the target is the only admin", () => {
      expect(adminsRemainAfter([admin("a")], "a", false)).toBe(false);
    });
    it("is true when another ACTIVE admin exists", () => {
      expect(adminsRemainAfter([admin("a"), admin("b")], "a", false)).toBe(true);
    });
    it("an INACTIVE other admin does not count", () => {
      expect(adminsRemainAfter([admin("a"), admin("b", false)], "a", false)).toBe(false);
    });
    it("is true when the target stays an active admin", () => {
      expect(adminsRemainAfter([admin("a")], "a", true)).toBe(true);
    });
  });

  describe("resolveRange", () => {
    const now = new Date("2026-06-30T12:00:00Z");
    it("defaults to the last 30 days ending now", () => {
      const r = resolveRange(undefined, undefined, now);
      expect(r.to).toEqual(now);
      expect(r.to.getTime() - r.from.getTime()).toBe(30 * 86_400_000);
    });
    it("honours explicit bounds and rejects an inverted range", () => {
      const from = new Date("2026-01-01"), to = new Date("2026-02-01");
      expect(resolveRange(from, to, now)).toEqual({ from, to });
      expect(() => resolveRange(to, from, now)).toThrow();
      expect(() => resolveRange(from, from, now)).toThrow();
    });
  });

  describe("assertBucketCount", () => {
    it("allows a year of daily buckets and refuses a year of hourly ones", () => {
      const r = { from: new Date("2026-01-01"), to: new Date("2026-12-31") };
      expect(() => assertBucketCount("day", r)).not.toThrow();
      expect(() => assertBucketCount("hour", r)).toThrow(/max 500/);
    });
  });

  describe("pagination helpers", () => {
    it("likePattern escapes wildcards so user input is matched literally", () => {
      expect(likePattern("50%_off")).toBe("%50\\%\\_off%");
      expect(likePattern("a\\b")).toBe("%a\\\\b%");
    });
    it("decodeCursor accepts its own encoding and rejects garbage", () => {
      const good = Buffer.from(JSON.stringify({ t: "2026-01-01 10:00:00+00", id: "x" })).toString("base64url");
      expect(decodeCursor(good)).toEqual({ t: "2026-01-01 10:00:00+00", id: "x" });
      expect(decodeCursor(undefined)).toBeUndefined();
      expect(() => decodeCursor("not-a-cursor")).toThrow();
      expect(() => decodeCursor(Buffer.from(JSON.stringify({ t: "nope", id: "x" })).toString("base64url"))).toThrow();
    });
  });
});
