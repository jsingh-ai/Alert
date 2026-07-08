import type { FastifyInstance } from "fastify";
import { Server } from "socket.io";
import { config } from "../config.js";
import type { SessionToken } from "./auth.js";

let io: Server | null = null;

export function setupRealtime(app: FastifyInstance) {
  io = new Server(app.server, {
    cors: {
      origin: config.corsOrigin,
      credentials: true
    }
  });

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token || Array.isArray(token)) return next(new Error("Missing token"));
      const session = app.jwt.verify<SessionToken>(token);
      socket.data.session = session;
      next();
    } catch {
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", (socket) => {
    const session = socket.data.session as SessionToken;
    socket.join(`company:${session.companyId}`);
    socket.join(`user:${session.userId}`);
  });

  return io;
}

export function emitCompany(companyId: string, event: string, payload: unknown) {
  io?.to(`company:${companyId}`).emit(event, payload);
}
