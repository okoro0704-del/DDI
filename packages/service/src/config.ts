export type DdiConfig = {
  environment: "development" | "test" | "production";
  databaseUrl?: string;
  trustIdIssuer?: string;
  trustIdAudience?: string;
  trustIdJwksUrl?: string;
  allowedOrigins: string[];
  digiCoreUrl?: string;
  digiAuthorityUrl?: string;
  digiAuthorityJwksUrl?: string;
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
    allowedOrigins,
    digiCoreUrl: env.DIGI_CORE_URL,
    digiAuthorityUrl: env.DIGI_AUTHORITY_URL,
    digiAuthorityJwksUrl: env.DIGI_AUTHORITY_JWKS_URL,
  };
  if (environment === "production") {
    if (!config.databaseUrl || !config.trustIdIssuer || !config.trustIdAudience || !config.trustIdJwksUrl || !allowedOrigins.length || !config.digiCoreUrl || !config.digiAuthorityUrl || !config.digiAuthorityJwksUrl) throw new Error("DDI_PRODUCTION_CONFIGURATION_INVALID");
    if (!config.databaseUrl.startsWith("postgres://") && !config.databaseUrl.startsWith("postgresql://")) throw new Error("DDI_POSTGRES_REQUIRED");
  }
  return config;
}
