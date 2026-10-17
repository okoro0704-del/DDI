import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Activation codes are proof of commercial authorization, never of identity.
 * Format: DDI-LLLL-LLLL-SSSS-SSSS-SSSS-SSSS-SSSS-SSSS (Crockford base32).
 * L is a 40-bit random lookup id; S is a 120-bit random secret. Only an HMAC of
 * both, keyed by a server-side pepper, is stored.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const LOOKUP_LENGTH = 8;
const SECRET_LENGTH = 24;
export const ACTIVATION_HASH_VERSION = "hmac-sha256:v1";
export const MIN_PEPPER_LENGTH = 32;

function randomBase32(length: number) {
  // 256 is a multiple of 32, so masking each byte is uniform.
  const bytes = randomBytes(length);
  let value = "";
  for (const byte of bytes) value += ALPHABET[byte & 31];
  return value;
}

export function generateActivationCode() {
  const lookupId = randomBase32(LOOKUP_LENGTH);
  const secret = randomBase32(SECRET_LENGTH);
  const body = `${lookupId}${secret}`.match(/.{4}/g)!.join("-");
  return { lookupId, secret, code: `DDI-${body}` };
}

/** Tolerates case, spaces, hyphens and Crockford look-alikes. Anything else is rejected. */
export function parseActivationCode(input: unknown): { lookupId: string; secret: string } | null {
  if (typeof input !== "string" || input.length > 128) return null;
  const compact = input.toUpperCase().replace(/[\s-]/g, "");
  if (!compact.startsWith("DDI")) return null;
  const body = compact.slice(3).replace(/O/g, "0").replace(/[IL]/g, "1");
  if (!new RegExp(`^[${ALPHABET}]{${LOOKUP_LENGTH + SECRET_LENGTH}}$`).test(body)) return null;
  return { lookupId: body.slice(0, LOOKUP_LENGTH), secret: body.slice(LOOKUP_LENGTH) };
}

export function hashActivationSecret(pepper: string, lookupId: string, secret: string) {
  return createHmac("sha256", pepper).update(`ddi-activation:${ACTIVATION_HASH_VERSION}|${lookupId}|${secret}`).digest("hex");
}

export function sameDigest(left: string, right: string) {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** Download tokens are 256-bit random bearer values; only their SHA-256 is stored. */
export function generateDownloadToken() {
  const token = `ddidl_${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashDownloadToken(token) };
}

export function hashDownloadToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
