import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import {
  createCommunicationMessage,
  findReadableMembership,
  findWritableMembership,
  replaceUserChannelMemberships,
  serializeChannel,
  serializeMessage,
  syncGeneratedCommunicationChannels
} from "../services/communicationService.js";
import { emitChannel, emitCompany, emitUser } from "../services/realtime.js";

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function changed(companyId: string) {
  emitCompany(companyId, "admin.changed", { at: new Date().toISOString() });
}

export async function communicationRoutes(app: FastifyInstance) {
  app.get("/api/channels", { preHandler: app.authenticate }, async (request) => {
    const { companyId, userId } = request.session;
    const memberships = await prisma.communicationChannelMember.findMany({
      where: {
        companyId,
        userId,
        canRead: true,
        channel: { companyId, active: true, archivedAt: null }
      },
      include: { channel: { include: { _count: { select: { members: true } } } } },
      orderBy: [{ channel: { type: "asc" } }, { channel: { name: "asc" } }]
    });
    return { success: true, data: memberships.map((membership) => serializeChannel(membership.channel, membership)) };
  });

  app.get("/api/channels/:channelId/messages", { preHandler: app.authenticate }, async (request, reply) => {
    const { companyId, userId } = request.session;
    const params = request.params as { channelId: string };
    const query = request.query as { beforeSeq?: string; limit?: string };
    const membership = await findReadableMembership(companyId, userId, params.channelId);
    if (!membership) return reply.code(403).send({ success: false, error: "You do not have access to this channel." });

    const beforeSeq = Number(query.beforeSeq ?? 0);
    const limit = Math.max(1, Math.min(100, Number(query.limit ?? 50)));
    const messages = await prisma.communicationMessage.findMany({
      where: {
        companyId,
        channelId: params.channelId,
        ...(beforeSeq > 0 ? { seq: { lt: beforeSeq } } : {})
      },
      include: { user: { select: { id: true, username: true, displayName: true } } },
      orderBy: { seq: "desc" },
      take: limit
    });

    return {
      success: true,
      data: {
        messages: messages.reverse().map(serializeMessage),
        nextBeforeSeq: messages.length === limit ? messages[0]?.seq : null
      }
    };
  });

  app.post("/api/channels/:channelId/messages", { preHandler: app.authenticate }, async (request, reply) => {
    const { companyId, userId } = request.session;
    const params = request.params as { channelId: string };
    const body = request.body as { body?: string; message?: string; clientMessageId?: string };
    const text = cleanString(body.body ?? body.message);
    const clientMessageId = cleanString(body.clientMessageId) || null;
    if (!text) return reply.code(400).send({ success: false, error: "Message is required." });
    if (text.length > 4000) return reply.code(400).send({ success: false, error: "Message is too long." });

    const membership = await findWritableMembership(companyId, userId, params.channelId);
    if (!membership) return reply.code(403).send({ success: false, error: "You cannot write to this channel." });

    if (clientMessageId) {
      const existing = await prisma.communicationMessage.findFirst({
        where: { companyId, channelId: params.channelId, userId, clientMessageId },
        include: { user: { select: { id: true, username: true, displayName: true } } }
      });
      if (existing) return { success: true, data: serializeMessage(existing) };
    }

    const message = await prisma.$transaction((tx) => createCommunicationMessage(tx, {
      companyId,
      channelId: params.channelId,
      userId,
      body: text,
      clientMessageId
    }));

    const payload = serializeMessage(message);
    emitChannel(params.channelId, "communication.message.created", payload);
    return { success: true, data: payload };
  });

  app.patch("/api/channels/:channelId/read", { preHandler: app.authenticate }, async (request, reply) => {
    const { companyId, userId } = request.session;
    const params = request.params as { channelId: string };
    const body = request.body as { lastReadSeq?: number };
    const membership = await findReadableMembership(companyId, userId, params.channelId);
    if (!membership) return reply.code(403).send({ success: false, error: "You do not have access to this channel." });
    const requestedSeq = Math.max(0, Number(body.lastReadSeq ?? membership.channel.lastMessageSeq));
    const lastReadSeq = Math.max(membership.lastReadSeq, Math.min(requestedSeq, membership.channel.lastMessageSeq));
    const updated = await prisma.communicationChannelMember.update({
      where: { channelId_userId: { channelId: params.channelId, userId } },
      data: { lastReadSeq }
    });
    return { success: true, data: { lastReadSeq: updated.lastReadSeq } };
  });

  app.get("/api/admin/communication-channels", { preHandler: app.requireAdmin }, async (request) => {
    const companyId = request.session.companyId;
    const channels = await prisma.communicationChannel.findMany({
      where: { companyId },
      include: {
        department: true,
        machineGroup: true,
        machine: true,
        _count: { select: { members: true, messages: true } }
      },
      orderBy: [{ type: "asc" }, { name: "asc" }]
    });
    return { success: true, data: channels.map((channel) => serializeChannel(channel as any)) };
  });

  app.post("/api/admin/communication-channels/sync", { preHandler: app.requireAdmin }, async (request) => {
    const result = await syncGeneratedCommunicationChannels(request.session.companyId);
    changed(request.session.companyId);
    return { success: true, data: { created: result.created, updated: result.updated, channels: result.channels.map((channel) => serializeChannel(channel)) } };
  });

  app.patch("/api/admin/communication-channels/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as { name?: string; active?: boolean };
    const data: any = {};
    if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim();
    if (typeof body.active === "boolean") {
      data.active = body.active;
      data.disabledAt = body.active ? null : new Date();
    }
    if (!Object.keys(data).length) return reply.code(400).send({ success: false, error: "No changes provided." });
    const channel = await prisma.communicationChannel.update({
      where: { id: params.id, companyId: request.session.companyId },
      data
    });
    changed(request.session.companyId);
    return { success: true, data: serializeChannel(channel) };
  });

  app.patch("/api/admin/communication-channels/:id/archive", { preHandler: app.requireAdmin }, async (request) => {
    const params = request.params as { id: string };
    const channel = await prisma.communicationChannel.update({
      where: { id: params.id, companyId: request.session.companyId },
      data: { active: false, archivedAt: new Date(), disabledAt: new Date() }
    });
    changed(request.session.companyId);
    return { success: true, data: serializeChannel(channel) };
  });

  app.get("/api/admin/users/:userId/channel-memberships", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { companyId } = request.session;
    const params = request.params as { userId: string };
    const user = await prisma.user.findFirst({ where: { id: params.userId, memberships: { some: { companyId, active: true } } }, select: { id: true, username: true, displayName: true } });
    if (!user) return reply.code(404).send({ success: false, error: "User not found." });
    const [channels, memberships] = await Promise.all([
      prisma.communicationChannel.findMany({
        where: { companyId, archivedAt: null },
        include: { _count: { select: { members: true } } },
        orderBy: [{ type: "asc" }, { name: "asc" }]
      }),
      prisma.communicationChannelMember.findMany({ where: { companyId, userId: params.userId } })
    ]);
    return {
      success: true,
      data: {
        user,
        channels: channels.map((channel) => serializeChannel(channel as any, memberships.find((membership) => membership.channelId === channel.id))),
        memberships
      }
    };
  });

  app.put("/api/admin/users/:userId/channel-memberships", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { companyId } = request.session;
    const params = request.params as { userId: string };
    const body = request.body as { memberships?: Array<{ channelId: string; role?: "MEMBER" | "MODERATOR" | "OWNER"; canRead?: boolean; canWrite?: boolean; muted?: boolean }> };
    const memberships = await replaceUserChannelMemberships(companyId, params.userId, body.memberships ?? []);
    if (!memberships) return reply.code(404).send({ success: false, error: "User not found." });
    emitUser(params.userId, "communication.membership.changed", { userId: params.userId, at: new Date().toISOString() });
    changed(companyId);
    return { success: true, data: memberships };
  });
}
