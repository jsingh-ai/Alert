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

function intFromEnv(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function splitOrigins(value: string | undefined) {
  return (value ?? "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function originFromUrl(value: string | undefined) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

const isProduction = process.env.NODE_ENV === "production";
const corsOrigins = Array.from(new Set([
  ...splitOrigins(process.env.CORS_ORIGIN),
  originFromUrl(process.env.PUBLIC_URL)
].filter(Boolean) as string[]));

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProduction,
  port: Number(process.env.PORT ?? 5003),
  host: process.env.HOST ?? "0.0.0.0",
  jwtSecret: process.env.JWT_SECRET ?? (isProduction ? "" : "dev-secret-change-me"),
  demoMode: boolFromEnv(process.env.DEMO_MODE, !isProduction),
  serveWeb: boolFromEnv(process.env.SERVE_WEB, true),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  corsOrigins,
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 5003}`,
  reportTimeZone: process.env.REPORT_TIME_ZONE ?? process.env.TZ ?? "America/Chicago",
  rateLimit: {
    globalMax: intFromEnv(process.env.RATE_LIMIT_GLOBAL_MAX, 1200),
    authMax: intFromEnv(process.env.RATE_LIMIT_AUTH_MAX, 10),
    pagerMax: intFromEnv(process.env.RATE_LIMIT_PAGER_MAX, 120),
    messageMax: intFromEnv(process.env.RATE_LIMIT_MESSAGE_MAX, 30),
    adminWriteMax: intFromEnv(process.env.RATE_LIMIT_ADMIN_WRITE_MAX, 120),
    timeWindow: process.env.RATE_LIMIT_TIME_WINDOW ?? "1 minute"
  },
  socketRevalidateMs: intFromEnv(process.env.SOCKET_REVALIDATE_MS, 5 * 60 * 1000)
};

if (isProduction) {
  const loweredSecret = config.jwtSecret.toLowerCase();
  const placeholderPattern = /(dev|demo|example|replace|change|local|secret|test)/;
  if (!config.jwtSecret) {
    throw new Error("JWT_SECRET must be set in production.");
  }
  if (config.jwtSecret.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters in production.");
  }
  if (placeholderPattern.test(loweredSecret)) {
    throw new Error("JWT_SECRET looks like a placeholder and cannot be used in production.");
  }
  if (config.demoMode) {
    throw new Error("DEMO_MODE must be false in production.");
  }
  if (config.corsOrigins.includes("*")) {
    throw new Error("CORS_ORIGIN cannot be '*' with credentials enabled in production.");
  }
}
