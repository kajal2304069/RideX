import { Router } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { validate } from "../../../middleware/validate";
import { locationController } from "../controllers/location.controller";
import { updateLocationSchema, nearbyDriversSchema } from "../validators/location.validators";

export const locationRouter = Router();

locationRouter.post(
  "/drivers/me",
  authenticate,
  authorize("DRIVER"),
  validate(updateLocationSchema),
  locationController.updateMine
);

// Any authenticated user can preview nearby drivers (a rider browsing
// before requesting, spec section 6 - "View nearby drivers").
locationRouter.get("/drivers/nearby", authenticate, validate(nearbyDriversSchema), locationController.nearbyDrivers);
