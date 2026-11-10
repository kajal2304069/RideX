import { documentStage, serviceStage } from "../../src/modules/maintenance/services/reminderRules";
import { isChatOpen, CHAT_GRACE_MS } from "../../src/modules/chat/services/chatRules";
import { canTransition } from "../../src/modules/support/services/ticketStateMachine";

const NOW = new Date("2026-06-15T10:00:00Z");
const plus = (ms: number) => new Date(NOW.getTime() + ms);
const H = 3_600_000, D = 24 * H;

describe("service reminder stages", () => {
  it("far in the future: nothing", () => expect(serviceStage(plus(8 * D), NOW)).toBeNull());
  it("within 7 days: DUE_7D", () => { expect(serviceStage(plus(7 * D), NOW)).toBe("DUE_7D"); expect(serviceStage(plus(2 * D), NOW)).toBe("DUE_7D"); });
  it("within a day: DUE_1D", () => { expect(serviceStage(plus(D), NOW)).toBe("DUE_1D"); expect(serviceStage(plus(H), NOW)).toBe("DUE_1D"); });
  it("in the past: OVERDUE", () => expect(serviceStage(plus(-1), NOW)).toBe("OVERDUE"));
});

describe("document reminder stages (calendar days, UTC)", () => {
  const stage = (d: string) => documentStage(d, NOW);
  it("more than 30 days away: nothing", () => expect(stage("2026-07-16")).toBeNull());
  it("30 / 8 days away: EXPIRES_30D", () => { expect(stage("2026-07-15")).toBe("EXPIRES_30D"); expect(stage("2026-06-23")).toBe("EXPIRES_30D"); });
  it("7 days away: EXPIRES_7D", () => { expect(stage("2026-06-22")).toBe("EXPIRES_7D"); expect(stage("2026-06-17")).toBe("EXPIRES_7D"); });
  it("today or tomorrow: EXPIRES_1D (a document expiring today is still valid today)", () => { expect(stage("2026-06-15")).toBe("EXPIRES_1D"); expect(stage("2026-06-16")).toBe("EXPIRES_1D"); });
  it("yesterday: EXPIRED, and we stop reminding after 30 days", () => { expect(stage("2026-06-14")).toBe("EXPIRED"); expect(stage("2026-05-16")).toBe("EXPIRED"); expect(stage("2026-05-15")).toBeNull(); });
  it("accepts a Date and a timestamp-ish string", () => { expect(documentStage(new Date("2026-06-20T00:00:00Z"), NOW)).toBe("EXPIRES_7D"); expect(stage("2026-06-20T00:00:00.000Z")).toBe("EXPIRES_7D"); });
});

describe("chat window", () => {
  it("closed until a driver is assigned", () => expect(isChatOpen({ driver_id: null, ended_at: null })).toBe(false));
  it("open while the ride is active", () => expect(isChatOpen({ driver_id: "d", ended_at: null })).toBe(true));
  it("open for 24h after the ride ends, then closed", () => {
    const now = new Date();
    expect(isChatOpen({ driver_id: "d", ended_at: new Date(now.getTime() - CHAT_GRACE_MS + 1000) }, now)).toBe(true);
    expect(isChatOpen({ driver_id: "d", ended_at: new Date(now.getTime() - CHAT_GRACE_MS - 1000) }, now)).toBe(false);
  });
});

describe("support ticket state machine", () => {
  it("allows the normal path and reopening a resolved ticket", () => {
    expect(canTransition("OPEN", "IN_PROGRESS")).toBe(true);
    expect(canTransition("IN_PROGRESS", "RESOLVED")).toBe(true);
    expect(canTransition("RESOLVED", "OPEN")).toBe(true);
    expect(canTransition("RESOLVED", "CLOSED")).toBe(true);
  });
  it("CLOSED is final and nothing skips backwards illegally", () => {
    for (const to of ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"] as const) expect(canTransition("CLOSED", to)).toBe(false);
    expect(canTransition("RESOLVED", "IN_PROGRESS")).toBe(false);
  });
});
