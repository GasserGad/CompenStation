import pg from "pg";

// Return NUMERIC and BIGINT columns as JS numbers. Every money value is stored
// in cents and capped by CHECK constraints far below Number.MAX_SAFE_INTEGER.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
// Keep DATE columns as "YYYY-MM-DD" strings so time zones can't shift them.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

/**
 * @param {import("./config.js").Config} config
 */
export function createPool(config) {
  return new pg.Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl ? { rejectUnauthorized: true } : false,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Stop runaway queries from tying up the database.
    statement_timeout: 10_000,
    query_timeout: 15_000,
  });
}

/**
 * Run `fn` inside a transaction. Rolls back on any error.
 * @template T
 * @param {pg.Pool} pool
 * @param {(client: pg.PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
