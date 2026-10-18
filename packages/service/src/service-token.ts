import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject } from "node:crypto";

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

/**
 * Atomic single-use record of a token id. `consume` returns true exactly once per
 * (issuer, jti) across every verifier sharing the store, and must throw when it
 * cannot decide. Only a SHA-256 of issuer and jti is stored, never a token.
 */
export type ReplayStore = { consume(issuer: string, jti: string, expiresAtSeconds: number): Promise<boolean> };

/** Thrown when replay protection cannot be decided. Callers answer 503; they never accept the token. */
export class ServiceReplayUnavailable extends Error {
  constructor() { super("SERVICE_REPLAY_STORE_UNAVAILABLE"); }
}

const replayDigest = (issuer: string, jti: string) => createHash("sha256").update(`${issuer}
${jti}`).digest("hex");

/** Process-local store: correct for one instance only (development and tests). */
export class MemoryReplayStore implements ReplayStore {
  private seen = new Map<string, number>();
  async consume(issuer: string, jti: string, expiresAtSeconds: number) {
    const now = Math.floor(Date.now() / 1000);
    for (const [key, expiry] of this.seen) if (expiry < now) this.seen.delete(key);
    const key = replayDigest(issuer, jti);
    if (this.seen.has(key)) return false;
    this.seen.set(key, expiresAtSeconds);
    return true;
  }
}

/**
 * Shared store on an existing PostgreSQL database: `INSERT ... ON CONFLICT DO NOTHING`
 * makes consumption atomic across instances. A row is retained until the token's expiry
 * plus clock skew; after that the token itself is already refused by its `exp`, so
 * purging the row can never re-enable it.
 */
export class PostgresReplayStore implements ReplayStore {
  private db: { query(text: string, values?: unknown[]): Promise<{ rowCount: number | null }> };
  private table: string;
  private lastPurge = 0;
  constructor(db: { query(text: string, values?: unknown[]): Promise<{ rowCount: number | null }> }, table: string) {
    if (!/^[a-z_][a-z0-9_.]*$/.test(table)) throw new Error("REPLAY_TABLE_INVALID");
    this.db = db;
    this.table = table;
  }
  async consume(issuer: string, jti: string, expiresAtSeconds: number) {
    const inserted = await this.db.query(`INSERT INTO ${this.table} (jti_hash, issuer, expires_at) VALUES ($1, $2, to_timestamp($3)) ON CONFLICT (jti_hash) DO NOTHING`, [replayDigest(issuer, jti), issuer, expiresAtSeconds]);
    if (Date.now() - this.lastPurge > 60_000) {
      this.lastPurge = Date.now();
      await this.db.query(`DELETE FROM ${this.table} WHERE expires_at < now() - interval '60 seconds'`).catch(() => undefined);
    }
    return inserted.rowCount === 1;
  }
}

/**
 * Verifies a service token. Cheap structural, signature, audience, time and request-binding
 * checks run first; the token is consumed in the replay store last, so rejected tokens never
 * occupy it. Every authentication failure is `null`; an undecidable replay check throws
 * `ServiceReplayUnavailable` so that protection can never be silently skipped.
 */
export class ServiceTokenVerifier {
  private options: ServiceVerifierOptions;
  private replay: ReplayStore;
  constructor(options: ServiceVerifierOptions & { replay?: ReplayStore }) {
    this.options = options;
    this.replay = options.replay ?? new MemoryReplayStore();
  }

  async verify(token: string | undefined, request: { method: string; path: string }): Promise<VerifiedService | null> {
    let checked: { serviceId: string; keyId: string; permissions: string[]; jti: string; exp: number };
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
      if (claims.aud !== this.options.audience || typeof claims.iat !== "number" || typeof claims.exp !== "number" || typeof claims.jti !== "string" || claims.jti.length > 128) return null;
      if (claims.iat > now + CLOCK_SKEW_SECONDS || claims.exp <= now || claims.exp - claims.iat > MAX_LIFETIME_SECONDS) return null;
      if (claims.htm !== request.method.toUpperCase() || claims.htu !== request.path) return null;
      checked = { serviceId: claims.iss, keyId: header.kid, permissions: [...service.permissions], jti: claims.jti, exp: claims.exp };
    } catch { return null; }
    let fresh: boolean;
    try { fresh = await this.replay.consume(checked.serviceId, checked.jti, checked.exp + CLOCK_SKEW_SECONDS); }
    catch { throw new ServiceReplayUnavailable(); }
    if (!fresh) return null;
    return { serviceId: checked.serviceId, keyId: checked.keyId, permissions: checked.permissions, jti: checked.jti };
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
