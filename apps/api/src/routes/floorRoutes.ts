import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { requirePage } from "../services/auth.js";
import { alertCommandLabel, includeAlert, serializeAlert } from "../services/alertService.js";
import { ACTIVE_ALERT_STATUSES, machineWhereForContext } from "../services/permissions.js";
import { startOfDayInTimeZone } from "../utils/time.js";

function groupCommands(alerts: any[]) {
  const grouped = new Map<string, any>();
  for (const alert of alerts) {
    const key = alert.commandId ?? `single:${alert.id}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        id: key,
        realCommandId: alert.commandId,
        commandLabel: alertCommandLabel(alert),
        status: alert.command?.status ?? alert.status,
        machine: {
          id: alert.machine.id,
          name: alert.machine.name,
          code: alert.machine.code,
          group: alert.machine.machineGroup.name
        },
        sharedNote: alert.command?.sharedNote ?? alert.operatorNote,
        createdAt: alert.command?.createdAt ?? alert.createdAt,
        alerts: []
      });
    }
    grouped.get(key).alerts.push(serializeAlert(alert));
  }
  return Array.from(grouped.values()).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

export async function floorRoutes(app: FastifyInstance) {
  app.get("/api/floor/active", { preHandler: requirePage(app, "floor") }, async (request) => {
    const ctx = request.membershipContext!;
    const fetched = await prisma.machine.findMany({
      where: machineWhereForContext(ctx),
      include: { machineGroup: true },
      // Ties (sortOrder defaults to 0) fall back to names, so the floor's order never shuffles
      orderBy: [{ machineGroup: { sortOrder: "asc" } }, { machineGroup: { name: "asc" } }, { sortOrder: "asc" }, { name: "asc" }]
    });
    // Same order, except names compare as people read them: "Press 3" before "Press 10" (the database sorts them as text)
    const areaRank = new Map<string, number>();
    for (const machine of fetched) if (!areaRank.has(machine.machineGroupId)) areaRank.set(machine.machineGroupId, areaRank.size);
    const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    const machines = [...fetched].sort((a, b) =>
      (areaRank.get(a.machineGroupId) ?? 0) - (areaRank.get(b.machineGroupId) ?? 0)
      || a.sortOrder - b.sortOrder
      || byName.compare(a.name, b.name));
    const machineIds = machines.map((machine) => machine.id);
    const todayStart = startOfDayInTimeZone(new Date(), config.reportTimeZone);
    if (machineIds.length === 0) {
      return { success: true, data: { commands: [], machines: [], machineStats: {} } };
    }
    const alerts = await prisma.andonAlert.findMany({
      where: { companyId: ctx.companyId, machineId: { in: machineIds }, status: { in: [...ACTIVE_ALERT_STATUSES] } },
      include: includeAlert(),
      orderBy: [{ createdAt: "asc" }]
    });
    const todayAlerts = await prisma.andonAlert.groupBy({
      by: ["machineId"],
      where: { companyId: ctx.companyId, machineId: { in: machineIds }, createdAt: { gte: todayStart } },
      _count: { _all: true }
    });
    // Calls today, not team alerts: a call to two teams is one call
    const todayRows = await prisma.andonAlert.findMany({
      where: { companyId: ctx.companyId, machineId: { in: machineIds }, createdAt: { gte: todayStart } },
      select: { id: true, machineId: true, commandId: true }
    });
    const todayCalls = new Map<string, Set<string>>();
    for (const row of todayRows) {
      const set = todayCalls.get(row.machineId) ?? new Set<string>();
      set.add(row.commandId ?? row.id);
      todayCalls.set(row.machineId, set);
    }
    const latestAlerts = await prisma.andonAlert.findMany({
      where: { companyId: ctx.companyId, machineId: { in: machineIds } },
      orderBy: { createdAt: "desc" },
      distinct: ["machineId"]
    });
    const activeCounts = new Map<string, number>();
    for (const alert of alerts) activeCounts.set(alert.machineId, (activeCounts.get(alert.machineId) ?? 0) + 1);
    const todayCounts = new Map(todayAlerts.map((item) => [item.machineId, item._count._all]));
    const latestByMachine = new Map(latestAlerts.map((alert) => {
      const end = alert.resolvedAt ?? alert.cancelledAt ?? new Date();
      return [alert.machineId, {
        createdAt: alert.createdAt,
        status: alert.status,
        durationSeconds: Math.max(0, Math.floor((end.getTime() - alert.createdAt.getTime()) / 1000))
      }];
    }));
    const machineStats = Object.fromEntries(machineIds.map((machineId) => [machineId, {
      alertsToday: todayCounts.get(machineId) ?? 0,
      callsToday: todayCalls.get(machineId)?.size ?? 0,
      activeAlerts: activeCounts.get(machineId) ?? 0,
      lastAlert: latestByMachine.get(machineId) ?? null
    }]));

    return { success: true, data: { commands: groupCommands(alerts), machines, machineStats } };
  });
}
