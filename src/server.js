import "dotenv/config";
import { createApp } from "./app.js";
import { purgeExpiredSessions } from "./auth/sessions.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { resetDemoData } from "./demo.js";
import { migrate } from "./migrate.js";

/** JSON-lines logger. Never log passwords, tokens, cookies or pay data. */
const log = (level, message, fields = {}) => {
  const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...fields });
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
};

let config;
try {
  config = loadConfig();
} catch (err) {
  log("error", "invalid configuration", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}

const pool = createPool(config);
pool.on("error", (err) => log("error", "database pool error", { error: err.message }));

await migrate(pool, (m) => log("info", m));

const timers = [];
if (config.demoMode) {
  const reset = () =>
    resetDemoData(pool, config.demoPassword)
      .then(() => log("info", "demo data reset"))
      .catch((err) => log("error", "demo reset failed", { error: err.message }));
  await reset();
  timers.push(setInterval(reset, config.demoResetHours * 3_600_000));
}
timers.push(
  setInterval(() => purgeExpiredSessions(pool).catch((err) => log("warn", "session purge failed", { error: err.message })), 3_600_000)
);
timers.forEach((t) => t.unref());

const app = createApp({ pool, config, log });
const server = app.listen(config.port, () => log("info", "server listening", { port: config.port, demoMode: config.demoMode }));

// Slow-client (slowloris) protection.
server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;

/** @param {string} signal */
function shutdown(signal) {
  log("info", "shutting down", { signal });
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => log("error", "unhandled rejection", { error: String(reason) }));
