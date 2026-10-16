// Load the fictional demo data set: npm run seed:demo
// WARNING: this deletes every row in the database first.
import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db.js";
import { resetDemoData } from "../src/demo.js";
import { migrate } from "../src/migrate.js";

const config = loadConfig();
const pool = createPool(config);
await migrate(pool);
await resetDemoData(pool, config.demoPassword);
await pool.end();
console.log("Demo data loaded. Log in as admin, jdoe, jsmith, mgarcia or kchen with the demo password.");
