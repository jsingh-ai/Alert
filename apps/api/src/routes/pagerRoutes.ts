import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { alertCommandLabel, includePagerAlert, serializePagerAlert, transitionAlert } from "../services/alertService.js";
import { createAlertSystemMessages, serializeMessage } from "../services/communicationService.js";
import { ACTIVE_ALERT_STATUSES } from "../services/permissions.js";
import { emitChannel, emitCompany } from "../services/realtime.js";
import { sha256 } from "../utils/crypto.js";

type PagerContext = NonNullable<Awaited<ReturnType<typeof loadPager>>>;
const MAX_PAGER_ACTIVE_ALERTS = 50;

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

async function loadPager(request: FastifyRequest) {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const rawToken = header.slice("Bearer ".length).trim();
  if (!rawToken) return null;
  const hash = sha256(rawToken);
  const pager = await prisma.pagerDevice.findUnique({
    where: { tokenHash: hash },
    include: { company: true, department: true }
  });
  if (!pager || !pager.active || !pager.company.active || !pager.department.active) return null;
  const now = new Date();
  if (!pager.lastSeenAt || now.getTime() - pager.lastSeenAt.getTime() > 60_000) {
    await prisma.pagerDevice.update({ where: { id: pager.id }, data: { lastSeenAt: now } }).catch(() => undefined);
  }
  return pager;
}

async function requirePager(request: FastifyRequest, reply: FastifyReply) {
  const pager = await loadPager(request);
  if (!pager) {
    reply.code(403).send({ success: false, error: "Invalid or inactive pager token." });
    return null;
  }
  return pager;
}

async function activePagerAlerts(pager: PagerContext) {
  const alerts = await prisma.andonAlert.findMany({
    where: {
      companyId: pager.companyId,
      departmentId: pager.departmentId,
      status: { in: [...ACTIVE_ALERT_STATUSES] }
    },
    include: includePagerAlert(),
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    take: MAX_PAGER_ACTIVE_ALERTS
  });
  return alerts.map(serializePagerAlert);
}

export async function pagerRoutes(app: FastifyInstance) {
  const pagerRateLimit = { config: { rateLimit: { max: config.rateLimit.pagerMax, timeWindow: config.rateLimit.timeWindow } } };

  async function getActive(request: FastifyRequest, reply: FastifyReply) {
    const pager = await requirePager(request, reply);
    if (!pager) return;
    reply.header("Cache-Control", "no-store");
    return { success: true, data: await activePagerAlerts(pager) };
  }

  async function postAction(request: FastifyRequest, reply: FastifyReply, action: "acknowledge" | "arrive" | "resolve") {
    const pager = await requirePager(request, reply);
    if (!pager) return;
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { responder_name_text?: string; responderNameText?: string; note?: string };
    const alertId = cleanString(params.id);
    const responderNameText = cleanString(body.responderNameText ?? body.responder_name_text) || pager.name;
    const note = cleanString(body.note);
    if (!alertId) return reply.code(400).send({ success: false, error: "Alert id is required." });
    if (responderNameText.length > 120) return reply.code(400).send({ success: false, error: "Responder name is too long." });
    if (note.length > 1000) return reply.code(400).send({ success: false, error: "Note is too long." });

    try {
      const result = await prisma.$transaction(async (tx) => {
        const updated = await transitionAlert(tx, {
          alertId,
          companyId: pager.companyId,
          departmentId: pager.departmentId,
          action,
          actorUserId: null,
          actorNameText: responderNameText,
          responderNameText,
          note: note || `${action} from ${pager.name}`
        });

        const notifications: Array<{ channelId: string; message: any }> = [];
        if (action === "resolve") {
          const commandLabel = alertCommandLabel(updated);
          const message = `${commandLabel} alert resolved on ${updated.machine.name}${updated.machine.code ? ` (${updated.machine.code})` : ""}.`;
          notifications.push(...await createAlertSystemMessages(tx, {
            companyId: pager.companyId,
            userId: null,
            actorNameText: responderNameText,
            machineId: updated.machineId,
            departmentId: updated.departmentId,
            alertId: updated.id,
            body: message,
            clientMessageKey: "alert-resolved"
          }));
        }

        return { updated, notifications };
      });
      const updated = result.updated;
      emitCompany(pager.companyId, "alert.changed", { alertId: updated.id, commandId: updated.commandId, action, source: "pager" });
      for (const notification of result.notifications) {
        emitChannel(notification.channelId, "communication.message.created", serializeMessage(notification.message as any));
      }
      return { success: true, data: serializePagerAlert(updated as any) };
    } catch (error: any) {
      return reply.code(error.statusCode ?? 500).send({ success: false, error: error.message ?? "Pager action failed." });
    }
  }

  app.get("/api/andon/pager/alerts/active", pagerRateLimit, getActive);
  app.get("/api/pager/alerts/active", pagerRateLimit, getActive);

  app.post("/api/andon/pager/alerts/:id/acknowledge", pagerRateLimit, (request, reply) => postAction(request, reply, "acknowledge"));
  app.post("/api/pager/alerts/:id/acknowledge", pagerRateLimit, (request, reply) => postAction(request, reply, "acknowledge"));

  app.post("/api/andon/pager/alerts/:id/arrive", pagerRateLimit, (request, reply) => postAction(request, reply, "arrive"));
  app.post("/api/pager/alerts/:id/arrive", pagerRateLimit, (request, reply) => postAction(request, reply, "arrive"));

  app.post("/api/andon/pager/alerts/:id/resolve", pagerRateLimit, (request, reply) => postAction(request, reply, "resolve"));
  app.post("/api/pager/alerts/:id/resolve", pagerRateLimit, (request, reply) => postAction(request, reply, "resolve"));
}
