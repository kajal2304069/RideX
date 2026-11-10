import { asyncHandler } from "../../../common/asyncHandler";
import { sendSuccess } from "../../../common/ApiResponse";
import { SearchFilters, SortKey } from "../repositories/listings.repository";
import { inspectionsService } from "../services/inspections.service";
import { listingsService } from "../services/listings.service";
import { offersService } from "../services/offers.service";
import { ListingCondition, OfferStatus } from "../types/marketplace.types";

const isAdmin = (roles: string[]) => roles.includes("ADMIN");

export const marketplaceController = {
  // listings
  create: asyncHandler(async (req, res) => sendSuccess(res, { listing: await listingsService.create(req.user!.sub, req.body) }, 201)),

  search: asyncHandler(async (req, res) => {
    const q = req.query as unknown as {
      q?: string; brand?: string; vehicleTypeId?: string; minPrice?: number; maxPrice?: number; minYear?: number; maxYear?: number;
      maxMileage?: number; condition?: ListingCondition[]; fuelType?: SearchFilters["fuelType"]; transmission?: SearchFilters["transmission"];
      lat?: number; lng?: number; radiusMeters: number; sort: SortKey; cursor?: string; limit: number;
    };
    const filters: SearchFilters = {
      q: q.q, brand: q.brand, vehicleTypeId: q.vehicleTypeId, minPrice: q.minPrice, maxPrice: q.maxPrice, minYear: q.minYear,
      maxYear: q.maxYear, maxMileage: q.maxMileage, conditions: q.condition, fuelType: q.fuelType, transmission: q.transmission,
      near: q.lat !== undefined && q.lng !== undefined ? { lat: q.lat, lng: q.lng, radiusMeters: q.radiusMeters } : undefined,
    };
    sendSuccess(res, await listingsService.search({ filters, sort: q.sort, cursor: q.cursor, limit: q.limit }));
  }),

  mine: asyncHandler(async (req, res) => sendSuccess(res, { listings: await listingsService.mine(req.user!.sub) })),
  getOne: asyncHandler(async (req, res) =>
    sendSuccess(res, await listingsService.getOne(req.params.listingId, req.user?.sub, req.user ? isAdmin(req.user.roles) : false))),
  update: asyncHandler(async (req, res) => sendSuccess(res, { listing: await listingsService.update(req.params.listingId, req.user!.sub, req.body) })),
  delist: asyncHandler(async (req, res) => sendSuccess(res, { listing: await listingsService.delist(req.params.listingId, req.user!.sub) })),
  relist: asyncHandler(async (req, res) => sendSuccess(res, { listing: await listingsService.relist(req.params.listingId, req.user!.sub) })),
  addImage: asyncHandler(async (req, res) => sendSuccess(res, { image: await listingsService.addImage(req.params.listingId, req.user!.sub, req.body) }, 201)),
  removeImage: asyncHandler(async (req, res) => {
    await listingsService.removeImage(req.params.listingId, req.user!.sub, req.params.imageId);
    sendSuccess(res, { removed: true });
  }),
  favorite: asyncHandler(async (req, res) => sendSuccess(res, await listingsService.favorite(req.user!.sub, req.params.listingId))),
  unfavorite: asyncHandler(async (req, res) => sendSuccess(res, await listingsService.unfavorite(req.user!.sub, req.params.listingId))),
  favorites: asyncHandler(async (req, res) => sendSuccess(res, { listings: await listingsService.listFavorites(req.user!.sub) })),

  // offers
  createOffer: asyncHandler(async (req, res) => sendSuccess(res, { offer: await offersService.create(req.user!.sub, req.params.listingId, req.body.amount) }, 201)),
  listingOffers: asyncHandler(async (req, res) => {
    const status = (req.query as { status?: OfferStatus }).status;
    sendSuccess(res, { offers: await offersService.listForListing(req.params.listingId, req.user!.sub, status) });
  }),
  myOffers: asyncHandler(async (req, res) => sendSuccess(res, { offers: await offersService.listMine(req.user!.sub) })),
  acceptOffer: asyncHandler(async (req, res) => sendSuccess(res, { offer: await offersService.accept(req.params.offerId, req.user!.sub) })),
  rejectOffer: asyncHandler(async (req, res) => sendSuccess(res, { offer: await offersService.reject(req.params.offerId, req.user!.sub) })),
  withdrawOffer: asyncHandler(async (req, res) => sendSuccess(res, { offer: await offersService.withdraw(req.params.offerId, req.user!.sub) })),

  // inspections
  scheduleInspection: asyncHandler(async (req, res) =>
    sendSuccess(res, { inspection: await inspectionsService.schedule(req.user!.sub, req.params.listingId, req.body.scheduledAt) }, 201)),
  listingInspections: asyncHandler(async (req, res) =>
    sendSuccess(res, { inspections: await listingsService.listInspectionsForSeller(req.params.listingId, req.user!.sub) })),
  myInspections: asyncHandler(async (req, res) => sendSuccess(res, { inspections: await inspectionsService.listMine(req.user!.sub) })),
  openInspections: asyncHandler(async (_req, res) => sendSuccess(res, { inspections: await inspectionsService.listOpen() })),
  getInspection: asyncHandler(async (req, res) =>
    sendSuccess(res, { inspection: await inspectionsService.getOne(req.params.inspectionId, req.user!.sub, isAdmin(req.user!.roles)) })),
  submitReport: asyncHandler(async (req, res) =>
    sendSuccess(res, { inspection: await inspectionsService.submitReport(req.params.inspectionId, req.user!.sub, req.body) })),
  cancelInspection: asyncHandler(async (req, res) => sendSuccess(res, { inspection: await inspectionsService.cancel(req.params.inspectionId, req.user!.sub) })),
};
