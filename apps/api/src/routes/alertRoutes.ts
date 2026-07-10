import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { includeAlert, serializeAlert, transitionAlert } from "../services/alertService.js";
import { createCommunicationMessage, ensureMachineCommunicationChannel, serializeMessage } from "../services/communicationService.js";
import { ACTIVE_ALERT_STATUSES, canActAsResponder, canSeeDepartment, canUseMachine, machineWhereForContext } from "../services/permissions.js";
import { emitChannel, emitCompany } from "../services/realtime.js";

export async function alertRoutes(app: FastifyInstance) {
  app.get("/api/alerts/active", { preHandler: app.authenticate }, async (request, reply) => {
    const ctx = request.membershipContext!;
    const query = request.query as { departmentId?: string; machineId?: string };

    if (query.departmentId && !canSeeDepartment(ctx, query.departmentId)) {
      return reply.code(403).send({ success: false, error: "Department is outside your scope." });
    }

    const machineIds = (await prisma.machine.findMany({ where: machineWhereForContext(ctx), select: { id: true } })).map((m) => m.id);
    const alerts = await prisma.andonAlert.findMany({
      where: {
        companyId: ctx.companyId,
        machineId: { in: machineIds },
        status: { in: [...ACTIVE_ALERT_STATUSES] },
        ...(query.departmentId ? { departmentId: query.departmentId } : {}),
        ...(query.machineId ? { machineId: query.machineId } : {})
      },
      include: includeAlert(),
      orderBy: [{ status: "asc" }, { createdAt: "asc" }]
    });

    return { success: true, data: alerts.map(serializeAlert) };
  });

  app.post("/api/alerts/:id/acknowledge", { preHandler: app.authenticate }, async (request, reply) => {
    return runAction(request, reply, "acknowledge");
  });

  app.post("/api/alerts/:id/arrive", { preHandler: app.authenticate }, async (request, reply) => {
    return runAction(request, reply, "arrive");
  });

  app.post("/api/alerts/:id/resolve", { preHandler: app.authenticate }, async (request, reply) => {
    return runAction(request, reply, "resolve");
  });

  app.post("/api/alerts/:id/cancel", { preHandler: app.authenticate }, async (request, reply) => {
    return runAction(request, reply, "cancel");
  });

  app.post("/api/alerts/:id/notes", { preHandler: app.authenticate }, async (request, reply) => {
    return runAction(request, reply, "note");
  });

  async function runAction(request: any, reply: any, action: "acknowledge" | "arrive" | "resolve" | "cancel" | "note") {
    const ctx = request.membershipContext!;
    const params = request.params as { id: string };
    const body = request.body as { note?: string; responderNameText?: string; clientMessageId?: string };

    const alert = await prisma.andonAlert.findFirst({ where: { id: params.id, companyId: ctx.companyId } });
    if (!alert) return reply.code(404).send({ success: false, error: "Alert not found." });

    if (action === "note") {
      const note = typeof body.note === "string" ? body.note.trim() : "";
      const clientMessageId = typeof body.clientMessageId === "string" && body.clientMessageId.trim() ? body.clientMessageId.trim() : null;
      if (!note) return reply.code(400).send({ success: false, error: "Message is required." });
      if (note.length > 4000) return reply.code(400).send({ success: false, error: "Message is too long." });

      const canWriteAlertConversation = ["ADMIN", "MANAGER"].includes(ctx.role)
        || (ctx.role === "RESPONDER" && canSeeDepartment(ctx, alert.departmentId))
        || await canUseMachine(ctx, alert.machineId, prisma);
      if (!canWriteAlertConversation) {
        return reply.code(403).send({ success: false, error: "You cannot message this alert." });
      }

      try {
        const result = await prisma.$transaction(async (tx) => {
          const channel = await ensureMachineCommunicationChannel(tx, ctx.companyId, alert.machineId);
          if (clientMessageId) {
            const existing = await tx.communicationMessage.findFirst({
              where: { companyId: ctx.companyId, channelId: channel.id, userId: ctx.userId, clientMessageId },
              include: { user: { select: { id: true, username: true, displayName: true } } }
            });
            if (existing) {
              return {
                channelId: channel.id,
                message: existing,
                alert: await tx.andonAlert.findUniqueOrThrow({ where: { id: alert.id }, include: includeAlert() })
              };
            }
          }
          const message = await createCommunicationMessage(tx, {
            companyId: ctx.companyId,
            channelId: channel.id,
            userId: ctx.userId,
            body: note,
            clientMessageId,
            alertId: alert.id
          });
          return {
            channelId: channel.id,
            message,
            alert: await tx.andonAlert.findUniqueOrThrow({ where: { id: alert.id }, include: includeAlert() })
          };
        });
        emitChannel(result.channelId, "communication.message.created", serializeMessage(result.message as any));
        emitCompany(ctx.companyId, "alert.changed", { alertId: alert.id, commandId: alert.commandId, action: "note" });
        return { success: true, data: serializeAlert(result.alert as any) };
      } catch (error: any) {
        return reply.code(error.statusCode ?? 500).send({ success: false, error: error.message ?? "Message failed." });
      }
    }

    if (action === "acknowledge" && !canActAsResponder(ctx, alert.departmentId)) {
      return reply.code(403).send({ success: false, error: "You cannot act for this department." });
    }
    if (["arrive", "resolve"].includes(action)) {
      const canRespondForDepartment = canActAsResponder(ctx, alert.departmentId);
      const canOperatorActForMachine = ctx.role === "OPERATOR" && await canUseMachine(ctx, alert.machineId, prisma);
      if (!canRespondForDepartment && !canOperatorActForMachine) {
        return reply.code(403).send({ success: false, error: "You cannot act for this alert." });
      }
    }

    try {
      const updated = await prisma.$transaction((tx) => transitionAlert(tx, {
        alertId: params.id,
        companyId: ctx.companyId,
        action,
        actorUserId: ctx.userId,
        actorNameText: ctx.user.displayName,
        responderNameText: body.responderNameText ?? ctx.user.displayName,
        note: body.note ?? null
      }));
      emitCompany(ctx.companyId, "alert.changed", { alertId: updated.id, commandId: updated.commandId, action });
      return { success: true, data: serializeAlert(updated as any) };
    } catch (error: any) {
      return reply.code(error.statusCode ?? 500).send({ success: false, error: error.message ?? "Action failed." });
    }
  }
}
