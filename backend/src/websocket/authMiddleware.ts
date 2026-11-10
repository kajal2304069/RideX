import { Socket } from "socket.io";
import { isTokenRevoked } from "../common/tokenRevocation";
import { verifyAccessToken } from "../common/jwt";
import { UserRole } from "../modules/auth/types/auth.types";

export interface AuthenticatedSocketData {
  userId: string;
  roles: UserRole[];
}

/** A Socket.IO socket whose `data` has been populated by socketAuthMiddleware. Used as the type throughout the websocket layer instead of augmenting Socket.IO's generic `SocketData` type param directly. */
export type AuthenticatedSocket = Socket<any, any, any, AuthenticatedSocketData>;

/**
 * Authenticates the WebSocket handshake using the SAME access tokens
 * issued by REST login/refresh (Phase 2) - one token type serves both
 * transports, so a client doesn't need a separate socket-specific auth
 * flow. The token is expected in `socket.handshake.auth.token` (the
 * standard Socket.IO client convention: `io(url, { auth: { token } })`),
 * not a header, since the initial handshake is a plain HTTP upgrade
 * request where custom headers are more awkward for browser clients to
 * set than the `auth` payload Socket.IO provides for exactly this
 * purpose.
 *
 * Rejecting here (calling `next(error)`) refuses the connection before
 * it's ever established - an unauthenticated client never gets a
 * socket at all, the same way an unauthenticated REST request never
 * reaches a controller.
 */
export function socketAuthMiddleware(socket: AuthenticatedSocket, next: (err?: Error) => void): void {
  const token = socket.handshake.auth?.token as string | undefined;

  if (!token) {
    return next(new Error("Authentication required: no token provided"));
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return next(new Error("Authentication failed: invalid or expired token"));
  }
  isTokenRevoked(payload.sub, payload.iat).then(
    (revoked) => {
      if (revoked) return next(new Error("Authentication failed: session is no longer valid"));
      socket.data = { userId: payload.sub, roles: payload.roles as UserRole[] };
      next();
    },
    () => next(new Error("Authentication failed"))
  );
}
