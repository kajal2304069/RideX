import { ApiError } from "../../../common/ApiError";
import { notificationsService } from "../../notifications/services/notifications.service";
import { listingsRepository } from "../repositories/listings.repository";
import { inspectionsRepository } from "../repositories/inspections.repository";
import { InspectionRecord, InspectionReport, toPublicInspection } from "../types/marketplace.types";

const isPgCode = (err: unknown, code: string) => typeof err === "object" && err !== null && (err as { code?: string }).code === code;

/** Scheduling window: not in the past, not absurdly far ahead. */
const MAX_DAYS_AHEAD = 60;
/** A report cannot be filed before the slot starts (minus a short tolerance for early arrival). Stops fabricated reports. */
const EARLY_REPORT_TOLERANCE_MS = 60 * 60 * 1000;

const SCORED = ["engine", "brakes", "tyres", "battery", "body", "electrical"] as const;

/**
 * The overall score and the red flags are derived on the server from the structured report. A mechanic cannot submit
 * "overallScore: 10" on a car with a bad engine, and a buyer sees a consistent number across all inspections.
 */
export function summarizeReport(report: InspectionReport): InspectionReport {
  const scores = SCORED.map((k) => report[k].score);
  const overallScore = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;

  const flags: string[] = [];
  if (report.accidentHistory.hadAccident) flags.push("ACCIDENT_HISTORY");
  if (!report.documents.verified) flags.push("DOCUMENTS_NOT_VERIFIED");
  for (const k of SCORED) if (report[k].score <= 3) flags.push(`${k.toUpperCase()}_POOR`);

  return { ...report, overallScore, flags };
}

/** Buyer, seller of the listing, the inspecting mechanic and admins may read a report. Everyone else gets a 404. */
function canView(i: InspectionRecord, userId: string, isAdmin: boolean): boolean {
  return isAdmin || i.buyer_id === userId || i.seller_id === userId || i.inspector_id === userId;
}

export const inspectionsService = {
  async schedule(buyerId: string, listingId: string, scheduledAt: Date) {
    const listing = await listingsRepository.findById(listingId);
    if (!listing || listing.status === "DELISTED") throw ApiError.notFound("Listing not found");
    if (listing.status !== "ACTIVE") throw ApiError.conflict("This vehicle has been sold");
    if (listing.seller_id === buyerId) throw ApiError.badRequest("You cannot inspect your own listing");

    const now = Date.now();
    if (scheduledAt.getTime() <= now) throw ApiError.badRequest("scheduledAt must be in the future");
    if (scheduledAt.getTime() > now + MAX_DAYS_AHEAD * 86_400_000) throw ApiError.badRequest(`scheduledAt must be within ${MAX_DAYS_AHEAD} days`);

    try {
      const inspection = await inspectionsRepository.create(listingId, buyerId, scheduledAt);
      void notificationsService.notify(listing.seller_id, "INSPECTION_SCHEDULED", inspection.id);
      return toPublicInspection(inspection);
    } catch (err) {
      if (isPgCode(err, "23505")) throw ApiError.conflict("You already have a scheduled inspection for this listing");
      throw err;
    }
  },

  async listMine(buyerId: string) {
    return (await inspectionsRepository.listForBuyer(buyerId)).map(toPublicInspection);
  },

  async listOpen() {
    return (await inspectionsRepository.listOpen()).map(toPublicInspection);
  },

  async getOne(inspectionId: string, userId: string, isAdmin: boolean) {
    const i = await inspectionsRepository.findById(inspectionId);
    if (!i || !canView(i, userId, isAdmin)) throw ApiError.notFound("Inspection not found");
    return toPublicInspection(i);
  },

  async submitReport(inspectionId: string, mechanicId: string, report: InspectionReport) {
    const i = await inspectionsRepository.findById(inspectionId);
    if (!i) throw ApiError.notFound("Inspection not found");
    if (mechanicId === i.buyer_id || mechanicId === i.seller_id) {
      throw ApiError.forbidden("You cannot inspect a vehicle you are buying or selling");
    }
    if (i.status !== "SCHEDULED") throw ApiError.conflict(`A ${i.status} inspection cannot receive a report`);
    if (Date.now() < i.scheduled_at.getTime() - EARLY_REPORT_TOLERANCE_MS) {
      throw ApiError.badRequest("A report cannot be submitted before the scheduled time");
    }

    // Guarded UPDATE ... WHERE status = 'SCHEDULED': two mechanics submitting at once -> one wins, one gets a 409.
    const done = await inspectionsRepository.complete(inspectionId, mechanicId, summarizeReport(report));
    if (!done) throw ApiError.conflict("This inspection was already completed or cancelled");

    void notificationsService.notify(done.buyer_id, "INSPECTION_COMPLETED", done.id, { overallScore: done.report?.overallScore });
    return toPublicInspection(done);
  },

  async cancel(inspectionId: string, buyerId: string) {
    const i = await inspectionsRepository.findById(inspectionId);
    if (!i || i.buyer_id !== buyerId) throw ApiError.notFound("Inspection not found");
    if (!(await inspectionsRepository.cancel(inspectionId))) throw ApiError.conflict(`A ${i.status} inspection cannot be cancelled`);
    return toPublicInspection((await inspectionsRepository.findById(inspectionId))!);
  },
};
