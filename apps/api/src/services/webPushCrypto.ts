/*
 * The two pieces of Web Push cryptography, using only Node's crypto (no packages):
 *   vapidJwt      a short ES256-signed token proving notifications come from this server (RFC 8292)
 *   encryptPush   the notification encrypted for one device, as one aes128gcm record (RFC 8291 / 8188)
 * Kept free of the database and config so it can be checked against the RFC's test vector.
 */
import crypto from "node:crypto";

export function b64url(buffer: Buffer) {
  return buffer.toString("base64url");
}

export function fromB64url(value: string) {
  return Buffer.from(value, "base64url");
}

/** A private key object from the raw base64url values kept in .env (public: 65-byte point, private: 32-byte scalar). */
export function vapidPrivateKey(publicKey: string, privateKey: string) {
  const pub = fromB64url(publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("VAPID_PUBLIC_KEY must be an uncompressed P-256 point (65 bytes).");
  return crypto.createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: privateKey, x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) },
    format: "jwk"
  });
}

export function vapidJwt(key: crypto.KeyObject, audience: string, subject: string, expiresAt: number) {
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud: audience, exp: expiresAt, sub: subject })));
  const unsigned = `${header}.${claims}`;
  const signature = crypto.sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" });
  return `${unsigned}.${b64url(signature)}`;
}

/**
 * The push services browsers actually use. The server only ever sends to these, so a made-up
 * "subscription" can't make it call an address inside the network.
 */
const PUSH_SERVICES = ["fcm.googleapis.com", ".push.services.mozilla.com", ".push.apple.com", ".notify.windows.com"];

export function isPushServiceUrl(endpoint: string) {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    return PUSH_SERVICES.some((service) => (service.startsWith(".") ? host.endsWith(service) : host === service));
  } catch {
    return false;
  }
}

export const RECORD_SIZE = 4096;

/**
 * Encrypt a payload for one device. `salt` and `localKey` are only passed by the test (the RFC's fixed
 * values); in use both are fresh and random for every message.
 */
export function encryptPush(device: { p256dh: string; auth: string }, payload: Buffer, test?: { salt: Buffer; localKey: crypto.ECDH }) {
  const devicePublic = fromB64url(device.p256dh);
  const authSecret = fromB64url(device.auth);
  if (devicePublic.length !== 65 || authSecret.length < 16) throw new Error("Subscription keys are malformed.");
  if (payload.length + 17 > RECORD_SIZE) throw new Error("Notification is too long for one record.");

  const local = test?.localKey ?? crypto.createECDH("prime256v1");
  if (!test) local.generateKeys();
  const localPublic = local.getPublicKey();
  const shared = local.computeSecret(devicePublic);

  // IKM = HKDF(salt: auth secret, key: shared secret, info: "WebPush: info" 0x00 || device key || server key)
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), devicePublic, localPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const salt = test?.salt ?? crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));

  // One record: the text, then the 0x02 "last record" delimiter
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const sealed = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  // Header: salt (16) | record size (4) | key id length (1), then the key id = our public key (65)
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(localPublic.length, 20);
  return Buffer.concat([header, localPublic, sealed]);
}
