import test from "node:test";
import assert from "node:assert/strict";
import { createAcknowledgementToken, verifyAcknowledgementToken } from "../src/security.mjs";

const secret = "a-secure-test-secret-that-is-long-enough";

test("valid acknowledgment tokens retain their alert scope", () => {
  const token = createAcknowledgementToken({ alertId: "alert-123", departmentKey: "quality" }, secret, 60_000, 1000);
  assert.deepEqual(verifyAcknowledgementToken(token, secret, 2000), {
    version: 1,
    alertId: "alert-123",
    departmentKey: "quality",
    expiresAt: 61_000
  });
});

test("expired and tampered acknowledgment tokens are rejected", () => {
  const token = createAcknowledgementToken({ alertId: "alert-123", departmentKey: "quality" }, secret, 1000, 1000);
  assert.equal(verifyAcknowledgementToken(token, secret, 2001), null);
  assert.equal(verifyAcknowledgementToken(`${token}x`, secret, 1500), null);
});
