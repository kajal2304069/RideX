import { Router } from "express";
import { authenticate, authorize, optionalAuthenticate } from "../../../middleware/auth";
import { validate } from "../../../middleware/validate";
import { rentalsController as c } from "../controllers/rentals.controller";
import * as v from "../validators/rentals.validators";

export const rentalsRouter = Router();
const owner = authorize("VEHICLE_OWNER");
const renter = authorize("RIDER");

// ---- listings (fixed paths BEFORE "/listings/:listingId") ----
rentalsRouter.get("/listings", validate(v.searchRentalsSchema), c.search);
rentalsRouter.post("/listings", authenticate, owner, validate(v.createRentalListingSchema), c.createListing);
rentalsRouter.get("/listings/mine", authenticate, owner, c.mine);

rentalsRouter.get("/listings/:listingId", optionalAuthenticate, validate(v.listingIdParamSchema), c.getListing);
rentalsRouter.patch("/listings/:listingId", authenticate, owner, validate(v.updateRentalListingSchema), c.updateListing);
rentalsRouter.post("/listings/:listingId/activate", authenticate, owner, validate(v.listingIdParamSchema), c.activate);
rentalsRouter.post("/listings/:listingId/deactivate", authenticate, owner, validate(v.listingIdParamSchema), c.deactivate);
rentalsRouter.get("/listings/:listingId/quote", validate(v.quoteSchema), c.quote);
rentalsRouter.get("/listings/:listingId/availability", validate(v.availabilitySchema), c.availability);
rentalsRouter.post("/listings/:listingId/bookings", authenticate, renter, validate(v.bookSchema), c.book);
rentalsRouter.get("/listings/:listingId/bookings", authenticate, owner, validate(v.listingIdParamSchema), c.listingBookings);

// ---- bookings ----
rentalsRouter.get("/bookings/mine", authenticate, renter, c.myBookings);
rentalsRouter.get("/bookings/incoming", authenticate, owner, validate(v.ownerBookingsSchema), c.ownerBookings);
rentalsRouter.get("/bookings/:bookingId", authenticate, validate(v.bookingIdParamSchema), c.getBooking);
rentalsRouter.post("/bookings/:bookingId/cancel", authenticate, validate(v.bookingIdParamSchema), c.cancel);
rentalsRouter.post("/bookings/:bookingId/start", authenticate, owner, validate(v.bookingIdParamSchema), c.start);
rentalsRouter.post("/bookings/:bookingId/complete", authenticate, owner, validate(v.completeSchema), c.complete);
