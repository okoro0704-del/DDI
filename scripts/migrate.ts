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
  await migrate(pool, resolve("migrations/004_connected_properties.sql"));
  await migrate(pool, resolve("migrations/005_commercial_activation.sql"));
  await migrate(pool, resolve("migrations/006_commercial_recovery.sql"));
  await migrate(pool, resolve("migrations/007_portal_install_state.sql"));
  await migrate(pool, resolve("migrations/008_download_grant_version.sql"));
} finally {
  await pool.end();
}
