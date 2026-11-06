/*
 * Call notifications on phones and browsers (Web Push), with no extra packages: Node's own crypto
 * does the two things the standard needs.
 *   VAPID (RFC 8292)   a short signed token that proves these notifications come from this server
 *   aes128gcm (RFC 8291) the notification text is encrypted for the one device that will show it
 *
 * Keys come from .env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, made once with `npm run push:keys`).
 * Without them push is off: the app hides the switch and nothing here sends.
 *
 * What is sent:
 *   a new call        everyone who responds for that department and turned notifications on
 *   a call accepted   the same people, minus whoever accepted (so two people don't both go)
 *   a message         on an accepted call: the person who accepted it and anyone helping, minus the writer
 * Sending never holds up the request that caused it; failures are logged, and a device the push
 * service says is gone (404/410) is removed.
 */
import type crypto from "node:crypto";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { canActAsResponder } from "./permissions.js";
import { encryptPush, isPushServiceUrl, vapidJwt, vapidPrivateKey } from "./webPushCrypto.js";

export type PushMessage = {
  title: string;
  body: string;
  /** Same tag = the new notification replaces the old one on the device (one per call). */
  tag: string;
  /** Page to open when the notification is tapped. */
  url: string;
  /** Replace quietly, without sound or vibration. */
  silent?: boolean;
};

type Subscription = { id: string; endpoint: string; p256dh: string; auth: string };

/* ---------- Keys ---------- */

type Vapid = { publicKey: string; privateKey: crypto.KeyObject; subject: string };

let vapid: Vapid | null | undefined;

/** The server's key pair, or null when push isn't set up (or the keys in .env are unusable). */
function loadVapid(): Vapid | null {
  if (vapid !== undefined) return vapid;
  vapid = null;
  if (!config.push.publicKey || !config.push.privateKey) return vapid;
  try {
    vapid = { publicKey: config.push.publicKey, privateKey: vapidPrivateKey(config.push.publicKey, config.push.privateKey), subject: config.push.subject };
  } catch (error) {
    console.error("ProcessGuard: push notifications are off, the VAPID keys in .env can't be used.", error);
  }
  return vapid;
}

/** The public key devices subscribe with, or null when push is off. */
export function pushPublicKey() {
  return loadVapid()?.publicKey ?? null;
}

/** Signed token for one push service, reused for an hour per service (it is valid for 12). */
const tokens = new Map<string, { value: string; until: number }>();

function vapidToken(keys: Vapid, endpoint: string) {
  const audience = new URL(endpoint).origin;
  const cached = tokens.get(audience);
  if (cached && cached.until > Date.now()) return cached.value;
  const value = vapidJwt(keys.privateKey, audience, keys.subject, Math.floor(Date.now() / 1000) + 12 * 3600);
  tokens.set(audience, { value, until: Date.now() + 3600_000 });
  return value;
}

/* ---------- Sending ---------- */

/** Keep each notification well inside one record and every push service's size limit. */
function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function sendOne(keys: Vapid, subscription: Subscription, message: PushMessage) {
  // Checked again here, not only when saved: the server never calls anything but a push service
  if (!isPushServiceUrl(subscription.endpoint)) {
    await prisma.pushSubscription.deleteMany({ where: { id: subscription.id } });
    return;
  }
  const payload = Buffer.from(JSON.stringify({ ...message, title: clip(message.title, 120), body: clip(message.body, 400) }));
  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${vapidToken(keys, subscription.endpoint)}, k=${keys.publicKey}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      // A call is only useful for a short while; a phone that's off for an hour doesn't need it later
      TTL: "1800",
      Urgency: message.silent ? "normal" : "high"
    },
    body: encryptPush(subscription, payload),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000)
  });
  // 404/410: the device unsubscribed or the browser was reset. 403: it was made with keys this server
  // no longer has (the keys changed). Either way it will never receive anything again: forget it.
  if (response.status === 404 || response.status === 410 || response.status === 403) {
    await prisma.pushSubscription.deleteMany({ where: { id: subscription.id } });
    return;
  }
  if (!response.ok) throw new Error(`Push service answered ${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}`.trim());
}

/** Send to every device of these users in this company. Never throws. */
async function sendToUsers(companyId: string, userIds: string[], message: PushMessage) {
  const keys = loadVapid();
  if (!keys || userIds.length === 0) return;
  const subscriptions = await prisma.pushSubscription.findMany({
    where: { companyId, userId: { in: Array.from(new Set(userIds)) } },
    select: { id: true, endpoint: true, p256dh: true, auth: true }
  });
  const results = await Promise.allSettled(subscriptions.map((subscription) => sendOne(keys, subscription, message)));
  results.forEach((result, index) => {
    if (result.status === "rejected") console.warn(`ProcessGuard: push to ${new URL(subscriptions[index].endpoint).host} failed:`, result.reason?.message ?? result.reason);
  });
}

/** Run a send after the response, so a slow push service never delays the screen that caused it. */
function later(work: () => Promise<void>) {
  if (!loadVapid()) return;
  setImmediate(() => {
    work().catch((error) => console.warn("ProcessGuard: push notification failed:", error?.message ?? error));
  });
}

/** Users (with a device turned on) who respond for this department. */
async function responders(companyId: string, departmentId: string) {
  const memberships = await prisma.membership.findMany({
    where: { companyId, active: true, user: { active: true, pushSubscriptions: { some: { companyId } } }, company: { active: true } },
    select: { userId: true, role: true, scopes: true }
  });
  return memberships.filter((membership) => canActAsResponder(membership, departmentId)).map((membership) => membership.userId);
}

/* ---------- The three moments ---------- */

type AlertLike = {
  id: string;
  companyId: string;
  departmentId: string;
  department: { name: string };
  machine: { name: string };
  issueType?: { name: string } | null;
  displayMessage?: string | null;
  operatorNote?: string | null;
};

const callTag = (alertId: string) => `call:${alertId}`;
const QUEUE_URL = "/queue";

/** A machine called a department. */
export function notifyNewCall(alert: AlertLike) {
  later(async () => {
    const note = alert.displayMessage || alert.operatorNote;
    await sendToUsers(alert.companyId, await responders(alert.companyId, alert.departmentId), {
      title: `${alert.machine.name} needs ${alert.department.name}`,
      body: [alert.issueType?.name, note ? `“${note}”` : ""].filter(Boolean).join(" · ") || "Tap to respond",
      tag: callTag(alert.id),
      url: QUEUE_URL
    });
  });
}

/** Someone took the call: tell the rest of the team quietly, replacing the call notification. */
export function notifyAccepted(alert: AlertLike, responderName: string, acceptedByUserId: string | null) {
  later(async () => {
    const userIds = (await responders(alert.companyId, alert.departmentId)).filter((id) => id !== acceptedByUserId);
    await sendToUsers(alert.companyId, userIds, {
      title: `${alert.machine.name}: ${responderName} accepted`,
      body: `${alert.department.name}${alert.issueType?.name ? ` · ${alert.issueType.name}` : ""}`,
      tag: callTag(alert.id),
      url: QUEUE_URL,
      silent: true
    });
  });
}

/** A message on an accepted call goes to whoever accepted it and anyone helping, never back to the writer. */
export function notifyMessage(alert: AlertLike & { status: string; acknowledgedByUserId?: string | null }, fromUserId: string, fromName: string, text: string) {
  // Waiting calls: the call notification already went to the whole team. Closed calls: nobody needs it.
  if (alert.status !== "ACKNOWLEDGED" && alert.status !== "ARRIVED") return;
  later(async () => {
    const helpers = await prisma.communicationMessage.findMany({
      where: { companyId: alert.companyId, alertId: alert.id, clientMessageId: { startsWith: "help:" }, deletedAt: null, userId: { not: null } },
      select: { userId: true }
    });
    // Only people still active and still responding for this department (not someone since moved or switched off)
    const allowed = new Set(await responders(alert.companyId, alert.departmentId));
    const userIds = [alert.acknowledgedByUserId, ...helpers.map((helper) => helper.userId)].filter((id): id is string => Boolean(id) && id !== fromUserId && allowed.has(id));
    await sendToUsers(alert.companyId, userIds, {
      title: `${alert.machine.name} · ${fromName}`,
      body: text,
      tag: `${callTag(alert.id)}:message`,
      url: QUEUE_URL
    });
  });
}
