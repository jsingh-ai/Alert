import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { authPlugin } from "./services/auth.js";
import { setupRealtime } from "./services/realtime.js";
import { authRoutes } from "./routes/authRoutes.js";
import { operatorRoutes } from "./routes/operatorRoutes.js";
import { commandRoutes } from "./routes/commandRoutes.js";
import { alertRoutes } from "./routes/alertRoutes.js";
import { floorRoutes } from "./routes/floorRoutes.js";
import { pagerRoutes } from "./routes/pagerRoutes.js";
import { reportRoutes } from "./routes/reportRoutes.js";
import { adminRoutes } from "./routes/adminRoutes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: true, bodyLimit: 1_000_000 });

app.setErrorHandler((error, request, reply) => {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("the URL must start with the protocol `file:`")) {
    return reply.code(500).send({
      success: false,
      error: "Database configuration mismatch. The generated Prisma client is for SQLite, but DATABASE_URL is not a file: URL. Use npm run dev:sqlite/start:sqlite, or regenerate Prisma for PostgreSQL with npm run db:generate."
    });
  }
  if (message.includes("the URL must start with the protocol `postgresql:`") || message.includes("the URL must start with the protocol `postgres:`")) {
    return reply.code(500).send({
      success: false,
      error: "Database configuration mismatch. The generated Prisma client is for PostgreSQL, but DATABASE_URL is not a PostgreSQL URL. Use npm run db:generate:sqlite for SQLite, or fix DATABASE_URL."
    });
  }
  request.log.error(error);
  return reply.code((error as any).statusCode ?? 500).send({
    success: false,
    error: process.env.NODE_ENV === "production" ? "Internal server error." : message || "Internal server error."
  });
});

await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin || origin === config.corsOrigin || config.corsOrigin === "*") cb(null, true);
    else cb(null, true);
  },
  credentials: true
});

await app.register(authPlugin);
setupRealtime(app);

app.get("/api/health", async () => ({ success: true, name: "ProcessGuard Andon", now: new Date().toISOString() }));

await app.register(authRoutes);
await app.register(operatorRoutes);
await app.register(commandRoutes);
await app.register(alertRoutes);
await app.register(floorRoutes);
await app.register(pagerRoutes);
await app.register(reportRoutes);
await app.register(adminRoutes);

if (config.serveWeb) {
  const webDist = path.resolve(__dirname, "../../web/dist");
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: "/" });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        reply.code(404).send({ success: false, error: "API route not found." });
        return;
      }
      reply.sendFile("index.html");
    });
  } else {
    app.log.warn(`SERVE_WEB=true but ${webDist} does not exist. Run npm run build first.`);
  }
}

const close = async () => {
  app.log.info("Shutting down...");
  await prisma.$disconnect();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);

await app.listen({ host: config.host, port: config.port });
app.log.info(`ProcessGuard Andon listening at ${config.publicUrl}`);
