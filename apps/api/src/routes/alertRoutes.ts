import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { alertCommandLabel, includeAlert, serializeAlert, transitionAlert } from "../services/alertService.js";
import { createAlertSystemMessages, createCommunicationMessage, ensureMachineCommunicationChannel, serializeMessage } from "../services/communicationService.js";
import { ACTIVE_ALERT_STATUSES, canActAsResponder, canSeeDepartment, canUseMachine, machineWhereForContext, scopedDepartmentIds } from "../services/permissions.js";
import { triggerAlertAcknowledged } from "../services/powerAutomateService.js";
import { notifyAccepted, notifyMessage } from "../services/push.js";
import { emitChannel, emitCompany } from "../services/realtime.js";

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function alertRoutes(app: FastifyInstance) {
  app.get("/api/alerts/active", { preHandler: app.authenticate }, async (request, reply) => {
    const ctx = request.membershipContext!;
    const query = request.query as { departmentId?: string; machineId?: string };
    const departmentId = cleanString(query.departmentId) || undefined;
    const machineId = cleanString(query.machineId) || undefined;

    if (departmentId && !canSeeDepartment(ctx, departmentId)) {
      return reply.code(403).send({ success: false, error: "Department is outside your scope." });
    }
    if (machineId && !(await canUseMachine(ctx, machineId, prisma))) {
      return reply.code(403).send({ success: false, error: "Machine is outside your scope." });
    }

    const accessFilters: Prisma.AndonAlertWhereInput[] = [];
    const managerHasGlobalAlertAccess = ctx.role === "MANAGER" && ctx.scopes.length === 0;
    const responderDepartments = ctx.role === "RESPONDER" ? scopedDepartmentIds(ctx) : [];
    if (responderDepartments.length) {
      // Their departments AND the machines they cover (every machine when none are picked). Matched by id and
      // group, not by "active", so an open call never vanishes because its machine was just switched off.
      const machineIds = ctx.scopes.filter((scope: { scopeType: string }) => scope.scopeType === "MACHINE").map((scope: { scopeId: string }) => scope.scopeId);
      const groupIds = ctx.scopes.filter((scope: { scopeType: string }) => scope.scopeType === "MACHINE_GROUP").map((scope: { scopeId: string }) => scope.scopeId);
      accessFilters.push({
        departmentId: { in: responderDepartments },
        ...(machineIds.length || groupIds.length ? { OR: [{ machineId: { in: machineIds } }, { machine: { machineGroupId: { in: groupIds } } }] } : {})
      });
    } else if (ctx.role !== "ADMIN" && !managerHasGlobalAlertAccess) {
      // (Includes responders set up before departments were required: they keep their old view until edited)
      const departmentIds = scopedDepartmentIds(ctx);
      if (departmentIds.length) accessFilters.push({ departmentId: { in: departmentIds } });

      const machineIds = (await prisma.machine.findMany({ where: machineWhereForContext(ctx), select: { id: true } })).map((m) => m.id);
      if (machineIds.length) accessFilters.push({ machineId: { in: machineIds } });

      if (accessFilters.length === 0) {
        return { success: true, data: [] };
      }
    }

    const alerts = await prisma.andonAlert.findMany({
      where: {
        companyId: ctx.companyId,
        status: { in: [...ACTIVE_ALERT_STATUSES] },
        ...(accessFilters.length ? { OR: accessFilters } : {}),
        ...(departmentId ? { departmentId } : {}),
        ...(machineId ? { machineId } : {})
      },
      include: includeAlert(),
      orderBy: [{ status: "asc" }, { createdAt: "asc" }]
    });

    // Who tapped "Help out" on each call (a message with clientMessageId "help:<alertId>").
    // Read separately: the alert's message list is capped, and a long call would push these out of it.
    const helpNotes = alerts.length
      ? await prisma.communicationMessage.findMany({
          where: { companyId: ctx.companyId, alertId: { in: alerts.map((alert) => alert.id) }, clientMessageId: { startsWith: "help:" }, deletedAt: null },
          select: { alertId: true, user: { select: { id: true, displayName: true, username: true } } },
          orderBy: { createdAt: "asc" }
        })
      : [];
    const helpers = new Map<string, Array<{ id: string; name: string }>>();
    for (const note of helpNotes) {
      if (!note.alertId || !note.user) continue;
      const list = helpers.get(note.alertId) ?? [];
      if (!list.some((helper) => helper.id === note.user!.id)) list.push({ id: note.user.id, name: note.user.displayName || note.user.username });
      helpers.set(note.alertId, list);
    }

    return { success: true, data: alerts.map((alert) => ({ ...serializeAlert(alert), helpers: helpers.get(alert.id) ?? [] })) };
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
    const body = (request.body ?? {}) as { note?: string; responderNameText?: string; clientMessageId?: string };
    const alertId = cleanString(params.id);
    if (!alertId) return reply.code(400).send({ success: false, error: "Alert id is required." });
    const actionNote = typeof body.note === "string" ? body.note.trim() : null;
    if (actionNote && actionNote.length > 4000) return reply.code(400).send({ success: false, error: "Note is too long." });

    const alert = await prisma.andonAlert.findFirst({ where: { id: alertId, companyId: ctx.companyId }, include: { machine: { select: { id: true, machineGroupId: true } } } });
    if (!alert) return reply.code(404).send({ success: false, error: "Alert not found." });

    if (action === "note") {
      const note = typeof body.note === "string" ? body.note.trim() : "";
      const clientMessageId = typeof body.clientMessageId === "string" && body.clientMessageId.trim() ? body.clientMessageId.trim() : null;
      if (!note) return reply.code(400).send({ success: false, error: "Message is required." });
      if (note.length > 4000) return reply.code(400).send({ success: false, error: "Message is too long." });

      const canWriteAlertConversation = ctx.role === "ADMIN"
        || ((ctx.role === "MANAGER" || ctx.role === "RESPONDER") && canActAsResponder(ctx, alert.departmentId, alert.machine))
        || (ctx.role === "OPERATOR" && await canUseMachine(ctx, alert.machineId, prisma));
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
            created: true,
            alert: await tx.andonAlert.findUniqueOrThrow({ where: { id: alert.id }, include: includeAlert() })
          };
        });
        // A resend of the same message (same clientMessageId) doesn't buzz anyone twice
        if ("created" in result) notifyMessage(result.alert, ctx.userId, ctx.user.displayName, note);
        emitChannel(result.channelId, "communication.message.created", serializeMessage(result.message as any));
        emitCompany(ctx.companyId, "alert.changed", { alertId: alert.id, commandId: alert.commandId, action: "note" });
        return { success: true, data: serializeAlert(result.alert as any) };
      } catch (error: any) {
        return reply.code(error.statusCode ?? 500).send({ success: false, error: error.message ?? "Message failed." });
      }
    }

    if (action === "acknowledge" && !canActAsResponder(ctx, alert.departmentId, alert.machine)) {
      return reply.code(403).send({ success: false, error: "You cannot act for this department." });
    }
    if (["arrive", "resolve", "cancel"].includes(action)) {
      const canRespondForDepartment = canActAsResponder(ctx, alert.departmentId, alert.machine);
      const canOperatorActForMachine = ctx.role === "OPERATOR" && await canUseMachine(ctx, alert.machineId, prisma);
      if (!canRespondForDepartment && !canOperatorActForMachine) {
        return reply.code(403).send({ success: false, error: "You cannot act for this alert." });
      }
    }

    try {
      const updated = await prisma.$transaction(async (tx) => {
        return transitionAlert(tx, {
          alertId,
          companyId: ctx.companyId,
          action,
          actorUserId: ctx.userId,
          actorNameText: ctx.user.displayName,
          responderNameText: ctx.user.displayName,
          note: actionNote
        });
      });

      const notifications: Array<{ channelId: string; message: any }> = [];
      if (action === "acknowledge" || action === "resolve") {
        const commandLabel = alertCommandLabel(updated);
        const actionText = action === "acknowledge" ? "accepted" : "resolved";
        const message = `${commandLabel} ${updated.department.name} alert ${actionText} on ${updated.machine.name}${updated.machine.code ? ` (${updated.machine.code})` : ""}.`;
        try {
          notifications.push(...await prisma.$transaction((tx) => createAlertSystemMessages(tx, {
            companyId: ctx.companyId,
            userId: ctx.userId,
            machineId: updated.machineId,
            departmentId: updated.departmentId,
            alertId: updated.id,
            body: message,
            clientMessageKey: action === "acknowledge" ? "alert-acknowledged" : "alert-resolved"
          })));
        } catch (error) {
          request.log.warn({ err: error, alertId: updated.id, action }, "alert action completed but communication system post failed");
        }
      }

      if (action === "acknowledge" && updated.acknowledgedAt) {
        const acknowledgeSeconds = Math.max(0, Math.floor(
          (updated.acknowledgedAt.getTime() - updated.createdAt.getTime()) / 1000
        ));
        try {
          const webhookResult = await triggerAlertAcknowledged({
            alertId: updated.id,
            commandId: updated.commandId,
            departmentName: updated.department.name,
            machineName: updated.machine.name,
            machineCode: updated.machine.code ?? null,
            issueName: updated.issueType?.name ?? "General help",
            priority: updated.priority,
            responderName: updated.responderNameText ?? ctx.user.displayName,
            acknowledgedAt: updated.acknowledgedAt,
            acknowledgeSeconds,
            source: "WEB"
          });
          request.log.info(
            { alertId: updated.id, webhookStatus: webhookResult.status },
            "Power Automate acknowledgement notification SUCCESS"
          );
        } catch (error) {
          request.log.error(
            { err: error, alertId: updated.id },
            "Alert acknowledged but Power Automate acknowledgement notification failed"
          );
        }
      }

      if (action === "acknowledge") notifyAccepted(updated, updated.responderNameText || ctx.user.displayName, ctx.userId);
      emitCompany(ctx.companyId, "alert.changed", { alertId: updated.id, commandId: updated.commandId, action });
      for (const notification of notifications) {
        emitChannel(notification.channelId, "communication.message.created", serializeMessage(notification.message as any));
      }
      return { success: true, data: serializeAlert(updated as any) };
    } catch (error: any) {
      return reply.code(error.statusCode ?? 500).send({ success: false, error: error.message ?? "Action failed." });
    }
  }
}
