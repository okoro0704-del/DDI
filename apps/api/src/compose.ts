import { Pool } from "pg";
import { readConfig } from "../../../packages/service/src/config.ts";
import { HttpDigiAuthorityClient, HttpDigiAuthorityGrantClient, HttpDigiSessionClient } from "../../../packages/service/src/digi.ts";
import { postgresHealth } from "../../../packages/service/src/postgres.ts";
import { PostgresDdiRepository } from "../../../packages/service/src/postgres-repository.ts";
import { DurableDdiService, authorityVerifier, defaultAdapters } from "../../../packages/service/src/runtime.ts";
import { HttpPortalOwnershipVerifier } from "../../../packages/service/src/ownership.ts";
import { CommercialService, UnavailableCommercialProvisioner } from "../../../packages/service/src/commercial.ts";
import { loadCatalog } from "../../../packages/service/src/commercial-catalog.ts";
import { PostgresCommercialRepository } from "../../../packages/service/src/commercial-repository.ts";
import { CanonicalTrustIdVerifier } from "../../../packages/service/src/trustid.ts";
import { buildApi } from "./app.ts";

/** Production composition. PostgreSQL is required. There is no JSON or memory fallback. */
export async function composeRuntime(env: NodeJS.ProcessEnv = process.env) {
  const config = readConfig(env);
  if (!config.databaseUrl || !config.digiCoreUrl || !config.digiAuthorityUrl || !config.digiAuthorityJwksUrl || !config.digiAuthorityVerifierModuleUrl || !config.trustIdIssuer || !config.trustIdAudience || !config.trustIdJwksUrl || !config.trustIdBridgeModuleUrl) throw new Error("DDI_PRODUCTION_CONFIGURATION_INVALID");
  // Validate the commercial configuration before opening a pool, so misconfiguration fails closed early.
  const catalog = loadCatalog(env);
  if (catalog && (config.activationCodePepper ?? "").length < 32) throw new Error("DDI_PRODUCTION_CONFIGURATION_INVALID");
  const pool = new Pool({ connectionString: config.databaseUrl, max: 8, connectionTimeoutMillis: 3000 });
  const database = await postgresHealth(pool);
  if (database !== "UP") {
    await pool.end().catch(() => undefined);
    throw new Error("DDI_POSTGRES_UNAVAILABLE");
  }
  const identityVerifier = new CanonicalTrustIdVerifier({ issuer: config.trustIdIssuer, audience: config.trustIdAudience, jwksUrl: config.trustIdJwksUrl, bridgeModuleUrl: config.trustIdBridgeModuleUrl });
  const repository = new PostgresDdiRepository(pool);
  const ownership = new HttpPortalOwnershipVerifier({ url: config.portalOwnershipUrl!, sharedSecret: config.portalOwnershipSharedSecret! });
  const service = new DurableDdiService(
    repository,
    authorityVerifier(new HttpDigiAuthorityClient({ consumeUrl: new URL("/v1/authority/consume", config.digiAuthorityUrl).href, jwksUrl: config.digiAuthorityJwksUrl, verifierModuleUrl: config.digiAuthorityVerifierModuleUrl })),
    defaultAdapters(assertion => identityVerifier.verify(assertion)),
    new HttpDigiSessionClient(config.digiCoreUrl),
    new HttpDigiAuthorityGrantClient(config.digiAuthorityUrl),
    ownership,
  );
  // No verified Portal/Master Distributor provisioning endpoint exists yet: provisioning stays durably pending.
  const commercial = catalog ? new CommercialService({ repository: new PostgresCommercialRepository(pool), pdi: repository, ownership, provisioner: new UnavailableCommercialProvisioner(), catalog, pepper: config.activationCodePepper!, downloadTtlSeconds: config.downloadGrantTtlSeconds }) : undefined;
  const app = buildApi({ service, config, commercial, database: () => postgresHealth(pool), identity: () => identityVerifier.health() });
  return { app, pool, config, service, commercial };
}
