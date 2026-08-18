import test from "node:test";
import assert from "node:assert/strict";
import { buildConfig } from "../src/config.mjs";

const baseEnv = {
  PROCESSGUARD_BASE_URL: "http://127.0.0.1:5003",
  BRIDGE_PUBLIC_URL: "http://10.8.10.97:5010",
  ACK_LINK_SECRET: "a-secure-test-secret-that-is-long-enough"
};

test("keeps the existing webhook as the fallback", () => {
  const config = buildConfig({
    ...baseEnv,
    TEAMS_WORKFLOW_WEBHOOK_URL: "https://example.test/existing",
    QUALITY_TEAMS_WEBHOOK_URL: "",
    SUPERVISOR_TEAMS_WEBHOOK_URL: "",
    MAINTENANCE_TEAMS_WEBHOOK_URL: "",
    SUPERVISOR_PAGER_TOKEN: "supervisor-token"
  });
  assert.equal(config.departments[0].webhookUrl, "https://example.test/existing");
});

test("supports separate Quality, Supervisor, and Maintenance channel URLs", () => {
  const config = buildConfig({
    ...baseEnv,
    QUALITY_PAGER_TOKEN: "quality-token",
    QUALITY_TEAMS_WEBHOOK_URL: "https://example.test/quality",
    SUPERVISOR_PAGER_TOKEN: "supervisor-token",
    SUPERVISOR_TEAMS_WEBHOOK_URL: "https://example.test/supervisor",
    MAINTENANCE_PAGER_TOKEN: "maintenance-token",
    MAINTENANCE_TEAMS_WEBHOOK_URL: "https://example.test/maintenance"
  });

  assert.deepEqual(
    config.departments.map(({ key, webhookUrl }) => ({ key, webhookUrl })),
    [
      { key: "quality", webhookUrl: "https://example.test/quality" },
      { key: "supervisor", webhookUrl: "https://example.test/supervisor" },
      { key: "maintenance", webhookUrl: "https://example.test/maintenance" }
    ]
  );
});
