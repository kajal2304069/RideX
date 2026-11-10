import { asyncHandler } from "../../../common/asyncHandler";
import { sendSuccess } from "../../../common/ApiResponse";
import { repairsService } from "../services/repairs.service";
import { BookingStatus } from "../types/repairs.types";

const isAdmin = (roles: string[]) => roles.includes("ADMIN");

export const repairsController = {
  create: asyncHandler(async (req, res) => {
    sendSuccess(res, { booking: await repairsService.create(req.user!.sub, req.body) }, 201);
  }),
  emergency: asyncHandler(async (req, res) => {
    sendSuccess(res, { booking: await repairsService.createEmergency(req.user!.sub, req.body) }, 201);
  }),
  listMine: asyncHandler(async (req, res) => {
    sendSuccess(res, { bookings: await repairsService.listMine(req.user!.sub) });
  }),
  listForGarage: asyncHandler(async (req, res) => {
    const status = (req.query as { status?: BookingStatus }).status;
    sendSuccess(res, { bookings: await repairsService.listForGarage(req.params.garageId, req.user!.sub, status) });
  }),
  getOne: asyncHandler(async (req, res) => {
    sendSuccess(res, await repairsService.getOne(req.params.bookingId, req.user!.sub, isAdmin(req.user!.roles)));
  }),
  accept: asyncHandler(async (req, res) => {
    sendSuccess(res, { booking: await repairsService.accept(req.params.bookingId, req.user!.sub) });
  }),
  assignMechanic: asyncHandler(async (req, res) => {
    sendSuccess(res, { booking: await repairsService.assignMechanic(req.params.bookingId, req.user!.sub, req.body.mechanicId) });
  }),
  vehicleReceived: asyncHandler(async (req, res) => {
    sendSuccess(res, { booking: await repairsService.markVehicleReceived(req.params.bookingId, req.user!.sub) });
  }),
  startRepair: asyncHandler(async (req, res) => {
    sendSuccess(res, { booking: await repairsService.startRepair(req.params.bookingId, req.user!.sub) });
  }),
  updateRepairOrder: asyncHandler(async (req, res) => {
    sendSuccess(res, { repairOrder: await repairsService.updateRepairOrder(req.params.bookingId, req.user!.sub, req.body) });
  }),
  ready: asyncHandler(async (req, res) => {
    sendSuccess(res, { booking: await repairsService.markReady(req.params.bookingId, req.user!.sub) });
  }),
  cancel: asyncHandler(async (req, res) => {
    sendSuccess(res, { booking: await repairsService.cancel(req.params.bookingId, req.user!.sub) });
  }),
  maintenance: asyncHandler(async (req, res) => {
    sendSuccess(res, { records: await repairsService.maintenanceHistory(req.params.vehicleId, req.user!.sub, isAdmin(req.user!.roles)) });
  }),
};
