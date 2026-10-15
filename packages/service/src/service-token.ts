import { createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject } from "node:crypto";

/**
 * Digiconomy service-to-service token, format `digiconomy-service+jwt` v1.
 * Identical wire format in DDI, Portal and Master Distributor.
 *
 * - Ed25519 (JWS alg EdDSA) only; the verifier pins each caller's public keys.
 * - Bound to issuer (= subject), audience, HTTP method and path; lifetime <= 300 s.
 * - Carries no roles: the verifier maps the authenticated service id to its own
 *   configured permissions. TrustID has no workload-identity flow today; this is
 *   service identity only and never identifies a person.
 */
export const SERVICE_TOKEN_TYPE = "digiconomy-service+jwt";
const MAX_LIFETIME_SECONDS = 300;
const CLOCK_SKEW_SECONDS = 30;

export type ServiceSigner = { serviceId: string; keyId: string; privateKey: KeyObject };
export type TrustedService = { keys: Record<string, KeyObject>; permissions: string[] };
export type ServiceVerifierOptions = { audience: string; services: Record<string, TrustedService>; production?: boolean; now?: () => number };
export type VerifiedService = { serviceId: string; keyId: string; permissions: string[]; jti: string };

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const decode = (value: string) => JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;

export function signServiceToken(signer: ServiceSigner, input: { audience: string; method: string; path: string; lifetimeSeconds?: number; now?: number }) {
  const iat = Math.floor((input.now ?? Date.now()) / 1000);
  const header = encode({ alg: "EdDSA", typ: SERVICE_TOKEN_TYPE, kid: signer.keyId });
  const payload = encode({ iss: signer.serviceId, sub: signer.serviceId, aud: input.audience, iat, exp: iat + Math.min(input.lifetimeSeconds ?? 120, MAX_LIFETIME_SECONDS), jti: randomUUID(), htm: input.method.toUpperCase(), htu: input.path });
  return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), signer.privateKey).toString("base64url")}`;
}

/** Verifies and enforces single use of each jti within its lifetime. Every failure is `null`. */
export class ServiceTokenVerifier {
  private options: ServiceVerifierOptions;
  private seen = new Map<string, number>();
  constructor(options: ServiceVerifierOptions) { this.options = options; }

  verify(token: string | undefined, request: { method: string; path: string }): VerifiedService | null {
    try {
      if (!token) return null;
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];
      const header = decode(rawHeader);
      const claims = decode(rawPayload);
      if (header.alg !== "EdDSA" || header.typ !== SERVICE_TOKEN_TYPE || typeof header.kid !== "string") return null;
      if (typeof claims.iss !== "string" || claims.iss !== claims.sub) return null;
      const service = Object.hasOwn(this.options.services, claims.iss) ? this.options.services[claims.iss] : undefined;
      const key = service && Object.hasOwn(service.keys, header.kid) ? service.keys[header.kid] : undefined;
      if (!service || !key) return null;
      // Test keys are labelled test-*; they are never a production trust anchor.
      if (this.options.production && header.kid.startsWith("test-")) return null;
      if (!verify(null, Buffer.from(`${rawHeader}.${rawPayload}`), key, Buffer.from(rawSignature, "base64url"))) return null;
      const now = Math.floor((this.options.now?.() ?? Date.now()) / 1000);
      if (claims.aud !== this.options.audience || typeof claims.iat !== "number" || typeof claims.exp !== "number" || typeof claims.jti !== "string") return null;
      if (claims.iat > now + CLOCK_SKEW_SECONDS || claims.exp <= now || claims.exp - claims.iat > MAX_LIFETIME_SECONDS) return null;
      if (claims.htm !== request.method.toUpperCase() || claims.htu !== request.path) return null;
      for (const [jti, expiry] of this.seen) if (expiry <= now) this.seen.delete(jti);
      const replayKey = `${claims.iss}:${claims.jti}`;
      if (this.seen.has(replayKey)) return null;
      this.seen.set(replayKey, claims.exp + CLOCK_SKEW_SECONDS);
      return { serviceId: claims.iss, keyId: header.kid, permissions: [...service.permissions], jti: claims.jti };
    } catch { return null; }
  }
}

export function bearer(header: string | undefined) {
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
}

/** `{"<serviceId>":{"permissions":["…"],"keys":{"<kid>":"<SPKI PEM>"}}}` */
export function parseTrustedServices(json: string | undefined): Record<string, TrustedService> {
  if (!json) return {};
  const raw = JSON.parse(json) as Record<string, { permissions?: unknown; keys?: Record<string, string> }>;
  const services: Record<string, TrustedService> = {};
  for (const [serviceId, entry] of Object.entries(raw)) {
    if (!Array.isArray(entry.permissions) || !entry.keys) throw new Error("SERVICE_TRUST_CONFIGURATION_INVALID");
    const keys: Record<string, KeyObject> = {};
    for (const [kid, pem] of Object.entries(entry.keys)) {
      const key = createPublicKey(pem);
      if (key.asymmetricKeyType !== "ed25519") throw new Error("SERVICE_TRUST_CONFIGURATION_INVALID");
      keys[kid] = key;
    }
    services[serviceId] = { keys, permissions: entry.permissions.map(String) };
  }
  return services;
}

export function parseServiceSigner(input: { serviceId?: string; keyId?: string; privateKeyPem?: string; production?: boolean }): ServiceSigner | undefined {
  if (!input.serviceId || !input.keyId || !input.privateKeyPem) return undefined;
  if (input.production && input.keyId.startsWith("test-")) throw new Error("SERVICE_SIGNING_KEY_INVALID");
  const privateKey = createPrivateKey(input.privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("SERVICE_SIGNING_KEY_INVALID");
  return { serviceId: input.serviceId, keyId: input.keyId, privateKey };
}
