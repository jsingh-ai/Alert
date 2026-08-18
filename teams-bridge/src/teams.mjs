function text(value, fallback = "—") {
  const result = typeof value === "string" ? value.trim() : "";
  return result || fallback;
}

export function normalizeAlert(alert, department) {
  return {
    id: String(alert.id),
    department: text(alert.department?.name, department.label),
    machine: text(alert.machine?.name, "Unknown machine"),
    machineCode: text(alert.machine?.code ?? alert.machine?.machine_code, ""),
    request: text(alert.command_label ?? alert.issue_problem?.name, "Assistance requested"),
    message: text(alert.display_message, ""),
    priority: text(alert.priority, "NORMAL"),
    status: text(alert.status, "OPEN"),
    responder: text(alert.responder_name_text ?? alert.responder_name, "")
  };
}

export function buildTeamsMessage({ alert, event, acknowledgementUrl }) {
  const machine = alert.machineCode ? `${alert.machine} (${alert.machineCode})` : alert.machine;
  const acknowledged = event === "acknowledged";
  const title = acknowledged
    ? `Acknowledged: ${alert.department} request at ${machine}`
    : `New request: ${alert.department} needed at ${machine}`;
  const facts = [
    { title: "Department", value: alert.department },
    { title: "Machine", value: machine },
    { title: "Request", value: alert.request },
    { title: "Priority", value: alert.priority },
    { title: "Status", value: acknowledged ? "ACKNOWLEDGED" : alert.status }
  ];
  if (acknowledged && alert.responder) facts.push({ title: "Responder", value: alert.responder });

  return {
    type: "message",
    summary: title,
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      contentUrl: null,
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.2",
        body: [
          {
            type: "TextBlock",
            text: title,
            size: "Large",
            weight: "Bolder",
            color: acknowledged ? "Good" : (alert.priority === "HIGH" || alert.priority === "CRITICAL" ? "Attention" : "Warning"),
            wrap: true
          },
          { type: "FactSet", facts },
          ...(alert.message ? [{ type: "TextBlock", text: alert.message, wrap: true }] : [])
        ],
        ...(!acknowledged && acknowledgementUrl ? {
          actions: [{
            type: "Action.OpenUrl",
            title: `Acknowledge ${alert.department} request`,
            url: acknowledgementUrl
          }]
        } : {})
      }
    }]
  };
}

export async function postTeamsMessage(webhookUrl, message, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Teams Workflow returned HTTP ${response.status}.`);
  } finally {
    clearTimeout(timeout);
  }
}
