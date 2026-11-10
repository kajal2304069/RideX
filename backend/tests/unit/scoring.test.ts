import { scoreCandidate } from "../../src/modules/matching/services/scoring";

describe("scoreCandidate", () => {
  it("gives a closer driver a higher distance score than a farther one, all else equal", () => {
    const near = scoreCandidate({ distanceMeters: 200, etaSeconds: 60, ratingAvg: 4.5, searchRadiusMeters: 2000 });
    const far = scoreCandidate({ distanceMeters: 1800, etaSeconds: 60, ratingAvg: 4.5, searchRadiusMeters: 2000 });

    expect(near.distanceScore).toBeGreaterThan(far.distanceScore);
    expect(near.total).toBeGreaterThan(far.total);
  });

  it("gives a driver with a sooner ETA a higher eta score, all else equal", () => {
    const soon = scoreCandidate({ distanceMeters: 500, etaSeconds: 60, ratingAvg: 4.5, searchRadiusMeters: 2000 });
    const later = scoreCandidate({ distanceMeters: 500, etaSeconds: 600, ratingAvg: 4.5, searchRadiusMeters: 2000 });

    expect(soon.etaScore).toBeGreaterThan(later.etaScore);
    expect(soon.total).toBeGreaterThan(later.total);
  });

  it("gives a higher-rated driver a higher rating score, all else equal", () => {
    const highRated = scoreCandidate({ distanceMeters: 500, etaSeconds: 120, ratingAvg: 4.9, searchRadiusMeters: 2000 });
    const lowRated = scoreCandidate({ distanceMeters: 500, etaSeconds: 120, ratingAvg: 3.0, searchRadiusMeters: 2000 });

    expect(highRated.ratingScore).toBeGreaterThan(lowRated.ratingScore);
    expect(highRated.total).toBeGreaterThan(lowRated.total);
  });

  it("distance dominates the total score over rating (a much closer, lower-rated driver still wins)", () => {
    const closeButLowRated = scoreCandidate({
      distanceMeters: 100,
      etaSeconds: 60,
      ratingAvg: 3.0,
      searchRadiusMeters: 2000,
    });
    const farButPerfectRated = scoreCandidate({
      distanceMeters: 1900,
      etaSeconds: 600,
      ratingAvg: 5.0,
      searchRadiusMeters: 2000,
    });

    expect(closeButLowRated.total).toBeGreaterThan(farButPerfectRated.total);
  });

  it("a driver at the edge of the search radius scores distanceScore ~0, not negative", () => {
    const atEdge = scoreCandidate({ distanceMeters: 2000, etaSeconds: 60, ratingAvg: 5, searchRadiusMeters: 2000 });
    expect(atEdge.distanceScore).toBe(0);
  });

  it("a driver right at the source point scores distanceScore of 1", () => {
    const atSource = scoreCandidate({ distanceMeters: 0, etaSeconds: 0, ratingAvg: 5, searchRadiusMeters: 2000 });
    expect(atSource.distanceScore).toBe(1);
    expect(atSource.etaScore).toBe(1);
  });

  it("an ETA beyond the normalization ceiling clamps to 0, never goes negative", () => {
    const veryFar = scoreCandidate({ distanceMeters: 100, etaSeconds: 3600, ratingAvg: 5, searchRadiusMeters: 2000 });
    expect(veryFar.etaScore).toBe(0);
  });

  it("the total score is a weighted sum bounded between 0 and 1", () => {
    const result = scoreCandidate({ distanceMeters: 500, etaSeconds: 300, ratingAvg: 4.0, searchRadiusMeters: 2000 });
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeLessThanOrEqual(1);
  });

  it("a perfect candidate (zero distance, zero ETA, 5-star rating) scores the maximum total of 1.0", () => {
    const perfect = scoreCandidate({ distanceMeters: 0, etaSeconds: 0, ratingAvg: 5, searchRadiusMeters: 2000 });
    expect(perfect.total).toBe(1);
  });

  it("the worst possible candidate (at radius edge, at ETA ceiling, minimum rating) scores near the minimum", () => {
    const worst = scoreCandidate({
      distanceMeters: 2000,
      etaSeconds: 1200,
      ratingAvg: 1,
      searchRadiusMeters: 2000,
    });
    // rating floor is 1/5 = 0.2, weighted at 0.2 -> contributes 0.04 to total
    expect(worst.total).toBeCloseTo(0.04, 2);
  });
});
