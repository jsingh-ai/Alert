import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { alertCommandLabel } from "../services/alertService.js";
import { ACTIVE_ALERT_STATUSES } from "../services/permissions.js";
import { sha256 } from "../utils/crypto.js";
import { formatInTimeZone, parseZonedInput } from "../utils/time.js";

/*
 * Read-only data for other systems (dashboards, Power Automate, scripts), protected by one API key.
 *   GET /api/external/active   machines, teams and the calls active right now (?machine=<code or id>, ?team=<name>)
 *   GET /api/external/calls    call history (from, to, team, machine, status, limit, offset), and /api/external/calls/<id> for one call
 * Send the key as "Authorization: Bearer <key>" or "X-API-Key: <key>". The key lives in .env
 * (EXTERNAL_API_KEY, made with `npm run api:key`); without it these routes answer 503.
 * Nothing here can change data.
 */

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const MAX_RANGE_DAYS = 92;
const HISTORY_DEFAULT = 1000;
const HISTORY_MAX = 5000;
const STATUSES = ["OPEN", "ACKNOWLEDGED", "ARRIVED", "RESOLVED", "CANCELLED"] as const;

const keyHash = config.externalApi.key ? Buffer.from(sha256(config.externalApi.key)) : null;

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function seconds(start: Date | null, end: Date | null) {
  return start && end ? Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000)) : null;
}

/** Hashing both sides makes the lengths equal, so the comparison takes the same time whatever is sent. */
function keyMatches(sent: string) {
  return Boolean(keyHash && sent && timingSafeEqual(Buffer.from(sha256(sent)), keyHash));
}

async function authorize(request: FastifyRequest, reply: FastifyReply) {
  if (!keyHash) return reply.code(503).send({ success: false, error: "The external API isn't set up on this server." });
  const bearer = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7).trim() : "";
  const sent = bearer || cleanString(request.headers["x-api-key"]);
  if (!keyMatches(sent)) return reply.code(401).send({ success: false, error: "Missing or invalid API key." });
  reply.header("Cache-Control", "no-store");
}

/** The one company this key reads: EXTERNAL_API_COMPANY (its slug), or the only active company. */
async function companyId() {
  const companies = await prisma.company.findMany({
    where: { active: true, ...(config.externalApi.companySlug ? { slug: config.externalApi.companySlug } : {}) },
    select: { id: true },
    take: 2
  });
  return companies.length === 1 ? companies[0].id : null;
}

const callInclude = {
  machine: { include: { machineGroup: true } },
  department: true,
  issueType: true,
  command: true,
  acknowledgedByUser: { select: { displayName: true, username: true } }
} as const;

type CallRow = Awaited<ReturnType<typeof loadCalls>>[number];

function loadCalls(args: { where: object; orderBy: object; take?: number; skip?: number }) {
  return prisma.andonAlert.findMany({ ...args, include: callInclude });
}

function serializeCall(alert: CallRow) {
  const command = alert.command;
  return {
    id: alert.id,
    call: alertCommandLabel(alert),
    status: alert.status,
    priority: alert.priority,
    machine: { id: alert.machine.id, name: alert.machine.name, code: alert.machine.code, group: alert.machine.machineGroup.name },
    team: { id: alert.department.id, name: alert.department.name },
    issue: alert.issueType?.name ?? null,
    message: alert.displayMessage ?? alert.operatorNote ?? null,
    responder: alert.acknowledgedByUser ? alert.acknowledgedByUser.displayName || alert.acknowledgedByUser.username : alert.responderNameText ?? null,
    calledAt: at(alert.createdAt),
    acceptedAt: at(alert.acknowledgedAt),
    arrivedAt: at(alert.arrivedAt ?? alert.resolvedAt),
    closedAt: at(alert.resolvedAt),
    cancelledAt: at(alert.cancelledAt),
    secondsToAccept: seconds(alert.createdAt, alert.acknowledgedAt),
    secondsToArrive: seconds(alert.createdAt, alert.arrivedAt ?? alert.resolvedAt),
    // A call sent to several teams is one job: the same job id on each team's row
    job: command
      ? { id: command.id, status: command.status, calledAt: at(command.createdAt), closedAt: at(command.closedAt), totalSeconds: command.status === "CLOSED" ? seconds(command.createdAt, command.closedAt) : null }
      : null
  };
}

/** Every time this API returns or accepts is in the company's time zone (REPORT_TIME_ZONE, Central by default). */
const ZONE = config.reportTimeZone;
const at = (date: Date | null | undefined) => (date ? formatInTimeZone(date, ZONE) : null);

function parseDate(value: unknown, boundary: "start" | "end") {
  return parseZonedInput(cleanString(value), ZONE, boundary);
}

/** A team by name ("Maintenance", any capitalisation): the id, null when there is no such team. Done here so it works on every database. */
async function teamIdByName(company: string, name: string) {
  const teams = await prisma.department.findMany({ where: { companyId: company }, select: { id: true, name: true } });
  return teams.find((team) => team.name.toLowerCase() === name.toLowerCase())?.id ?? null;
}

const NO_COMPANY = "Set EXTERNAL_API_COMPANY to a company slug: this server has more than one company.";

export async function externalRoutes(app: FastifyInstance) {
  const limits = { config: { rateLimit: { max: config.rateLimit.pagerMax, timeWindow: config.rateLimit.timeWindow } } };

  /*
   * Every machine, and for the ones with a call open right now: the team called, its status
   * (OPEN, or ACKNOWLEDGED once accepted), when it started, and when it was accepted (only then).
   * Optional: ?machine=<code or id>, ?team=<name>.
   */
  app.get("/api/external/active", { ...limits, preHandler: authorize }, async (request, reply) => {
    const company = await companyId();
    if (!company) return reply.code(503).send({ success: false, error: NO_COMPANY });
    const query = request.query as Record<string, unknown>;
    const machineFilter = cleanString(query.machine);
    const byMachine = machineFilter ? { OR: [{ id: machineFilter }, { code: machineFilter }] } : {};
    const teamFilter = cleanString(query.team);
    const teamId = teamFilter ? await teamIdByName(company, teamFilter) : null;
    if (teamFilter && !teamId) return reply.code(404).send({ success: false, error: "No team with that name." });

    const [machines, alerts] = await Promise.all([
      prisma.machine.findMany({ where: { companyId: company, active: true, ...byMachine }, include: { machineGroup: true }, orderBy: [{ machineGroup: { name: "asc" } }, { name: "asc" }] }),
      prisma.andonAlert.findMany({
        where: { companyId: company, status: { in: [...ACTIVE_ALERT_STATUSES] }, ...(machineFilter ? { machine: byMachine } : {}), ...(teamId ? { departmentId: teamId } : {}) },
        select: { machineId: true, status: true, createdAt: true, acknowledgedAt: true, arrivedAt: true, department: { select: { name: true } } },
        orderBy: { createdAt: "asc" },
        take: MAX_LIMIT
      })
    ]);
    if (machineFilter && machines.length === 0) return reply.code(404).send({ success: false, error: "No machine with that code or id." });
    return {
      success: true,
      data: {
        machines: machines.map((machine) => {
          const calls = alerts.filter((alert) => alert.machineId === machine.id).map((alert) => {
            const acceptedAt = alert.status === "OPEN" ? null : alert.acknowledgedAt ?? alert.arrivedAt;
            return {
              department: alert.department.name,
              status: alert.status === "OPEN" ? "OPEN" : "ACKNOWLEDGED",
              activeSince: at(alert.createdAt),
              // Left out until someone accepts it
              ...(acceptedAt ? { acceptedAt: at(acceptedAt) } : {})
            };
          });
          return { id: machine.id, name: machine.name, code: machine.code, group: machine.machineGroup.name, activeCalls: calls.length, calls };
        })
      }
    };
  });

  // One call by its id (the alertId in the Teams message): start time, who accepted it, when it was resolved
  app.get("/api/external/calls/:id", { ...limits, preHandler: authorize }, async (request, reply) => {
    const company = await companyId();
    if (!company) return reply.code(503).send({ success: false, error: NO_COMPANY });
    const id = cleanString((request.params as { id?: string }).id);
    const [alert] = id ? await loadCalls({ where: { id, companyId: company }, orderBy: { createdAt: "desc" }, take: 1 }) : [];
    if (!alert) return reply.code(404).send({ success: false, error: "No call with that id." });
    return { success: true, data: serializeCall(alert) };
  });

  /*
   * Calls made between two times (?from=&to=, default the last 7 days), grouped by machine.
   * Every machine is listed; one with no calls in the window has callCount 0 and an empty list.
   * Same fields as /active, with calledAt for when it started, and for closed calls the closedAt time
   * and secondsToClose (called to closed). Optional: ?machine=<code or id>, ?team=<name>,
   * ?status=OPEN|ACKNOWLEDGED|CLOSED|CANCELLED, ?limit= (default 1000, up to 5000), ?offset=.
   */
  app.get("/api/external/calls", { ...limits, preHandler: authorize }, async (request, reply) => {
    const company = await companyId();
    if (!company) return reply.code(503).send({ success: false, error: NO_COMPANY });

    const query = request.query as Record<string, unknown>;
    const to = parseDate(query.to, "end");
    const from = parseDate(query.from, "start");
    if (to === undefined || from === undefined) return reply.code(400).send({ success: false, error: "from and to must be dates, e.g. 2026-11-01 or 2026-11-01T08:00:00Z." });
    const end = to ?? new Date();
    const start = from ?? new Date(end.getTime() - 7 * 86_400_000);
    if (start > end) return reply.code(400).send({ success: false, error: "from must be before to." });
    if ((end.getTime() - start.getTime()) / 86_400_000 > MAX_RANGE_DAYS) return reply.code(400).send({ success: false, error: `The range can't be longer than ${MAX_RANGE_DAYS} days.` });

    const statusFilter: Record<string, Array<(typeof STATUSES)[number]>> = { OPEN: ["OPEN"], ACKNOWLEDGED: ["ACKNOWLEDGED", "ARRIVED"], CLOSED: ["RESOLVED"], CANCELLED: ["CANCELLED"] };
    const status = cleanString(query.status).toUpperCase();
    if (status && !statusFilter[status]) return reply.code(400).send({ success: false, error: "status must be one of OPEN, ACKNOWLEDGED, CLOSED, CANCELLED." });
    const limit = Math.min(HISTORY_MAX, Math.max(1, Number.parseInt(cleanString(query.limit), 10) || HISTORY_DEFAULT));
    const offset = Math.max(0, Number.parseInt(cleanString(query.offset), 10) || 0);
    const teamName = cleanString(query.team);
    const teamId = teamName ? await teamIdByName(company, teamName) : null;
    if (teamName && !teamId) return reply.code(404).send({ success: false, error: "No team with that name." });
    const machine = cleanString(query.machine);

    const where = {
      companyId: company,
      createdAt: { gte: start, lte: end },
      ...(status ? { status: { in: statusFilter[status] } } : {}),
      ...(teamId ? { departmentId: teamId } : {}),
      ...(machine ? { machine: { OR: [{ id: machine }, { code: machine }] } } : {})
    };
    const [total, alerts] = await Promise.all([
      prisma.andonAlert.count({ where }),
      prisma.andonAlert.findMany({
        where,
        select: {
          status: true, createdAt: true, acknowledgedAt: true, arrivedAt: true, resolvedAt: true,
          department: { select: { name: true } },
          machine: { select: { id: true, name: true, code: true, machineGroup: { select: { name: true } } } }
        },
        orderBy: { createdAt: "asc" },
        take: limit,
        skip: offset
      })
    ]);

    const byMachine = new Map<string, { id: string; name: string; code: string; group: string; callCount: number; calls: Array<Record<string, unknown>> }>();
    for (const alert of alerts) {
      const entry = byMachine.get(alert.machine.id) ?? { id: alert.machine.id, name: alert.machine.name, code: alert.machine.code, group: alert.machine.machineGroup.name, callCount: 0, calls: [] };
      const acceptedAt = alert.status === "OPEN" || alert.status === "CANCELLED" ? null : alert.acknowledgedAt ?? alert.arrivedAt;
      const closed = alert.status === "RESOLVED" && alert.resolvedAt;
      entry.calls.push({
        department: alert.department.name,
        status: alert.status === "RESOLVED" ? "CLOSED" : alert.status === "ARRIVED" ? "ACKNOWLEDGED" : alert.status,
        calledAt: at(alert.createdAt),
        ...(acceptedAt ? { acceptedAt: at(acceptedAt) } : {}),
        ...(closed ? { closedAt: at(alert.resolvedAt), secondsToClose: seconds(alert.createdAt, alert.resolvedAt) } : {})
      });
      entry.callCount += 1;
      byMachine.set(alert.machine.id, entry);
    }
    // Every machine is listed, as in /active: the ones with no calls in this window show callCount 0
    const everyMachine = await prisma.machine.findMany({
      where: { companyId: company, active: true, ...(machine ? { OR: [{ id: machine }, { code: machine }] } : {}) },
      select: { id: true, name: true, code: true, machineGroup: { select: { name: true } } }
    });
    for (const m of everyMachine) {
      if (!byMachine.has(m.id)) byMachine.set(m.id, { id: m.id, name: m.name, code: m.code, group: m.machineGroup.name, callCount: 0, calls: [] });
    }
    if (machine && byMachine.size === 0) return reply.code(404).send({ success: false, error: "No machine with that code or id." });
    const machines = Array.from(byMachine.values()).sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    // Only said when the limit cut the list short, so a missing call is never silent
    const truncated = total > offset + alerts.length;
    return { success: true, data: { from: at(start), to: at(end), ...(truncated ? { truncated: true } : {}), machines } };
  });
}
