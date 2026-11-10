import { describe, expect, it } from "vitest";
import { cn, humanize, inr, km, mins, newKey } from "@/lib/format";

describe("format helpers", () => {
  it("formats rupees without noisy decimals", () => {
    expect(inr(68000)).toBe("₹68,000");
    expect(inr(1234.5)).toBe("₹1,234.50");
    expect(inr(null)).toBe("–");
  });
  it("uses Indian digit grouping", () => expect(inr(1234567)).toBe("₹12,34,567"));
  it("formats distance and duration", () => {
    expect(km(450)).toBe("450 m");
    expect(km(1500)).toBe("1.5 km");
    expect(mins(30)).toBe("1 min");
    expect(mins(600)).toBe("10 min");
    expect(mins(null)).toBe("–");
  });
  it("humanizes enum values", () => expect(humanize("DRIVER_ARRIVING")).toBe("Driver arriving"));
  it("joins only truthy class names", () => expect(cn("a", false, null, "b")).toBe("a b"));
  it("generates distinct idempotency keys", () => expect(newKey()).not.toBe(newKey()));
});
