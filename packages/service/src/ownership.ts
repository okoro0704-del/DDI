import { createHash } from "node:crypto";
import type { ConnectedPropertyType } from "../../contracts/src/index.ts";
import { signServiceToken, type ServiceSigner } from "./service-token.ts";

/**
 * ACTIVATE (default) requires the authoritative PortalInstall to be READY.
 * BOOTSTRAP still requires the same verified owner, but accepts an install that
 * is not READY yet; DDI then holds the property in PENDING_ACTIVATION with no
 * privileges until a later ACTIVATE verification succeeds.
 */
export type OwnershipPurpose = "ACTIVATE" | "BOOTSTRAP";
export type OwnershipReadiness = "READY" | "PENDING";

export type OwnershipVerification = {
  verified: true;
  issuer: string;
  evidenceId: string;
  verifiedAt: string;
  expiresAt?: string;
  readiness: OwnershipReadiness;
  /** D3C-B: the Portal's monotonic per-install sequence at verification time, when supplied. */
  sequence?: number;
};

export type OwnershipRequest = { trustIdSubject: string; externalSystem: string; externalReference: string; type: ConnectedPropertyType; purpose?: OwnershipPurpose };

export type OwnershipVerifier = {
  verify(input: OwnershipRequest): Promise<OwnershipVerification>;
};

/** Authenticated Portal-side lookup. Caller-supplied evidence is never trusted. */
export class HttpPortalOwnershipVerifier implements OwnershipVerifier {
  private readonly options: { url: string; sharedSecret?: string; signer?: ServiceSigner; audience?: string; fetch?: typeof fetch };
  /** D3C-B: with a signer, DDI authenticates with a service token instead of the legacy D3A shared secret. */
  constructor(options: { url: string; sharedSecret?: string; signer?: ServiceSigner; audience?: string; fetch?: typeof fetch }) { this.options = options; }

  async verify(input: OwnershipRequest): Promise<OwnershipVerification> {
    const fetcher = this.options.fetch ?? fetch;
    const purpose = input.purpose ?? "ACTIVATE";
    let response: Response;
    try {
      response = await fetcher(this.options.url, {
        method: "POST",
        headers: this.headers(),
        // The Portal wire contract names the canonical TrustID subject ownerSubject.
        body: JSON.stringify({ ownerSubject: input.trustIdSubject, externalSystem: input.externalSystem, externalReference: input.externalReference, type: input.type, purpose: purpose.toLowerCase() }),
      });
    } catch { throw new Error("OWNERSHIP_VERIFICATION_UNAVAILABLE"); }
    if (response.status === 404 || response.status === 403) throw new Error("OWNERSHIP_NOT_VERIFIED");
    if (response.status === 409) throw new Error("OWNERSHIP_VERIFICATION_PENDING");
    if (!response.ok) throw new Error("OWNERSHIP_VERIFICATION_UNAVAILABLE");
    let value: Partial<Omit<OwnershipVerification, "readiness"> & { ownerSubject: string; externalSystem: string; externalReference: string; readiness: string }>;
    try { value = await response.json() as typeof value; }
    catch { throw new Error("OWNERSHIP_NOT_VERIFIED"); }
    if (value.verified !== true || value.ownerSubject !== input.trustIdSubject || value.externalSystem !== input.externalSystem || value.externalReference !== input.externalReference || !value.issuer || !value.evidenceId || !value.verifiedAt) {
      throw new Error("OWNERSHIP_NOT_VERIFIED");
    }
    if (value.expiresAt && Date.parse(value.expiresAt) <= Date.now()) throw new Error("OWNERSHIP_NOT_VERIFIED");
    // A D3A Portal answers 200 only for a READY install, so an absent readiness means READY.
    const readiness = value.readiness === undefined || value.readiness === "ready" || value.readiness === "READY" ? "READY" : value.readiness === "pending" || value.readiness === "PENDING" ? "PENDING" : null;
    if (!readiness) throw new Error("OWNERSHIP_NOT_VERIFIED");
    if (readiness === "PENDING" && purpose !== "BOOTSTRAP") throw new Error("OWNERSHIP_VERIFICATION_PENDING");
    const sequence = typeof (value as { sequence?: unknown }).sequence === "number" && Number.isSafeInteger((value as { sequence: number }).sequence) ? (value as { sequence: number }).sequence : undefined;
    return { verified: true, issuer: value.issuer, evidenceId: value.evidenceId, verifiedAt: value.verifiedAt, expiresAt: value.expiresAt, readiness, sequence };
  }

  private headers(): Record<string, string> {
    if (this.options.signer) return { "content-type": "application/json", authorization: `Bearer ${signServiceToken(this.options.signer, { audience: this.options.audience ?? "lifeos-portal", method: "POST", path: new URL(this.options.url).pathname })}` };
    if (!this.options.sharedSecret) throw new Error("OWNERSHIP_VERIFICATION_UNAVAILABLE");
    return { "content-type": "application/json", "x-ddi-ownership-secret": this.options.sharedSecret };
  }
}

/** Stable, non-secret receipt retained with the property for audit without retaining credentials. */
export function ownershipReceipt(value: OwnershipVerification): string {
  return `portal:${value.issuer}:${value.evidenceId}:${createHash("sha256").update(`${value.issuer}|${value.evidenceId}|${value.verifiedAt}|${value.expiresAt ?? ""}`).digest("hex")}`;
}
