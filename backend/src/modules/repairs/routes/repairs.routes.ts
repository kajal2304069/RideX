import { Router } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { validate } from "../../../middleware/validate";
import { repairsController as c } from "../controllers/repairs.controller";
import {
  assignMechanicSchema, bookingIdParamSchema, createBookingSchema, emergencySchema, garageBookingsSchema,
  repairOrderSchema, vehicleIdParamSchema,
} from "../validators/repairs.validators";

export const repairsRouter = Router();
const garage = authorize("GARAGE_OWNER");

// Customer side (any authenticated user can book a service)
repairsRouter.post("/", authenticate, validate(createBookingSchema), c.create);
repairsRouter.post("/emergency", authenticate, validate(emergencySchema), c.emergency);
repairsRouter.get("/", authenticate, c.listMine);

// Fixed paths before "/:bookingId"
repairsRouter.get("/garage/:garageId", authenticate, garage, validate(garageBookingsSchema), c.listForGarage);
repairsRouter.get("/vehicles/:vehicleId/maintenance", authenticate, validate(vehicleIdParamSchema), c.maintenance);

repairsRouter.get("/:bookingId", authenticate, validate(bookingIdParamSchema), c.getOne);
repairsRouter.post("/:bookingId/cancel", authenticate, validate(bookingIdParamSchema), c.cancel);

// Garage side
repairsRouter.post("/:bookingId/accept", authenticate, garage, validate(bookingIdParamSchema), c.accept);
repairsRouter.post("/:bookingId/assign-mechanic", authenticate, garage, validate(assignMechanicSchema), c.assignMechanic);
repairsRouter.post("/:bookingId/vehicle-received", authenticate, garage, validate(bookingIdParamSchema), c.vehicleReceived);
repairsRouter.post("/:bookingId/start-repair", authenticate, garage, validate(bookingIdParamSchema), c.startRepair);
repairsRouter.put("/:bookingId/repair-order", authenticate, garage, validate(repairOrderSchema), c.updateRepairOrder);
repairsRouter.post("/:bookingId/ready", authenticate, garage, validate(bookingIdParamSchema), c.ready);
