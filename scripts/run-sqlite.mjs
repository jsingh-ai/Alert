import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const envFile = path.join(root, ".env.sqlite.example");

function parseEnvFile(file) {
  const values = {};
  const content = fs.readFileSync(file, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

const args = process.argv.slice(2);
if (!args.length) {
  console.error("Usage: node scripts/run-sqlite.mjs <command> [args...]");
  process.exit(1);
}

const command = args[0];
const commandArgs = args.slice(1);
const sqliteEnv = parseEnvFile(envFile);
const env = {
  ...sqliteEnv,
  ...process.env,
  DATABASE_URL: sqliteEnv.DATABASE_URL,
  DEMO_MODE: sqliteEnv.DEMO_MODE,
  SEED_DEMO: sqliteEnv.SEED_DEMO
};

const child = spawn(command, commandArgs, {
  cwd: root,
  env,
  stdio: "inherit",
  shell: process.platform === "win32"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
