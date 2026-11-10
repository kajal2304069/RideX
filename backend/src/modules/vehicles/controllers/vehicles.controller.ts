import { asyncHandler } from "../../../common/asyncHandler";
import { sendSuccess } from "../../../common/ApiResponse";
import { vehiclesService } from "../services/vehicles.service";

export const vehiclesController = {
  lookupDriver: asyncHandler(async (req, res) => {
    const email = String(req.query.email ?? "").trim();
    sendSuccess(res, { driver: email ? await vehiclesService.lookupDriver(email) : null });
  }),
  listTypes: asyncHandler(async (_req, res) => {
    sendSuccess(res, { vehicleTypes: await vehiclesService.listTypes() });
  }),

  create: asyncHandler(async (req, res) => {
    const vehicle = await vehiclesService.create(req.user!.sub, req.body);
    sendSuccess(res, { vehicle }, 201);
  }),

  listMine: asyncHandler(async (req, res) => {
    const vehicles = await vehiclesService.listMine(req.user!.sub);
    sendSuccess(res, { vehicles });
  }),

  getOne: asyncHandler(async (req, res) => {
    const vehicle = await vehiclesService.getOwned(req.params.vehicleId, req.user!.sub);
    sendSuccess(res, { vehicle });
  }),

  update: asyncHandler(async (req, res) => {
    const vehicle = await vehiclesService.update(req.params.vehicleId, req.user!.sub, req.body);
    sendSuccess(res, { vehicle });
  }),

  updateStatus: asyncHandler(async (req, res) => {
    const vehicle = await vehiclesService.updateStatus(req.params.vehicleId, req.user!.sub, req.body.status);
    sendSuccess(res, { vehicle });
  }),

  assignDriver: asyncHandler(async (req, res) => {
    const assignment = await vehiclesService.assignDriver(req.params.vehicleId, req.user!.sub, req.body);
    sendSuccess(res, { assignment }, 201);
  }),

  unassignDriver: asyncHandler(async (req, res) => {
    await vehiclesService.unassignDriver(req.params.vehicleId, req.user!.sub);
    sendSuccess(res, { unassigned: true });
  }),
};
