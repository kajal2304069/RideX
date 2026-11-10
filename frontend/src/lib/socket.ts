import { io, Socket } from "socket.io-client";
import { tokenStore } from "./api";

/** One socket per signed-in session. The same access token that authorises REST authorises the handshake. */
let socket: Socket | null = null;

export function connectSocket(): Socket {
  if (socket) return socket;
  socket = io("/", {
    auth: (cb) => cb({ token: tokenStore.get() }), // re-read the token on every (re)connect attempt
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionDelay: 800,
    reconnectionDelayMax: 8000,
  });
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}
