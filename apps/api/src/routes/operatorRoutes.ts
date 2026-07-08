import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { includeAlert, serializeAlert } from "../services/alertService.js";
import { ACTIVE_ALERT_STATUSES, machineWhereForContext } from "../services/permissions.js";

function groupCommands(alerts: any[]) {
  const map = new Map<string, any>();
  for (const alert of alerts) {
    const key = alert.commandId ? `${alert.commandId}:${alert.id}` : `single:${alert.id}`;
    if (!map.has(key)) {
      map.set(key, {
        id: key,
        realCommandId: alert.commandId,
        commandTemplateId: alert.command?.commandTemplateId ?? null,
        commandLabel: alert.command?.commandLabel ?? alert.issueType?.name ?? "Help Call",
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
  app.get("/api/operator/bootstrap", { preHandler: app.authenticate }, async (request) => {
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
      where: { companyId: ctx.companyId, active: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }]
    });
    const commandTemplates = await prisma.commandTemplate.findMany({
      where: { companyId: ctx.companyId, active: true },
      include: { targets: { include: { department: true, issueType: true }, orderBy: { sortOrder: "asc" } } },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }]
    });

    return { success: true, data: { machines, machineGroups, departments, issueTypes, commandTemplates } };
  });

  app.get("/api/operator/snapshot", { preHandler: app.authenticate }, async (request) => {
    const ctx = request.membershipContext!;
    const machines = await prisma.machine.findMany({ where: machineWhereForContext(ctx), select: { id: true } });
    const machineIds = machines.map((machine) => machine.id);
    const alerts = await prisma.andonAlert.findMany({
      where: { companyId: ctx.companyId, machineId: { in: machineIds }, status: { in: [...ACTIVE_ALERT_STATUSES] } },
      include: includeAlert(),
      orderBy: { createdAt: "desc" }
    });
    return { success: true, data: { commands: groupCommands(alerts), alerts: alerts.map(serializeAlert) } };
  });
}
