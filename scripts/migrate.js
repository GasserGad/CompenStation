// Apply database migrations: npm run migrate
import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db.js";
import { migrate } from "../src/migrate.js";

const pool = createPool(loadConfig());
await migrate(pool, (m) => console.log(m));
await pool.end();
console.log("Migrations are up to date.");
