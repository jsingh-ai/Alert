import test from "node:test";
import assert from "node:assert/strict";
import { createAcknowledgementToken } from "../src/security.mjs";
import { createBridgeServer } from "../src/server.mjs";

test("a signed link previews and acknowledges only its scoped alert", async (context) => {
  const department = { key: "quality", label: "Quality", token: "department-secret" };
  const secret = "a-secure-test-secret-that-is-long-enough";
  const config = {
    departments: [department],
    acknowledgementSecret: secret,
    responderPrefix: "Teams"
  };
  let alert = {
    id: "alert-7",
    status: "OPEN",
    command_label: "Quality support",
    machine: { name: "Press 7", code: "P7" },
    department: { name: "Quality" }
  };
  let acknowledgements = 0;
  let notifications = 0;
  const monitor = { recordTeamsAcknowledgement: async () => { notifications += 1; } };
  const server = createBridgeServer(config, monitor, {
    getActiveAlerts: async () => [alert],
    acknowledgeAlert: async (_config, _department, id, responder) => {
      assert.equal(id, "alert-7");
      acknowledgements += 1;
      alert = { ...alert, status: "ACKNOWLEDGED", responder_name_text: responder };
      return alert;
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const token = createAcknowledgementToken({ alertId: "alert-7", departmentKey: "quality" }, secret, 60_000);

  const preview = await fetch(`${baseUrl}/ack?token=${encodeURIComponent(token)}`);
  assert.equal(preview.status, 200);
  assert.match(await preview.text(), /Acknowledge Quality request/);

  const response = await fetch(`${baseUrl}/api/acknowledge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, alreadyAcknowledged: false });
  assert.equal(acknowledgements, 1);
  assert.equal(notifications, 1);
});
