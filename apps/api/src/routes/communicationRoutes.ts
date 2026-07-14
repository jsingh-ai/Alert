import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
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
import { emitChannel, emitCompany, emitUser, refreshUserChannelRooms } from "../services/realtime.js";

const MAX_ATTACHMENTS_PER_MESSAGE = 4;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MESSAGE_ATTACHMENT_DIR = process.env.COMMUNICATION_ATTACHMENT_DIR
  ? path.resolve(process.env.COMMUNICATION_ATTACHMENT_DIR)
  : path.resolve(process.cwd(), "data", "communication-attachments");

type PendingAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  filePath: string;
};

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function requestError(message: string, statusCode = 400) {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = statusCode;
  return error;
}

function cleanFileName(value: unknown) {
  const normalized = typeof value === "string" ? value.replace(/\0/g, "").trim() : "";
  const fileName = path.basename(normalized).slice(0, 180);
  return fileName || "attachment";
}

function decodeBase64(value: unknown) {
  if (typeof value !== "string") throw requestError("Each attachment must include file data.");
  const normalized = value.replace(/\s/g, "");
  if (!normalized || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)) {
    throw requestError("An attachment contains invalid file data.");
  }
  return Buffer.from(normalized, "base64");
}

async function persistAttachments(value: unknown): Promise<PendingAttachment[]> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw requestError("Attachments must be an array.");
  if (value.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw requestError(`A message can include at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments.`);
  }

  const attachments: PendingAttachment[] = [];
  let totalBytes = 0;
  await fs.promises.mkdir(MESSAGE_ATTACHMENT_DIR, { recursive: true });
  try {
    for (const item of value) {
      if (!item || typeof item !== "object") throw requestError("Each attachment must be a file.");
      const raw = item as { fileName?: unknown; mimeType?: unknown; dataBase64?: unknown };
      const bytes = decodeBase64(raw.dataBase64);
      if (!bytes.length) throw requestError("Attachments cannot be empty.");
      if (bytes.length > MAX_ATTACHMENT_BYTES) throw requestError("Each attachment must be 5 MB or smaller.");
      totalBytes += bytes.length;
      if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) throw requestError("Message attachments must total 8 MB or less.");

      const id = nanoid();
      const storageKey = nanoid(32);
      const filePath = path.join(MESSAGE_ATTACHMENT_DIR, storageKey);
      await fs.promises.writeFile(filePath, bytes, { flag: "wx" });
      attachments.push({
        id,
        fileName: cleanFileName(raw.fileName),
        mimeType: cleanString(raw.mimeType).slice(0, 120) || "application/octet-stream",
        sizeBytes: bytes.length,
        storageKey,
        filePath
      });
    }
    return attachments;
  } catch (error) {
    await Promise.all(attachments.map((attachment) => fs.promises.rm(attachment.filePath, { force: true })));
    throw error;
  }
}

async function removePersistedAttachments(attachments: PendingAttachment[]) {
  await Promise.all(attachments.map((attachment) => fs.promises.rm(attachment.filePath, { force: true })));
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function changed(companyId: string) {
  emitCompany(companyId, "admin.changed", { at: new Date().toISOString() });
}

function isChannelMemberRole(value: unknown): value is "MEMBER" | "MODERATOR" | "OWNER" {
  return value === undefined || value === "MEMBER" || value === "MODERATOR" || value === "OWNER";
}

export async function communicationRoutes(app: FastifyInstance) {
  const messageRateLimit = { config: { rateLimit: { max: config.rateLimit.messageMax, timeWindow: config.rateLimit.timeWindow } } };
  const adminWriteRateLimit = { config: { rateLimit: { max: config.rateLimit.adminWriteMax, timeWindow: config.rateLimit.timeWindow } } };

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

    const beforeSeq = boundedInteger(query.beforeSeq, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = boundedInteger(query.limit, 50, 1, 100);
    if (beforeSeq === null || limit === null) {
      return reply.code(400).send({ success: false, error: "Invalid message pagination." });
    }

    const messages = await prisma.communicationMessage.findMany({
      where: {
        companyId,
        channelId: params.channelId,
        ...(beforeSeq > 0 ? { seq: { lt: beforeSeq } } : {})
      },
      include: { user: { select: { id: true, username: true, displayName: true } }, attachments: true },
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

  app.post("/api/channels/:channelId/messages", { preHandler: app.authenticate, bodyLimit: 12 * 1024 * 1024, ...messageRateLimit }, async (request, reply) => {
    const { companyId, userId } = request.session;
    const params = request.params as { channelId: string };
    const body = request.body as { body?: string; message?: string; clientMessageId?: string; attachments?: unknown };
    const text = cleanString(body.body ?? body.message);
    const clientMessageId = cleanString(body.clientMessageId) || null;
    if (!text && !Array.isArray(body.attachments)) return reply.code(400).send({ success: false, error: "Message or attachment is required." });
    if (text.length > 4000) return reply.code(400).send({ success: false, error: "Message is too long." });

    const membership = await findWritableMembership(companyId, userId, params.channelId);
    if (!membership) return reply.code(403).send({ success: false, error: "You cannot write to this channel." });

    if (clientMessageId) {
      const existing = await prisma.communicationMessage.findFirst({
        where: { companyId, channelId: params.channelId, userId, clientMessageId },
        include: { user: { select: { id: true, username: true, displayName: true } }, attachments: true }
      });
      if (existing) return { success: true, data: serializeMessage(existing) };
    }

    let attachments: PendingAttachment[] = [];
    try {
      attachments = await persistAttachments(body.attachments);
      if (!text && !attachments.length) return reply.code(400).send({ success: false, error: "Message or attachment is required." });
      const message = await prisma.$transaction((tx) => createCommunicationMessage(tx, {
        companyId,
        channelId: params.channelId,
        userId,
        body: text,
        clientMessageId,
        attachments: attachments.map(({ filePath: _filePath, ...attachment }) => attachment)
      }));

      const savedStorageKeys = new Set((message.attachments ?? []).map((attachment) => attachment.storageKey));
      await removePersistedAttachments(attachments.filter((attachment) => !savedStorageKeys.has(attachment.storageKey)));

      const payload = serializeMessage(message);
      emitChannel(params.channelId, "communication.message.created", payload);
      return { success: true, data: payload };
    } catch (error) {
      await removePersistedAttachments(attachments);
      throw error;
    }
  });

  app.get("/api/channels/attachments/:attachmentId", { preHandler: app.authenticate }, async (request, reply) => {
    const { companyId, userId } = request.session;
    const params = request.params as { attachmentId: string };
    const attachment = await prisma.communicationAttachment.findFirst({
      where: { id: params.attachmentId, companyId },
      include: { message: { select: { channelId: true } } }
    });
    if (!attachment) return reply.code(404).send({ success: false, error: "Attachment not found." });

    const membership = await findReadableMembership(companyId, userId, attachment.message.channelId);
    if (!membership) return reply.code(403).send({ success: false, error: "You do not have access to this attachment." });

    const filePath = path.join(MESSAGE_ATTACHMENT_DIR, attachment.storageKey);
    try {
      await fs.promises.access(filePath, fs.constants.R_OK);
    } catch {
      return reply.code(404).send({ success: false, error: "Attachment file not found." });
    }

    reply.header("X-Content-Type-Options", "nosniff");
    const disposition = attachment.mimeType.startsWith("image/") ? "inline" : "attachment";
    reply.header("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`);
    reply.type(attachment.mimeType || "application/octet-stream");
    return reply.send(fs.createReadStream(filePath));
  });

  app.patch("/api/channels/:channelId/read", { preHandler: app.authenticate }, async (request, reply) => {
    const { companyId, userId } = request.session;
    const params = request.params as { channelId: string };
    const body = request.body as { lastReadSeq?: number };
    const membership = await findReadableMembership(companyId, userId, params.channelId);
    if (!membership) return reply.code(403).send({ success: false, error: "You do not have access to this channel." });
    const requestedSeq = boundedInteger(body.lastReadSeq, membership.channel.lastMessageSeq, 0, membership.channel.lastMessageSeq);
    if (requestedSeq === null) {
      return reply.code(400).send({ success: false, error: "Invalid read position." });
    }
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

  app.post("/api/admin/communication-channels/sync", { preHandler: app.requireAdmin, ...adminWriteRateLimit }, async (request) => {
    const result = await syncGeneratedCommunicationChannels(request.session.companyId);
    changed(request.session.companyId);
    return { success: true, data: { created: result.created, updated: result.updated, channels: result.channels.map((channel) => serializeChannel(channel)) } };
  });

  app.patch("/api/admin/communication-channels/:id", { preHandler: app.requireAdmin, ...adminWriteRateLimit }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as { name?: string; active?: boolean };
    const existing = await prisma.communicationChannel.findFirst({ where: { id: params.id, companyId: request.session.companyId }, select: { id: true, archivedAt: true } });
    if (!existing) return reply.code(404).send({ success: false, error: "Channel not found." });
    const data: any = {};
    if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim();
    if (typeof body.active === "boolean") {
      data.active = body.active;
      data.disabledAt = body.active ? null : new Date();
      if (body.active && existing.archivedAt) data.archivedAt = null;
    }
    if (!Object.keys(data).length) return reply.code(400).send({ success: false, error: "No changes provided." });
    const channel = await prisma.communicationChannel.update({ where: { id: params.id }, data });
    changed(request.session.companyId);
    return { success: true, data: serializeChannel(channel) };
  });

  app.patch("/api/admin/communication-channels/:id/archive", { preHandler: app.requireAdmin, ...adminWriteRateLimit }, async (request) => {
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
        where: { companyId, active: true, archivedAt: null },
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

  app.put("/api/admin/users/:userId/channel-memberships", { preHandler: app.requireAdmin, ...adminWriteRateLimit }, async (request, reply) => {
    const { companyId } = request.session;
    const params = request.params as { userId: string };
    const body = request.body as { memberships?: Array<{ channelId: string; role?: "MEMBER" | "MODERATOR" | "OWNER"; canRead?: boolean; canWrite?: boolean; muted?: boolean }> };
    if (!Array.isArray(body.memberships)) {
      return reply.code(400).send({ success: false, error: "Memberships must be an array." });
    }
    const requestedMemberships: Array<{ channelId: string; role?: "MEMBER" | "MODERATOR" | "OWNER"; canRead?: boolean; canWrite?: boolean; muted?: boolean }> = [];
    for (const membership of body.memberships) {
      if (!membership || typeof membership !== "object" || !cleanString(membership.channelId)) {
        return reply.code(400).send({ success: false, error: "Each membership requires a channel id." });
      }
      if (!isChannelMemberRole(membership.role)) {
        return reply.code(400).send({ success: false, error: "Invalid channel member role." });
      }
      if (membership.canRead !== undefined && typeof membership.canRead !== "boolean") {
        return reply.code(400).send({ success: false, error: "Invalid channel read permission." });
      }
      if (membership.canWrite !== undefined && typeof membership.canWrite !== "boolean") {
        return reply.code(400).send({ success: false, error: "Invalid channel write permission." });
      }
      if (membership.muted !== undefined && typeof membership.muted !== "boolean") {
        return reply.code(400).send({ success: false, error: "Invalid channel muted value." });
      }
      requestedMemberships.push({
        channelId: cleanString(membership.channelId),
        role: membership.role,
        canRead: membership.canRead,
        canWrite: membership.canWrite,
        muted: membership.muted
      });
    }
    const memberships = await replaceUserChannelMemberships(companyId, params.userId, requestedMemberships);
    if (!memberships) return reply.code(404).send({ success: false, error: "User not found." });
    await refreshUserChannelRooms(companyId, params.userId);
    emitUser(companyId, params.userId, "communication.membership.changed", { userId: params.userId, at: new Date().toISOString() });
    changed(companyId);
    return { success: true, data: memberships };
  });
}
