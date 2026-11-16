// Makes a key for the read-only external API. Run `npm run api:key`, paste the line into .env
// (EXTERNAL_API_KEY) and restart. Anyone with the key can read active calls and call history,
// so share it only with the systems that need it. A new key replaces the old one at once.
import crypto from "node:crypto";

console.log("Add this to .env, then restart the app:\n");
console.log(`EXTERNAL_API_KEY="pgk_${crypto.randomBytes(32).toString("base64url")}"`);
