import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../db.js";
import { includeAlert, serializePagerAlert, transitionAlert } from "../services/alertService.js";
import { ACTIVE_ALERT_STATUSES } from "../services/permissions.js";
import { emitCompany } from "../services/realtime.js";
import { sha256 } from "../utils/crypto.js";

type PagerContext = NonNullable<Awaited<ReturnType<typeof loadPager>>>;

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
    include: includeAlert(),
    orderBy: [{ status: "asc" }, { createdAt: "asc" }]
  });
  return alerts.map(serializePagerAlert);
}

export async function pagerRoutes(app: FastifyInstance) {
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
    const responderNameText = body.responderNameText ?? body.responder_name_text ?? pager.name;

    try {
      const updated = await prisma.$transaction((tx) => transitionAlert(tx, {
        alertId: params.id,
        companyId: pager.companyId,
        departmentId: pager.departmentId,
        action,
        actorUserId: null,
        actorNameText: responderNameText,
        responderNameText,
        note: body.note ?? `${action} from ${pager.name}`
      }));
      emitCompany(pager.companyId, "alert.changed", { alertId: updated.id, commandId: updated.commandId, action, source: "pager" });
      return { success: true, data: serializePagerAlert(updated as any) };
    } catch (error: any) {
      return reply.code(error.statusCode ?? 500).send({ success: false, error: error.message ?? "Pager action failed." });
    }
  }

  app.get("/api/andon/pager/alerts/active", getActive);
  app.get("/api/pager/alerts/active", getActive);

  app.post("/api/andon/pager/alerts/:id/acknowledge", (request, reply) => postAction(request, reply, "acknowledge"));
  app.post("/api/pager/alerts/:id/acknowledge", (request, reply) => postAction(request, reply, "acknowledge"));

  app.post("/api/andon/pager/alerts/:id/arrive", (request, reply) => postAction(request, reply, "arrive"));
  app.post("/api/pager/alerts/:id/arrive", (request, reply) => postAction(request, reply, "arrive"));

  app.post("/api/andon/pager/alerts/:id/resolve", (request, reply) => postAction(request, reply, "resolve"));
  app.post("/api/pager/alerts/:id/resolve", (request, reply) => postAction(request, reply, "resolve"));
}
