import { ApiError } from "../../../common/ApiError";
import { env } from "../../../config/env";
import { logger } from "../../../config/logger";
import { ridesRepository } from "../../rides/repositories/rides.repository";
import { rentalBookingsRepository } from "../../rentals/repositories/rentalBookings.repository";
import { earningsRepository } from "../repositories/earnings.repository";
import { DateRange } from "../types/earnings.types";
import { fromPaise, splitRental, splitRideFare, toPaise } from "./earningsSplit";

const round2 = (n: number) => Math.round(n * 100) / 100;

export type SettleResult = { settled: boolean; reason?: string };

const encodeCursor = (t: string, id: string) => Buffer.from(JSON.stringify({ t, id })).toString("base64url");
function decodeCursor(c?: string): { t: string; id: string } | undefined {
  if (!c) return undefined;
  try {
    const v = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
    if (typeof v.t === "string" && typeof v.id === "string" && !Number.isNaN(Date.parse(v.t))) return v;
  } catch { /* fall through */ }
  throw ApiError.badRequest("Invalid cursor");
}

export const earningsService = {
  // ---------- settlement ----------

  /**
   * Splits a PAID ride's fare between platform, vehicle owner and driver. Idempotent: calling it twice (a retried
   * payment, the reconcile job, a race) writes the ledger once, because the commission row is a unique gate.
   * The owner agreement used is the one in force when the ride was ACCEPTED, so unassigning a driver afterwards cannot
   * change what a past ride paid.
   */
  async settleRide(rideId: string): Promise<SettleResult> {
    const ride = await ridesRepository.findById(rideId);
    if (!ride) return { settled: false, reason: "ride not found" };
    if (ride.status !== "PAYMENT_COMPLETED") return { settled: false, reason: `ride is ${ride.status}, not paid` };
    if (!ride.driver_id) return { settled: false, reason: "ride has no driver" };

    const fare = await ridesRepository.findFareByRideId(rideId);
    if (!fare) return { settled: false, reason: "ride has no fare" };

    const at = ride.accepted_at ?? ride.started_at ?? ride.requested_at;
    const terms = ride.vehicle_id ? await earningsRepository.findAssignmentTerms(ride.vehicle_id, ride.driver_id, at) : null;
    const ownerIsPaid = !!terms && terms.owner_id !== ride.driver_id;

    const platformPercent = terms ? Number(terms.commission_percent) : env.PLATFORM_COMMISSION_PERCENT;
    const total = toPaise(fare.total_fare);
    const split = splitRideFare(total, platformPercent, ownerIsPaid ? Number(terms!.owner_share_percent) : null);

    const settled = await earningsRepository.settleRide({
      rideId, rideTotalPaise: total, platformPercent, platform: split.platform,
      owner: ownerIsPaid ? { ownerId: terms!.owner_id, vehicleId: ride.vehicle_id!, paise: split.owner } : null,
      driver: { driverId: ride.driver_id, paise: split.driver },
    });
    if (settled) logger.info({ rideId, ...split }, "Ride settled");
    return { settled };
  },

  /** Splits a returned rental. Owner gets rent + late fee - commission + damage compensation. */
  async settleRental(bookingId: string): Promise<SettleResult> {
    const b = await rentalBookingsRepository.findById(bookingId);
    if (!b) return { settled: false, reason: "booking not found" };
    if (b.status !== "COMPLETED") return { settled: false, reason: `booking is ${b.status}, not completed` };

    const split = splitRental(toPaise(b.total_amount), toPaise(b.late_fee), toPaise(b.damage_deduction), env.RENTAL_COMMISSION_PERCENT);
    const settled = await earningsRepository.settleRental({
      bookingId, platformPercent: env.RENTAL_COMMISSION_PERCENT, platform: split.platform,
      owner: { ownerId: b.owner_id, vehicleId: b.vehicle_id, renterId: b.renter_id, paise: split.owner },
    });
    if (settled) logger.info({ bookingId, ...split }, "Rental settled");
    return { settled };
  },

  /**
   * Called from the payment / return paths AFTER the money has moved. A bookkeeping failure must not turn a successful
   * payment into an error response, so it is logged and left for reconcile() to repair.
   */
  async settleRideSafely(rideId: string): Promise<void> {
    try { await this.settleRide(rideId); } catch (err) { logger.error({ err, rideId }, "Ride settlement failed; reconcile will retry"); }
  },
  async settleRentalSafely(bookingId: string): Promise<void> {
    try { await this.settleRental(bookingId); } catch (err) { logger.error({ err, bookingId }, "Rental settlement failed; reconcile will retry"); }
  },

  /** Repairs anything left half-done: unsettled rides/rentals and unpaid deposit refunds. Safe to run any time, any number of times. */
  async reconcile(limit = 100) {
    const result = { rides: 0, rentals: 0, depositRefunds: 0, errors: 0 };
    for (const id of await earningsRepository.findUnsettledRideIds(limit)) {
      try { if ((await this.settleRide(id)).settled) result.rides += 1; } catch (err) { result.errors += 1; logger.error({ err, id }, "Reconcile: ride failed"); }
    }
    for (const id of await earningsRepository.findUnsettledRentalIds(limit)) {
      try { if ((await this.settleRental(id)).settled) result.rentals += 1; } catch (err) { result.errors += 1; logger.error({ err, id }, "Reconcile: rental failed"); }
    }
    const { payoutsService } = await import("./payouts.service");
    for (const id of await earningsRepository.findOpenDepositRefundIds(limit)) {
      try { if (await payoutsService.refundDeposit(id)) result.depositRefunds += 1; } catch (err) { result.errors += 1; logger.error({ err, id }, "Reconcile: deposit refund failed"); }
    }
    return result;
  },

  // ---------- dashboards ----------

  async ownerSummary(ownerId: string, range: DateRange) {
    const [t, vehicles, balance] = await Promise.all([
      earningsRepository.ownerTotals(ownerId, range),
      earningsRepository.ownerByVehicle(ownerId, range),
      earningsRepository.balance(ownerId),
    ]);
    const gross = round2(t.rideShareEarnings + t.rentalRevenue);
    return {
      range: { from: range.from ?? null, to: range.to ?? null },
      rideShareEarnings: t.rideShareEarnings,
      rentalRevenue: t.rentalRevenue,
      grossEarnings: gross,
      maintenanceCost: t.maintenanceCost,
      netEarnings: round2(gross - t.maintenanceCost),
      rideCount: t.rideCount,
      rentalCount: t.rentalCount,
      balance,
      vehicles,
    };
  },

  async driverSummary(driverId: string, range: DateRange) {
    const [t, balance] = await Promise.all([earningsRepository.driverTotals(driverId, range), earningsRepository.balance(driverId)]);
    return {
      range: { from: range.from ?? null, to: range.to ?? null },
      rideFares: t.rideFares,
      bonuses: t.bonuses,
      adjustments: t.adjustments,
      totalEarnings: round2(t.rideFares + t.bonuses + t.adjustments),
      rideCount: t.rideCount,
      balance,
    };
  },

  async platformSummary(range: DateRange) {
    const rows = await earningsRepository.platformTotals(range);
    return { range: { from: range.from ?? null, to: range.to ?? null }, totalCommission: round2(rows.reduce((s, r) => s + r.amount, 0)), bySource: rows };
  },

  async ownerEntries(ownerId: string, limit: number, cursor?: string) {
    const rows = await earningsRepository.ownerEntries(ownerId, limit + 1, decodeCursor(cursor));
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      entries: page.map((r) => ({ id: r.id, sourceType: r.source_type, sourceId: r.source_id, vehicleId: r.vehicle_id, amount: Number(r.amount), createdAt: r.created_at })),
      nextCursor: rows.length > limit && last ? encodeCursor(last.created_at_raw, last.id) : null,
    };
  },

  async driverEntries(driverId: string, limit: number, cursor?: string) {
    const rows = await earningsRepository.driverEntries(driverId, limit + 1, decodeCursor(cursor));
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      entries: page.map((r) => ({ id: r.id, type: r.type, rideId: r.ride_id, amount: Number(r.amount), createdAt: r.created_at })),
      nextCursor: rows.length > limit && last ? encodeCursor(last.created_at_raw, last.id) : null,
    };
  },

  balance: (userId: string) => earningsRepository.balance(userId),
  fromPaise,
};
