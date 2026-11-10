import { Router } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { ridersController } from "../controllers/riders.controller";

export const ridersRouter = Router();

ridersRouter.get("/me", authenticate, authorize("RIDER"), ridersController.me);
