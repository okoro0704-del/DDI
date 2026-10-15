import { parseServiceSigner, parseTrustedServices, type ServiceSigner, type TrustedService } from "./service-token.ts";

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
  downloadGrantTtlSeconds?: number;
  /** D3C-B: services allowed to call DDI internal routes, by pinned Ed25519 key, with DDI-assigned permissions. */
  trustedServices: Record<string, TrustedService>;
  /** D3C-B: DDI's own service identity for calls to the Portal. */
  serviceSigner?: ServiceSigner;
  /** D3C-B: `portal-local-integration` enables the real Portal provisioning adapter outside production only. */
  provisioningMode?: "portal-local-integration";
  portalProvisioningUrl?: string;
};

function invalid(): never { throw new Error("DDI_PRODUCTION_CONFIGURATION_INVALID"); }

export function readConfig(env: NodeJS.ProcessEnv = process.env): DdiConfig {
  const marker = env.DDI_ENV;
  const environment: DdiConfig["environment"] = marker === "production" ? "production" : marker === "test" ? "test" : "development";
  const production = environment === "production";
  const allowedOrigins = (env.DDI_ALLOWED_ORIGINS ?? "").split(",").map(x => x.trim()).filter(Boolean);
  let trustedServices: Record<string, TrustedService>;
  let serviceSigner: ServiceSigner | undefined;
  try {
    trustedServices = parseTrustedServices(env.DDI_TRUSTED_SERVICES);
    serviceSigner = parseServiceSigner({ serviceId: env.DDI_SERVICE_ID, keyId: env.DDI_SERVICE_KEY_ID, privateKeyPem: env.DDI_SERVICE_PRIVATE_KEY, production });
  } catch { invalid(); }
  if (production && Object.values(trustedServices).some(service => Object.keys(service.keys).some(kid => kid.startsWith("test-")))) invalid();
  const mode = env.DDI_COMMERCIAL_PROVISIONING_MODE;
  if (mode !== undefined && mode !== "" && mode !== "portal-local-integration") invalid();
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
    downloadGrantTtlSeconds: env.DDI_DOWNLOAD_GRANT_TTL_SECONDS ? Number(env.DDI_DOWNLOAD_GRANT_TTL_SECONDS) : undefined,
    trustedServices,
    serviceSigner,
    provisioningMode: mode === "portal-local-integration" ? mode : undefined,
    portalProvisioningUrl: env.PORTAL_PROVISIONING_URL,
  };
  if (production) {
    if (!config.databaseUrl || !config.trustIdIssuer || !config.trustIdAudience || !config.trustIdJwksUrl || !config.trustIdBridgeModuleUrl || !allowedOrigins.length || !config.digiCoreUrl || !config.digiAuthorityUrl || !config.digiAuthorityJwksUrl || !config.digiAuthorityVerifierModuleUrl || !config.portalOwnershipUrl || !config.portalOwnershipSharedSecret) invalid();
    if ((env.DDI_COMMERCIAL_CATALOG || env.DDI_COMMERCIAL_CATALOG_PATH) && (config.activationCodePepper ?? "").length < 32) invalid();
    // Production provisioning stays fail-closed: the local-integration adapter is never enabled there.
    if (config.provisioningMode) invalid();
    if (!config.databaseUrl.startsWith("postgres://") && !config.databaseUrl.startsWith("postgresql://")) throw new Error("DDI_POSTGRES_REQUIRED");
  }
  if (config.provisioningMode && (!config.portalProvisioningUrl || !config.serviceSigner)) invalid();
  return config;
}
