import { MockPaymentProvider } from "../../src/modules/payments/services/providers/MockPaymentProvider";
import { PaymentRecord } from "../../src/modules/payments/types/payments.types";

// --- Mocks: the service is tested in isolation from Postgres, Redis and rides ---
jest.mock("../../src/common/redisLock", () => ({
  withLock: jest.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
}));
jest.mock("../../src/modules/payments/repositories/payments.repository", () => ({
  paymentsRepository: {
    findById: jest.fn(),
    findByIdempotencyKey: jest.fn(),
    findLiveByPayable: jest.fn(),
    findByPayer: jest.fn(),
    createPending: jest.fn(),
    transition: jest.fn(),
  },
}));
jest.mock("../../src/modules/payments/services/payableResolvers", () => ({ getPayableResolver: jest.fn() }));
jest.mock("../../src/modules/payments/services/providers", () => ({ getPaymentProvider: jest.fn() }));
jest.mock("../../src/config/logger", () => ({ logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() } }));

import { paymentsRepository } from "../../src/modules/payments/repositories/payments.repository";
import { getPayableResolver } from "../../src/modules/payments/services/payableResolvers";
import { getPaymentProvider } from "../../src/modules/payments/services/providers";
import { paymentsService } from "../../src/modules/payments/services/payments.service";
import { withLock } from "../../src/common/redisLock";

const repo = paymentsRepository as jest.Mocked<typeof paymentsRepository>;
const mockedResolver = getPayableResolver as jest.Mock;
const mockedProvider = getPaymentProvider as jest.Mock;

const RIDE_ID = "11111111-1111-1111-1111-111111111111";
const PAYER = "22222222-2222-2222-2222-222222222222";

function record(over: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: "pay-1",
    payable_type: "RIDE",
    payable_id: RIDE_ID,
    payer_id: PAYER,
    amount: "120.00",
    currency: "INR",
    provider: "mock",
    provider_reference: null,
    status: "PENDING",
    idempotency_key: `${PAYER}:key-12345678`,
    failure_reason: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}

const input = { payableType: "RIDE" as const, payableId: RIDE_ID, paymentMethodToken: "tok_mock_success", idempotencyKey: "key-12345678" };

let provider: MockPaymentProvider;
let resolver: { resolve: jest.Mock; onSuccess: jest.Mock };

beforeEach(() => {
  jest.resetAllMocks();
  // resetAllMocks also wipes the module-factory implementation, so restore the pass-through lock.
  (withLock as jest.Mock).mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn());
  provider = new MockPaymentProvider();
  mockedProvider.mockReturnValue(provider);
  resolver = { resolve: jest.fn().mockResolvedValue({ payerId: PAYER, amount: 120, currency: "INR" }), onSuccess: jest.fn().mockResolvedValue(undefined) };
  mockedResolver.mockReturnValue(resolver);

  repo.findByIdempotencyKey.mockResolvedValue(null);
  repo.findLiveByPayable.mockResolvedValue(null);
  repo.createPending.mockResolvedValue(record());
  // transition() echoes the target status back, like the real conditional UPDATE
  repo.transition.mockImplementation(async (_id, _from, to, extra) =>
    record({ status: to, provider_reference: extra?.providerReference ?? null, failure_reason: extra?.failureReason ?? null })
  );
});

describe("MockPaymentProvider", () => {
  it("returns the same reference for the same idempotency key", async () => {
    const a = await provider.charge({ amount: 1, currency: "INR", paymentMethodToken: "tok_x", idempotencyKey: "k1" });
    const b = await provider.charge({ amount: 1, currency: "INR", paymentMethodToken: "tok_x", idempotencyKey: "k1" });
    expect(a).toEqual(b);
  });

  it.each([
    ["tok_mock_decline", "card_declined"],
    ["tok_mock_funds", "insufficient_funds"],
  ])("%s fails with %s", async (token, reason) => {
    const r = await provider.charge({ amount: 1, currency: "INR", paymentMethodToken: token, idempotencyKey: "k" });
    expect(r).toEqual({ status: "FAILED", failureReason: reason });
  });

  it("tok_mock_error throws", async () => {
    await expect(provider.charge({ amount: 1, currency: "INR", paymentMethodToken: "tok_mock_error", idempotencyKey: "k" })).rejects.toThrow();
  });
});

describe("paymentsService.pay", () => {
  it("charges the server-computed amount and marks SUCCESS, then runs the payable's follow-up", async () => {
    const out = await paymentsService.pay(PAYER, input);

    expect(repo.createPending).toHaveBeenCalledWith(expect.objectContaining({ amount: 120, idempotencyKey: `${PAYER}:key-12345678` }));
    expect(provider.chargeCalls).toBe(1);
    expect(out.status).toBe("SUCCESS");
    expect(out.providerReference).toMatch(/^mock_ch_/);
    expect(resolver.onSuccess).toHaveBeenCalledWith(RIDE_ID);
  });

  it("rejects a too-short Idempotency-Key before doing anything", async () => {
    await expect(paymentsService.pay(PAYER, { ...input, idempotencyKey: "short" })).rejects.toMatchObject({ statusCode: 400 });
    expect(repo.createPending).not.toHaveBeenCalled();
  });

  it("returns the original payment on a replayed key without charging again", async () => {
    repo.findByIdempotencyKey.mockResolvedValue(record({ status: "FAILED", failure_reason: "card_declined" }));

    const out = await paymentsService.pay(PAYER, input);

    expect(out.status).toBe("FAILED");
    expect(provider.chargeCalls).toBe(0);
    expect(repo.createPending).not.toHaveBeenCalled();
  });

  it("409s when a key is reused for a different payable", async () => {
    repo.findByIdempotencyKey.mockResolvedValue(record({ payable_id: "33333333-3333-3333-3333-333333333333" }));
    await expect(paymentsService.pay(PAYER, input)).rejects.toMatchObject({ statusCode: 409 });
    expect(provider.chargeCalls).toBe(0);
  });

  it("404s when someone other than the payer tries to pay (does not leak existence)", async () => {
    resolver.resolve.mockResolvedValue({ payerId: "someone-else", amount: 120, currency: "INR" });
    await expect(paymentsService.pay(PAYER, input)).rejects.toMatchObject({ statusCode: 404 });
    expect(provider.chargeCalls).toBe(0);
  });

  it("409s when the payable already has a live payment under a different key", async () => {
    repo.findLiveByPayable.mockResolvedValue(record({ status: "SUCCESS", idempotency_key: "other" }));
    await expect(paymentsService.pay(PAYER, input)).rejects.toMatchObject({ statusCode: 409 });
    expect(provider.chargeCalls).toBe(0);
  });

  it("maps a DB unique violation (lock failure backstop) to the winner's payment", async () => {
    repo.createPending.mockRejectedValue({ code: "23505" });
    repo.findByIdempotencyKey.mockResolvedValueOnce(null).mockResolvedValueOnce(record({ status: "SUCCESS" }));

    const out = await paymentsService.pay(PAYER, input);

    expect(out.status).toBe("SUCCESS");
    expect(provider.chargeCalls).toBe(0);
  });

  it("maps a unique violation with no matching key to 409", async () => {
    repo.createPending.mockRejectedValue({ code: "23505" });
    await expect(paymentsService.pay(PAYER, input)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("marks FAILED on a decline and does NOT run the payable's follow-up", async () => {
    const out = await paymentsService.pay(PAYER, { ...input, paymentMethodToken: "tok_mock_decline" });

    expect(out.status).toBe("FAILED");
    expect(out.failureReason).toBe("card_declined");
    expect(resolver.onSuccess).not.toHaveBeenCalled();
  });

  it("leaves the payment PROCESSING (never FAILED) when the provider call errors, and returns 502", async () => {
    await expect(paymentsService.pay(PAYER, { ...input, paymentMethodToken: "tok_mock_error" })).rejects.toMatchObject({ statusCode: 502 });

    const targets = repo.transition.mock.calls.map((c) => c[2]);
    expect(targets).toEqual(["PROCESSING"]); // no FAILED/SUCCESS write
    expect(resolver.onSuccess).not.toHaveBeenCalled();
  });

  it("re-drives a PROCESSING payment on retry with the same key", async () => {
    repo.findByIdempotencyKey.mockResolvedValue(record({ status: "PROCESSING" }));

    const out = await paymentsService.pay(PAYER, input);

    expect(out.status).toBe("SUCCESS");
    expect(provider.chargeCalls).toBe(1);
    expect(repo.createPending).not.toHaveBeenCalled();
  });

  it("re-runs the idempotent follow-up when replaying an already-SUCCESS payment", async () => {
    repo.findByIdempotencyKey.mockResolvedValue(record({ status: "SUCCESS", provider_reference: "mock_ch_x" }));

    const out = await paymentsService.pay(PAYER, input);

    expect(out.status).toBe("SUCCESS");
    expect(provider.chargeCalls).toBe(0);
    expect(resolver.onSuccess).toHaveBeenCalledTimes(1);
  });
});

describe("paymentsService.refund", () => {
  it("refunds a SUCCESS payment", async () => {
    repo.findById.mockResolvedValue(record({ status: "SUCCESS", provider_reference: "mock_ch_x" }));
    const out = await paymentsService.refund("pay-1");
    expect(out.status).toBe("REFUNDED");
  });

  it("409s for a payment that is not SUCCESS", async () => {
    repo.findById.mockResolvedValue(record({ status: "FAILED" }));
    await expect(paymentsService.refund("pay-1")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("409s if another refund wins the conditional update", async () => {
    repo.findById.mockResolvedValue(record({ status: "SUCCESS", provider_reference: "mock_ch_x" }));
    repo.transition.mockResolvedValue(null);
    await expect(paymentsService.refund("pay-1")).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("paymentsService.getOne", () => {
  it("hides other users' payments (404) but lets admins see them", async () => {
    repo.findById.mockResolvedValue(record());
    await expect(paymentsService.getOne("pay-1", "stranger", false)).rejects.toMatchObject({ statusCode: 404 });
    await expect(paymentsService.getOne("pay-1", "stranger", true)).resolves.toMatchObject({ id: "pay-1" });
  });
});
