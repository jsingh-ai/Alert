import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { pushPublicKey } from "../services/push.js";
import { isPushServiceUrl } from "../services/webPushCrypto.js";

/*
 * Turning call notifications on and off for this device.
 *   GET  /api/push/key          the key a device subscribes with (null = push isn't set up on this server)
 *   POST /api/push/subscribe    this device now belongs to the signed-in person (shared phones move over)
 *   POST /api/push/unsubscribe  stop notifying this device (the switch, or signing out)
 */

const MAX_ENDPOINT = 1000;
/** Phones, tablets and PCs one person can have notifications on; the oldest goes when a new one is added. */
const MAX_DEVICES = 10;

function cleanString(value: unknown, max: number) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max ? value.trim() : "";
}

export async function pushRoutes(app: FastifyInstance) {
  app.get("/api/push/key", { preHandler: app.authenticate }, async () => {
    return { success: true, data: { publicKey: pushPublicKey() } };
  });

  app.post("/api/push/subscribe", { preHandler: app.authenticate }, async (request, reply) => {
    const ctx = request.membershipContext!;
    if (!pushPublicKey()) return reply.code(409).send({ success: false, error: "Notifications aren't set up on this server." });
    const body = (request.body ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    const endpoint = cleanString(body.endpoint, MAX_ENDPOINT);
    const p256dh = cleanString(body.keys?.p256dh, 200);
    const auth = cleanString(body.keys?.auth, 100);
    // Only real push services (never a URL someone made up for the server to call)
    if (!endpoint || !isPushServiceUrl(endpoint) || !p256dh || !auth) {
      return reply.code(400).send({ success: false, error: "That notification subscription isn't valid." });
    }
    const userAgent = cleanString(request.headers["user-agent"], 300) || null;
    await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: { companyId: ctx.companyId, userId: ctx.userId, endpoint, p256dh, auth, userAgent },
      update: { companyId: ctx.companyId, userId: ctx.userId, p256dh, auth, userAgent }
    });
    const devices = await prisma.pushSubscription.findMany({ where: { userId: ctx.userId }, orderBy: { updatedAt: "desc" }, select: { id: true } });
    if (devices.length > MAX_DEVICES) {
      await prisma.pushSubscription.deleteMany({ where: { id: { in: devices.slice(MAX_DEVICES).map((device) => device.id) } } });
    }
    return { success: true };
  });

  app.post("/api/push/unsubscribe", { preHandler: app.authenticate }, async (request) => {
    const ctx = request.membershipContext!;
    const body = (request.body ?? {}) as { endpoint?: unknown };
    const endpoint = cleanString(body.endpoint, MAX_ENDPOINT);
    // Only this person's device: one person can't switch off someone else's phone
    if (endpoint) await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: ctx.userId } });
    return { success: true };
  });
}
