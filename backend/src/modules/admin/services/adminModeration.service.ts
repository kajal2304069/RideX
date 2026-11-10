import { ApiError } from "../../../common/ApiError";
import { withTransaction } from "../../../db/pool";
import { notificationsService } from "../../notifications/services/notifications.service";
import { offersRepository } from "../../marketplace/repositories/offers.repository";
import { listingsRepository } from "../../marketplace/repositories/listings.repository";
import { adminModerationRepository } from "../repositories/adminModeration.repository";
import { Actor } from "./adminUsers.service";
import { auditService } from "./audit.service";

export const adminModerationService = {
  /**
   * Takes a listing down. Reuses the seller's delist transaction (same row lock, so it cannot race an accepted offer),
   * refuses while a buyer holds an accepted reservation, and writes the audit row INSIDE that transaction.
   */
  async removeListing(actor: Actor, listingId: string, reason: string) {
    const result = await offersRepository.delistIfUnreserved(listingId, async (client) => {
      await adminModerationRepository.markListingRemoved(client, listingId, reason);
      await auditService.record({ actorId: actor.id, action: "listing.removed", entityType: "vehicle_listing", entityId: listingId, metadata: { reason }, ip: actor.ip }, client);
    });
    if (result.outcome === "reserved") throw ApiError.conflict("An offer is accepted and awaiting payment; the listing cannot be removed until it is paid or expires");
    if (result.outcome !== "delisted") {
      if (!(await listingsRepository.findById(listingId))) throw ApiError.notFound("Listing not found");
      throw ApiError.conflict("Only an ACTIVE listing can be removed");
    }
    for (const buyerId of result.rejectedBuyerIds) void notificationsService.notify(buyerId, "OFFER_REJECTED", `${listingId}__removed__${buyerId}`);
    return { listingId, status: "DELISTED" as const, removedReason: reason };
  },

  async restoreListing(actor: Actor, listingId: string, reason: string) {
    await withTransaction(async (client) => {
      if (!(await adminModerationRepository.restoreListing(client, listingId))) {
        if (!(await listingsRepository.findById(listingId))) throw ApiError.notFound("Listing not found");
        throw ApiError.conflict("This listing was not removed by moderation");
      }
      await auditService.record({ actorId: actor.id, action: "listing.restored", entityType: "vehicle_listing", entityId: listingId, metadata: { reason }, ip: actor.ip }, client);
    });
    return { listingId, status: "ACTIVE" as const };
  },

  async setGarageActive(actor: Actor, garageId: string, active: boolean, reason: string) {
    await withTransaction(async (client) => {
      if (!(await adminModerationRepository.garageExists(client, garageId))) throw ApiError.notFound("Garage not found");
      if (!(await adminModerationRepository.setGarageActive(client, garageId, active))) {
        throw ApiError.conflict(`The garage is already ${active ? "active" : "inactive"}`);
      }
      await auditService.record(
        { actorId: actor.id, action: active ? "garage.activated" : "garage.deactivated", entityType: "garage", entityId: garageId, metadata: { reason }, ip: actor.ip }, client
      );
    });
    return { garageId, isActive: active };
  },
};
