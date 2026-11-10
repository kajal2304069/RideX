import { auditService } from "../../admin/services/audit.service";
import { asyncHandler } from "../../../common/asyncHandler";
import { sendSuccess } from "../../../common/ApiResponse";
import { ApiError } from "../../../common/ApiError";
import { paymentsService } from "../services/payments.service";

export const paymentsController = {
  pay: asyncHandler(async (req, res) => {
    const key = req.header("Idempotency-Key");
    if (!key) throw ApiError.badRequest("Idempotency-Key header is required");

    const payment = await paymentsService.pay(req.user!.sub, {
      payableType: req.body.payableType,
      payableId: req.body.payableId,
      paymentMethodToken: req.body.paymentMethodToken,
      idempotencyKey: key,
    });

    // A declined card is a legitimate, completed attempt: report it with 402
    // so clients can branch on status code, and still return the payment.
    sendSuccess(res, { payment }, payment.status === "FAILED" ? 402 : 201);
  }),

  getOne: asyncHandler(async (req, res) => {
    const payment = await paymentsService.getOne(req.params.paymentId, req.user!.sub, req.user!.roles.includes("ADMIN"));
    sendSuccess(res, { payment });
  }),

  listMine: asyncHandler(async (req, res) => {
    const payments = await paymentsService.listMine(req.user!.sub);
    sendSuccess(res, { payments });
  }),

  refund: asyncHandler(async (req, res) => {
    const payment = await paymentsService.refund(req.params.paymentId);
    await auditService.recordAfter({ actorId: req.user!.sub, action: "payment.refunded", entityType: "payment", entityId: req.params.paymentId, metadata: { amount: payment.amount }, ip: req.ip });
    sendSuccess(res, { payment });
  }),
};
