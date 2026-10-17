import { Pool } from "pg";
import type { CommercialOperatorRole } from "../packages/contracts/src/index.ts";
import { PostgresCommercialRepository } from "../packages/service/src/commercial-repository.ts";

/**
 * Bootstraps commercial operator role bindings. Possession of DATABASE_URL is
 * the privilege here; there is deliberately no HTTP route that self-grants.
 *   node scripts/commercial-operator.ts grant <canonical-owner-id> COMMERCIAL_ISSUER|COMMERCIAL_ADMIN
 *   node scripts/commercial-operator.ts revoke <canonical-owner-id>
 */
const [command, ownerId, role] = process.argv.slice(2);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED");
if (!ownerId || (command !== "grant" && command !== "revoke") || (command === "grant" && role !== "COMMERCIAL_ISSUER" && role !== "COMMERCIAL_ADMIN")) throw new Error("USAGE: grant <ownerId> COMMERCIAL_ISSUER|COMMERCIAL_ADMIN | revoke <ownerId>");
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  await new PostgresCommercialRepository(pool).setOperator(ownerId, command === "grant" ? role as CommercialOperatorRole : null, `cli:${process.env.USERNAME ?? process.env.USER ?? "database-operator"}`, new Date());
  console.log(`${command} ${ownerId} ${command === "grant" ? role : ""}`.trim());
} finally {
  await pool.end();
}
