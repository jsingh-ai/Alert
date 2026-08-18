import test from "node:test";
import assert from "node:assert/strict";
import { AlertMonitor } from "../src/monitor.mjs";

class MemoryStore {
  constructor() { this.state = { initialized: false, alerts: {} }; }
  key(department, id) { return `${department}:${id}`; }
  get(department, id) { return this.state.alerts[this.key(department, id)] ?? null; }
  set(department, id, value) { this.state.alerts[this.key(department, id)] = { ...this.get(department, id), ...value }; }
  isDepartmentInitialized() { return this.state.initialized; }
  initializeDepartment() { this.state.initialized = true; }
  prune() {}
  save() {}
}

const config = {
  teamsWebhookUrl: "https://example.test/webhook",
  requestTimeoutMs: 1000,
  bridgePublicUrl: "http://10.8.10.97:5010",
  acknowledgementSecret: "a-secure-test-secret-that-is-long-enough",
  acknowledgementTtlMs: 60_000,
  notifyExistingAlertsOnStart: false
};
const department = { key: "quality", label: "Quality", token: "secret-token", webhookUrl: "https://example.test/quality" };
const openAlert = { id: "a1", status: "OPEN", machine: { name: "Press 1" }, department: { name: "Quality" } };

test("first poll creates a quiet baseline and later acknowledgment sends one update", async () => {
  const store = new MemoryStore();
  const posted = [];
  let alerts = [openAlert];
  const monitor = new AlertMonitor(config, store, {
    getActiveAlerts: async () => alerts,
    postTeamsMessage: async (_url, message) => posted.push(message)
  });

  await monitor.pollDepartment(department);
  assert.equal(posted.length, 0);

  alerts = [{ ...openAlert, status: "ACKNOWLEDGED", responder_name_text: "Pager Supervisor" }];
  await monitor.pollDepartment(department);
  await monitor.pollDepartment(department);
  assert.equal(posted.length, 1);
  assert.match(posted[0].summary, /Acknowledged/);
});

test("a new alert after startup posts one actionable card", async () => {
  const store = new MemoryStore();
  store.initializeDepartment();
  const posted = [];
  const monitor = new AlertMonitor(config, store, {
    getActiveAlerts: async () => [openAlert],
    postTeamsMessage: async (_url, message) => posted.push(message)
  });
  await monitor.pollDepartment(department);
  await monitor.pollDepartment(department);
  assert.equal(posted.length, 1);
  assert.match(posted[0].attachments[0].content.actions[0].url, /\/ack\?token=/);
});
