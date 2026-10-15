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
import { PostgresPortalInstallState } from "../../../packages/service/src/portal-install-state.ts";
import { HttpPortalProvisioner } from "../../../packages/service/src/portal-provisioner.ts";
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
  // With a DDI service identity the Portal call carries a service token; otherwise the D3A shared secret.
  const ownership = new HttpPortalOwnershipVerifier({ url: config.portalOwnershipUrl!, sharedSecret: config.portalOwnershipSharedSecret, signer: config.serviceSigner });
  const service = new DurableDdiService(
    repository,
    authorityVerifier(new HttpDigiAuthorityClient({ consumeUrl: new URL("/v1/authority/consume", config.digiAuthorityUrl).href, jwksUrl: config.digiAuthorityJwksUrl, verifierModuleUrl: config.digiAuthorityVerifierModuleUrl })),
    defaultAdapters(assertion => identityVerifier.verify(assertion)),
    new HttpDigiSessionClient(config.digiCoreUrl),
    new HttpDigiAuthorityGrantClient(config.digiAuthorityUrl),
    ownership,
  );
  // Production keeps the always-unavailable provisioner. readConfig refuses the Portal adapter in production;
  // it is enabled only by an explicit local-integration mode with a DDI service identity.
  const provisioner = config.provisioningMode === "portal-local-integration" && config.environment !== "production"
    ? new HttpPortalProvisioner({ url: config.portalProvisioningUrl!, signer: config.serviceSigner! })
    : new UnavailableCommercialProvisioner();
  const commercial = catalog ? new CommercialService({ repository: new PostgresCommercialRepository(pool), pdi: repository, ownership, provisioner, catalog, pepper: config.activationCodePepper!, downloadTtlSeconds: config.downloadGrantTtlSeconds }) : undefined;
  const installState = new PostgresPortalInstallState(pool);
  const app = buildApi({ service, config, commercial, installState, database: () => postgresHealth(pool), identity: () => identityVerifier.health() });
  return { app, pool, config, service, commercial, installState, ownership };
}
