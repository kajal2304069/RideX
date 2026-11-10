import { Router } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { validate } from "../../../middleware/validate";
import { vehiclesController } from "../controllers/vehicles.controller";
import {
  createVehicleSchema,
  updateVehicleSchema,
  updateVehicleStatusSchema,
  assignDriverSchema,
} from "../validators/vehicles.validators";

export const vehiclesRouter = Router();

// Public catalogue of ride / rental vehicle types (needed before anyone has logged in).
vehiclesRouter.get("/types", vehiclesController.listTypes);
// Owners find a verified, unassigned driver by exact email before assigning them a vehicle.
vehiclesRouter.get("/drivers/lookup", authenticate, authorize("VEHICLE_OWNER"), vehiclesController.lookupDriver);

// Vehicle ownership is restricted to VEHICLE_OWNER role holders.
vehiclesRouter.post("/", authenticate, authorize("VEHICLE_OWNER"), validate(createVehicleSchema), vehiclesController.create);
vehiclesRouter.get("/mine", authenticate, authorize("VEHICLE_OWNER"), vehiclesController.listMine);
vehiclesRouter.get("/:vehicleId", authenticate, authorize("VEHICLE_OWNER"), vehiclesController.getOne);
vehiclesRouter.patch(
  "/:vehicleId",
  authenticate,
  authorize("VEHICLE_OWNER"),
  validate(updateVehicleSchema),
  vehiclesController.update
);
vehiclesRouter.patch(
  "/:vehicleId/status",
  authenticate,
  authorize("VEHICLE_OWNER"),
  validate(updateVehicleStatusSchema),
  vehiclesController.updateStatus
);
vehiclesRouter.post(
  "/:vehicleId/assign-driver",
  authenticate,
  authorize("VEHICLE_OWNER"),
  validate(assignDriverSchema),
  vehiclesController.assignDriver
);
vehiclesRouter.post(
  "/:vehicleId/unassign-driver",
  authenticate,
  authorize("VEHICLE_OWNER"),
  vehiclesController.unassignDriver
);
