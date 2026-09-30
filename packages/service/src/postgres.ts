import { readFile } from "node:fs/promises";
import type { Pool } from "pg";

/** Explicit migration runner. One checked-out client owns BEGIN/COMMIT. Startup never calls this. */
export async function migrate(pool: Pool, migrationPath: string) {
  const sql = await readFile(migrationPath, "utf8");
  const executable = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");
  if (/\b(drop|truncate|delete\s+from)\b/i.test(executable)) throw new Error("DESTRUCTIVE_MIGRATION_REJECTED");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function postgresHealth(pool: Pool) {
  try { await pool.query("SELECT 1"); return "UP" as const; }
  catch { return "DOWN" as const; }
}
