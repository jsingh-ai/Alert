import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { alertCommandLabel } from "../services/alertService.js";
import { departmentWhereForContext, machineWhereForContext } from "../services/permissions.js";
import { dayKeyInTimeZone, parseDateInputEnd, parseDateInputStart } from "../utils/time.js";

const MAX_REPORT_RANGE_DAYS = 90;
const MAX_REPORT_ALERTS_LOADED = 25_000;
const dateInputPattern = /^(\d{4})-(\d{2})-(\d{2})$/;

function secondsBetween(start: Date | null, end: Date | null) {
  if (!start || !end) return null;
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000));
}

function avg(values: Array<number | null>) {
  const valid = values.filter((value): value is number => typeof value === "number");
  if (!valid.length) return null;
  return Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length);
}

function hourKeyInTimeZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hour12: false,
    hourCycle: "h23"
  }).formatToParts(date);
  return `${parts.find((part) => part.type === "hour")?.value ?? "00"}:00`;
}

function parseReportBoundary(value: unknown, fallback: Date, timeZone: string, boundary: "start" | "end") {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const parsed = dateInputPattern.test(trimmed)
    ? boundary === "start"
      ? parseDateInputStart(trimmed, fallback, timeZone)
      : parseDateInputEnd(trimmed, fallback, timeZone)
    : new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function reportRoutes(app: FastifyInstance) {
  app.get("/api/reports/summary", { preHandler: app.authenticate }, async (request, reply) => {
    const ctx = request.membershipContext!;
    const query = request.query as { start?: string; end?: string; departmentId?: string; machineGroupId?: string; machineId?: string };
    const timeZone = config.reportTimeZone;
    const end = parseReportBoundary(query.end, new Date(), timeZone, "end");
    const start = parseReportBoundary(query.start, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), timeZone, "start");
    if (!start || !end) return reply.code(400).send({ success: false, error: "Report dates are invalid." });
    if (start.getTime() > end.getTime()) return reply.code(400).send({ success: false, error: "Report start date must be before end date." });
    const rangeDays = (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
    if (rangeDays > MAX_REPORT_RANGE_DAYS) {
      return reply.code(400).send({ success: false, error: `Report range cannot exceed ${MAX_REPORT_RANGE_DAYS} days.` });
    }

    const machineWhere = {
      ...machineWhereForContext(ctx),
      ...(query.machineGroupId ? { machineGroupId: query.machineGroupId } : {}),
      ...(query.machineId ? { id: query.machineId } : {})
    };
    const departmentWhere = {
      ...departmentWhereForContext(ctx),
      ...(query.departmentId ? { id: query.departmentId } : {})
    };

    const alerts = await prisma.andonAlert.findMany({
      where: { companyId: ctx.companyId, createdAt: { gte: start, lte: end }, machine: machineWhere, department: departmentWhere },
      include: { machine: { include: { machineGroup: true } }, department: true, issueType: true, command: true },
      orderBy: { createdAt: "desc" },
      take: MAX_REPORT_ALERTS_LOADED + 1
    });
    if (alerts.length > MAX_REPORT_ALERTS_LOADED) {
      return reply.code(413).send({ success: false, error: `Report result is too large. Narrow the filters or date range below ${MAX_REPORT_ALERTS_LOADED} alerts.` });
    }

    const byDepartment = new Map<string, { id: string; name: string; count: number; acknowledgeSeconds: Array<number | null>; clearSeconds: Array<number | null> }>();
    const byMachine = new Map<string, { id: string; name: string; code: string; groupId: string; groupName: string; count: number; acknowledgeSeconds: Array<number | null>; clearSeconds: Array<number | null> }>();
    const byMachineGroup = new Map<string, { id: string; name: string; count: number; acknowledgeSeconds: Array<number | null>; clearSeconds: Array<number | null> }>();
    const byIssue = new Map<string, { id: string | null; name: string; count: number; acknowledgeSeconds: Array<number | null>; clearSeconds: Array<number | null> }>();
    const byHour = new Map<string, number>();
    const byDay = new Map<string, { count: number; acknowledgeSeconds: Array<number | null>; clearSeconds: Array<number | null> }>();

    for (const alert of alerts) {
      const acknowledgeSeconds = secondsBetween(alert.createdAt, alert.acknowledgedAt);
      const clearSeconds = secondsBetween(alert.arrivedAt ?? alert.acknowledgedAt, alert.resolvedAt);
      const departmentStats = byDepartment.get(alert.department.id) ?? { id: alert.department.id, name: alert.department.name, count: 0, acknowledgeSeconds: [], clearSeconds: [] };
      departmentStats.count += 1;
      departmentStats.acknowledgeSeconds.push(acknowledgeSeconds);
      departmentStats.clearSeconds.push(clearSeconds);
      byDepartment.set(alert.department.id, departmentStats);

      const machineStats = byMachine.get(alert.machine.id) ?? {
        id: alert.machine.id,
        name: alert.machine.name,
        code: alert.machine.code,
        groupId: alert.machine.machineGroup.id,
        groupName: alert.machine.machineGroup.name,
        count: 0,
        acknowledgeSeconds: [],
        clearSeconds: []
      };
      machineStats.count += 1;
      machineStats.acknowledgeSeconds.push(acknowledgeSeconds);
      machineStats.clearSeconds.push(clearSeconds);
      byMachine.set(alert.machine.id, machineStats);

      const groupStats = byMachineGroup.get(alert.machine.machineGroup.id) ?? { id: alert.machine.machineGroup.id, name: alert.machine.machineGroup.name, count: 0, acknowledgeSeconds: [], clearSeconds: [] };
      groupStats.count += 1;
      groupStats.acknowledgeSeconds.push(acknowledgeSeconds);
      groupStats.clearSeconds.push(clearSeconds);
      byMachineGroup.set(alert.machine.machineGroup.id, groupStats);

      const issueKey = alert.issueType?.id ?? "general-help";
      const issueStats = byIssue.get(issueKey) ?? { id: alert.issueType?.id ?? null, name: alert.issueType?.name ?? "General help", count: 0, acknowledgeSeconds: [], clearSeconds: [] };
      issueStats.count += 1;
      issueStats.acknowledgeSeconds.push(acknowledgeSeconds);
      issueStats.clearSeconds.push(clearSeconds);
      byIssue.set(issueKey, issueStats);
      const hour = hourKeyInTimeZone(alert.createdAt, timeZone);
      byHour.set(hour, (byHour.get(hour) ?? 0) + 1);
      const day = dayKeyInTimeZone(alert.createdAt, timeZone);
      const dayStats = byDay.get(day) ?? { count: 0, acknowledgeSeconds: [], clearSeconds: [] };
      dayStats.count += 1;
      dayStats.acknowledgeSeconds.push(acknowledgeSeconds);
      dayStats.clearSeconds.push(clearSeconds);
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
        byDepartment: Array.from(byDepartment.values(), (stats) => ({ ...stats, averageAcknowledgeSeconds: avg(stats.acknowledgeSeconds), averageClearSeconds: avg(stats.clearSeconds), acknowledgeSeconds: undefined, clearSeconds: undefined })).sort((a, b) => b.count - a.count),
        byMachine: Array.from(byMachine.values(), (stats) => ({ ...stats, averageAcknowledgeSeconds: avg(stats.acknowledgeSeconds), averageClearSeconds: avg(stats.clearSeconds), acknowledgeSeconds: undefined, clearSeconds: undefined })).sort((a, b) => b.count - a.count),
        byMachineGroup: Array.from(byMachineGroup.values(), (stats) => ({ ...stats, averageAcknowledgeSeconds: avg(stats.acknowledgeSeconds), averageClearSeconds: avg(stats.clearSeconds), acknowledgeSeconds: undefined, clearSeconds: undefined })).sort((a, b) => b.count - a.count),
        byIssue: Array.from(byIssue.values(), (stats) => ({ ...stats, averageAcknowledgeSeconds: avg(stats.acknowledgeSeconds), averageClearSeconds: avg(stats.clearSeconds), acknowledgeSeconds: undefined, clearSeconds: undefined })).sort((a, b) => b.count - a.count),
        byHour: Array.from(byHour, ([hour, count]) => ({ hour, count })).sort((a, b) => a.hour.localeCompare(b.hour)),
        byDay: Array.from(byDay, ([day, stats]) => ({
          day,
          count: stats.count,
          averageAcknowledgeSeconds: avg(stats.acknowledgeSeconds),
          averageClearSeconds: avg(stats.clearSeconds)
        })).sort((a, b) => a.day.localeCompare(b.day)),
        alerts: alerts.map((alert) => ({
          id: alert.id,
          commandId: alert.commandId,
          commandLabel: alertCommandLabel(alert),
          machine: {
            id: alert.machine.id,
            name: alert.machine.name,
            code: alert.machine.code,
            groupId: alert.machine.machineGroup.id,
            groupName: alert.machine.machineGroup.name
          },
          department: { id: alert.department.id, name: alert.department.name },
          issueType: alert.issueType ? { id: alert.issueType.id, name: alert.issueType.name } : null,
          status: alert.status,
          priority: alert.priority,
          displayMessage: alert.displayMessage,
          operatorNote: alert.operatorNote,
          createdAt: alert.createdAt,
          dayKey: dayKeyInTimeZone(alert.createdAt, timeZone),
          hourKey: hourKeyInTimeZone(alert.createdAt, timeZone),
          acknowledgedAt: alert.acknowledgedAt,
          arrivedAt: alert.arrivedAt,
          resolvedAt: alert.resolvedAt,
          cancelledAt: alert.cancelledAt,
          acknowledgeSeconds: secondsBetween(alert.createdAt, alert.acknowledgedAt),
          clearSeconds: secondsBetween(alert.arrivedAt ?? alert.acknowledgedAt, alert.resolvedAt),
          resolveSeconds: secondsBetween(alert.createdAt, alert.resolvedAt)
        })),
        latest: alerts.slice(0, 25)
      }
    };
  });
}
