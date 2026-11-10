import { Router } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { validate } from "../../../middleware/validate";
import { maintenanceController as c } from "../controllers/maintenance.controller";
import * as v from "../validators/maintenance.validators";

export const maintenanceRouter = Router();
maintenanceRouter.use(authenticate);

maintenanceRouter.post("/scan", authorize("ADMIN"), c.scan);

const owner = authorize("VEHICLE_OWNER");
maintenanceRouter.get("/upcoming", owner, c.upcoming);
maintenanceRouter.get("/vehicles/:vehicleId", owner, validate(v.vehicleParam), c.overview);
maintenanceRouter.post("/vehicles/:vehicleId/records", owner, validate(v.addRecordSchema), c.addRecord);
maintenanceRouter.post("/vehicles/:vehicleId/documents", owner, validate(v.addDocumentSchema), c.addDocument);
maintenanceRouter.delete("/vehicles/:vehicleId/documents/:documentId", owner, validate(v.deleteDocumentSchema), c.deleteDocument);
maintenanceRouter.post("/vehicles/:vehicleId/incidents", owner, validate(v.addIncidentSchema), c.addIncident);
