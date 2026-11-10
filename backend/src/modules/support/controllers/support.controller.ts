import { asyncHandler } from "../../../common/asyncHandler";
import { sendSuccess } from "../../../common/ApiResponse";
import { supportService } from "../services/support.service";

const isStaff = (roles: string[]) => roles.includes("ADMIN");
const page = (q: unknown) => q as { limit: number; cursor?: string; status?: string; priority?: string };

export const supportController = {
  create: asyncHandler(async (req, res) => sendSuccess(res, { ticket: await supportService.create(req.user!.sub, req.body) }, 201)),
  listMine: asyncHandler(async (req, res) => { const q = page(req.query); sendSuccess(res, await supportService.listMine(req.user!.sub, q.limit, q.cursor)); }),
  listAll: asyncHandler(async (req, res) => { const q = page(req.query); sendSuccess(res, await supportService.listAll({ status: q.status, priority: q.priority }, q.limit, q.cursor)); }),
  get: asyncHandler(async (req, res) => sendSuccess(res, await supportService.get(req.params.ticketId, req.user!.sub, isStaff(req.user!.roles)))),
  reply: asyncHandler(async (req, res) => sendSuccess(res, { message: await supportService.reply(req.params.ticketId, req.user!.sub, isStaff(req.user!.roles), req.body.body) }, 201)),
  update: asyncHandler(async (req, res) => sendSuccess(res, { ticket: await supportService.update({ id: req.user!.sub, ip: req.ip }, req.params.ticketId, req.body) })),
};
