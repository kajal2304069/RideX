import { ApiError } from "../../src/common/ApiError";

describe("ApiError", () => {
  it("builds a 404 not-found error with correct code", () => {
    const err = ApiError.notFound("Ride not found");
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("Ride not found");
    expect(err.isOperational).toBe(true);
  });

  it("builds a 409 conflict error and preserves details", () => {
    const err = ApiError.conflict("Ride already assigned", { rideId: "abc123" });
    expect(err.statusCode).toBe(409);
    expect(err.details).toEqual({ rideId: "abc123" });
  });

  it("is an instance of Error so it can be thrown/caught normally", () => {
    const err = ApiError.badRequest("bad input");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApiError);
  });
});
