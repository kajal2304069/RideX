import { Request } from "express";
import { asyncHandler } from "../../../common/asyncHandler";
import { sendSuccess } from "../../../common/ApiResponse";
import { adminListsRepository as lists } from "../repositories/adminLists.repository";
import { auditRepository } from "../repositories/audit.repository";
import { adminModerationService } from "../services/adminModeration.service";
import { adminUsersService } from "../services/adminUsers.service";
import { systemHealthService } from "../services/systemHealth.service";

const actor = (req: Request) => ({ id: req.user!.sub, ip: req.ip });
const q = <T>(req: Request) => req.query as unknown as T;

export const adminController = {
  listUsers: asyncHandler(async (req, res) => sendSuccess(res, await adminUsersService.list(q(req)))),
  getUser: asyncHandler(async (req, res) => sendSuccess(res, await adminUsersService.get(req.params.userId))),
  deactivateUser: asyncHandler(async (req, res) => sendSuccess(res, await adminUsersService.deactivate(actor(req), req.params.userId, req.body.reason))),
  activateUser: asyncHandler(async (req, res) => sendSuccess(res, await adminUsersService.activate(actor(req), req.params.userId, req.body.reason))),
  changeRoles: asyncHandler(async (req, res) => sendSuccess(res, await adminUsersService.changeRoles(actor(req), req.params.userId, req.body))),

  drivers: asyncHandler(async (req, res) => sendSuccess(res, await lists.drivers(q(req)))),
  vehicles: asyncHandler(async (req, res) => sendSuccess(res, await lists.vehicles(q(req)))),
  rides: asyncHandler(async (req, res) => sendSuccess(res, await lists.rides(q(req)))),
  rentals: asyncHandler(async (req, res) => sendSuccess(res, await lists.rentals(q(req)))),
  listings: asyncHandler(async (req, res) => sendSuccess(res, await lists.listings(q(req)))),
  garages: asyncHandler(async (req, res) => sendSuccess(res, await lists.garages(q(req)))),
  payments: asyncHandler(async (req, res) => sendSuccess(res, await lists.payments(q(req)))),

  removeListing: asyncHandler(async (req, res) => sendSuccess(res, await adminModerationService.removeListing(actor(req), req.params.listingId, req.body.reason))),
  restoreListing: asyncHandler(async (req, res) => sendSuccess(res, await adminModerationService.restoreListing(actor(req), req.params.listingId, req.body.reason))),
  deactivateGarage: asyncHandler(async (req, res) => sendSuccess(res, await adminModerationService.setGarageActive(actor(req), req.params.garageId, false, req.body.reason))),
  activateGarage: asyncHandler(async (req, res) => sendSuccess(res, await adminModerationService.setGarageActive(actor(req), req.params.garageId, true, req.body.reason))),

  auditLogs: asyncHandler(async (req, res) => sendSuccess(res, await auditRepository.list(q(req)))),
  systemHealth: asyncHandler(async (_req, res) => sendSuccess(res, await systemHealthService.report())),
};
