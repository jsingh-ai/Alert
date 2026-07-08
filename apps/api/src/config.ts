import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

function findEnvFile() {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../../.env"),
    path.resolve(process.cwd(), "../.env")
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

const envFile = findEnvFile();
if (envFile) {
  dotenv.config({ path: envFile });
} else {
  dotenv.config();
}

function boolFromEnv(value: string | undefined, fallback: boolean) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export const config = {
  port: Number(process.env.PORT ?? 5003),
  host: process.env.HOST ?? "0.0.0.0",
  jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-me",
  demoMode: boolFromEnv(process.env.DEMO_MODE, true),
  serveWeb: boolFromEnv(process.env.SERVE_WEB, true),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 5003}`,
  reportTimeZone: process.env.REPORT_TIME_ZONE ?? process.env.TZ ?? "America/Chicago"
};

if (config.jwtSecret === "dev-secret-change-me" && process.env.NODE_ENV === "production") {
  throw new Error("JWT_SECRET must be set in production.");
}
