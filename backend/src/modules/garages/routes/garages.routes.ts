import { Router } from "express";
import { authenticate, authorize, optionalAuthenticate } from "../../../middleware/auth";
import { validate } from "../../../middleware/validate";
import { garagesController } from "../controllers/garages.controller";
import {
  addMechanicSchema, addServiceSchema, createGarageSchema, garageIdParamSchema, mechanicActiveSchema,
  nearbyGaragesSchema, serviceParamSchema, updateGarageSchema,
} from "../validators/garages.validators";

export const garagesRouter = Router();

// Fixed paths first so "/nearby" and "/mine" are never captured by "/:garageId".
garagesRouter.get("/nearby", authenticate, validate(nearbyGaragesSchema), garagesController.nearby);
garagesRouter.get("/mine", authenticate, authorize("GARAGE_OWNER"), garagesController.listMine);
garagesRouter.post("/", authenticate, authorize("GARAGE_OWNER"), validate(createGarageSchema), garagesController.create);

garagesRouter.get("/:garageId", optionalAuthenticate, validate(garageIdParamSchema), garagesController.getOne);
garagesRouter.patch("/:garageId", authenticate, authorize("GARAGE_OWNER"), validate(updateGarageSchema), garagesController.update);

garagesRouter.post("/:garageId/services", authenticate, authorize("GARAGE_OWNER"), validate(addServiceSchema), garagesController.addService);
garagesRouter.delete("/:garageId/services/:serviceId", authenticate, authorize("GARAGE_OWNER"), validate(serviceParamSchema), garagesController.removeService);

garagesRouter.post("/:garageId/mechanics", authenticate, authorize("GARAGE_OWNER"), validate(addMechanicSchema), garagesController.addMechanic);
garagesRouter.get("/:garageId/mechanics", authenticate, authorize("GARAGE_OWNER", "ADMIN"), validate(garageIdParamSchema), garagesController.listMechanics);
garagesRouter.patch("/:garageId/mechanics/:mechanicId", authenticate, authorize("GARAGE_OWNER"), validate(mechanicActiveSchema), garagesController.setMechanicActive);
