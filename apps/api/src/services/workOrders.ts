/*
 * Work orders in the maintenance app.
 *
 * Maintenance calls for a mechanical or electrical tech open a work order there:
 *   - accepted: POST 1 (workType, Created_at, machineId, Start_time). The reply holds the folio, kept on the alert.
 *   - resolved: look up the technician who accepted (GET), then POST 2 with the folio, worker, finish time and comment.
 *
 * Everything is set in .env (see WORKORDER_* in .env.example). With WORKORDER_DRY_RUN=1 nothing is sent:
 * each request is written to the log instead, so it can be checked before going live.
 *
 * It never holds up or fails the call: errors are retried a few times, then logged and dropped.
 */
import { prisma } from "../db.js";

type Json = Record<string, any>;

const env = (name: string) => (process.env[name] ?? "").trim();
const enabled = () => Boolean(env("WORKORDER_CREATE_URL"));
const dryRun = () => /^(1|true|yes)$/i.test(env("WORKORDER_DRY_RUN"));

/** "2026-11-10 09:00:00" in the server's local time. */
function stamp(date: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

function headers() {
  const out: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  const key = env("WORKORDER_API_KEY");
  if (key) out[env("WORKORDER_AUTH_HEADER") || "Authorization"] = key;
  return out;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Send with up to three tries (now, 2s, 10s). Returns the parsed reply. */
async function call(label: string, method: "GET" | "POST", url: string, body?: Json): Promise<Json> {
  if (dryRun()) {
    console.log(`ProcessGuard work order (dry run) ${label}: ${method} ${url}${body ? `\n${JSON.stringify(body, null, 2)}` : ""}`);
    return { __dryRun: true };
  }
  let last: unknown;
  for (const delay of [0, 2000, 10000]) {
    if (delay) await wait(delay);
    try {
      const response = await fetch(url, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
      const text = await response.text();
      if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 200)}`);
      try { return text ? JSON.parse(text) : {}; } catch { return {}; }
    } catch (error: any) {
      last = error;
    }
  }
  throw new Error(`${label} failed: ${(last as any)?.message ?? last}`);
}

/* ---------- Which calls count ---------- */

async function loadAlert(alertId: string) {
  return prisma.andonAlert.findUnique({ where: { id: alertId }, include: { machine: true, department: true } });
}

/** "mechanical" or "electrical" from the operator's "which tech is needed" note; null when it isn't one. */
async function workTypeOf(alert: { id: string; companyId: string; department: { name: string } }) {
  if (!/maint/i.test(alert.department.name)) return null;
  const note = await prisma.communicationMessage.findFirst({
    where: { companyId: alert.companyId, alertId: alert.id, clientMessageId: `need:${alert.id}`, deletedAt: null },
    select: { body: true }
  });
  const text = note?.body ?? "";
  if (/electric/i.test(text)) return "electrical";
  if (/mechanic/i.test(text)) return "mechanical";
  return null;
}

/** Their machine number: WORKORDER_MACHINE_IDS {"Press 4":123} (by name or code), else the machine's own external id. */
function machineNumber(machine: { name: string; code: string; radiusMachineId: string | null }) {
  let map: Json = {};
  try { map = JSON.parse(env("WORKORDER_MACHINE_IDS") || "{}"); } catch { /* ignore */ }
  const value = map[machine.name] ?? map[machine.code] ?? machine.radiusMachineId;
  const number = Number(value);
  return value !== undefined && value !== null && value !== "" && Number.isFinite(number) ? number : null;
}

/* ---------- Pending work orders (so a quick resolve waits for the folio) ---------- */

const opening = new Map<string, Promise<string | null>>();

/** The call was accepted: open the work order. Returns at once; never throws. */
export function workOrderAccepted(alertId: string) {
  if (!enabled()) return;
  setImmediate(() => {
    const job = open(alertId).catch((error) => {
      console.warn("ProcessGuard work order:", error?.message ?? error);
      return null;
    });
    opening.set(alertId, job);
    void job.finally(() => opening.delete(alertId));
  });
}

async function open(alertId: string): Promise<string | null> {
  const alert = await loadAlert(alertId);
  if (!alert || alert.externalRef || !alert.acknowledgedAt) return alert?.externalRef ?? null;
  const workType = await workTypeOf(alert);
  if (!workType) return null;
  const machineId = machineNumber(alert.machine);
  if (machineId === null) {
    console.warn(`ProcessGuard work order: no machine number for ${alert.machine.name} (${alert.machine.code}); add it to WORKORDER_MACHINE_IDS. Skipped.`);
    return null;
  }
  const reply = await call("open", "POST", env("WORKORDER_CREATE_URL"), {
    data: { workType, Created_at: stamp(alert.createdAt), machineId, Start_time: stamp(alert.acknowledgedAt) }
  });
  const folio: string | null = reply.workOrder?.folio ?? (reply.__dryRun ? "DRY-RUN" : null);
  if (!folio) throw new Error(`open: the reply had no workOrder.folio (${JSON.stringify(reply).slice(0, 200)})`);
  if (!reply.__dryRun) await prisma.andonAlert.update({ where: { id: alertId }, data: { externalRef: folio } });
  return folio;
}

/* ---------- Technicians ---------- */

const norm = (value: unknown) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** Find the technician by name: { userId, categoryCode }. WORKORDER_TECH_URL may hold {name}, else the whole list is read. */
async function findTech(name: string, workType: string): Promise<{ userId: number | string; categoryCode: string } | null> {
  let url = env("WORKORDER_TECH_URL");
  if (!url) return null;
  url = url.replace("{name}", encodeURIComponent(name));
  const reply = await call("technician lookup", "GET", url);
  if (reply.__dryRun) return { userId: 0, categoryCode: workTypeCode(workType) };
  const list: Json[] = Array.isArray(reply) ? reply : [reply.data, reply.users, reply.technicians, reply.items, reply.results].find(Array.isArray) ?? (reply.data ? [reply.data] : [reply]);
  const nameOf = (item: Json) => item.name ?? item.fullName ?? item.displayName ?? item.userName ?? item.username ?? [item.firstName, item.lastName].filter(Boolean).join(" ");
  // A person can be listed once per category (mechanic and electrician): take the row for this call's work type
  const rows = list.filter((item) => norm(nameOf(item)) === norm(name));
  const codeOf = (item: Json) => String(item.categoryCode ?? item.category?.code ?? item.category ?? "").toUpperCase();
  const hit = rows.find((item) => codeOf(item) === workTypeCode(workType)) ?? rows[0] ?? (list.length === 1 ? list[0] : undefined);
  const userId = hit?.userId ?? hit?.id;
  const categoryCode = hit?.categoryCode ?? hit?.category?.code ?? hit?.category;
  return hit && userId !== undefined && categoryCode ? { userId, categoryCode: String(categoryCode) } : null;
}

const workTypeCode = (workType: string) => (workType === "electrical" ? "ELECTRICAL" : "MECHANIC");

/* ---------- Resolved ---------- */

/** The call was resolved: close the work order. Returns at once; never throws. */
export function workOrderResolved(alertId: string, comment: string | null) {
  if (!enabled()) return;
  setImmediate(() => {
    close(alertId, comment).catch((error) => console.warn("ProcessGuard work order:", error?.message ?? error));
  });
}

async function close(alertId: string, comment: string | null) {
  // Accepted a moment ago: the folio may still be on its way back
  const alert = await loadAlert(alertId);
  if (!alert) return;
  let folio = (await opening.get(alertId)) ?? alert.externalRef;
  if (!folio && dryRun() && (await workTypeOf(alert))) folio = "DRY-RUN"; // nothing is saved in a dry run
  if (!folio) return; // not a work-order call, or opening it failed (already logged)
  const finishedAt = stamp(alert.resolvedAt ?? new Date());
  const name = alert.responderNameText || "";
  const workType = (await workTypeOf(alert)) ?? "mechanical";
  const tech = name ? await findTech(name, workType) : null;
  if (!tech) {
    console.warn(`ProcessGuard work order: technician "${name}" was not found in the technician list, so ${folio} was not updated.`);
    return;
  }
  await call("close", "POST", env("WORKORDER_UPDATE_URL") || env("WORKORDER_CREATE_URL"), {
    data: {
      folio,
      workers: [{ userId: tech.userId, categoryCode: tech.categoryCode, workFinishedAt: finishedAt, workPerformed: comment?.trim() || "" }],
      finishedAt
    }
  });
}
