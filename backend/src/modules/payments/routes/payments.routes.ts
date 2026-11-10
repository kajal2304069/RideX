import { Router } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { validate } from "../../../middleware/validate";
import { paymentsController } from "../controllers/payments.controller";
import { createPaymentSchema, paymentIdParamSchema } from "../validators/payments.validators";

export const paymentsRouter = Router();

paymentsRouter.post("/", authenticate, validate(createPaymentSchema), paymentsController.pay);
paymentsRouter.get("/", authenticate, paymentsController.listMine);
paymentsRouter.get("/:paymentId", authenticate, validate(paymentIdParamSchema), paymentsController.getOne);
paymentsRouter.post("/:paymentId/refund", authenticate, authorize("ADMIN"), validate(paymentIdParamSchema), paymentsController.refund);
