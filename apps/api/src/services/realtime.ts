import type { FastifyInstance } from "fastify";
import { Server } from "socket.io";
import { config } from "../config.js";
import { prisma } from "../db.js";
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

  io.on("connection", async (socket) => {
    const session = socket.data.session as SessionToken;
    socket.join(`company:${session.companyId}`);
    socket.join(`user:${session.userId}`);
    try {
      const memberships = await prisma.communicationChannelMember.findMany({
        where: {
          companyId: session.companyId,
          userId: session.userId,
          canRead: true,
          channel: { active: true, archivedAt: null }
        },
        select: { channelId: true }
      });
      for (const membership of memberships) {
        socket.join(`channel:${membership.channelId}`);
      }
    } catch (error) {
      app.log.error(error);
    }
  });

  return io;
}

export function emitCompany(companyId: string, event: string, payload: unknown) {
  io?.to(`company:${companyId}`).emit(event, payload);
}

export function emitUser(userId: string, event: string, payload: unknown) {
  io?.to(`user:${userId}`).emit(event, payload);
}

export function emitChannel(channelId: string, event: string, payload: unknown) {
  io?.to(`channel:${channelId}`).emit(event, payload);
}
