import test from "node:test";
import assert from "node:assert/strict";
import { buildTeamsMessage, normalizeAlert } from "../src/teams.mjs";

const department = { key: "quality", label: "Quality" };
const sourceAlert = {
  id: "alert-1",
  status: "OPEN",
  priority: "HIGH",
  command_label: "Quality support",
  display_message: "Check the part",
  machine: { name: "Press 2", code: "P2" },
  department: { name: "Quality" }
};

test("new alert cards contain the passwordless acknowledgment link", () => {
  const alert = normalizeAlert(sourceAlert, department);
  const message = buildTeamsMessage({ alert, event: "created", acknowledgementUrl: "http://10.8.10.97:5010/ack?token=signed" });
  const card = message.attachments[0].content;
  assert.equal(card.actions[0].type, "Action.OpenUrl");
  assert.match(card.actions[0].url, /token=signed/);
  assert.match(message.summary, /Quality/);
});

test("acknowledged cards do not contain another acknowledgment action", () => {
  const alert = normalizeAlert({ ...sourceAlert, status: "ACKNOWLEDGED", responder_name_text: "Teams — Quality" }, department);
  const message = buildTeamsMessage({ alert, event: "acknowledged" });
  assert.equal(message.attachments[0].content.actions, undefined);
  assert.match(message.summary, /Acknowledged/);
});
