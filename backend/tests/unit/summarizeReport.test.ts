jest.mock("../../src/modules/notifications/services/notifications.service", () => ({ notificationsService: { notify: jest.fn() } }));
jest.mock("../../src/modules/marketplace/repositories/listings.repository", () => ({ listingsRepository: {} }));
jest.mock("../../src/modules/marketplace/repositories/inspections.repository", () => ({ inspectionsRepository: {} }));
import { summarizeReport } from "../../src/modules/marketplace/services/inspections.service";
import { MIN_OFFER_RATIO } from "../../src/modules/marketplace/services/offers.service";

const base = {
  engine: { score: 8 }, brakes: { score: 7 }, tyres: { score: 9 }, battery: { score: 6 }, body: { score: 8 }, electrical: { score: 8 },
  documents: { verified: true }, accidentHistory: { hadAccident: false },
} as never;

describe("summarizeReport", () => {
  it("averages six scores to one decimal with no flags for a clean car", () => {
    const r = summarizeReport(base);
    expect(r.overallScore).toBe(7.7);
    expect(r.flags).toEqual([]);
  });
  it("rounds half up at one decimal", () => {
    const r = summarizeReport({ ...(base as object), engine: { score: 1 }, brakes: { score: 1 }, tyres: { score: 1 }, battery: { score: 1 }, body: { score: 1 }, electrical: { score: 2 } } as never);
    expect(r.overallScore).toBe(1.2); // 7/6 = 1.1667
  });
  it("flags a score of exactly 3 but not 4", () => {
    expect(summarizeReport({ ...(base as object), brakes: { score: 3 } } as never).flags).toEqual(["BRAKES_POOR"]);
    expect(summarizeReport({ ...(base as object), brakes: { score: 4 } } as never).flags).toEqual([]);
  });
  it("adds accident and document flags and overrides any client-supplied values", () => {
    const r = summarizeReport({ ...(base as object), accidentHistory: { hadAccident: true }, documents: { verified: false }, overallScore: 10, flags: [] } as never);
    expect(r.flags).toEqual(["ACCIDENT_HISTORY", "DOCUMENTS_NOT_VERIFIED"]);
    expect(r.overallScore).toBe(7.7);
  });
});

describe("offer rules", () => {
  it("minimum offer is half the asking price", () => expect(MIN_OFFER_RATIO).toBe(0.5));
});
