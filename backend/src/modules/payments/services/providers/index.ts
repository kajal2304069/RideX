import { env } from "../../../../config/env";
import { MockPaymentProvider } from "./MockPaymentProvider";
import { PaymentProvider } from "./PaymentProvider";
import { StripePaymentProvider } from "./StripePaymentProvider";

export type { PaymentProvider } from "./PaymentProvider";

let instance: PaymentProvider | null = null;

/** Single provider instance per process, chosen by PAYMENT_PROVIDER. */
export function getPaymentProvider(): PaymentProvider {
  if (!instance) {
    instance = env.PAYMENT_PROVIDER === "stripe" ? new StripePaymentProvider(env.STRIPE_SECRET_KEY) : new MockPaymentProvider();
  }
  return instance;
}

/** Test hook: swap the provider (e.g. a slow mock to widen race windows). */
export function setPaymentProviderForTests(provider: PaymentProvider | null) {
  instance = provider;
}
