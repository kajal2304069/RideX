import { Router } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { validate } from "../../../middleware/validate";
import { analyticsController as c } from "../controllers/analytics.controller";
import * as v from "../validators/analytics.validators";

export const analyticsRouter = Router();
analyticsRouter.use(authenticate, authorize("ADMIN"));

analyticsRouter.get("/overview", validate(v.overviewSchema), c.overview);
analyticsRouter.get("/timeseries", validate(v.timeseriesSchema), c.timeseries);
analyticsRouter.get("/revenue", validate(v.overviewSchema), c.revenue);
analyticsRouter.get("/leaderboards", validate(v.leaderboardSchema), c.leaderboards);
