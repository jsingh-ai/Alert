import fs from "node:fs";
import path from "node:path";

export function loadEnvFile(filePath = path.resolve(process.cwd(), ".env")) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function positiveInteger(value, fallback, name) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function booleanValue(value, fallback) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function requiredUrl(value, name, protocols) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
  if (!protocols.includes(url.protocol)) throw new Error(`${name} must use ${protocols.join(" or ")}.`);
  return url.toString().replace(/\/$/, "");
}

export function buildConfig(env = process.env) {
  const acknowledgementSecret = String(env.ACK_LINK_SECRET ?? "").trim();
  if (acknowledgementSecret.length < 32) throw new Error("ACK_LINK_SECRET must contain at least 32 characters.");

  const defaultWebhookUrl = String(env.TEAMS_WORKFLOW_WEBHOOK_URL ?? "").trim();
  const departmentInputs = [
    {
      key: "quality",
      label: "Quality",
      token: String(env.QUALITY_PAGER_TOKEN ?? "").trim(),
      webhookUrl: String(env.QUALITY_TEAMS_WEBHOOK_URL ?? "").trim() || defaultWebhookUrl
    },
    {
      key: "supervisor",
      label: "Supervisor",
      token: String(env.SUPERVISOR_PAGER_TOKEN ?? "").trim(),
      webhookUrl: String(env.SUPERVISOR_TEAMS_WEBHOOK_URL ?? "").trim() || defaultWebhookUrl
    },
    {
      key: "maintenance",
      label: "Maintenance",
      token: String(env.MAINTENANCE_PAGER_TOKEN ?? "").trim(),
      webhookUrl: String(env.MAINTENANCE_TEAMS_WEBHOOK_URL ?? "").trim() || defaultWebhookUrl
    }
  ];
  for (const department of departmentInputs) {
    if (department.token && !department.webhookUrl) {
      throw new Error(`${department.key.toUpperCase()}_TEAMS_WEBHOOK_URL or TEAMS_WORKFLOW_WEBHOOK_URL is required when its pager token is configured.`);
    }
  }
  const departments = departmentInputs
    .filter((department) => department.token)
    .map((department) => ({
      ...department,
      webhookUrl: requiredUrl(department.webhookUrl, `${department.key.toUpperCase()}_TEAMS_WEBHOOK_URL`, ["https:"])
    }));
  if (!departments.length) {
    throw new Error("Configure a Quality, Supervisor, or Maintenance pager token.");
  }

  return {
    processGuardBaseUrl: requiredUrl(env.PROCESSGUARD_BASE_URL ?? "http://127.0.0.1:5003", "PROCESSGUARD_BASE_URL", ["http:", "https:"]),
    bridgePublicUrl: requiredUrl(env.BRIDGE_PUBLIC_URL ?? "http://10.8.10.97:5010", "BRIDGE_PUBLIC_URL", ["http:", "https:"]),
    teamsWebhookUrl: defaultWebhookUrl
      ? requiredUrl(defaultWebhookUrl, "TEAMS_WORKFLOW_WEBHOOK_URL", ["https:"])
      : "",
    acknowledgementSecret,
    acknowledgementTtlMs: positiveInteger(env.ACK_LINK_TTL_MINUTES, 1440, "ACK_LINK_TTL_MINUTES") * 60_000,
    bindHost: String(env.BRIDGE_BIND_HOST ?? "0.0.0.0"),
    port: positiveInteger(env.BRIDGE_PORT, 5010, "BRIDGE_PORT"),
    pollIntervalMs: positiveInteger(env.POLL_INTERVAL_MS, 5000, "POLL_INTERVAL_MS"),
    requestTimeoutMs: positiveInteger(env.HTTP_TIMEOUT_MS, 7000, "HTTP_TIMEOUT_MS"),
    notifyExistingAlertsOnStart: booleanValue(env.NOTIFY_EXISTING_ALERTS_ON_START, false),
    responderPrefix: String(env.ACK_RESPONDER_PREFIX ?? "Teams").trim() || "Teams",
    stateFile: path.resolve(process.cwd(), env.STATE_FILE ?? "./data/state.json"),
    departments
  };
}
