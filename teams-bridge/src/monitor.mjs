import { createAcknowledgementToken } from "./security.mjs";
import { getActiveAlerts } from "./processguard.mjs";
import { buildTeamsMessage, normalizeAlert, postTeamsMessage } from "./teams.mjs";

const ACKNOWLEDGED_STATUSES = new Set(["ACKNOWLEDGED", "ARRIVED"]);

export class AlertMonitor {
  constructor(config, store, dependencies = {}) {
    this.config = config;
    this.store = store;
    this.getActiveAlerts = dependencies.getActiveAlerts ?? getActiveAlerts;
    this.postTeamsMessage = dependencies.postTeamsMessage ?? postTeamsMessage;
  }

  acknowledgementUrl(department, alertId) {
    const token = createAcknowledgementToken(
      { alertId, departmentKey: department.key },
      this.config.acknowledgementSecret,
      this.config.acknowledgementTtlMs
    );
    return `${this.config.bridgePublicUrl}/ack?token=${encodeURIComponent(token)}`;
  }

  async sendCreated(department, alert) {
    const normalized = normalizeAlert(alert, department);
    const message = buildTeamsMessage({
      alert: normalized,
      event: "created",
      acknowledgementUrl: this.acknowledgementUrl(department, normalized.id)
    });
    await this.postTeamsMessage(department.webhookUrl, message, this.config.requestTimeoutMs);
  }

  async sendAcknowledged(department, alert) {
    const normalized = normalizeAlert(alert, department);
    const message = buildTeamsMessage({ alert: normalized, event: "acknowledged" });
    await this.postTeamsMessage(department.webhookUrl, message, this.config.requestTimeoutMs);
  }

  async recordTeamsAcknowledgement(department, alert) {
    await this.sendAcknowledged(department, alert);
    this.store.set(department.key, alert.id, {
      status: alert.status,
      createdNotified: true,
      acknowledgementNotified: true
    });
    this.store.save();
  }

  async pollDepartment(department) {
    const alerts = await this.getActiveAlerts(this.config, department);
    if (!Array.isArray(alerts)) throw new Error(`ProcessGuard returned an invalid alert list for ${department.label}.`);

    const firstPoll = !this.store.isDepartmentInitialized(department.key);
    for (const alert of alerts) {
      const alertId = String(alert.id ?? "");
      if (!alertId) continue;
      const status = String(alert.status ?? "OPEN").toUpperCase();
      const prior = this.store.get(department.key, alertId);

      if (firstPoll && !this.config.notifyExistingAlertsOnStart) {
        this.store.set(department.key, alertId, {
          status,
          createdNotified: true,
          acknowledgementNotified: ACKNOWLEDGED_STATUSES.has(status)
        });
        continue;
      }

      if (status === "OPEN" && !prior?.createdNotified) {
        await this.sendCreated(department, alert);
        this.store.set(department.key, alertId, { status, createdNotified: true, acknowledgementNotified: false });
        continue;
      }

      if (ACKNOWLEDGED_STATUSES.has(status) && !prior?.acknowledgementNotified) {
        await this.sendAcknowledged(department, alert);
        this.store.set(department.key, alertId, {
          status,
          createdNotified: prior?.createdNotified ?? true,
          acknowledgementNotified: true
        });
        continue;
      }

      this.store.set(department.key, alertId, { status });
    }

    this.store.initializeDepartment(department.key);
    this.store.prune();
    this.store.save();
    return alerts.length;
  }

  async pollAll(log = console) {
    const results = await Promise.allSettled(this.config.departments.map(async (department) => ({
      department,
      count: await this.pollDepartment(department)
    })));
    for (const result of results) {
      if (result.status === "fulfilled") {
        log.info(`[bridge] ${result.value.department.label}: ${result.value.count} active alert(s)`);
      } else {
        log.error(`[bridge] polling failed: ${result.reason?.message ?? result.reason}`);
      }
    }
  }
}
