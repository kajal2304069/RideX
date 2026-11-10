import { Router } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { validate } from "../../../middleware/validate";
import { adminController as c } from "../controllers/admin.controller";
import * as v from "../validators/admin.validators";

export const adminRouter = Router();

// Every admin route needs a valid session AND the ADMIN role. Applied once, here, so a new route cannot forget it.
adminRouter.use(authenticate, authorize("ADMIN"));

// users
adminRouter.get("/users", validate(v.listUsersSchema), c.listUsers);
adminRouter.get("/users/:userId", validate(v.userIdParam), c.getUser);
adminRouter.post("/users/:userId/deactivate", validate(v.reasonBody), c.deactivateUser);
adminRouter.post("/users/:userId/activate", validate(v.reasonBody), c.activateUser);
adminRouter.post("/users/:userId/roles", validate(v.changeRolesSchema), c.changeRoles);

// operational lists
adminRouter.get("/drivers", validate(v.listDriversSchema), c.drivers);
adminRouter.get("/vehicles", validate(v.listVehiclesSchema), c.vehicles);
adminRouter.get("/rides", validate(v.listRidesSchema), c.rides);
adminRouter.get("/rentals", validate(v.listRentalsSchema), c.rentals);
adminRouter.get("/payments", validate(v.listPaymentsSchema), c.payments);

// marketplace + garage moderation
adminRouter.get("/listings", validate(v.listListingsSchema), c.listings);
adminRouter.post("/listings/:listingId/remove", validate(v.listingReasonSchema), c.removeListing);
adminRouter.post("/listings/:listingId/restore", validate(v.listingReasonSchema), c.restoreListing);
adminRouter.get("/garages", validate(v.listGaragesSchema), c.garages);
adminRouter.post("/garages/:garageId/deactivate", validate(v.garageReasonSchema), c.deactivateGarage);
adminRouter.post("/garages/:garageId/activate", validate(v.garageReasonSchema), c.activateGarage);

// accountability + health
adminRouter.get("/audit-logs", validate(v.auditLogsSchema), c.auditLogs);
adminRouter.get("/system/health", c.systemHealth);
