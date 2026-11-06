// Makes the key pair for call notifications on phones (Web Push). Run once: `npm run push:keys`,
// then paste the two lines into .env and restart. Keep the same keys from then on: new keys turn
// notifications off on every phone until each person turns them on again.
import crypto from "node:crypto";

const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = privateKey.export({ format: "jwk" });
const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");

console.log("Add these to .env, then restart the app:\n");
console.log(`VAPID_PUBLIC_KEY="${publicKey}"`);
console.log(`VAPID_PRIVATE_KEY="${jwk.d}"`);
console.log('VAPID_SUBJECT="mailto:it@example.com"   # an IT mailbox push services can contact');
