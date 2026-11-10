import { auditService } from "../../admin/services/audit.service";
import { ApiError } from "../../../common/ApiError";
import { asyncHandler } from "../../../common/asyncHandler";
import { sendSuccess } from "../../../common/ApiResponse";
import { earningsService } from "../services/earnings.service";
import { payoutsService } from "../services/payouts.service";

const range = (q: unknown) => q as { from?: Date; to?: Date };
const page = (q: unknown) => q as { limit: number; cursor?: string };

export const earningsController = {
  ownerSummary: asyncHandler(async (req, res) => sendSuccess(res, await earningsService.ownerSummary(req.user!.sub, range(req.query)))),
  ownerEntries: asyncHandler(async (req, res) => {
    const q = page(req.query);
    sendSuccess(res, await earningsService.ownerEntries(req.user!.sub, q.limit, q.cursor));
  }),
  driverSummary: asyncHandler(async (req, res) => sendSuccess(res, await earningsService.driverSummary(req.user!.sub, range(req.query)))),
  driverEntries: asyncHandler(async (req, res) => {
    const q = page(req.query);
    sendSuccess(res, await earningsService.driverEntries(req.user!.sub, q.limit, q.cursor));
  }),
  platformSummary: asyncHandler(async (req, res) => sendSuccess(res, await earningsService.platformSummary(range(req.query)))),
  balance: asyncHandler(async (req, res) => sendSuccess(res, { balance: await earningsService.balance(req.user!.sub) })),

  withdraw: asyncHandler(async (req, res) => {
    const key = req.header("Idempotency-Key");
    if (!key) throw ApiError.badRequest("Idempotency-Key header is required");
    if (key.length > 200) throw ApiError.badRequest("Idempotency-Key is too long");
    sendSuccess(res, { payout: await payoutsService.withdraw(req.user!.sub, { amount: req.body.amount, idempotencyKey: key }) }, 201);
  }),
  listPayouts: asyncHandler(async (req, res) => sendSuccess(res, { payouts: await payoutsService.listMine(req.user!.sub, page(req.query).limit) })),
  reconcile: asyncHandler(async (req, res) => {
    const reconciled = await earningsService.reconcile(req.body.limit);
    await auditService.recordAfter({ actorId: req.user!.sub, action: "earnings.reconciled", metadata: reconciled, ip: req.ip });
    sendSuccess(res, { reconciled });
  }),
};
