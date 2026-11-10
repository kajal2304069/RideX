import { asyncHandler } from "../../../common/asyncHandler";
import { sendSuccess } from "../../../common/ApiResponse";
import { RentalSortKey } from "../repositories/rentalListings.repository";
import { rentalBookingsService } from "../services/rentalBookings.service";
import { rentalListingsService } from "../services/rentalListings.service";

const isAdmin = (roles: string[]) => roles.includes("ADMIN");

export const rentalsController = {
  createListing: asyncHandler(async (req, res) => sendSuccess(res, { listing: await rentalListingsService.create(req.user!.sub, req.body) }, 201)),
  mine: asyncHandler(async (req, res) => sendSuccess(res, { listings: await rentalListingsService.mine(req.user!.sub) })),
  getListing: asyncHandler(async (req, res) =>
    sendSuccess(res, await rentalListingsService.getOne(req.params.listingId, req.user?.sub, req.user ? isAdmin(req.user.roles) : false))),
  updateListing: asyncHandler(async (req, res) => sendSuccess(res, { listing: await rentalListingsService.update(req.params.listingId, req.user!.sub, req.body) })),
  activate: asyncHandler(async (req, res) => sendSuccess(res, { listing: await rentalListingsService.setActive(req.params.listingId, req.user!.sub, true) })),
  deactivate: asyncHandler(async (req, res) => sendSuccess(res, { listing: await rentalListingsService.setActive(req.params.listingId, req.user!.sub, false) })),

  search: asyncHandler(async (req, res) => {
    const q = req.query as unknown as {
      q?: string; vehicleTypeId?: string; fuelType?: string; transmission?: string; minDailyPrice?: number; maxDailyPrice?: number;
      lat?: number; lng?: number; radiusMeters: number; availableFrom?: Date; availableTo?: Date; sort: RentalSortKey; cursor?: string; limit: number;
    };
    sendSuccess(res, await rentalListingsService.search({
      filters: {
        q: q.q, vehicleTypeId: q.vehicleTypeId, fuelType: q.fuelType, transmission: q.transmission,
        minDailyPrice: q.minDailyPrice, maxDailyPrice: q.maxDailyPrice, availableFrom: q.availableFrom, availableTo: q.availableTo,
        near: q.lat !== undefined && q.lng !== undefined ? { lat: q.lat, lng: q.lng, radiusMeters: q.radiusMeters } : undefined,
      },
      sort: q.sort, cursor: q.cursor, limit: q.limit,
    }));
  }),
  quote: asyncHandler(async (req, res) => {
    const q = req.query as unknown as { startAt: Date; endAt: Date };
    sendSuccess(res, { quote: await rentalListingsService.quote(req.params.listingId, q.startAt, q.endAt) });
  }),
  availability: asyncHandler(async (req, res) => {
    const q = req.query as unknown as { from?: Date; to?: Date };
    const from = q.from ?? new Date();
    const to = q.to ?? new Date(from.getTime() + 30 * 86_400_000);
    sendSuccess(res, await rentalListingsService.availability(req.params.listingId, from, to));
  }),

  book: asyncHandler(async (req, res) => {
    const { booking, created } = await rentalBookingsService.book(req.user!.sub, req.params.listingId, req.body);
    sendSuccess(res, { booking }, created ? 201 : 200);
  }),
  myBookings: asyncHandler(async (req, res) => sendSuccess(res, { bookings: await rentalBookingsService.listMine(req.user!.sub) })),
  ownerBookings: asyncHandler(async (req, res) =>
    sendSuccess(res, { bookings: await rentalBookingsService.listForOwner(req.user!.sub, (req.query as { listingId?: string }).listingId) })),
  listingBookings: asyncHandler(async (req, res) =>
    sendSuccess(res, { bookings: await rentalBookingsService.listForOwner(req.user!.sub, req.params.listingId) })),
  getBooking: asyncHandler(async (req, res) =>
    sendSuccess(res, { booking: await rentalBookingsService.getOne(req.params.bookingId, req.user!.sub, isAdmin(req.user!.roles)) })),
  cancel: asyncHandler(async (req, res) => sendSuccess(res, { booking: await rentalBookingsService.cancel(req.params.bookingId, req.user!.sub) })),
  start: asyncHandler(async (req, res) => sendSuccess(res, { booking: await rentalBookingsService.start(req.params.bookingId, req.user!.sub) })),
  complete: asyncHandler(async (req, res) => sendSuccess(res, { booking: await rentalBookingsService.complete(req.params.bookingId, req.user!.sub, req.body) })),
};
