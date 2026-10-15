export type DdiConfig = {
  environment: "development" | "test" | "production";
  databaseUrl?: string;
  trustIdIssuer?: string;
  trustIdAudience?: string;
  trustIdJwksUrl?: string;
  trustIdBridgeModuleUrl?: string;
  allowedOrigins: string[];
  digiCoreUrl?: string;
  digiAuthorityUrl?: string;
  digiAuthorityJwksUrl?: string;
  digiAuthorityVerifierModuleUrl?: string;
  portalOwnershipUrl?: string;
  portalOwnershipSharedSecret?: string;
  /** D3B: keyed-hash pepper for activation codes. Required whenever a commercial catalog is configured. */
  activationCodePepper?: string;
  /** D3B: Master Distributor service credential for single-use download-grant redemption. */
  downloadDistributorSecret?: string;
  downloadGrantTtlSeconds?: number;
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): DdiConfig {
  const marker = env.DDI_ENV;
  const environment: DdiConfig["environment"] = marker === "production" ? "production" : marker === "test" ? "test" : "development";
  const allowedOrigins = (env.DDI_ALLOWED_ORIGINS ?? "").split(",").map(x => x.trim()).filter(Boolean);
  const config: DdiConfig = {
    environment,
    databaseUrl: env.DATABASE_URL,
    trustIdIssuer: env.TRUSTID_ISSUER,
    trustIdAudience: env.TRUSTID_AUDIENCE,
    trustIdJwksUrl: env.TRUSTID_JWKS_URL,
    trustIdBridgeModuleUrl: env.TRUSTID_BRIDGE_MODULE_URL,
    allowedOrigins,
    digiCoreUrl: env.DIGI_CORE_URL,
    digiAuthorityUrl: env.DIGI_AUTHORITY_URL,
    digiAuthorityJwksUrl: env.DIGI_AUTHORITY_JWKS_URL,
    digiAuthorityVerifierModuleUrl: env.DIGI_AUTHORITY_VERIFIER_MODULE_URL,
    portalOwnershipUrl: env.PORTAL_OWNERSHIP_URL,
    portalOwnershipSharedSecret: env.PORTAL_OWNERSHIP_SHARED_SECRET,
    activationCodePepper: env.DDI_ACTIVATION_CODE_PEPPER,
    downloadDistributorSecret: env.DDI_DOWNLOAD_DISTRIBUTOR_SECRET,
    downloadGrantTtlSeconds: env.DDI_DOWNLOAD_GRANT_TTL_SECONDS ? Number(env.DDI_DOWNLOAD_GRANT_TTL_SECONDS) : undefined,
  };
  if (environment === "production") {
    if (!config.databaseUrl || !config.trustIdIssuer || !config.trustIdAudience || !config.trustIdJwksUrl || !config.trustIdBridgeModuleUrl || !allowedOrigins.length || !config.digiCoreUrl || !config.digiAuthorityUrl || !config.digiAuthorityJwksUrl || !config.digiAuthorityVerifierModuleUrl || !config.portalOwnershipUrl || !config.portalOwnershipSharedSecret) throw new Error("DDI_PRODUCTION_CONFIGURATION_INVALID");
    if ((env.DDI_COMMERCIAL_CATALOG || env.DDI_COMMERCIAL_CATALOG_PATH) && (config.activationCodePepper ?? "").length < 32) throw new Error("DDI_PRODUCTION_CONFIGURATION_INVALID");
    if (config.downloadDistributorSecret !== undefined && config.downloadDistributorSecret.length < 32) throw new Error("DDI_PRODUCTION_CONFIGURATION_INVALID");
    if (!config.databaseUrl.startsWith("postgres://") && !config.databaseUrl.startsWith("postgresql://")) throw new Error("DDI_POSTGRES_REQUIRED");
  }
  return config;
}
