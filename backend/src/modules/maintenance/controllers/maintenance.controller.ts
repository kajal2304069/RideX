import { asyncHandler } from "../../../common/asyncHandler";
import { sendSuccess } from "../../../common/ApiResponse";
import { auditService } from "../../admin/services/audit.service";
import { maintenanceService as s } from "../services/maintenance.service";

export const maintenanceController = {
  overview: asyncHandler(async (req, res) => sendSuccess(res, await s.overview(req.user!.sub, req.params.vehicleId))),
  addRecord: asyncHandler(async (req, res) => sendSuccess(res, { record: await s.addRecord(req.user!.sub, req.params.vehicleId, req.body) }, 201)),
  addDocument: asyncHandler(async (req, res) => sendSuccess(res, { document: await s.addDocument(req.user!.sub, req.params.vehicleId, req.body) }, 201)),
  deleteDocument: asyncHandler(async (req, res) => { await s.deleteDocument(req.user!.sub, req.params.vehicleId, req.params.documentId); res.status(204).end(); }),
  addIncident: asyncHandler(async (req, res) => sendSuccess(res, { incident: await s.addIncident(req.user!.sub, req.params.vehicleId, req.body) }, 201)),
  upcoming: asyncHandler(async (req, res) => sendSuccess(res, await s.upcoming(req.user!.sub))),
  scan: asyncHandler(async (req, res) => {
    const result = await s.scan();
    await auditService.recordAfter({ actorId: req.user!.sub, action: "maintenance.scan_run", metadata: result, ip: req.ip });
    sendSuccess(res, { scan: result });
  }),
};
