import { Pool } from "pg";
import { readConfig } from "../../../packages/service/src/config.ts";
import { HttpDigiAuthorityClient, HttpDigiAuthorityGrantClient, HttpDigiSessionClient, defaultAuthorityVerifierUrl } from "../../../packages/service/src/digi.ts";
import { postgresHealth } from "../../../packages/service/src/postgres.ts";
import { PostgresDdiRepository } from "../../../packages/service/src/postgres-repository.ts";
import { DurableDdiService, authorityVerifier, defaultAdapters } from "../../../packages/service/src/runtime.ts";
import { CanonicalTrustIdVerifier, defaultTrustBridgeUrl } from "../../../packages/service/src/trustid.ts";
import { buildApi } from "./app.ts";

/** Production composition. PostgreSQL is required. There is no JSON or memory fallback. */
export async function composeRuntime(env: NodeJS.ProcessEnv = process.env) {
  const config = readConfig(env);
  if (!config.databaseUrl || !config.digiCoreUrl || !config.digiAuthorityUrl || !config.digiAuthorityJwksUrl || !config.trustIdIssuer || !config.trustIdAudience || !config.trustIdJwksUrl) throw new Error("DDI_PRODUCTION_CONFIGURATION_INVALID");
  const pool = new Pool({ connectionString: config.databaseUrl, max: 8, connectionTimeoutMillis: 3000 });
  const database = await postgresHealth(pool);
  if (database !== "UP") {
    await pool.end().catch(() => undefined);
    throw new Error("DDI_POSTGRES_UNAVAILABLE");
  }
  const identityVerifier = new CanonicalTrustIdVerifier({ issuer: config.trustIdIssuer, audience: config.trustIdAudience, jwksUrl: config.trustIdJwksUrl, bridgeModuleUrl: defaultTrustBridgeUrl() });
  const service = new DurableDdiService(
    new PostgresDdiRepository(pool),
    authorityVerifier(new HttpDigiAuthorityClient({ consumeUrl: new URL("/v1/authority/consume", config.digiAuthorityUrl).href, jwksUrl: config.digiAuthorityJwksUrl, verifierModuleUrl: defaultAuthorityVerifierUrl() })),
    defaultAdapters(assertion => identityVerifier.verify(assertion)),
    new HttpDigiSessionClient(config.digiCoreUrl),
    new HttpDigiAuthorityGrantClient(config.digiAuthorityUrl),
  );
  const app = buildApi({ service, config, database: () => postgresHealth(pool), identity: () => identityVerifier.health() });
  return { app, pool, config, service };
}
