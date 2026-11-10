import { asyncHandler } from "../../../common/asyncHandler";
import { sendSuccess } from "../../../common/ApiResponse";
import { garagesService } from "../services/garages.service";
import { GarageServiceType } from "../types/garages.types";

const isAdmin = (roles: string[]) => roles.includes("ADMIN");

export const garagesController = {
  create: asyncHandler(async (req, res) => {
    sendSuccess(res, { garage: await garagesService.create(req.user!.sub, req.body) }, 201);
  }),

  listMine: asyncHandler(async (req, res) => {
    sendSuccess(res, { garages: await garagesService.listMine(req.user!.sub) });
  }),

  nearby: asyncHandler(async (req, res) => {
    const q = req.query as unknown as { lat: number; lng: number; radiusMeters: number; serviceType?: GarageServiceType; limit: number };
    sendSuccess(res, { garages: await garagesService.nearby(q) });
  }),

  getOne: asyncHandler(async (req, res) => {
    sendSuccess(res, await garagesService.getOne(req.params.garageId, req.user?.sub, req.user ? isAdmin(req.user.roles) : false));
  }),

  update: asyncHandler(async (req, res) => {
    sendSuccess(res, { garage: await garagesService.update(req.params.garageId, req.user!.sub, req.body) });
  }),

  addService: asyncHandler(async (req, res) => {
    sendSuccess(res, { service: await garagesService.addService(req.params.garageId, req.user!.sub, req.body) }, 201);
  }),

  removeService: asyncHandler(async (req, res) => {
    await garagesService.removeService(req.params.garageId, req.user!.sub, req.params.serviceId);
    sendSuccess(res, { removed: true });
  }),

  addMechanic: asyncHandler(async (req, res) => {
    sendSuccess(res, { mechanic: await garagesService.addMechanic(req.params.garageId, req.user!.sub, req.body) }, 201);
  }),

  listMechanics: asyncHandler(async (req, res) => {
    sendSuccess(res, { mechanics: await garagesService.listMechanics(req.params.garageId, req.user!.sub, isAdmin(req.user!.roles)) });
  }),

  setMechanicActive: asyncHandler(async (req, res) => {
    sendSuccess(res, { mechanic: await garagesService.setMechanicActive(req.params.garageId, req.user!.sub, req.params.mechanicId, req.body.isActive) });
  }),
};
