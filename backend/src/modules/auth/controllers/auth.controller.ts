import { Request, Response } from "express";
import { asyncHandler } from "../../../common/asyncHandler";
import { sendSuccess } from "../../../common/ApiResponse";
import { ApiError } from "../../../common/ApiError";
import { authService } from "../services/auth.service";
import { env } from "../../../config/env";

const REFRESH_COOKIE = "ridex_refresh_token";

function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true, // not readable by client-side JS - mitigates XSS token theft
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/auth", // only sent to auth endpoints, not every request
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE, { path: "/api/auth" });
}

function requestMeta(req: Request) {
  return { userAgent: req.header("user-agent"), ip: req.ip };
}

export const authController = {
  register: asyncHandler(async (req, res) => {
    const { user, tokens } = await authService.register(req.body);
    setRefreshCookie(res, tokens.refreshToken);
    sendSuccess(res, { user, accessToken: tokens.accessToken }, 201);
  }),

  login: asyncHandler(async (req, res) => {
    const { user, tokens } = await authService.login(req.body.email, req.body.password, requestMeta(req));
    setRefreshCookie(res, tokens.refreshToken);
    sendSuccess(res, { user, accessToken: tokens.accessToken });
  }),

  refresh: asyncHandler(async (req, res) => {
    const raw = req.cookies?.[REFRESH_COOKIE] ?? req.body?.refreshToken;
    if (!raw) throw ApiError.unauthorized("No refresh token provided");

    const tokens = await authService.refresh(raw, requestMeta(req));
    setRefreshCookie(res, tokens.refreshToken);
    sendSuccess(res, { accessToken: tokens.accessToken });
  }),

  logout: asyncHandler(async (req, res) => {
    const raw = req.cookies?.[REFRESH_COOKIE] ?? req.body?.refreshToken;
    if (raw) await authService.logout(raw);
    clearRefreshCookie(res);
    sendSuccess(res, { loggedOut: true });
  }),

  me: asyncHandler(async (req, res) => {
    // req.user is populated by the `authenticate` middleware (routes/auth.routes.ts)
    const user = await authService.getPublicUser(req.user!.sub);
    sendSuccess(res, { user });
  }),
};
