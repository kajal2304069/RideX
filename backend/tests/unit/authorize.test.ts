import { Request, Response } from "express";
import { authorize } from "../../src/middleware/auth";
import { ApiError } from "../../src/common/ApiError";

function mockReq(user?: { sub: string; roles: string[] }): Request {
  return { user } as unknown as Request;
}

describe("authorize() middleware (RBAC)", () => {
  it("calls next() with no error when the user has one of the allowed roles", () => {
    const req = mockReq({ sub: "u1", roles: ["RIDER", "VEHICLE_OWNER"] });
    const next = jest.fn();

    authorize("VEHICLE_OWNER" as never, "GARAGE_OWNER" as never)(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith(); // called with no args = success
  });

  it("calls next(ApiError.forbidden) when the user has none of the allowed roles", () => {
    const req = mockReq({ sub: "u1", roles: ["RIDER"] });
    const next = jest.fn();

    authorize("ADMIN" as never)(req, {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    const errArg = next.mock.calls[0][0];
    expect(errArg).toBeInstanceOf(ApiError);
    expect(errArg.statusCode).toBe(403);
  });

  it("calls next(ApiError.unauthorized) when req.user is missing (not authenticated)", () => {
    const req = mockReq(undefined);
    const next = jest.fn();

    authorize("RIDER" as never)(req, {} as Response, next);

    const errArg = next.mock.calls[0][0];
    expect(errArg).toBeInstanceOf(ApiError);
    expect(errArg.statusCode).toBe(401);
  });

  it("allows access with a UNION check - only one matching role is required", () => {
    const req = mockReq({ sub: "u1", roles: ["SELLER"] });
    const next = jest.fn();

    authorize("BUYER" as never, "SELLER" as never)(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
  });
});
