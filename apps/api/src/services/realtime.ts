import type { FastifyInstance } from "fastify";
import { Server } from "socket.io";
import type { Socket } from "socket.io";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { getMembershipContext } from "./auth.js";
import type { MembershipContext, SessionToken } from "./auth.js";

let io: Server | null = null;

type VerifiedSessionToken = SessionToken & { exp?: number };

async function validateSession(session: SessionToken) {
  const membership = await getMembershipContext(session.membershipId);
  if (!membership || !membership.active || !membership.user.active || !membership.company.active) return null;
  if (membership.userId !== session.userId || membership.companyId !== session.companyId || membership.role !== session.role) return null;
  return membership;
}

function userRoom(companyId: string, userId: string) {
  return `user:${companyId}:${userId}`;
}

async function joinReadableChannelRooms(socket: Pick<Socket, "rooms" | "join" | "leave">, companyId: string, userId: string) {
  for (const room of socket.rooms) {
    if (room.startsWith("channel:")) socket.leave(room);
  }
  const memberships = await prisma.communicationChannelMember.findMany({
    where: {
      companyId,
      userId,
      canRead: true,
      channel: { companyId, active: true, archivedAt: null }
    },
    select: { channelId: true }
  });
  for (const membership of memberships) {
    socket.join(`channel:${membership.channelId}`);
  }
}

export function setupRealtime(app: FastifyInstance) {
  io = new Server(app.server, {
    cors: {
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (!config.isProduction && config.corsOrigins.includes("*")) return cb(null, true);
        return cb(null, config.corsOrigins.includes(origin));
      },
      credentials: true
    }
  });

  io.use((socket, next) => {
    void (async () => {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token || Array.isArray(token)) return next(new Error("Missing token"));
      const session = app.jwt.verify<VerifiedSessionToken>(token);
      const membership = await validateSession(session);
      if (!membership) return next(new Error("Inactive session"));
      socket.data.session = session;
      socket.data.membershipContext = membership;
      next();
    })().catch(() => next(new Error("Invalid token")));
  });

  io.on("connection", async (socket) => {
    const session = socket.data.session as VerifiedSessionToken;
    socket.join(`company:${session.companyId}`);
    socket.join(userRoom(session.companyId, session.userId));
    try {
      await joinReadableChannelRooms(socket, session.companyId, session.userId);
      const revalidate = async () => {
        const membership = await validateSession(session);
        if (!membership) {
          socket.disconnect(true);
          return;
        }
        socket.data.membershipContext = membership;
        await joinReadableChannelRooms(socket, session.companyId, session.userId);
      };
      const revalidateTimer = setInterval(() => {
        revalidate().catch((error) => {
          app.log.error(error);
          socket.disconnect(true);
        });
      }, config.socketRevalidateMs);
      socket.data.revalidateTimer = revalidateTimer;

      if (session.exp) {
        const expiresInMs = session.exp * 1000 - Date.now();
        const expireTimer = setTimeout(() => socket.disconnect(true), Math.max(0, Math.min(expiresInMs, 2_147_483_647)));
        socket.data.expireTimer = expireTimer;
      }
    } catch (error) {
      app.log.error(error);
      socket.disconnect(true);
    }
    socket.on("disconnect", () => {
      if (socket.data.revalidateTimer) clearInterval(socket.data.revalidateTimer);
      if (socket.data.expireTimer) clearTimeout(socket.data.expireTimer);
    });
  });

  return io;
}

export function emitCompany(companyId: string, event: string, payload: unknown) {
  io?.to(`company:${companyId}`).emit(event, payload);
}

export function emitUser(companyId: string, userId: string, event: string, payload: unknown) {
  io?.to(userRoom(companyId, userId)).emit(event, payload);
}

export function emitChannel(channelId: string, event: string, payload: unknown) {
  io?.to(`channel:${channelId}`).emit(event, payload);
}

export async function refreshUserChannelRooms(companyId: string, userId: string) {
  if (!io) return;
  const sockets = await io.in(userRoom(companyId, userId)).fetchSockets();
  await Promise.all(sockets.map((socket) => joinReadableChannelRooms(socket as any, companyId, userId)));
}
