import { z } from "zod";

export const createPaymentSchema = z.object({
  body: z.object({
    payableType: z.enum(["RIDE", "RENTAL", "MARKETPLACE", "GARAGE_SERVICE"]),
    payableId: z.string().uuid(),
    // Opaque token from the provider's client SDK. Raw card numbers are never accepted.
    paymentMethodToken: z.string().min(3).max(200),
    // NOTE: no `amount` field on purpose. The server computes what is owed.
  }).strict(),
});

export const paymentIdParamSchema = z.object({
  params: z.object({ paymentId: z.string().uuid() }),
});
