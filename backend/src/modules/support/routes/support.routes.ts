import { Router } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { validate } from "../../../middleware/validate";
import { supportController as c } from "../controllers/support.controller";
import * as v from "../validators/support.validators";

export const supportRouter = Router();
supportRouter.use(authenticate);

supportRouter.post("/tickets", validate(v.createTicketSchema), c.create);
supportRouter.get("/tickets", validate(v.listMineSchema), c.listMine);
// staff queue + triage (fixed path before :ticketId)
supportRouter.get("/tickets/all", authorize("ADMIN"), validate(v.listAllSchema), c.listAll);
supportRouter.get("/tickets/:ticketId", validate(v.ticketIdSchema), c.get);
supportRouter.post("/tickets/:ticketId/messages", validate(v.replySchema), c.reply);
supportRouter.patch("/tickets/:ticketId", authorize("ADMIN"), validate(v.updateTicketSchema), c.update);
