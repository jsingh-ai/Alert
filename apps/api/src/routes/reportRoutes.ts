import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { departmentWhereForContext, machineWhereForContext } from "../services/permissions.js";
import { dayKeyInTimeZone, parseDateInputEnd, parseDateInputStart } from "../utils/time.js";

function secondsBetween(start: Date | null, end: Date | null) {
  if (!start || !end) return null;
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000));
}

function avg(values: Array<number | null>) {
  const valid = values.filter((value): value is number => typeof value === "number");
  if (!valid.length) return null;
  return Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length);
}

export async function reportRoutes(app: FastifyInstance) {
  app.get("/api/reports/summary", { preHandler: app.authenticate }, async (request) => {
    const ctx = request.membershipContext!;
    const query = request.query as { start?: string; end?: string; departmentId?: string; machineGroupId?: string };
    const timeZone = config.reportTimeZone;
    const end = parseDateInputEnd(query.end, new Date(), timeZone);
    const start = parseDateInputStart(query.start, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), timeZone);
    const machineWhere = {
      ...machineWhereForContext(ctx),
      ...(query.machineGroupId ? { machineGroupId: query.machineGroupId } : {})
    };
    const departmentWhere = {
      ...departmentWhereForContext(ctx),
      ...(query.departmentId ? { id: query.departmentId } : {})
    };

    const alerts = await prisma.andonAlert.findMany({
      where: { companyId: ctx.companyId, createdAt: { gte: start, lte: end }, machine: machineWhere, department: departmentWhere },
      include: { machine: { include: { machineGroup: true } }, department: true, issueType: true },
      orderBy: { createdAt: "desc" }
    });

    const byDepartment = new Map<string, number>();
    const byMachine = new Map<string, number>();
    const byMachineGroup = new Map<string, number>();
    const byIssue = new Map<string, number>();
    const byHour = new Map<string, number>();
    const byDay = new Map<string, { count: number; acknowledgeSeconds: Array<number | null>; clearSeconds: Array<number | null> }>();

    for (const alert of alerts) {
      byDepartment.set(alert.department.name, (byDepartment.get(alert.department.name) ?? 0) + 1);
      byMachine.set(alert.machine.name, (byMachine.get(alert.machine.name) ?? 0) + 1);
      byMachineGroup.set(alert.machine.machineGroup.name, (byMachineGroup.get(alert.machine.machineGroup.name) ?? 0) + 1);
      byIssue.set(alert.issueType?.name ?? "General help", (byIssue.get(alert.issueType?.name ?? "General help") ?? 0) + 1);
      const hour = `${alert.createdAt.getHours().toString().padStart(2, "0")}:00`;
      byHour.set(hour, (byHour.get(hour) ?? 0) + 1);
      const day = dayKeyInTimeZone(alert.createdAt, timeZone);
      const dayStats = byDay.get(day) ?? { count: 0, acknowledgeSeconds: [], clearSeconds: [] };
      dayStats.count += 1;
      dayStats.acknowledgeSeconds.push(secondsBetween(alert.createdAt, alert.acknowledgedAt));
      dayStats.clearSeconds.push(secondsBetween(alert.arrivedAt ?? alert.acknowledgedAt, alert.resolvedAt));
      byDay.set(day, dayStats);
    }

    const open = alerts.filter((alert) => ["OPEN", "ACKNOWLEDGED", "ARRIVED"].includes(alert.status)).length;
    const closed = alerts.filter((alert) => ["RESOLVED", "CANCELLED"].includes(alert.status)).length;

    return {
      success: true,
      data: {
        range: { start, end },
        totalAlerts: alerts.length,
        openAlerts: open,
        closedAlerts: closed,
        averageAcknowledgeSeconds: avg(alerts.map((alert) => secondsBetween(alert.createdAt, alert.acknowledgedAt))),
        averageClearSeconds: avg(alerts.map((alert) => secondsBetween(alert.arrivedAt ?? alert.acknowledgedAt, alert.resolvedAt))),
        averageResolveSeconds: avg(alerts.map((alert) => secondsBetween(alert.createdAt, alert.resolvedAt))),
        byDepartment: Array.from(byDepartment, ([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
        byMachine: Array.from(byMachine, ([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
        byMachineGroup: Array.from(byMachineGroup, ([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
        byIssue: Array.from(byIssue, ([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
        byHour: Array.from(byHour, ([hour, count]) => ({ hour, count })).sort((a, b) => a.hour.localeCompare(b.hour)),
        byDay: Array.from(byDay, ([day, stats]) => ({
          day,
          count: stats.count,
          averageAcknowledgeSeconds: avg(stats.acknowledgeSeconds),
          averageClearSeconds: avg(stats.clearSeconds)
        })).sort((a, b) => a.day.localeCompare(b.day)),
        latest: alerts.slice(0, 25)
      }
    };
  });
}
