import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { includeAlert, serializeAlert, transitionAlert } from "../services/alertService.js";
import { ACTIVE_ALERT_STATUSES, canActAsResponder, canSeeDepartment, canUseMachine, machineWhereForContext } from "../services/permissions.js";
import { emitCompany } from "../services/realtime.js";

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
    const body = request.body as { note?: string; responderNameText?: string };

    const alert = await prisma.andonAlert.findFirst({ where: { id: params.id, companyId: ctx.companyId } });
    if (!alert) return reply.code(404).send({ success: false, error: "Alert not found." });

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
