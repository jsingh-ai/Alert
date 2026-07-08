import { createHash, randomBytes } from "node:crypto";

export function sha256(input: string) {
  return createHash("sha256").update(input).digest("hex");
}

export function tokenFingerprint(token: string) {
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

export function generatePagerToken() {
  return `pg_${randomBytes(24).toString("base64url")}`;
}
