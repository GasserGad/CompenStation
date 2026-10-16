import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withTransaction } from "./db.js";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
// Arbitrary constant key so two app instances never migrate at the same time.
const LOCK_KEY = 71_404_2026;

/**
 * Apply any .sql migrations that haven't run yet, in filename order.
 * @param {import("pg").Pool} pool
 * @param {(msg: string) => void} [log]
 */
export async function migrate(pool, log = () => {}) {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  await withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK_KEY]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
    );
    const { rows } = await client.query("SELECT name FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.name));
    for (const file of files) {
      if (applied.has(file)) continue;
      // File names come from listing our own migrations folder, never from a request.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      log(`applied migration ${file}`);
    }
  });
}
