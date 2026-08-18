async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function processGuardRequest(config, department, path, options = {}) {
  const response = await fetchWithTimeout(`${config.processGuardBaseUrl}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${department.token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  }, config.requestTimeoutMs);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const error = new Error(payload.error || `ProcessGuard returned HTTP ${response.status}.`);
    error.statusCode = response.status;
    throw error;
  }
  return payload.data;
}

export function getActiveAlerts(config, department) {
  return processGuardRequest(config, department, "/api/andon/pager/alerts/active");
}

export function acknowledgeAlert(config, department, alertId, responderName) {
  return processGuardRequest(
    config,
    department,
    `/api/andon/pager/alerts/${encodeURIComponent(alertId)}/acknowledge`,
    {
      method: "POST",
      body: JSON.stringify({
        responder_name_text: responderName,
        note: "Acknowledged through the Microsoft Teams link"
      })
    }
  );
}
