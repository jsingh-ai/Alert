import fs from "node:fs";
import path from "node:path";

const EMPTY_STATE = { version: 1, initializedDepartments: [], alerts: {} };

export class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = structuredClone(EMPTY_STATE);
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (parsed?.version === 1 && Array.isArray(parsed.initializedDepartments) && parsed.alerts) {
        this.state = parsed;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return this.state;
  }

  key(departmentKey, alertId) {
    return `${departmentKey}:${alertId}`;
  }

  get(departmentKey, alertId) {
    return this.state.alerts[this.key(departmentKey, alertId)] ?? null;
  }

  set(departmentKey, alertId, value) {
    this.state.alerts[this.key(departmentKey, alertId)] = {
      ...this.get(departmentKey, alertId),
      ...value,
      updatedAt: new Date().toISOString()
    };
  }

  isDepartmentInitialized(departmentKey) {
    return this.state.initializedDepartments.includes(departmentKey);
  }

  initializeDepartment(departmentKey) {
    if (!this.isDepartmentInitialized(departmentKey)) this.state.initializedDepartments.push(departmentKey);
  }

  prune(maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    for (const [key, value] of Object.entries(this.state.alerts)) {
      if (Date.parse(value.updatedAt ?? "") < cutoff) delete this.state.alerts[key];
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}
