/**
 * Pure surge rule (spec section 15): demand / available drivers -> multiplier.
 *
 *   demand = open ride requests near the pickup (including the one being priced)
 *   supply = online drivers of that vehicle type near the pickup
 *   ratio  = demand / max(supply, 1)
 *
 * The multiplier is the highest tier whose threshold the ratio reaches. Tiers are DATA, not code, so pricing can be tuned
 * with an env var and no deploy. Two guards keep surge from being noisy or abusive:
 *   - MIN_DEMAND: a couple of requests in a quiet area is not a shortage, so no surge below it
 *   - a hard cap, so a bug or a burst can never quote an absurd price
 */
export interface SurgeTier {
  /** Surge applies once demand-per-driver reaches this. */
  minRatio: number;
  multiplier: number;
}

export const DEFAULT_SURGE_TIERS: SurgeTier[] = [
  { minRatio: 1.5, multiplier: 1.2 },
  { minRatio: 2.5, multiplier: 1.5 },
  { minRatio: 4, multiplier: 2.0 },
];

export const MIN_DEMAND_FOR_SURGE = 3;
export const MAX_SURGE_MULTIPLIER = 3.0;

export function validateTiers(tiers: SurgeTier[]): SurgeTier[] {
  for (const t of tiers) {
    if (!(t.minRatio > 0) || !(t.multiplier >= 1) || t.multiplier > MAX_SURGE_MULTIPLIER) {
      throw new RangeError(`Invalid surge tier ${JSON.stringify(t)}: minRatio must be > 0 and multiplier within [1, ${MAX_SURGE_MULTIPLIER}]`);
    }
  }
  return [...tiers].sort((a, b) => a.minRatio - b.minRatio);
}

export function surgeMultiplierFor(demand: number, supply: number, tiers: SurgeTier[] = DEFAULT_SURGE_TIERS): number {
  if (!Number.isFinite(demand) || !Number.isFinite(supply) || demand < 0 || supply < 0) throw new RangeError("demand and supply must be non-negative numbers");
  if (demand < MIN_DEMAND_FOR_SURGE) return 1.0;
  const ratio = demand / Math.max(supply, 1);
  let m = 1.0;
  for (const t of validateTiers(tiers)) if (ratio >= t.minRatio) m = Math.max(m, t.multiplier);
  return Math.min(m, MAX_SURGE_MULTIPLIER);
}

/** Parses SURGE_TIERS ("1.5:1.2,2.5:1.5,4:2"). Empty/undefined means the defaults. */
export function parseTiers(raw: string | undefined): SurgeTier[] {
  if (!raw || !raw.trim()) return DEFAULT_SURGE_TIERS;
  return validateTiers(
    raw.split(",").map((pair) => {
      const [r, m] = pair.split(":").map((x) => Number(x.trim()));
      if (!Number.isFinite(r) || !Number.isFinite(m)) throw new RangeError(`Bad SURGE_TIERS entry "${pair}"`);
      return { minRatio: r, multiplier: m };
    })
  );
}
