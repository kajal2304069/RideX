import { auditService } from "../../admin/services/audit.service";
import { asyncHandler } from "../../../common/asyncHandler";
import { sendSuccess } from "../../../common/ApiResponse";
import { driversService } from "../services/drivers.service";

export const driversController = {
  onboard: asyncHandler(async (req, res) => {
    const driver = await driversService.onboard(req.user!.sub, req.body);
    sendSuccess(res, { driver }, 201);
  }),

  me: asyncHandler(async (req, res) => {
    const driver = await driversService.getMyProfile(req.user!.sub);
    sendSuccess(res, { driver });
  }),

  goOnline: asyncHandler(async (req, res) => {
    const driver = await driversService.goOnline(req.user!.sub);
    sendSuccess(res, { driver });
  }),

  goOffline: asyncHandler(async (req, res) => {
    const driver = await driversService.goOffline(req.user!.sub);
    sendSuccess(res, { driver });
  }),

  listPending: asyncHandler(async (_req, res) => {
    const drivers = await driversService.listPendingVerification();
    sendSuccess(res, { drivers });
  }),

  setVerification: asyncHandler(async (req, res) => {
    const driver = await driversService.setVerification(
      req.params.driverId,
      req.body.status,
      req.user!.sub
    );
    await auditService.recordAfter({ actorId: req.user!.sub, action: "driver.verification_set", entityType: "driver", entityId: req.params.driverId, metadata: { status: req.body.status }, ip: req.ip });
    sendSuccess(res, { driver });
  }),
};
