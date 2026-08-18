import http from "node:http";
import { acknowledgeAlert, getActiveAlerts } from "./processguard.mjs";
import { verifyAcknowledgementToken } from "./security.mjs";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  })[character]);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer"
  });
  response.end(JSON.stringify(payload));
}

function page({ title, message, alert, actionable = false }) {
  const machine = alert ? `${escapeHtml(alert.machine?.name ?? "Unknown machine")}${alert.machine?.code ? ` (${escapeHtml(alert.machine.code)})` : ""}` : "";
  const facts = alert ? `
    <dl>
      <div><dt>Department</dt><dd>${escapeHtml(alert.department?.name)}</dd></div>
      <div><dt>Machine</dt><dd>${machine}</dd></div>
      <div><dt>Request</dt><dd>${escapeHtml(alert.command_label ?? alert.issue_problem?.name ?? "Assistance requested")}</dd></div>
      <div><dt>Status</dt><dd id="status-value">${escapeHtml(alert.status)}</dd></div>
    </dl>` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>${escapeHtml(title)} — ProcessGuard</title>
  <style>
    :root{font-family:Inter,Segoe UI,sans-serif;color:#0f172a;background:#eef2f7}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px}.card{width:min(560px,100%);background:white;border-radius:22px;padding:26px;box-shadow:0 24px 70px rgba(15,23,42,.15);border-top:7px solid #2563eb}.brand{font-weight:900;color:#2563eb;letter-spacing:.04em}.card h1{margin:.7rem 0 .4rem;font-size:clamp(1.7rem,5vw,2.4rem)}.message{color:#475569;line-height:1.55;margin:0 0 1.2rem}dl{display:grid;gap:1px;background:#dbe3ee;border:1px solid #dbe3ee;border-radius:14px;overflow:hidden;margin:1.2rem 0}dl div{display:grid;grid-template-columns:120px 1fr;background:#f8fafc;padding:.8rem;gap:1rem}dt{color:#64748b;font-weight:800}dd{margin:0;font-weight:800}.ack{width:100%;border:0;border-radius:14px;padding:1rem;background:#2563eb;color:white;font:inherit;font-weight:900;cursor:pointer}.ack:disabled{opacity:.55;cursor:wait}.result{min-height:1.4rem;margin-top:1rem;font-weight:800}.success{color:#15803d}.error{color:#b91c1c}@media(max-width:480px){dl div{grid-template-columns:1fr;gap:.25rem}}
  </style>
</head>
<body>
  <main class="card">
    <div class="brand">PROCESSGUARD</div>
    <h1>${escapeHtml(title)}</h1>
    <p class="message">${escapeHtml(message)}</p>
    ${facts}
    ${actionable ? '<button id="ack-button" class="ack" type="button">Acknowledge request</button><div id="result" class="result" role="status"></div>' : ""}
  </main>
  ${actionable ? `<script>
    const button=document.getElementById("ack-button");const result=document.getElementById("result");
    button.addEventListener("click",async()=>{button.disabled=true;button.textContent="Acknowledging…";result.textContent="";result.className="result";
      try{const token=new URLSearchParams(location.search).get("token");const response=await fetch("/api/acknowledge",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token})});const body=await response.json();if(!response.ok||!body.success)throw new Error(body.error||"Acknowledgment failed.");document.getElementById("status-value").textContent="ACKNOWLEDGED";button.remove();result.textContent=body.alreadyAcknowledged?"This request was already acknowledged.":"Acknowledged. ProcessGuard and the pager have been updated.";result.className="result success"}catch(error){result.textContent=error.message;result.className="result error";button.disabled=false;button.textContent="Try again"}});
  </script>` : ""}
</body>
</html>`;
}

async function readJson(request, limit = 8192) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > limit) throw new Error("Request body is too large.");
  }
  return JSON.parse(body || "{}");
}

function securePageHeaders(response, statusCode = 200) {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  });
}

export function createBridgeServer(config, monitor, dependencies = {}) {
  const fetchAlerts = dependencies.getActiveAlerts ?? getActiveAlerts;
  const acknowledge = dependencies.acknowledgeAlert ?? acknowledgeAlert;

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { success: true, service: "ProcessGuard Teams Bridge", now: new Date().toISOString() });
      }

      if (request.method === "GET" && url.pathname === "/ack") {
        const payload = verifyAcknowledgementToken(url.searchParams.get("token"), config.acknowledgementSecret);
        if (!payload) {
          securePageHeaders(response, 400);
          return response.end(page({ title: "Link unavailable", message: "This acknowledgment link is invalid or has expired." }));
        }
        const department = config.departments.find((item) => item.key === payload.departmentKey);
        if (!department) {
          securePageHeaders(response, 404);
          return response.end(page({ title: "Department unavailable", message: "This department is not configured on the bridge." }));
        }
        const alerts = await fetchAlerts(config, department);
        const alert = alerts.find((item) => String(item.id) === payload.alertId);
        if (!alert) {
          securePageHeaders(response, 404);
          return response.end(page({ title: "Request no longer active", message: "This request may already have been resolved or cancelled." }));
        }
        const status = String(alert.status).toUpperCase();
        securePageHeaders(response);
        return response.end(page({
          title: status === "OPEN" ? `Acknowledge ${department.label} request` : "Request already acknowledged",
          message: status === "OPEN" ? "Confirm that your department has received this request." : "No additional action is needed.",
          alert,
          actionable: status === "OPEN"
        }));
      }

      if (request.method === "POST" && url.pathname === "/api/acknowledge") {
        const body = await readJson(request);
        const payload = verifyAcknowledgementToken(body.token, config.acknowledgementSecret);
        if (!payload) return sendJson(response, 400, { success: false, error: "This acknowledgment link is invalid or has expired." });
        const department = config.departments.find((item) => item.key === payload.departmentKey);
        if (!department) return sendJson(response, 404, { success: false, error: "Department is not configured." });

        let alerts = await fetchAlerts(config, department);
        let alert = alerts.find((item) => String(item.id) === payload.alertId);
        if (!alert) return sendJson(response, 404, { success: false, error: "This request is no longer active." });
        const status = String(alert.status).toUpperCase();
        if (status === "ACKNOWLEDGED" || status === "ARRIVED") {
          return sendJson(response, 200, { success: true, alreadyAcknowledged: true });
        }
        if (status !== "OPEN") return sendJson(response, 409, { success: false, error: `This request cannot be acknowledged from status ${status}.` });

        const responderName = `${config.responderPrefix} — ${department.label}`;
        try {
          alert = await acknowledge(config, department, payload.alertId, responderName);
        } catch (error) {
          if (error?.statusCode !== 409) throw error;
          alerts = await fetchAlerts(config, department);
          alert = alerts.find((item) => String(item.id) === payload.alertId);
          if (!alert || !["ACKNOWLEDGED", "ARRIVED"].includes(String(alert.status).toUpperCase())) throw error;
        }
        await monitor.recordTeamsAcknowledgement(department, alert);
        return sendJson(response, 200, { success: true, alreadyAcknowledged: false });
      }

      sendJson(response, 404, { success: false, error: "Not found." });
    } catch (error) {
      console.error(`[bridge] request failed: ${error?.message ?? error}`);
      sendJson(response, 500, { success: false, error: "The bridge could not complete the request." });
    }
  });
}
