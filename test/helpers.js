// Test helpers. Tests run against a real PostgreSQL database (set
// TEST_DATABASE_URL), which is wiped and rebuilt for every test file.

import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db.js";
import { resetDemoData } from "../src/demo.js";
import { migrate } from "../src/migrate.js";

export const ORIGIN = "http://localhost:3000";
export const DEMO_PASSWORD = "Test-Password-123";
const URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:5433/compenstation_test";

/**
 * Fresh database + app for one test file.
 * @param {Record<string, string>} [env] extra config
 */
export async function setup(env = {}) {
  const config = loadConfig({
    DATABASE_URL: URL,
    PUBLIC_ORIGIN: ORIGIN,
    DEMO_PASSWORD,
    DEMO_MODE: "true",
    LOGIN_RATE_LIMIT_PER_15_MIN: "1000",
    GLOBAL_RATE_LIMIT_PER_MINUTE: "10000",
    ...env,
  });
  const pool = createPool(config);
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(pool);
  await resetDemoData(pool, DEMO_PASSWORD);
  const app = createApp({ pool, config });
  return { app, pool, config };
}

/**
 * A supertest agent (keeps cookies) that sends our Origin like a browser would.
 * @param {import("express").Express} app
 */
export function client(app) {
  const agent = request.agent(app);
  const withOrigin = (method) => (path) => agent[method](path).set("Origin", ORIGIN);
  return {
    agent,
    get: (path) => agent.get(path),
    post: withOrigin("post"),
    patch: withOrigin("patch"),
    delete: withOrigin("delete"),
  };
}

/** Log in and return a client holding the session cookie. */
export async function loginAs(app, username, password = DEMO_PASSWORD) {
  const c = client(app);
  const res = await c.post("/api/auth/login").send({ username, password });
  if (res.status !== 200) throw new Error(`login as ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return c;
}

/** Employee ID for a demo username. */
export async function employeeIdOf(pool, username) {
  const { rows } = await pool.query("SELECT employee_id FROM users WHERE username = $1", [username]);
  return rows[0].employee_id;
}
