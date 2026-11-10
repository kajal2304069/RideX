import { Router } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { validate } from "../../../middleware/validate";
import { earningsController as c } from "../controllers/earnings.controller";
import * as v from "../validators/earnings.validators";

export const earningsRouter = Router();
earningsRouter.use(authenticate);

// Role dashboards. A user who is both owner and driver sees each hat separately.
earningsRouter.get("/owner/summary", authorize("VEHICLE_OWNER"), validate(v.summarySchema), c.ownerSummary);
earningsRouter.get("/owner/entries", authorize("VEHICLE_OWNER"), validate(v.entriesSchema), c.ownerEntries);
earningsRouter.get("/driver/summary", authorize("DRIVER"), validate(v.summarySchema), c.driverSummary);
earningsRouter.get("/driver/entries", authorize("DRIVER"), validate(v.entriesSchema), c.driverEntries);
earningsRouter.get("/platform", authorize("ADMIN"), validate(v.summarySchema), c.platformSummary);

// One wallet per user: owner + driver earnings, minus withdrawals.
earningsRouter.get("/balance", c.balance);
earningsRouter.post("/payouts", validate(v.withdrawSchema), c.withdraw);
earningsRouter.get("/payouts", validate(v.listPayoutsSchema), c.listPayouts);

earningsRouter.post("/reconcile", authorize("ADMIN"), validate(v.reconcileSchema), c.reconcile);
