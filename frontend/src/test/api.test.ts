import { beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import MockAdapter from "axios-mock-adapter";
import { api, errorMessage, get, tokenStore } from "@/lib/api";

describe("api client", () => {
  let mock: MockAdapter; let raw: MockAdapter;
  beforeEach(() => { mock = new MockAdapter(api); raw = new MockAdapter(axios); tokenStore.set(null); });

  it("unwraps the success envelope", async () => {
    mock.onGet("/x").reply(200, { success: true, data: { a: 1 } });
    expect(await get("/x")).toEqual({ a: 1 });
  });

  it("sends the bearer token", async () => {
    tokenStore.set("tok");
    mock.onGet("/me").reply((c) => [200, { success: true, data: { auth: c.headers?.Authorization } }]);
    expect(await get("/me")).toEqual({ auth: "Bearer tok" });
  });

  it("refreshes once for many concurrent 401s and retries each", async () => {
    tokenStore.set("old");
    let refreshes = 0;
    raw.onPost("/api/auth/refresh").reply(() => { refreshes++; return [200, { success: true, data: { accessToken: "new" } }]; });
    mock.onGet("/a").reply((c) => (c.headers?.Authorization === "Bearer new" ? [200, { success: true, data: "A" }] : [401, { success: false, error: { code: "UNAUTHORIZED", message: "x" } }]));
    mock.onGet("/b").reply((c) => (c.headers?.Authorization === "Bearer new" ? [200, { success: true, data: "B" }] : [401, { success: false, error: { code: "UNAUTHORIZED", message: "x" } }]));
    const [a, b] = await Promise.all([get("/a"), get("/b")]);
    expect([a, b]).toEqual(["A", "B"]);
    expect(refreshes).toBe(1);
  });

  it("turns validation errors into a readable message", () => {
    const e = { isAxiosError: true, response: { data: { error: { code: "VALIDATION_ERROR", message: "Invalid", details: { fieldErrors: { email: ["Invalid email"] } } } } } };
    expect(errorMessage(e)).toContain("Invalid email");
  });
  it("falls back for unknown errors", () => expect(errorMessage(new Error("boom"))).toBe("boom"));
  void vi;
});
