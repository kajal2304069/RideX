/**
 * The ranking algorithm spec section 9 explicitly demands ("do not
 * simply select the first driver returned... create a scoring/ranking
 * algorithm"). Kept as a pure function - (numbers in, a score out) -
 * deliberately separate from `matching.service.ts`'s Redis/Postgres
 * orchestration, so the actual ranking logic is testable with made-up
 * numbers instead of needing a live driver broadcasting a real location.
 *
 * Spec section 9 lists five ranking criteria: distance, ETA, vehicle
 * compatibility, driver availability, driver rating. This implementation
 * treats vehicle compatibility and availability as binary GATES (a
 * candidate either qualifies or is excluded entirely - see
 * matching.service.ts, which only ever passes gate-qualified drivers
 * into this function) rather than continuous score components: a
 * driver either has the right vehicle type and is actually free to
 * take the ride, or they're not a candidate at all. Distance, ETA, and
 * rating are the three dimensions that genuinely vary in DEGREE among
 * already-qualified candidates, which is what a weighted score is for.
 *
 * Weights: distance is weighted highest (0.5) because it's the
 * spec's first-listed criterion and the dominant real-world factor in
 * "how good is this match" (a much lower-rated driver 200m away beats
 * a perfect-rated driver 4km away for pickup promptness); ETA next
 * (0.3, correlated with but not identical to distance - accounts for
 * the duration estimate, not just raw meters); rating last (0.2) as a
 * meaningful but secondary tie-breaker among otherwise-similar options.
 */
const WEIGHTS = {
  distance: 0.5,
  eta: 0.3,
  rating: 0.2,
};

export interface ScoreInput {
  distanceMeters: number;
  etaSeconds: number;
  ratingAvg: number; // 1.0 - 5.0
  searchRadiusMeters: number; // the radius this candidate was found within - used to normalize distanceScore
}

export interface ScoreBreakdown {
  distanceScore: number;
  etaScore: number;
  ratingScore: number;
  total: number;
}

/** A generous ETA ceiling for normalization - trips estimated beyond this get the minimum ETA score rather than a further-shrinking one, so one extreme outlier doesn't distort everyone else's relative ranking. */
const ETA_NORMALIZATION_CEILING_SECONDS = 20 * 60; // 20 minutes

export function scoreCandidate(input: ScoreInput): ScoreBreakdown {
  // Closer to 1.0 the nearer the driver is; 0 at the edge of the search radius.
  const distanceScore = clamp01(1 - input.distanceMeters / input.searchRadiusMeters);

  // Closer to 1.0 the sooner the driver would arrive; 0 at/beyond the ceiling.
  const etaScore = clamp01(1 - input.etaSeconds / ETA_NORMALIZATION_CEILING_SECONDS);

  // Ratings run 1.0-5.0; normalize to 0-1. (A brand-new driver defaults
  // to 5.0 per Phase 4's schema default, so this never unfairly
  // penalizes drivers with no ride history yet.)
  const ratingScore = clamp01(input.ratingAvg / 5);

  const total =
    distanceScore * WEIGHTS.distance + etaScore * WEIGHTS.eta + ratingScore * WEIGHTS.rating;

  return {
    distanceScore: round4(distanceScore),
    etaScore: round4(etaScore),
    ratingScore: round4(ratingScore),
    total: round4(total),
  };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
