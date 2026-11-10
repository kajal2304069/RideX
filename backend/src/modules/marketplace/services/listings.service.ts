import { ApiError } from "../../../common/ApiError";
import { notificationsService } from "../../notifications/services/notifications.service";
import { listingsRepository, SearchFilters, SortKey } from "../repositories/listings.repository";
import { offersRepository } from "../repositories/offers.repository";
import { inspectionsRepository } from "../repositories/inspections.repository";
import { ListingRecord, toPublicImage, toPublicInspection, toPublicListing, toPublicOffer, FuelType, ListingCondition, TransmissionType } from "../types/marketplace.types";

const isPgCode = (err: unknown, code: string) => typeof err === "object" && err !== null && (err as { code?: string }).code === code;

export interface CreateListingInput {
  vehicleTypeId: string; brand: string; model: string; year: number; mileageKm: number;
  fuelType: FuelType; transmission: TransmissionType; condition: ListingCondition; ownerCount: number; price: number;
  lat: number; lng: number; address?: string; description?: string; insuranceValidUntil?: string;
}

export interface SearchInput {
  filters: SearchFilters;
  sort: SortKey;
  cursor?: string;
  limit: number;
}

/** Cursor = base64url(JSON{ s: sort, v: sortValueAsText, id }). Opaque to clients, so the format can change. */
function encodeCursor(sort: SortKey, v: string, id: string): string {
  return Buffer.from(JSON.stringify({ s: sort, v, id })).toString("base64url");
}
function decodeCursor(raw: string, sort: SortKey): { v: string; id: string } {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { s: string; v: string; id: string };
    if (c.s !== sort || typeof c.v !== "string" || !/^[0-9a-f-]{36}$/i.test(c.id)) throw new Error("bad cursor");
    return { v: c.v, id: c.id };
  } catch {
    throw ApiError.badRequest("Invalid or mismatched cursor");
  }
}

async function loadOwnListing(listingId: string, sellerId: string): Promise<ListingRecord> {
  const l = await listingsRepository.findById(listingId);
  // 404 for other sellers: don't confirm that someone else's listing exists.
  if (!l || l.seller_id !== sellerId) throw ApiError.notFound("Listing not found");
  return l;
}

export const listingsService = {
  async create(sellerId: string, input: CreateListingInput) {
    return toPublicListing(await listingsRepository.create({ sellerId, ...input }));
  },

  async search(input: SearchInput) {
    if (input.sort === "distance" && !input.filters.near) throw ApiError.badRequest("sort=distance requires lat and lng");
    const cursor = input.cursor ? decodeCursor(input.cursor, input.sort) : undefined;

    // Fetch one extra row: if it exists there is a next page, without a separate COUNT query.
    const rows = await listingsRepository.search({ filters: input.filters, sort: input.sort, cursor, limit: input.limit + 1 });
    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > input.limit && last ? encodeCursor(input.sort, last.sort_value!, last.id) : null;
    return { listings: page.map(toPublicListing), nextCursor };
  },

  async mine(sellerId: string) {
    return (await listingsRepository.findBySeller(sellerId)).map(toPublicListing);
  },

  /** ACTIVE and SOLD are public (SOLD pages stay up as a record). DELISTED is visible to the seller and admins only. */
  async getOne(listingId: string, viewerId?: string, isAdmin = false) {
    const l = await listingsRepository.findById(listingId);
    const isSeller = !!viewerId && l?.seller_id === viewerId;
    if (!l || (l.status === "DELISTED" && !isSeller && !isAdmin)) throw ApiError.notFound("Listing not found");

    const [images, favoritesCount, inspection, isFavorite, myOffer, pendingOffers] = await Promise.all([
      listingsRepository.listImages(listingId),
      listingsRepository.countFavorites(listingId),
      listingsRepository.inspectionSummary(listingId),
      viewerId ? listingsRepository.isFavorite(viewerId, listingId) : Promise.resolve(false),
      viewerId && !isSeller ? offersRepository.findPendingForBuyer(listingId, viewerId) : Promise.resolve(null),
      isSeller ? offersRepository.listForListing(listingId, "PENDING") : Promise.resolve([]),
    ]);

    return {
      listing: toPublicListing(l),
      images: images.map(toPublicImage),
      favoritesCount,
      inspection,
      ...(viewerId ? { isFavorite } : {}),
      ...(myOffer ? { myOffer: toPublicOffer(myOffer) } : {}),
      ...(isSeller ? { pendingOffersCount: pendingOffers.length } : {}),
    };
  },

  async update(listingId: string, sellerId: string, patch: Parameters<typeof listingsRepository.update>[1]) {
    const l = await loadOwnListing(listingId, sellerId);
    if (l.status !== "ACTIVE") throw ApiError.conflict(`A ${l.status} listing cannot be edited`);
    // The price is what the accepted buyer agreed to pay against; freezing it while reserved prevents bait-and-switch.
    if (l.is_reserved && patch.price !== undefined) throw ApiError.conflict("Price cannot change while an offer is accepted");
    return toPublicListing((await listingsRepository.update(listingId, patch))!);
  },

  async delist(listingId: string, sellerId: string) {
    await loadOwnListing(listingId, sellerId);
    const result = await offersRepository.delistIfUnreserved(listingId);
    if (result.outcome !== "delisted") {
      throw ApiError.conflict(
        result.outcome === "reserved"
          ? "An offer is accepted and awaiting payment; the listing cannot be delisted"
          : "Only an ACTIVE listing can be delisted"
      );
    }
    for (const buyerId of result.rejectedBuyerIds) void notificationsService.notify(buyerId, "OFFER_REJECTED", `${listingId}__delist__${buyerId}`);
    return toPublicListing((await listingsRepository.findById(listingId))!);
  },

  async relist(listingId: string, sellerId: string) {
    await loadOwnListing(listingId, sellerId);
    if (await listingsRepository.isRemovedByAdmin(listingId)) throw ApiError.forbidden("This listing was removed by RideX moderation and cannot be relisted");
    if (!(await listingsRepository.setStatusIfCurrently(listingId, "DELISTED", "ACTIVE"))) {
      throw ApiError.conflict("Only a DELISTED listing can be relisted");
    }
    return toPublicListing((await listingsRepository.findById(listingId))!);
  },

  // --- images ---
  async addImage(listingId: string, sellerId: string, input: { url: string; position?: number }) {
    const l = await loadOwnListing(listingId, sellerId);
    if (l.status === "SOLD") throw ApiError.conflict("A sold listing cannot be edited");
    // With no explicit position, concurrent adds can pick the SAME free slot; the UNIQUE(listing_id, position) index
    // makes one of them lose with 23505. That is not a client error, so re-pick a slot and try again. An explicit
    // position that is taken is a real conflict and is reported immediately.
    const attempts = input.position === undefined ? 12 : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        return toPublicImage(await listingsRepository.addImage(listingId, input.url, input.position));
      } catch (err) {
        if (isPgCode(err, "23505")) {
          if (attempt < attempts) continue;
          throw ApiError.conflict("That image position is already used");
        }
        // CHECK (position BETWEEN 0 AND 9): the gallery is full (the free-slot search found none) or the position was out of range.
        if (isPgCode(err, "23514")) throw ApiError.conflict("A listing can have at most 10 images");
        throw err;
      }
    }
  },

  async removeImage(listingId: string, sellerId: string, imageId: string) {
    await loadOwnListing(listingId, sellerId);
    if (!(await listingsRepository.deleteImage(listingId, imageId))) throw ApiError.notFound("Image not found");
  },

  // --- favorites ---
  async favorite(userId: string, listingId: string) {
    const l = await listingsRepository.findById(listingId);
    if (!l || l.status === "DELISTED") throw ApiError.notFound("Listing not found");
    await listingsRepository.addFavorite(userId, listingId); // idempotent: ON CONFLICT DO NOTHING
    return { favorited: true };
  },

  async unfavorite(userId: string, listingId: string) {
    await listingsRepository.removeFavorite(userId, listingId); // idempotent
    return { favorited: false };
  },

  async listFavorites(userId: string) {
    return (await listingsRepository.listFavorites(userId)).map(toPublicListing);
  },

  async listInspectionsForSeller(listingId: string, sellerId: string) {
    await loadOwnListing(listingId, sellerId);
    return (await inspectionsRepository.listForListing(listingId)).map(toPublicInspection);
  },
};
