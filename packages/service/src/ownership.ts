import { createHash } from "node:crypto";
import type { ConnectedPropertyType } from "../../contracts/src/index.ts";

export type OwnershipVerification = {
  verified: true;
  issuer: string;
  evidenceId: string;
  verifiedAt: string;
  expiresAt?: string;
};

export type OwnershipVerifier = {
  verify(input: { trustIdSubject: string; externalSystem: string; externalReference: string; type: ConnectedPropertyType }): Promise<OwnershipVerification>;
};

/** Authenticated Portal-side lookup. Caller-supplied evidence is never trusted. */
export class HttpPortalOwnershipVerifier implements OwnershipVerifier {
  private readonly options: { url: string; sharedSecret: string; fetch?: typeof fetch };
  constructor(options: { url: string; sharedSecret: string; fetch?: typeof fetch }) { this.options = options; }

  async verify(input: { trustIdSubject: string; externalSystem: string; externalReference: string; type: ConnectedPropertyType }): Promise<OwnershipVerification> {
    const fetcher = this.options.fetch ?? fetch;
    const response = await fetcher(this.options.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ddi-ownership-secret": this.options.sharedSecret,
      },
      // The Portal wire contract names the canonical TrustID subject ownerSubject.
      body: JSON.stringify({ ownerSubject: input.trustIdSubject, externalSystem: input.externalSystem, externalReference: input.externalReference, type: input.type }),
    });
    if (response.status === 404 || response.status === 403) throw new Error("OWNERSHIP_NOT_VERIFIED");
    if (response.status === 409) throw new Error("OWNERSHIP_VERIFICATION_PENDING");
    if (!response.ok) throw new Error("OWNERSHIP_VERIFICATION_UNAVAILABLE");
    const value = await response.json() as Partial<OwnershipVerification & { ownerSubject: string; externalSystem: string; externalReference: string }>;
    if (value.verified !== true || value.ownerSubject !== input.trustIdSubject || value.externalSystem !== input.externalSystem || value.externalReference !== input.externalReference || !value.issuer || !value.evidenceId || !value.verifiedAt) {
      throw new Error("OWNERSHIP_NOT_VERIFIED");
    }
    if (value.expiresAt && Date.parse(value.expiresAt) <= Date.now()) throw new Error("OWNERSHIP_NOT_VERIFIED");
    return { verified: true, issuer: value.issuer, evidenceId: value.evidenceId, verifiedAt: value.verifiedAt, expiresAt: value.expiresAt };
  }
}

/** Stable, non-secret receipt retained with the property for audit without retaining credentials. */
export function ownershipReceipt(value: OwnershipVerification): string {
  return `portal:${value.issuer}:${value.evidenceId}:${createHash("sha256").update(`${value.issuer}|${value.evidenceId}|${value.verifiedAt}|${value.expiresAt ?? ""}`).digest("hex")}`;
}
