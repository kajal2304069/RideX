import { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken } from "../../src/common/jwt";

describe("JWT utilities", () => {
  it("signs and verifies an access token, round-tripping sub and roles", () => {
    const token = signAccessToken("user-123", ["RIDER", "DRIVER"]);
    const decoded = verifyAccessToken(token);
    expect(decoded.sub).toBe("user-123");
    expect(decoded.roles).toEqual(["RIDER", "DRIVER"]);
    expect(decoded.type).toBe("access");
  });

  it("signs and verifies a refresh token, round-tripping sub and jti", () => {
    const token = signRefreshToken("user-123", "token-id-456");
    const decoded = verifyRefreshToken(token);
    expect(decoded.sub).toBe("user-123");
    expect(decoded.jti).toBe("token-id-456");
    expect(decoded.type).toBe("refresh");
  });

  it("rejects an access token when verified as a refresh token", () => {
    const accessToken = signAccessToken("user-123", ["RIDER"]);
    expect(() => verifyRefreshToken(accessToken)).toThrow();
  });

  it("rejects a refresh token when verified as an access token", () => {
    const refreshToken = signRefreshToken("user-123", "token-id");
    expect(() => verifyAccessToken(refreshToken)).toThrow();
  });

  it("rejects a garbage token", () => {
    expect(() => verifyAccessToken("not.a.jwt")).toThrow();
  });
});
