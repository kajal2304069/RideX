import { Router } from "express";
import { authenticate } from "../../../middleware/auth";
import { validate } from "../../../middleware/validate";
import { routingController } from "../controllers/routing.controller";
import { computeRouteSchema } from "../validators/routing.validators";

export const routingRouter = Router();

routingRouter.post("/route", authenticate, validate(computeRouteSchema), routingController.computeRoute);
