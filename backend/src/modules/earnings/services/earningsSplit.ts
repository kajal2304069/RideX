/**
 * Pure money-splitting rules for Phase 17. No database, no clock, no I/O, so
 * every rule is unit-testable and the one invariant that matters is provable:
 *
 *     platform + owner + driver  ==  the amount that was paid   (to the paisa)
 *
 * All math is in integer paise. Percentages are held in basis points
 * (1% = 100 bp) so 12.5% is exact. Rounding is half-up on the SMALLER share
 * and the remainder goes to the other side, which is what makes the sum exact.
 */

export const toPaise = (rupees: number | string): number => Math.round(Number(rupees) * 100);
export const fromPaise = (paise: number): number => paise / 100;
export const toBasisPoints = (percent: number | string): number => Math.round(Number(percent) * 100);

const share = (amountPaise: number, bp: number) => Math.round((amountPaise * bp) / 10_000);

export interface RideSplit {
  platform: number;
  owner: number;
  driver: number;
}

/**
 * Splits a paid ride fare.
 *   platform = platformPercent of the fare
 *   owner    = ownerSharePercent of what is LEFT after the platform's cut (0 when there is no owner to pay)
 *   driver   = the rest
 */
export function splitRideFare(farePaise: number, platformPercent: number, ownerSharePercent: number | null): RideSplit {
  if (!Number.isInteger(farePaise) || farePaise < 0) throw new RangeError("fare must be a non-negative integer number of paise");
  assertPercent(platformPercent, "platformPercent");
  if (ownerSharePercent !== null) assertPercent(ownerSharePercent, "ownerSharePercent");

  const platform = share(farePaise, toBasisPoints(platformPercent));
  const net = farePaise - platform;
  const owner = ownerSharePercent === null ? 0 : share(net, toBasisPoints(ownerSharePercent));
  return { platform, owner, driver: net - owner };
}

export interface RentalSplit {
  platform: number;
  owner: number;
}

/**
 * Splits a completed rental. The platform earns on what the renter paid for the USE of the vehicle (rent + late fee).
 * A damage deduction is compensation for harm to the owner's property, so it goes to the owner untouched.
 * The refundable part of the deposit never enters this split.
 */
export function splitRental(rentPaise: number, lateFeePaise: number, damagePaise: number, platformPercent: number): RentalSplit {
  for (const [n, v] of [["rent", rentPaise], ["lateFee", lateFeePaise], ["damage", damagePaise]] as const) {
    if (!Number.isInteger(v) || v < 0) throw new RangeError(`${n} must be a non-negative integer number of paise`);
  }
  assertPercent(platformPercent, "platformPercent");
  const chargeable = rentPaise + lateFeePaise;
  const platform = share(chargeable, toBasisPoints(platformPercent));
  return { platform, owner: chargeable - platform + damagePaise };
}

function assertPercent(p: number, name: string) {
  if (!Number.isFinite(p) || p < 0 || p > 100) throw new RangeError(`${name} must be between 0 and 100`);
}
