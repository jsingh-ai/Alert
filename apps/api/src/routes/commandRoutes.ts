import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { prisma } from "../db.js";
import { includeAlert, recalculateCommandStatus, serializeAlert } from "../services/alertService.js";
import { createCommunicationMessage, ensureDepartmentCommunicationChannel, serializeMessage } from "../services/communicationService.js";
import { canUseMachine, ACTIVE_ALERT_STATUSES } from "../services/permissions.js";
import { emitChannel, emitCompany } from "../services/realtime.js";

export async function commandRoutes(app: FastifyInstance) {
  app.post("/api/commands", { preHandler: app.authenticate }, async (request, reply) => {
    const ctx = request.membershipContext!;
    const body = request.body as {
      machineId?: string;
      templateId?: string;
      commandLabel?: string;
      sharedNote?: string;
      clientRequestId?: string;
      targets?: Array<{ departmentId?: string; issueTypeId?: string; message?: string }>;
    };

    if (!body.machineId) return reply.code(400).send({ success: false, error: "machineId is required." });
    if (!(await canUseMachine(ctx, body.machineId, prisma))) {
      return reply.code(403).send({ success: false, error: "Machine is outside your scope." });
    }

    const machine = await prisma.machine.findFirst({ where: { id: body.machineId, companyId: ctx.companyId } });
    if (!machine) return reply.code(404).send({ success: false, error: "Machine not found." });

    let commandLabel = body.commandLabel?.trim() || "Manual Help Call";
    let templateId: string | null = null;
    let targets: Array<{ departmentId: string; issueTypeId: string; message?: string | null; priority?: any }> = [];

    if (body.templateId) {
      const template = await prisma.commandTemplate.findFirst({
        where: { id: body.templateId, companyId: ctx.companyId, active: true },
        include: { targets: true }
      });
      if (!template) return reply.code(404).send({ success: false, error: "Command template not found." });
      commandLabel = template.buttonLabel;
      templateId = template.id;
      targets = template.targets.map((target) => ({
        departmentId: target.departmentId,
        issueTypeId: target.issueTypeId,
        message: target.targetMessage,
        priority: target.priority
      }));
    } else if (body.targets?.length) {
      targets = body.targets
        .filter((target) => target.departmentId && target.issueTypeId)
        .map((target) => ({
          departmentId: target.departmentId!,
          issueTypeId: target.issueTypeId!,
          message: target.message ?? null
        }));
    }

    if (targets.length === 0) {
      return reply.code(400).send({ success: false, error: "At least one target department/issue is required." });
    }

    const targetDepartmentIds = [...new Set(targets.map((target) => target.departmentId))];
    const conflictingAlerts = await prisma.andonAlert.findMany({
      where: {
        companyId: ctx.companyId,
        machineId: body.machineId,
        departmentId: { in: targetDepartmentIds },
        status: { in: [...ACTIVE_ALERT_STATUSES] }
      },
      include: { department: true }
    });
    if (conflictingAlerts.length > 0) {
      return reply.code(409).send({
        success: false,
        error: "One or more target departments already have an active alert for this machine.",
        conflicts: conflictingAlerts.map((alert) => ({
          alertId: alert.id,
          departmentId: alert.departmentId,
          departmentName: alert.department.name,
          status: alert.status
        }))
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const command = await tx.andonCommand.create({
        data: {
          companyId: ctx.companyId,
          machineId: body.machineId!,
          commandTemplateId: templateId,
          commandLabel,
          operatorUserId: ctx.userId,
          operatorNameText: ctx.user.displayName,
          sharedNote: body.sharedNote?.trim() || null,
          clientRequestId: body.clientRequestId ?? `web-${nanoid(16)}`
        }
      });

      const createdAlerts: any[] = [];
      const existingAlerts: any[] = [];
      const departmentNotifications: Array<{ channelId: string; message: any }> = [];

      for (const target of targets) {
        const issueType = await tx.issueType.findFirst({
          where: { id: target.issueTypeId, companyId: ctx.companyId, departmentId: target.departmentId, active: true }
        });
        if (!issueType) {
          continue;
        }

        const existing = await tx.andonAlert.findFirst({
          where: {
            companyId: ctx.companyId,
            machineId: body.machineId!,
            departmentId: target.departmentId,
            status: { in: [...ACTIVE_ALERT_STATUSES] }
          },
          include: includeAlert()
        });

        if (existing) {
          const err = new Error("One or more target departments already have an active alert for this machine.") as Error & { statusCode?: number };
          err.statusCode = 409;
          throw err;
        }

        const alert = await tx.andonAlert.create({
          data: {
            commandId: command.id,
            companyId: ctx.companyId,
            machineId: body.machineId!,
            departmentId: target.departmentId,
            issueTypeId: target.issueTypeId,
            priority: target.priority ?? issueType.defaultPriority,
            operatorNote: body.sharedNote?.trim() || null,
            displayMessage: target.message || body.sharedNote?.trim() || null,
            createdByUserId: ctx.userId,
            status: "OPEN"
          },
          include: includeAlert()
        });

        await tx.alertEvent.create({
          data: {
            alertId: alert.id,
            eventType: "CREATED",
            actorUserId: ctx.userId,
            actorNameText: ctx.user.displayName,
            note: body.sharedNote?.trim() || null,
            metadata: { commandId: command.id, commandLabel }
          }
        });
        const departmentChannel = await ensureDepartmentCommunicationChannel(tx, ctx.companyId, target.departmentId);
        const alertMessage = `${commandLabel} alert created on ${machine.name}${machine.code ? ` (${machine.code})` : ""}.`;
        const departmentMessage = await createCommunicationMessage(tx, {
          companyId: ctx.companyId,
          channelId: departmentChannel.id,
          userId: ctx.userId,
          body: alertMessage,
          alertId: alert.id,
          messageType: "SYSTEM",
          clientMessageId: `alert-created:${alert.id}`
        });
        departmentNotifications.push({ channelId: departmentChannel.id, message: departmentMessage });
        createdAlerts.push(alert);
      }

      await recalculateCommandStatus(tx, command.id);
      const commandWithAlerts = await tx.andonCommand.findUniqueOrThrow({
        where: { id: command.id },
        include: { machine: { include: { machineGroup: true } }, alerts: { include: includeAlert() } }
      });
      return { command: commandWithAlerts, createdAlerts, existingAlerts, departmentNotifications };
    });

    emitCompany(ctx.companyId, "command.changed", { commandId: result.command.id });
    emitCompany(ctx.companyId, "alert.changed", { commandId: result.command.id });
    for (const notification of result.departmentNotifications) {
      emitChannel(notification.channelId, "communication.message.created", serializeMessage(notification.message));
    }

    return reply.code(201).send({
      success: true,
      data: {
        command: result.command,
        createdAlerts: result.createdAlerts.map(serializeAlert),
        existingAlerts: result.existingAlerts.map(serializeAlert)
      }
    });
  });
}
