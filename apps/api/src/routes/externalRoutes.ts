import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { alertCommandLabel } from "../services/alertService.js";
import { ACTIVE_ALERT_STATUSES } from "../services/permissions.js";
import { sha256 } from "../utils/crypto.js";

/*
 * Read-only data for other systems (dashboards, Power Automate, scripts), protected by one API key.
 *   GET /api/external/active   machines, teams and the calls active right now (?machine=<code or id> for one machine)
 *   GET /api/external/calls    call history (from, to, departmentId, machine, status, limit, offset)
 * Send the key as "Authorization: Bearer <key>" or "X-API-Key: <key>". The key lives in .env
 * (EXTERNAL_API_KEY, made with `npm run api:key`); without it these routes answer 503.
 * Nothing here can change data.
 */

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const MAX_RANGE_DAYS = 92;
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
    calledAt: alert.createdAt,
    acceptedAt: alert.acknowledgedAt,
    arrivedAt: alert.arrivedAt ?? alert.resolvedAt,
    closedAt: alert.resolvedAt,
    cancelledAt: alert.cancelledAt,
    secondsToAccept: seconds(alert.createdAt, alert.acknowledgedAt),
    secondsToArrive: seconds(alert.createdAt, alert.arrivedAt ?? alert.resolvedAt),
    // A call sent to several teams is one job: the same job id on each team's row
    job: command
      ? { id: command.id, status: command.status, calledAt: command.createdAt, closedAt: command.closedAt, totalSeconds: command.status === "CLOSED" ? seconds(command.createdAt, command.closedAt) : null }
      : null
  };
}

function parseDate(value: unknown) {
  const text = cleanString(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

const NO_COMPANY = "Set EXTERNAL_API_COMPANY to a company slug: this server has more than one company.";

export async function externalRoutes(app: FastifyInstance) {
  const limits = { config: { rateLimit: { max: config.rateLimit.pagerMax, timeWindow: config.rateLimit.timeWindow } } };

  app.get("/api/external/active", { ...limits, preHandler: authorize }, async (request, reply) => {
    const company = await companyId();
    if (!company) return reply.code(503).send({ success: false, error: NO_COMPANY });
    // ?machine=<code or id> narrows everything to one machine
    const machineFilter = cleanString((request.query as Record<string, unknown>).machine);
    const byMachine = machineFilter ? { OR: [{ id: machineFilter }, { code: machineFilter }] } : {};

    const [machines, departments, alerts] = await Promise.all([
      prisma.machine.findMany({ where: { companyId: company, active: true, ...byMachine }, include: { machineGroup: true }, orderBy: [{ machineGroup: { name: "asc" } }, { name: "asc" }] }),
      prisma.department.findMany({ where: { companyId: company, active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
      loadCalls({ where: { companyId: company, status: { in: [...ACTIVE_ALERT_STATUSES] }, ...(machineFilter ? { machine: byMachine } : {}) }, orderBy: { createdAt: "asc" }, take: MAX_LIMIT })
    ]);
    const calls = alerts.map(serializeCall);
    const count = (key: "machine" | "team", id: string) => calls.filter((call) => call[key].id === id).length;
    if (machineFilter && machines.length === 0) return reply.code(404).send({ success: false, error: "No machine with that code or id." });
    return {
      success: true,
      data: {
        generatedAt: new Date(),
        machines: machines.map((machine) => ({ id: machine.id, name: machine.name, code: machine.code, group: machine.machineGroup.name,
          activeCalls: count("machine", machine.id),
          // Calls come oldest first, so the first one is when this machine's current call started
          activeSince: calls.find((call) => call.machine.id === machine.id)?.calledAt ?? null
        })),
        teams: departments.map((team) => ({ id: team.id, name: team.name, activeCalls: count("team", team.id) })),
        calls
      }
    };
  });

  app.get("/api/external/calls", { ...limits, preHandler: authorize }, async (request, reply) => {
    const company = await companyId();
    if (!company) return reply.code(503).send({ success: false, error: NO_COMPANY });

    const query = request.query as Record<string, unknown>;
    const to = parseDate(query.to);
    const from = parseDate(query.from);
    if (to === undefined || from === undefined) return reply.code(400).send({ success: false, error: "from and to must be dates, e.g. 2026-11-01 or 2026-11-01T08:00:00Z." });
    const end = to ?? new Date();
    const start = from ?? new Date(end.getTime() - 7 * 86_400_000);
    if (start > end) return reply.code(400).send({ success: false, error: "from must be before to." });
    if ((end.getTime() - start.getTime()) / 86_400_000 > MAX_RANGE_DAYS) return reply.code(400).send({ success: false, error: `The range can't be longer than ${MAX_RANGE_DAYS} days.` });

    const status = cleanString(query.status).toUpperCase();
    if (status && !(STATUSES as readonly string[]).includes(status)) return reply.code(400).send({ success: false, error: `status must be one of ${STATUSES.join(", ")}.` });
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(cleanString(query.limit), 10) || DEFAULT_LIMIT));
    const offset = Math.max(0, Number.parseInt(cleanString(query.offset), 10) || 0);
    const departmentId = cleanString(query.departmentId);
    const machine = cleanString(query.machine) || cleanString(query.machineId);

    const where = {
      companyId: company,
      createdAt: { gte: start, lte: end },
      ...(status ? { status: status as (typeof STATUSES)[number] } : {}),
      ...(departmentId ? { departmentId } : {}),
      ...(machine ? { machine: { OR: [{ id: machine }, { code: machine }] } } : {})
    };
    const [total, alerts] = await Promise.all([
      prisma.andonAlert.count({ where }),
      loadCalls({ where, orderBy: { createdAt: "desc" }, take: limit, skip: offset })
    ]);
    return { success: true, data: { from: start, to: end, total, limit, offset, calls: alerts.map(serializeCall) } };
  });
}
