import { config } from "../config.js";

type DepartmentWebhookKey = keyof typeof config.powerAutomateWebhookUrls;

function departmentWebhookKey(payload: unknown): DepartmentWebhookKey | null {
  if (!payload || typeof payload !== "object") return null;
  const departmentName = "departmentName" in payload
    ? String(payload.departmentName ?? "").trim().toLowerCase()
    : "";
  if (departmentName === "quality") return "quality";
  if (departmentName === "supervisor") return "supervisor";
  if (departmentName === "maintenance") return "maintenance";
  return null;
}

export async function triggerPowerAutomate(payload: unknown) {
  const webhookKey = departmentWebhookKey(payload);
  const webhookUrl =
    (webhookKey ? config.powerAutomateWebhookUrls[webhookKey] : "") ||
    config.powerAutomateWebhookUrl;

  if (!webhookUrl) {
    throw new Error(
      `${webhookKey ? `POWER_AUTOMATE_${webhookKey.toUpperCase()}_WEBHOOK_URL` : "POWER_AUTOMATE_WEBHOOK_URL"} is not configured.`
    );
  }

  console.log(`[PowerAutomate] Sending ${webhookKey ?? "default"} webhook...`);

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(payload)
  });

  const responseText = await response.text();

  console.log(
    `[PowerAutomate] Response: ${response.status} ${response.statusText}`
  );

  if (responseText) {
    console.log(
      `[PowerAutomate] Response body: ${responseText}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Power Automate webhook failed: ${response.status} ${response.statusText} ${responseText}`
    );
  }

  return {
    status: response.status,
    statusText: response.statusText,
    body: responseText
  };
}

export async function triggerAlertAcknowledged(input: {
  alertId: string;
  commandId: string | null;
  departmentName: string;
  machineName: string;
  machineCode: string | null;
  issueName: string;
  priority: string;
  responderName: string;
  acknowledgedAt: Date;
  acknowledgeSeconds: number;
  source: "WEB" | "PAGER";
}) {
  const machineLabel = input.machineCode
    ? `${input.machineName} (${input.machineCode})`
    : input.machineName;

  return triggerPowerAutomate({
    event: "ALERT_ACKNOWLEDGED",
    alertId: input.alertId,
    commandId: input.commandId,
    departmentName: input.departmentName,
    machineName: input.machineName,
    machineCode: input.machineCode,
    acknowledgedAt: input.acknowledgedAt.toISOString(),
    acknowledgeSeconds: input.acknowledgeSeconds,
    source: input.source,
    message: `${input.departmentName} alert acknowledged on ${machineLabel}.`
  });
}
