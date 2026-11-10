import { Router } from "express";
import { authenticate } from "../../../middleware/auth";
import { validate } from "../../../middleware/validate";
import { chatController as c } from "../controllers/chat.controller";
import * as v from "../validators/chat.validators";

export const chatRouter = Router();
chatRouter.use(authenticate);
chatRouter.get("/rides/:rideId/messages", validate(v.listSchema), c.list);
chatRouter.post("/rides/:rideId/messages", validate(v.sendSchema), c.send);
