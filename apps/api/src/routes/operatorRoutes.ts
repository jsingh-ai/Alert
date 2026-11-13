import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requirePage } from "../services/auth.js";
import { alertCommandLabel, includeAlert, serializeAlert } from "../services/alertService.js";
import { ACTIVE_ALERT_STATUSES, canUseMachine, machineWhereForContext } from "../services/permissions.js";

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function groupCommands(alerts: any[]) {
  const map = new Map<string, any>();
  for (const alert of alerts) {
    const key = alert.commandId ? `${alert.commandId}:${alert.id}` : `single:${alert.id}`;
    if (!map.has(key)) {
      map.set(key, {
        id: key,
        realCommandId: alert.commandId,
        commandTemplateId: alert.command?.commandTemplateId ?? null,
        commandLabel: alertCommandLabel(alert),
        status: alert.status,
        machine: alert.machine,
        sharedNote: alert.command?.sharedNote ?? alert.operatorNote,
        createdAt: alert.createdAt,
        alerts: []
      });
    }
    map.get(key).alerts.push(serializeAlert(alert));
  }
  return Array.from(map.values()).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function operatorRoutes(app: FastifyInstance) {
  app.get("/api/operator/bootstrap", { preHandler: requirePage(app, "operator") }, async (request) => {
    const ctx = request.membershipContext!;
    const machines = await prisma.machine.findMany({
      where: machineWhereForContext(ctx),
      include: { machineGroup: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }]
    });
    const machineGroups = await prisma.machineGroup.findMany({
      where: { companyId: ctx.companyId, active: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }]
    });
    const departments = await prisma.department.findMany({
      where: { companyId: ctx.companyId, active: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }]
    });
    const issueTypes = await prisma.issueType.findMany({
      where: { companyId: ctx.companyId, active: true, department: { active: true } },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }]
    });
    const commandTemplates = await prisma.commandTemplate.findMany({
      where: {
        companyId: ctx.companyId,
        active: true,
        targets: { some: {}, every: { department: { active: true }, issueType: { active: true } } }
      },
      include: { targets: { include: { department: true, issueType: true }, orderBy: { sortOrder: "asc" } } },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }]
    });

    return { success: true, data: { machines, machineGroups, departments, issueTypes, commandTemplates } };
  });

  app.get("/api/operator/snapshot", { preHandler: requirePage(app, "operator") }, async (request, reply) => {
    const ctx = request.membershipContext!;
    const query = request.query as { machineId?: string };
    const requestedMachineId = cleanString(query.machineId);
    let machineIds: string[];
    if (requestedMachineId) {
      if (!(await canUseMachine(ctx, requestedMachineId, prisma))) {
        return reply.code(403).send({ success: false, error: "Machine is outside your scope." });
      }
      machineIds = [requestedMachineId];
    } else {
      const machines = await prisma.machine.findMany({ where: machineWhereForContext(ctx), select: { id: true } });
      machineIds = machines.map((machine) => machine.id);
    }
    if (machineIds.length === 0) return { success: true, data: { commands: [], alerts: [] } };
    const alerts = await prisma.andonAlert.findMany({
      where: { companyId: ctx.companyId, machineId: { in: machineIds }, status: { in: [...ACTIVE_ALERT_STATUSES] } },
      include: includeAlert(),
      orderBy: { createdAt: "desc" }
    });
    // A multi-team job stays open until every team is closed: keep the teams already closed on screen
    // (their rows say when they arrived) for as long as another team on the same job is still active.
    const commandIds = Array.from(new Set(alerts.map((alert) => alert.commandId).filter((id): id is string => Boolean(id))));
    const finished = commandIds.length
      ? await prisma.andonAlert.findMany({
          where: { companyId: ctx.companyId, commandId: { in: commandIds }, status: "RESOLVED" },
          include: includeAlert(),
          orderBy: { createdAt: "desc" }
        })
      : [];
    return { success: true, data: { commands: groupCommands([...alerts, ...finished]), alerts: alerts.map(serializeAlert) } };
  });
}
