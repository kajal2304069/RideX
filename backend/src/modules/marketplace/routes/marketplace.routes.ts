import { Router } from "express";
import { authenticate, authorize, optionalAuthenticate } from "../../../middleware/auth";
import { validate } from "../../../middleware/validate";
import { marketplaceController as c } from "../controllers/marketplace.controller";
import * as v from "../validators/marketplace.validators";

export const marketplaceRouter = Router();
const seller = authorize("SELLER");
const buyer = authorize("BUYER");

// ---- listings (fixed paths BEFORE "/listings/:listingId") ----
marketplaceRouter.get("/listings", optionalAuthenticate, validate(v.searchListingsSchema), c.search);
marketplaceRouter.post("/listings", authenticate, seller, validate(v.createListingSchema), c.create);
marketplaceRouter.get("/listings/mine", authenticate, seller, c.mine);
marketplaceRouter.get("/listings/favorites", authenticate, c.favorites);

marketplaceRouter.get("/listings/:listingId", optionalAuthenticate, validate(v.listingIdParamSchema), c.getOne);
marketplaceRouter.patch("/listings/:listingId", authenticate, seller, validate(v.updateListingSchema), c.update);
marketplaceRouter.post("/listings/:listingId/delist", authenticate, seller, validate(v.listingIdParamSchema), c.delist);
marketplaceRouter.post("/listings/:listingId/relist", authenticate, seller, validate(v.listingIdParamSchema), c.relist);

marketplaceRouter.post("/listings/:listingId/images", authenticate, seller, validate(v.addImageSchema), c.addImage);
marketplaceRouter.delete("/listings/:listingId/images/:imageId", authenticate, seller, validate(v.imageParamSchema), c.removeImage);

marketplaceRouter.put("/listings/:listingId/favorite", authenticate, validate(v.listingIdParamSchema), c.favorite);
marketplaceRouter.delete("/listings/:listingId/favorite", authenticate, validate(v.listingIdParamSchema), c.unfavorite);

marketplaceRouter.post("/listings/:listingId/offers", authenticate, buyer, validate(v.createOfferSchema), c.createOffer);
marketplaceRouter.get("/listings/:listingId/offers", authenticate, seller, validate(v.listingOffersSchema), c.listingOffers);

marketplaceRouter.post("/listings/:listingId/inspections", authenticate, buyer, validate(v.scheduleInspectionSchema), c.scheduleInspection);
marketplaceRouter.get("/listings/:listingId/inspections", authenticate, seller, validate(v.listingIdParamSchema), c.listingInspections);

// ---- offers ----
marketplaceRouter.get("/offers/mine", authenticate, buyer, c.myOffers);
marketplaceRouter.post("/offers/:offerId/accept", authenticate, seller, validate(v.offerIdParamSchema), c.acceptOffer);
marketplaceRouter.post("/offers/:offerId/reject", authenticate, seller, validate(v.offerIdParamSchema), c.rejectOffer);
marketplaceRouter.post("/offers/:offerId/withdraw", authenticate, buyer, validate(v.offerIdParamSchema), c.withdrawOffer);

// ---- inspections ----
marketplaceRouter.get("/inspections/mine", authenticate, buyer, c.myInspections);
marketplaceRouter.get("/inspections/open", authenticate, authorize("MECHANIC"), c.openInspections);
marketplaceRouter.get("/inspections/:inspectionId", authenticate, validate(v.inspectionIdParamSchema), c.getInspection);
marketplaceRouter.post("/inspections/:inspectionId/report", authenticate, authorize("MECHANIC"), validate(v.submitReportSchema), c.submitReport);
marketplaceRouter.post("/inspections/:inspectionId/cancel", authenticate, buyer, validate(v.inspectionIdParamSchema), c.cancelInspection);
