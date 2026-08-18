import { buildConfig, loadEnvFile } from "./config.mjs";
import { AlertMonitor } from "./monitor.mjs";
import { createBridgeServer } from "./server.mjs";
import { StateStore } from "./state.mjs";

loadEnvFile();
const config = buildConfig();
const store = new StateStore(config.stateFile);
store.load();
const monitor = new AlertMonitor(config, store);
const server = createBridgeServer(config, monitor);

let polling = false;
let stopping = false;

async function poll() {
  if (polling || stopping) return;
  polling = true;
  try {
    await monitor.pollAll();
  } finally {
    polling = false;
  }
}

server.listen(config.port, config.bindHost, () => {
  console.info(`[bridge] listening on ${config.bindHost}:${config.port}`);
  console.info(`[bridge] acknowledgment links use ${config.bridgePublicUrl}`);
  console.info(`[bridge] monitoring ${config.departments.map((department) => department.label).join(" and ")}`);
  void poll();
});

const timer = setInterval(() => void poll(), config.pollIntervalMs);

async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  store.save();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
