import { Router } from "express";
import { authenticate } from "../../../middleware/auth";
import { matchingController } from "../controllers/matching.controller";

export const matchingRouter = Router();

matchingRouter.get("/rides/:rideId/candidates", authenticate, matchingController.findCandidates);
