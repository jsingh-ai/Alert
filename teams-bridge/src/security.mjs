import { createHmac, timingSafeEqual } from "node:crypto";

function signature(encodedPayload, secret) {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

export function createAcknowledgementToken({ alertId, departmentKey }, secret, ttlMs, now = Date.now()) {
  const payload = {
    version: 1,
    alertId,
    departmentKey,
    expiresAt: now + ttlMs
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${signature(encodedPayload, secret)}`;
}

export function verifyAcknowledgementToken(token, secret, now = Date.now()) {
  if (!token || !secret) return null;
  const [encodedPayload, suppliedSignature, ...extra] = String(token).split(".");
  if (!encodedPayload || !suppliedSignature || extra.length) return null;
  const expectedSignature = signature(encodedPayload, secret);
  const supplied = Buffer.from(suppliedSignature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (
      payload.version !== 1
      || typeof payload.alertId !== "string"
      || !payload.alertId
      || typeof payload.departmentKey !== "string"
      || !payload.departmentKey
      || !Number.isSafeInteger(payload.expiresAt)
      || payload.expiresAt <= now
    ) return null;
    return payload;
  } catch {
    return null;
  }
}
