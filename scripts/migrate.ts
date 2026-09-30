import { Pool } from "pg";
import { resolve } from "node:path";
import { migrate } from "../packages/service/src/postgres.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED");
const pool = new Pool({ connectionString: databaseUrl });
try {
  await migrate(pool, resolve("migrations/001_ddi_foundation.sql"));
  await migrate(pool, resolve("migrations/002_ddi_runtime.sql"));
  await migrate(pool, resolve("migrations/003_pdi_connections.sql"));
} finally {
  await pool.end();
}
