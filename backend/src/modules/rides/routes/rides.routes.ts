import { Router } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { validate } from "../../../middleware/validate";
import { ridesController } from "../controllers/rides.controller";
import { estimateRideSchema, requestRideSchema, rateRideSchema, rideIdParamSchema, cancelRideSchema } from "../validators/rides.validators";

export const ridesRouter = Router();

// --- Rider-facing ---
ridesRouter.post("/estimate", authenticate, validate(estimateRideSchema), ridesController.estimate);
ridesRouter.post("/request", authenticate, authorize("RIDER"), validate(requestRideSchema), ridesController.request);
ridesRouter.get("/current", authenticate, authorize("RIDER"), ridesController.getCurrent);
ridesRouter.get("/history", authenticate, authorize("RIDER"), ridesController.getHistory);

// --- Driver-facing ---
ridesRouter.get("/driver/current", authenticate, authorize("DRIVER"), ridesController.getCurrentForDriver);
ridesRouter.get("/available", authenticate, authorize("DRIVER"), ridesController.listAvailable);
ridesRouter.post("/:rideId/accept", authenticate, authorize("DRIVER"), validate(rideIdParamSchema), ridesController.accept);
ridesRouter.post("/:rideId/arriving", authenticate, authorize("DRIVER"), validate(rideIdParamSchema), ridesController.markArriving);
ridesRouter.post("/:rideId/arrived", authenticate, authorize("DRIVER"), validate(rideIdParamSchema), ridesController.markArrived);
ridesRouter.post("/:rideId/start", authenticate, authorize("DRIVER"), validate(rideIdParamSchema), ridesController.start);
ridesRouter.post("/:rideId/complete", authenticate, authorize("DRIVER"), validate(rideIdParamSchema), ridesController.complete);

// --- Either party ---
ridesRouter.post("/:rideId/rate", authenticate, validate(rateRideSchema), ridesController.rate);
ridesRouter.get("/:rideId/rating", authenticate, validate(rideIdParamSchema), ridesController.myRating);
ridesRouter.get("/:rideId", authenticate, validate(rideIdParamSchema), ridesController.getOne);
ridesRouter.post("/:rideId/cancel", authenticate, validate(cancelRideSchema), ridesController.cancel);
