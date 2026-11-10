import { Router } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { validate } from "../../../middleware/validate";
import { driversController } from "../controllers/drivers.controller";
import { onboardDriverSchema, verifyDriverSchema } from "../validators/drivers.validators";

export const driversRouter = Router();

// --- Self-service (DRIVER role) ---
driversRouter.post(
  "/onboard",
  authenticate,
  authorize("DRIVER"),
  validate(onboardDriverSchema),
  driversController.onboard
);
driversRouter.get("/me", authenticate, authorize("DRIVER"), driversController.me);
driversRouter.post("/online", authenticate, authorize("DRIVER"), driversController.goOnline);
driversRouter.post("/offline", authenticate, authorize("DRIVER"), driversController.goOffline);

// --- Admin verification workflow ---
driversRouter.get("/pending", authenticate, authorize("ADMIN"), driversController.listPending);
driversRouter.patch(
  "/:driverId/verification",
  authenticate,
  authorize("ADMIN"),
  validate(verifyDriverSchema),
  driversController.setVerification
);
